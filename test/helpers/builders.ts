import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { toIso } from "../../src/lib/time.js";
import { appHeaders, internalHeaders } from "./app.js";

/** Deterministic-looking unique UUIDs with a readable prefix for debugging. */
export function uuid(): string {
  return randomUUID();
}

export interface EventSpec {
  id?: string;
  userId?: string | null;
  sessionId?: string;
  name: string;
  props?: Record<string, unknown>;
  clientTs: number;
}

export function event(spec: EventSpec): Record<string, unknown> {
  return {
    id: spec.id ?? uuid(),
    userId: spec.userId === undefined ? "usr_A" : spec.userId,
    sessionId: spec.sessionId ?? "sess-1",
    name: spec.name,
    props: spec.props ?? {},
    clientTs: toIso(spec.clientTs),
    device: { os: "android", model: "Redmi Note 12", network: "3g" },
  };
}

export const view = (storyId: string, watchMs: number, clientTs: number, extra: Partial<EventSpec> = {}) =>
  event({ name: "story_view", props: { storyId, watchMs }, clientTs, ...extra });
export const tap = (storyId: string, productId: string, clientTs: number, extra: Partial<EventSpec> = {}) =>
  event({ name: "story_product_tap", props: { storyId, productId }, clientTs, ...extra });
export const checkout = (clientTs: number, extra: Partial<EventSpec> = {}) => event({ name: "checkout_start", clientTs, ...extra });

export async function sendBatch(app: FastifyInstance, events: unknown[], sentAt: number | null) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/events/batch",
    headers: appHeaders,
    payload: sentAt === null ? { events } : { sentAt: toIso(sentAt), events },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, headers: res.headers };
}

export interface OrderSpec {
  orderId: string;
  userId?: string;
  vendorId: string;
  variantId: string;
  subtotal: number;
  createdAt: number;
}

export async function sendOrderEvent(app: FastifyInstance, o: OrderSpec, status: string, occurredAt: number) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/order-events",
    headers: internalHeaders,
    payload: {
      orderId: o.orderId,
      status,
      occurredAt: toIso(occurredAt),
      order: {
        userId: o.userId ?? "usr_A",
        vendorId: o.vendorId,
        lines: [{ variantId: o.variantId, quantity: 1, unitPrice: { amount: o.subtotal, currency: "INR" } }],
        subtotal: { amount: o.subtotal, currency: "INR" },
        createdAt: toIso(o.createdAt),
      },
    },
  });
  if (res.statusCode !== 202) throw new Error(`order event rejected: ${res.statusCode} ${res.body}`);
  return res.json() as { duplicate: boolean };
}

export async function getJson(app: FastifyInstance, url: string) {
  const res = await app.inject({ method: "GET", url, headers: appHeaders });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

export async function sweep(app: FastifyInstance, asOf: number) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/jobs/commission-sweep",
    headers: internalHeaders,
    payload: { asOf: toIso(asOf) },
  });
  if (res.statusCode !== 200) throw new Error(`sweep failed: ${res.statusCode} ${res.body}`);
  return res.json() as { madePayable: number };
}