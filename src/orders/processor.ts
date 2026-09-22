/**
 * Applies one order lifecycle message: create the order on first sight
 * (computing attribution v1), record the status, and reconcile the ledger.
 * Safe to run for duplicate and out-of-order messages.
 */
import { evaluateOrder } from "../attribution/engine.js";
import type { RuleParams } from "../attribution/ruleConfig.js";
import type { PoolClient } from "../db/pool.js";
import { iso } from "../db/rows.js";
import { reconcileOrderLedger } from "../ledger/reconcile.js";
import type { Logger } from "../lib/logger.js";
import { attributionEvaluations } from "../metrics.js";
import { lockOrder, lockUsers, updateOrderReturning, type LockReason } from "./repo.js";
import { deserializeOrderEvent, type OrderEventMessage, type OrderStatus } from "./validate.js";

/** Status -> the timestamp column it sets. Statuses not listed only matter for attribution/creation. */
const STATUS_COLUMN: Partial<Record<OrderStatus, string>> = {
  delivered: "delivered_at",
  return_requested: "return_requested_at",
  returned: "returned_at",
  cancelled: "cancelled_at",
};

const TERMINAL_LOCK: Partial<Record<OrderStatus, LockReason>> = {
  returned: "returned",
  cancelled: "cancelled",
};

export interface ProcessDeps {
  rule: RuleParams;
  log: Logger;
}

export async function loadOrderEvent(tx: PoolClient, orderId: string, status: string): Promise<OrderEventMessage | null> {
  const { rows } = await tx.query<{ payload: unknown }>("SELECT payload FROM order_events WHERE order_id = $1 AND status = $2", [
    orderId,
    status,
  ]);
  return rows[0] ? deserializeOrderEvent(rows[0].payload) : null;
}

export async function processOrderEvent(tx: PoolClient, message: OrderEventMessage, deps: ProcessDeps): Promise<void> {
  const { order: snap } = message;
  const log = deps.log.child({ orderId: message.orderId, status: message.status });

  // Lock order: user advisory lock, then the order row (DECISIONS D-017).
  await lockUsers(tx, [snap.userId]);

  // First message wins for the snapshot (DECISIONS D-025). Variants resolve to products here;
  // unknown variants are dropped and so can never match a story.
  await tx.query(
    `INSERT INTO orders (id, user_id, vendor_id, lines, product_ids, subtotal_paise, currency, created_at)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT array_agg(DISTINCT product_id ORDER BY product_id) FROM variants WHERE id = ANY($5::text[])), '{}'), $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      message.orderId,
      snap.userId,
      snap.vendorId,
      JSON.stringify(snap.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPricePaise: l.unitPricePaise.toString() }))),
      snap.lines.map((l) => l.variantId),
      snap.subtotalPaise.toString(),
      snap.currency,
      iso(snap.createdAt),
    ],
  );

  let order = await lockOrder(tx, message.orderId);
  if (order === null) throw new Error(`order ${message.orderId} vanished after insert`);
  if (order.userId !== snap.userId || order.subtotalPaise !== snap.subtotalPaise || order.createdAt !== snap.createdAt) {
    log.warn("order snapshot differs from the first one received; keeping the first (D-025)");
  }

  if (order.attributionVersion === 0) {
    const result = await evaluateOrder(tx, order, { rule: deps.rule, reason: "initial", triggerEventIds: [] });
    attributionEvaluations.inc({ trigger: "order_created", outcome: result.outcome });
  }

  const column = STATUS_COLUMN[message.status];
  const lockReason = TERMINAL_LOCK[message.status] ?? null;
  if (column !== undefined) {
    order = await updateOrderReturning(
      tx,
      `UPDATE orders SET
         ${column} = COALESCE(${column}, $2),
         locked_at = CASE WHEN $3::text IS NOT NULL THEN COALESCE(locked_at, now()) ELSE locked_at END,
         lock_reason = CASE WHEN $3::text IS NOT NULL THEN COALESCE(lock_reason, $3::text) ELSE lock_reason END,
         updated_at = now()
       WHERE id = $1`,
      [message.orderId, iso(message.occurredAt), lockReason],
    );
  }

  const postings = await reconcileOrderLedger(tx, order, `order_${message.status}`);
  if (postings.length > 0) {
    log.info({ postings: postings.map((p) => p.idempotencyKey) }, "ledger updated");
  }
}

export async function processQueuedOrderEvent(tx: PoolClient, orderId: string, status: string, deps: ProcessDeps): Promise<boolean> {
  const message = await loadOrderEvent(tx, orderId, status);
  if (message === null) return false;
  await processOrderEvent(tx, message, deps);
  return true;
}