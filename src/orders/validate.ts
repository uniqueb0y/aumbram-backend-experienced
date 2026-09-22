import { isPlainObject } from "../ingest/validate.js";
import { parsePaise } from "../lib/money.js";
import { parseIsoTimestamp } from "../lib/time.js";

export const ORDER_STATUSES = [
  "created",
  "pending_payment",
  "paid",
  "confirmed",
  "packed",
  "shipped",
  "delivered",
  "return_requested",
  "returned",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(ORDER_STATUSES);
function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

export interface OrderLine {
  variantId: string;
  quantity: number;
  unitPricePaise: bigint;
}

export interface OrderSnapshot {
  userId: string;
  vendorId: string;
  lines: OrderLine[];
  subtotalPaise: bigint;
  currency: string;
  createdAt: number;
}

export interface OrderEventMessage {
  orderId: string;
  status: OrderStatus;
  occurredAt: number;
  order: OrderSnapshot;
}

export type OrderEventCheck = { ok: true; message: OrderEventMessage } | { ok: false; message: string; field: string };

const idOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 && !v.includes("\x00");

function fail(field: string, message: string): OrderEventCheck {
  return { ok: false, field, message };
}

/** Validates a POST /v1/internal/order-events body. Money must be integer paise. */
export function validateOrderEvent(body: unknown): OrderEventCheck {
  if (!isPlainObject(body)) return fail("body", "body must be a JSON object");
  if (!idOk(body.orderId)) return fail("orderId", "orderId must be a non-empty string");
  if (!isOrderStatus(body.status)) return fail("status", `status must be one of ${ORDER_STATUSES.join(", ")}`);
  const occurredAt = parseIsoTimestamp(body.occurredAt);
  if (occurredAt === null) return fail("occurredAt", "occurredAt must be an ISO-8601 timestamp");

  const o = body.order;
  if (!isPlainObject(o)) return fail("order", "order snapshot is required");
  if (!idOk(o.userId)) return fail("order.userId", "order.userId must be a non-empty string");
  if (!idOk(o.vendorId)) return fail("order.vendorId", "order.vendorId must be a non-empty string");
  const createdAt = parseIsoTimestamp(o.createdAt);
  if (createdAt === null) return fail("order.createdAt", "order.createdAt must be an ISO-8601 timestamp");

  if (!isPlainObject(o.subtotal)) return fail("order.subtotal", "order.subtotal must be Money");
  const subtotalPaise = parsePaise(o.subtotal.amount);
  if (subtotalPaise === null) return fail("order.subtotal.amount", "amount must be a non-negative integer (paise)");
  if (o.subtotal.currency !== "INR") return fail("order.subtotal.currency", "currency must be INR");

  if (!Array.isArray(o.lines) || o.lines.length === 0 || o.lines.length > 200) {
    return fail("order.lines", "order.lines must be a non-empty array");
  }
  const lines: OrderLine[] = [];
  for (const [i, line] of o.lines.entries()) {
    if (!isPlainObject(line)) return fail(`order.lines[${i}]`, "line must be an object");
    if (!idOk(line.variantId)) return fail(`order.lines[${i}].variantId`, "variantId must be a non-empty string");
    if (typeof line.quantity !== "number" || !Number.isInteger(line.quantity) || line.quantity < 1) {
      return fail(`order.lines[${i}].quantity`, "quantity must be an integer >= 1");
    }
    if (!isPlainObject(line.unitPrice)) return fail(`order.lines[${i}].unitPrice`, "unitPrice must be Money");
    const unitPricePaise = parsePaise(line.unitPrice.amount);
    if (unitPricePaise === null) return fail(`order.lines[${i}].unitPrice.amount`, "amount must be a non-negative integer (paise)");
    lines.push({ variantId: line.variantId, quantity: line.quantity, unitPricePaise });
  }

  return {
    ok: true,
    message: {
      orderId: body.orderId,
      status: body.status,
      occurredAt,
      order: { userId: o.userId, vendorId: o.vendorId, lines, subtotalPaise, currency: "INR", createdAt },
    },
  };
}

/** JSON form stored in order_events.payload (bigints as strings, timestamps as ms). */
export function serializeOrderEvent(m: OrderEventMessage): Record<string, unknown> {
  return {
    orderId: m.orderId,
    status: m.status,
    occurredAt: m.occurredAt,
    order: {
      userId: m.order.userId,
      vendorId: m.order.vendorId,
      lines: m.order.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPricePaise: l.unitPricePaise.toString() })),
      subtotalPaise: m.order.subtotalPaise.toString(),
      currency: m.order.currency,
      createdAt: m.order.createdAt,
    },
  };
}

export function deserializeOrderEvent(payload: unknown): OrderEventMessage {
  if (!isPlainObject(payload) || !isPlainObject(payload.order)) throw new Error("corrupt order event payload");
  const o = payload.order;
  if (!Array.isArray(o.lines) || !isOrderStatus(payload.status)) throw new Error("corrupt order event payload");
  const lines: OrderLine[] = o.lines.map((l: unknown) => {
    if (!isPlainObject(l) || typeof l.variantId !== "string" || typeof l.quantity !== "number" || typeof l.unitPricePaise !== "string") {
      throw new Error("corrupt order line in payload");
    }
    return { variantId: l.variantId, quantity: l.quantity, unitPricePaise: BigInt(l.unitPricePaise) };
  });
  if (
    typeof payload.orderId !== "string" ||
    typeof payload.occurredAt !== "number" ||
    typeof o.userId !== "string" ||
    typeof o.vendorId !== "string" ||
    typeof o.subtotalPaise !== "string" ||
    typeof o.createdAt !== "number"
  ) {
    throw new Error("corrupt order event payload");
  }
  return {
    orderId: payload.orderId,
    status: payload.status,
    occurredAt: payload.occurredAt,
    order: { userId: o.userId, vendorId: o.vendorId, lines, subtotalPaise: BigInt(o.subtotalPaise), currency: "INR", createdAt: o.createdAt },
  };
}