/**
 * Validation for POST /v1/events/batch. Pure functions: body in, typed values
 * or per-event rejections out. No database lookups (unknown story/product ids are
 * accepted and simply never match downstream).
 */
import { normalizeEventId } from "../lib/ids.js";
import { parseIsoTimestamp } from "../lib/time.js";

export const EVENT_NAMES = [
  "feed_impression",
  "card_tap",
  "story_view",
  "story_product_tap",
  "add_to_cart",
  "checkout_start",
  "purchase",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

const EVENT_NAME_SET: ReadonlySet<string> = new Set(EVENT_NAMES);
export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && EVENT_NAME_SET.has(value);
}
const MAX_ID_LENGTH = 128;

export type RejectCode =
  | "INVALID_EVENT"
  | "INVALID_ID"
  | "INVALID_NAME"
  | "INVALID_SESSION_ID"
  | "INVALID_USER_ID"
  | "INVALID_CLIENT_TS"
  | "INVALID_PROPS"
  | "MISSING_PROP"
  | "INVALID_DEVICE"
  | "INVALID_STRING";

export type Props = Record<string, unknown>;

export interface ValidEvent {
  /** Normalised dedupe key (lower-case UUID, no prefix). */
  id: string;
  userId: string | null;
  sessionId: string;
  name: EventName;
  props: Props;
  clientTs: number;
  device: Props | null;
}

export interface Rejection {
  index: number;
  id: string | null;
  code: RejectCode;
  message: string;
}

export type EventCheck = { ok: true; event: ValidEvent } | { ok: false; code: RejectCode; message: string };

export function isPlainObject(value: unknown): value is Props {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True if any string (key or value) anywhere inside contains NUL, which Postgres text/jsonb cannot store. */
export function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\x00");
  if (Array.isArray(value)) return value.some(containsNul);
  if (isPlainObject(value)) {
    return Object.entries(value).some(([k, v]) => k.includes("\x00") || containsNul(v));
  }
  return false;
}

function isNonEmptyString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

type PropRule = { name: string; check: (v: unknown) => boolean; expected: string };

const str: PropRule["check"] = (v) => isNonEmptyString(v);
const nonNegInt: PropRule["check"] = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Required props per event name (assignment section 3.4 A). Extra props are kept. */
const REQUIRED_PROPS: Readonly<Record<EventName, readonly PropRule[]>> = {
  feed_impression: [
    { name: "feedItemId", check: str, expected: "a non-empty string" },
    { name: "position", check: nonNegInt, expected: "an integer >= 0" },
  ],
  card_tap: [{ name: "feedItemId", check: str, expected: "a non-empty string" }],
  story_view: [
    { name: "storyId", check: str, expected: "a non-empty string" },
    { name: "watchMs", check: nonNegInt, expected: "an integer >= 0" },
  ],
  story_product_tap: [
    { name: "storyId", check: str, expected: "a non-empty string" },
    { name: "productId", check: str, expected: "a non-empty string" },
  ],
  add_to_cart: [{ name: "productId", check: str, expected: "a non-empty string" }],
  checkout_start: [],
  purchase: [{ name: "orderId", check: str, expected: "a non-empty string" }],
};

export function validateEvent(raw: unknown): EventCheck {
  if (!isPlainObject(raw)) return { ok: false, code: "INVALID_EVENT", message: "event must be an object" };

  const id = normalizeEventId(raw.id);
  if (id === null) return { ok: false, code: "INVALID_ID", message: "id must be a UUID, optionally prefixed with evt_" };

  const name = raw.name;
  if (!isEventName(name)) {
    return { ok: false, code: "INVALID_NAME", message: `name must be one of ${EVENT_NAMES.join(", ")}` };
  }

  if (!isNonEmptyString(raw.sessionId)) {
    return { ok: false, code: "INVALID_SESSION_ID", message: `sessionId must be a non-empty string of at most ${MAX_ID_LENGTH} chars` };
  }

  let userId: string | null = null;
  if (raw.userId !== undefined && raw.userId !== null && raw.userId !== "") {
    if (!isNonEmptyString(raw.userId)) {
      return { ok: false, code: "INVALID_USER_ID", message: `userId must be null or a string of at most ${MAX_ID_LENGTH} chars` };
    }
    userId = raw.userId;
  }

  const clientTs = parseIsoTimestamp(raw.clientTs);
  if (clientTs === null) return { ok: false, code: "INVALID_CLIENT_TS", message: "clientTs must be an ISO-8601 timestamp with offset" };

  const props = raw.props === undefined ? {} : raw.props;
  if (!isPlainObject(props)) return { ok: false, code: "INVALID_PROPS", message: "props must be an object" };
  for (const rule of REQUIRED_PROPS[name]) {
    const value = props[rule.name];
    if (value === undefined || value === null) {
      return { ok: false, code: "MISSING_PROP", message: `props.${rule.name} is required for ${name}` };
    }
    if (!rule.check(value)) {
      return { ok: false, code: "INVALID_PROPS", message: `props.${rule.name} must be ${rule.expected}` };
    }
  }

  let device: Props | null = null;
  if (raw.device !== undefined && raw.device !== null) {
    if (!isPlainObject(raw.device)) return { ok: false, code: "INVALID_DEVICE", message: "device must be an object" };
    device = raw.device;
  }

  if (containsNul(raw.sessionId) || containsNul(userId) || containsNul(props) || containsNul(device)) {
    return { ok: false, code: "INVALID_STRING", message: "strings must not contain NUL characters" };
  }

  return { ok: true, event: { id, userId, sessionId: raw.sessionId, name, props, clientTs, device } };
}

export type EnvelopeCheck =
  | { ok: true; sentAt: number | null; events: unknown[] }
  | { ok: false; status: number; code: string; message: string };

export function validateEnvelope(body: unknown, maxEvents: number): EnvelopeCheck {
  if (!isPlainObject(body)) return { ok: false, status: 400, code: "INVALID_BODY", message: "body must be a JSON object" };
  if (!Array.isArray(body.events)) return { ok: false, status: 422, code: "INVALID_BODY", message: "events must be an array" };
  if (body.events.length === 0 || body.events.length > maxEvents) {
    return { ok: false, status: 422, code: "BATCH_SIZE_INVALID", message: `a batch must contain 1-${maxEvents} events` };
  }
  // A missing or unparseable sentAt is not an error: serverTs falls back to receivedAt.
  return { ok: true, sentAt: parseIsoTimestamp(body.sentAt), events: body.events };
}