import { getDecision } from "../attribution/decisions.js";
import type { Queryable } from "../db/pool.js";
import type { OrderRow } from "../orders/repo.js";
import { desiredPosition, planPostings, type PlannedPosting } from "./plan.js";
import { applyPostings } from "./posting.js";

/**
 * Brings the ledger for one order in line with the order's current state and
 * attribution (DECISIONS D-018). Caller holds the order's row lock.
 */
export async function reconcileOrderLedger(tx: Queryable, order: OrderRow, reason: string): Promise<PlannedPosting[]> {
  const decision = await getDecision(tx, order.id, order.attributionVersion);
  const desired = desiredPosition(
    order,
    decision && {
      version: decision.version,
      attributed: decision.attributed,
      creatorId: decision.creatorId,
      commission: decision.commissionPaise,
    },
  );
  const plan = planPostings(order.id, order.ledger, desired);
  if (plan.postings.length === 0) return [];

  await applyPostings(tx, plan.postings, reason);
  const r = plan.resulting;
  await tx.query(
    `UPDATE orders SET ledger_bucket = $2, ledger_creator_id = $3, ledger_amount_paise = $4,
       ledger_attribution_version = $5, updated_at = now()
     WHERE id = $1`,
    [order.id, r?.bucket ?? null, r?.creatorId ?? null, r === null ? null : r.amount.toString(), r?.attributionVersion ?? null],
  );
  order.ledger = r;
  return plan.postings;
}