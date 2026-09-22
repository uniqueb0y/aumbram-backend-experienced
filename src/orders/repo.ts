import type { Queryable } from "../db/pool.js";
import { ms, msOrNull } from "../db/rows.js";
import type { Bucket, Position } from "../ledger/plan.js";

export type LockReason = "return_window_closed" | "returned" | "cancelled";

export interface OrderRow {
  id: string;
  userId: string;
  vendorId: string;
  productIds: string[];
  subtotalPaise: bigint;
  createdAt: number;
  deliveredAt: number | null;
  returnRequestedAt: number | null;
  returnedAt: number | null;
  cancelledAt: number | null;
  payableAt: number | null;
  lockedAt: number | null;
  lockReason: LockReason | null;
  attributionVersion: number;
  /** What the ledger currently holds for this order. */
  ledger: Position | null;
}

interface OrderDbRow {
  id: string;
  user_id: string;
  vendor_id: string;
  product_ids: string[];
  subtotal_paise: bigint;
  created_at: Date;
  delivered_at: Date | null;
  return_requested_at: Date | null;
  returned_at: Date | null;
  cancelled_at: Date | null;
  payable_at: Date | null;
  locked_at: Date | null;
  lock_reason: LockReason | null;
  attribution_version: number;
  ledger_bucket: Bucket | null;
  ledger_creator_id: string | null;
  ledger_amount_paise: bigint | null;
  ledger_attribution_version: number | null;
}

export const ORDER_COLUMNS = `id, user_id, vendor_id, product_ids, subtotal_paise, created_at, delivered_at,
  return_requested_at, returned_at, cancelled_at, payable_at, locked_at, lock_reason, attribution_version,
  ledger_bucket, ledger_creator_id, ledger_amount_paise, ledger_attribution_version`;

export function mapOrder(r: OrderDbRow): OrderRow {
  const ledger =
    r.ledger_bucket !== null && r.ledger_creator_id !== null && r.ledger_amount_paise !== null && r.ledger_attribution_version !== null
      ? { bucket: r.ledger_bucket, creatorId: r.ledger_creator_id, amount: r.ledger_amount_paise, attributionVersion: r.ledger_attribution_version }
      : null;
  return {
    id: r.id,
    userId: r.user_id,
    vendorId: r.vendor_id,
    productIds: r.product_ids,
    subtotalPaise: r.subtotal_paise,
    createdAt: ms(r.created_at),
    deliveredAt: msOrNull(r.delivered_at),
    returnRequestedAt: msOrNull(r.return_requested_at),
    returnedAt: msOrNull(r.returned_at),
    cancelledAt: msOrNull(r.cancelled_at),
    payableAt: msOrNull(r.payable_at),
    lockedAt: msOrNull(r.locked_at),
    lockReason: r.lock_reason,
    attributionVersion: r.attribution_version,
    ledger,
  };
}

/** Row-locks an order for the rest of the transaction. */
export async function lockOrder(tx: Queryable, orderId: string): Promise<OrderRow | null> {
  const { rows } = await tx.query<OrderDbRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  return rows[0] ? mapOrder(rows[0]) : null;
}

export async function getOrder(db: Queryable, orderId: string): Promise<OrderRow | null> {
  const { rows } = await db.query<OrderDbRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [orderId]);
  return rows[0] ? mapOrder(rows[0]) : null;
}

export async function updateOrderReturning(tx: Queryable, sql: string, params: unknown[]): Promise<OrderRow> {
  const { rows } = await tx.query<OrderDbRow>(`${sql} RETURNING ${ORDER_COLUMNS}`, params);
  const row = rows[0];
  if (!row) throw new Error("order update matched no row");
  return mapOrder(row);
}

/**
 * Serialises all attribution work for the given users (see DECISIONS D-017).
 * Locks are taken in ascending key order in a single statement, so two
 * transactions locking overlapping user sets cannot deadlock.
 */
export async function lockUsers(tx: Queryable, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await tx.query(
    `SELECT pg_advisory_xact_lock(k)
     FROM (SELECT DISTINCT hashtextextended(u, 0) AS k FROM unnest($1::text[]) AS u ORDER BY k) AS keys`,
    [[...new Set(userIds)]],
  );
}