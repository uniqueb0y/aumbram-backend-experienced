/**
 * Commission sweep: once `deliveredAt + 7 days <= asOf` and no return was
 * requested, the order's commission becomes payable and its attribution locks.
 * The clock is injected via `asOf`.
 */
import type { Pool } from "../db/pool.js";
import { iso } from "../db/rows.js";
import { withTransaction } from "../db/tx.js";
import { reconcileOrderLedger } from "../ledger/reconcile.js";
import { DAY } from "../lib/time.js";
import { sweepOrders } from "../metrics.js";
import { lockOrder, updateOrderReturning } from "./repo.js";

export const RETURN_WINDOW_MS = 7 * DAY;

export interface SweepResult {
  asOf: number;
  examined: number;
  madePayable: number;
  lockedWithoutCommission: number;
}

export async function runCommissionSweep(pool: Pool, asOf: number, batchSize = 500): Promise<SweepResult> {
  const cutoff = iso(asOf - RETURN_WINDOW_MS);
  const result: SweepResult = { asOf, examined: 0, madePayable: 0, lockedWithoutCommission: 0 };
  let after = "";

  for (;;) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM orders
       WHERE locked_at IS NULL AND delivered_at IS NOT NULL AND delivered_at <= $1
         AND return_requested_at IS NULL AND returned_at IS NULL AND cancelled_at IS NULL
         AND id > $2
       ORDER BY id LIMIT $3`,
      [cutoff, after, batchSize],
    );
    if (rows.length === 0) break;

    for (const { id } of rows) {
      after = id;
      result.examined++;
      // One transaction per order keeps lock time short and makes the sweep resumable.
      const outcome = await withTransaction(pool, async (tx) => {
        const order = await lockOrder(tx, id);
        // Re-check under the row lock: a return request may have arrived since the scan.
        if (
          order === null ||
          order.lockedAt !== null ||
          order.deliveredAt === null ||
          order.deliveredAt > asOf - RETURN_WINDOW_MS ||
          order.returnRequestedAt !== null ||
          order.returnedAt !== null ||
          order.cancelledAt !== null
        ) {
          return "skipped" as const;
        }
        const settled = await updateOrderReturning(
          tx,
          `UPDATE orders SET payable_at = $2, locked_at = now(), lock_reason = 'return_window_closed', updated_at = now() WHERE id = $1`,
          [id, iso(asOf)],
        );
        const postings = await reconcileOrderLedger(tx, settled, "sweep");
        return postings.some((p) => p.type === "make_payable") ? ("payable" as const) : ("locked" as const);
      });
      if (outcome === "payable") result.madePayable++;
      if (outcome === "locked") result.lockedWithoutCommission++;
      sweepOrders.inc({ result: outcome });
    }
  }
  return result;
}