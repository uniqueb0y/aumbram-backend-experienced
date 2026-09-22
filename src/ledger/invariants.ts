/**
 * Ledger invariant checker (BE-E-19). Runs in one read-only snapshot and
 * records its result, so /metrics and alerts can see violations.
 */
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";

export interface InvariantReport {
  ok: boolean;
  /** Sum of every ledger entry: must be exactly 0. */
  totalSum: string;
  unbalancedTransactions: number;
  negativeCreatorBalances: number;
  /** Orders whose recorded ledger position disagrees with the entries. */
  orderPositionMismatches: number;
}

export async function checkInvariants(pool: Pool): Promise<InvariantReport> {
  return withTransaction(
    pool,
    async (tx) => {
      const { rows } = await tx.query<{ total: bigint; unbalanced: bigint; negative: bigint; mismatched: bigint }>(`
        SELECT
          (SELECT coalesce(sum(amount_paise), 0) FROM ledger_entries) AS total,
          (SELECT count(*) FROM (
             SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_paise) <> 0
           ) u) AS unbalanced,
          (SELECT count(*) FROM (
             SELECT e.account_id FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
             WHERE a.kind <> 'platform_commission_expense'
             GROUP BY e.account_id HAVING sum(e.amount_paise) > 0
           ) n) AS negative,
          (SELECT count(*) FROM (
             SELECT o.id
             FROM orders o
             LEFT JOIN (
               SELECT e.order_id,
                 -sum(e.amount_paise) FILTER (WHERE a.kind = 'creator_accrued') AS accrued,
                 -sum(e.amount_paise) FILTER (WHERE a.kind = 'creator_payable') AS payable
               FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
               GROUP BY e.order_id
             ) x ON x.order_id = o.id
             WHERE coalesce(x.accrued, 0) <> CASE WHEN o.ledger_bucket = 'accrued' THEN o.ledger_amount_paise ELSE 0 END
                OR coalesce(x.payable, 0) <> CASE WHEN o.ledger_bucket = 'payable' THEN o.ledger_amount_paise ELSE 0 END
           ) m) AS mismatched`);
      const r = rows[0];
      const report: InvariantReport = {
        ok: false,
        totalSum: (r?.total ?? 0n).toString(),
        unbalancedTransactions: Number(r?.unbalanced ?? 0n),
        negativeCreatorBalances: Number(r?.negative ?? 0n),
        orderPositionMismatches: Number(r?.mismatched ?? 0n),
      };
      report.ok =
        report.totalSum === "0" && report.unbalancedTransactions === 0 && report.negativeCreatorBalances === 0 && report.orderPositionMismatches === 0;
      return report;
    },
    { isolation: "REPEATABLE READ", readOnly: true },
  );
}

export async function recordInvariantCheck(pool: Pool, report: InvariantReport): Promise<void> {
  await pool.query("INSERT INTO invariant_checks (ok, details) VALUES ($1, $2)", [report.ok, JSON.stringify(report)]);
}