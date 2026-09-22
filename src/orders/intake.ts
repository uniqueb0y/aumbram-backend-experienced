import type { Queryable } from "../db/pool.js";
import { iso } from "../db/rows.js";
import { serializeOrderEvent, type OrderEventMessage } from "./validate.js";

/**
 * Stores an order lifecycle message and enqueues it, in one statement.
 * (orderId, status) is the dedupe key: a repeat is stored nowhere and not enqueued.
 */
export async function recordOrderEvent(db: Queryable, message: OrderEventMessage): Promise<{ duplicate: boolean }> {
  const { rowCount } = await db.query(
    `WITH inserted AS (
       INSERT INTO order_events (order_id, status, occurred_at, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id, status) DO NOTHING
       RETURNING order_id, status
     )
     INSERT INTO order_event_queue (order_id, status) SELECT order_id, status FROM inserted`,
    [message.orderId, message.status, iso(message.occurredAt), JSON.stringify(serializeOrderEvent(message))],
  );
  return { duplicate: rowCount === 0 };
}