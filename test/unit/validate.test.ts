import { describe, expect, it } from "vitest";
import { validateEnvelope, validateEvent } from "../../src/ingest/validate.js";
import { normalizeEventId } from "../../src/lib/ids.js";
import { commissionFor, toJsonAmount } from "../../src/lib/money.js";
import { parseIsoTimestamp, toIso } from "../../src/lib/time.js";
import { validateOrderEvent } from "../../src/orders/validate.js";
import { parseCsvLine } from "../../src/tools/csv.js";

const base = {
  id: "0b7f7c1e-5d0b-4e61-8a61-9c2f5b7c3e11",
  userId: "usr_001466",
  sessionId: "0c677996-3fd9-45ac-a2c2-bb54760b7f1c",
  name: "story_view",
  props: { storyId: "sty_0108", creatorId: "crt_0001", watchMs: 4200 },
  clientTs: "2026-09-13T14:04:31Z",
};

describe("event ids", () => {
  it("evt_<uuid> and <uuid> normalise to the same lower-case key", () => {
    const bare = "6F1B0A52-7C1E-4D0B-9A61-3E2F5B7C9D10";
    expect(normalizeEventId(`evt_${bare.toLowerCase()}`)).toBe(bare.toLowerCase());
    expect(normalizeEventId(bare)).toBe(bare.toLowerCase());
    expect(normalizeEventId("evt_not-a-uuid")).toBeNull();
    expect(normalizeEventId(42)).toBeNull();
  });
});

describe("validateEvent", () => {
  it("accepts a valid event and keeps extra props", () => {
    const r = validateEvent(base);
    expect(r.ok && r.event.props.creatorId).toBe("crt_0001");
  });

  it.each([
    [{ ...base, id: "nope" }, "INVALID_ID"],
    [{ ...base, name: "page_view" }, "INVALID_NAME"],
    [{ ...base, sessionId: "" }, "INVALID_SESSION_ID"],
    [{ ...base, clientTs: "yesterday" }, "INVALID_CLIENT_TS"],
    [{ ...base, clientTs: "2026-09-13 14:04:31" }, "INVALID_CLIENT_TS"],
    [{ ...base, props: { storyId: "sty_1" } }, "MISSING_PROP"],
    [{ ...base, props: { storyId: "sty_1", watchMs: 12.5 } }, "INVALID_PROPS"],
    [{ ...base, props: { storyId: "sty_1", watchMs: -1 } }, "INVALID_PROPS"],
    [{ ...base, props: "x" }, "INVALID_PROPS"],
    [{ ...base, name: "purchase", props: {} }, "MISSING_PROP"],
    [{ ...base, name: "feed_impression", props: { feedItemId: "fi_1" } }, "MISSING_PROP"],
    [{ ...base, device: "android" }, "INVALID_DEVICE"],
    [{ ...base, props: { storyId: "sty\x001", watchMs: 1 } }, "INVALID_STRING"],
    [{ ...base, userId: 12 }, "INVALID_USER_ID"],
    ["not an object", "INVALID_EVENT"],
  ])("rejects %j with %s", (event, code) => {
    const r = validateEvent(event);
    expect(r.ok ? "ok" : r.code).toBe(code);
  });

  it("treats an empty-string userId as logged out", () => {
    const r = validateEvent({ ...base, userId: "" });
    expect(r.ok && r.event.userId).toBeNull();
  });

  it("checkout_start needs no props", () => {
    expect(validateEvent({ ...base, name: "checkout_start", props: undefined }).ok).toBe(true);
  });
});

describe("validateEnvelope", () => {
  it("enforces 1-500 events and tolerates a bad sentAt", () => {
    expect(validateEnvelope({ events: [] }, 500)).toMatchObject({ ok: false, status: 422 });
    expect(validateEnvelope({ events: new Array(501).fill(base) }, 500)).toMatchObject({ ok: false, status: 422 });
    expect(validateEnvelope({ events: [base], sentAt: "garbage" }, 500)).toMatchObject({ ok: true, sentAt: null });
    expect(validateEnvelope([], 500)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("money", () => {
  it.each([
    [99999n, 700, 6999n],
    [259800n, 300, 7794n],
    [1n, 1000, 0n],
    [9999n, 1, 0n],
    [10000n, 1, 1n],
    [0n, 500, 0n],
  ])("floor(%s x %s bps / 10000) = %s", (subtotal, bps, expected) => {
    expect(commissionFor(subtotal, bps)).toBe(expected);
  });

  it("rejects invalid rates and unsafe JSON amounts", () => {
    expect(() => commissionFor(100n, 10001)).toThrow();
    expect(() => commissionFor(-1n, 100)).toThrow();
    expect(() => toJsonAmount(2n ** 60n)).toThrow();
  });
});

describe("time", () => {
  it("parses strict ISO-8601 with offsets and fractional seconds", () => {
    expect(parseIsoTimestamp("2026-09-13T08:30:00Z")).toBe(Date.UTC(2026, 8, 13, 8, 30));
    expect(parseIsoTimestamp("2026-09-13T14:00:00+05:30")).toBe(Date.UTC(2026, 8, 13, 8, 30));
    expect(parseIsoTimestamp("2026-09-13T08:30:00.123456Z")).toBe(Date.UTC(2026, 8, 13, 8, 30, 0, 123));
    expect(parseIsoTimestamp("2026-09-13")).toBeNull();
    expect(toIso(Date.UTC(2026, 8, 13, 8, 30))).toBe("2026-09-13T08:30:00Z");
  });
});

describe("order event validation", () => {
  const order = {
    orderId: "ord_1",
    status: "delivered",
    occurredAt: "2026-09-15T11:20:00Z",
    order: {
      userId: "usr_1",
      vendorId: "vnd_1",
      lines: [{ variantId: "var_1", quantity: 2, unitPrice: { amount: 129900, currency: "INR" } }],
      subtotal: { amount: 259800, currency: "INR" },
      createdAt: "2026-09-13T08:40:00Z",
    },
  };
  it("accepts integer paise and rejects floats, unknown statuses and missing snapshots", () => {
    expect(validateOrderEvent(order).ok).toBe(true);
    expect(validateOrderEvent({ ...order, status: "lost" }).ok).toBe(false);
    expect(validateOrderEvent({ ...order, order: { ...order.order, subtotal: { amount: 2598.5, currency: "INR" } } }).ok).toBe(false);
    expect(validateOrderEvent({ ...order, order: undefined }).ok).toBe(false);
  });
});

describe("csv", () => {
  it("parses quoted fields with commas and doubled quotes", () => {
    expect(parseCsvLine('a,"{""k"":1,""j"":2}",,"x"')).toEqual(["a", '{"k":1,"j":2}', "", "x"]);
  });
});