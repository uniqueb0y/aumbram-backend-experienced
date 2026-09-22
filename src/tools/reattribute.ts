/**
 * Re-runs attribution for orders created in [from, to] (BE-E-21, design doc
 * section 4). Idempotent: a new version is written only when the outcome changes;
 * locked orders are never changed, and would-be changes are recorded instead.
 */
import { evaluateOrder } from "../attribution/engine.js";
import type { RuleParams } from "../attribution/ruleConfig.js";
import type { Pool } from "../db/pool.js";
import { iso } from "../db/rows.js";
import { withTransaction } from "../db/tx.js";
import { reconcileOrderLedger } from "../ledger/reconcile.js";
import { lockOrder, lockUsers } from "../orders/repo.js";

export interface ReattributeResult {
  examined: number;
  changed: number;
  unchanged: number;
  lateLocked: number;
}

export async function reattributeRange(pool: Pool, from: number, to: number, rule: RuleParams, batchSize = 200): Promise<ReattributeResult> {
  const result: ReattributeResult = { examined: 0, changed: 0, unchanged: 0, lateLocked: 0 };
  let after = "";
  for (;;) {
    const { rows } = await pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM orders WHERE created_at BETWEEN $1 AND $2 AND id > $3 ORDER BY id LIMIT $4`,
      [iso(from), iso(to), after, batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.id;
      result.examined++;
      const outcome = await withTransaction(pool, async (tx) => {
        await lockUsers(tx, [row.user_id]);
        const order = await lockOrder(tx, row.id);
        if (order === null || order.attributionVersion === 0) return "unchanged" as const;
        const evaluation = await evaluateOrder(tx, order, { rule, reason: "reattribution_job", triggerEventIds: [] });
        if (evaluation.outcome === "changed") await reconcileOrderLedger(tx, order, "reattribution_job");
        return evaluation.outcome;
      });
      if (outcome === "changed") result.changed++;
      else if (outcome === "late_locked") result.lateLocked++;
      else result.unchanged++;
    }
  }
  return result;
}