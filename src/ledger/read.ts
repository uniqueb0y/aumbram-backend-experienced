/** Read models over the ledger: earnings and the per-creator entry listing. */
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";

export interface Earnings {
  creatorId: string;
  asOf: number;
  accrued: bigint;
  payable: bigint;
  reversed: bigint;
  lifetimeEarned: bigint;
  orderCounts: { accrued: number; payable: number; reversed: number };
  ledgerSequence: bigint;
}

/**
 * All figures come from ONE snapshot (REPEATABLE READ, read-only), so a poll never
 * sees half of a ledger transaction or balances from different moments.
 */
export async function getEarnings(pool: Pool, creatorId: string): Promise<Earnings> {
  return withTransaction(
    pool,
    async (tx) => {
      const perOrder = await tx.query<{ kind: string; order_id: string; total: bigint }>(
        `SELECT a.kind, e.order_id, sum(e.amount_paise) AS total
         FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
         WHERE a.creator_id = $1
         GROUP BY a.kind, e.order_id`,
        [creatorId],
      );
      const reversals = await tx.query<{ n: bigint; total: bigint }>(
        `SELECT count(*) AS n, coalesce(sum(amount_paise), 0) AS total
         FROM ledger_transactions WHERE creator_id = $1 AND type = 'reverse'`,
        [creatorId],
      );
      const meta = await tx.query<{ seq: bigint; now: Date }>("SELECT coalesce(max(id), 0) AS seq, now() AS now FROM ledger_transactions");

      let accrued = 0n;
      let payable = 0n;
      let accruedOrders = 0;
      let payableOrders = 0;
      for (const r of perOrder.rows) {
        // Creator accounts are liabilities: balance = -(sum of entries).
        const balance = -r.total;
        if (r.kind === "creator_accrued") {
          accrued += balance;
          if (balance !== 0n) accruedOrders++;
        } else if (r.kind === "creator_payable") {
          payable += balance;
          if (balance !== 0n) payableOrders++;
        }
      }
      const rev = reversals.rows[0];
      const m = meta.rows[0];
      return {
        creatorId,
        asOf: m ? m.now.getTime() : Date.now(),
        accrued,
        payable,
        reversed: rev?.total ?? 0n,
        lifetimeEarned: accrued + payable, // + paid out, once payouts exist
        orderCounts: { accrued: accruedOrders, payable: payableOrders, reversed: Number(rev?.n ?? 0n) },
        ledgerSequence: m?.seq ?? 0n,
      };
    },
    { isolation: "REPEATABLE READ", readOnly: true },
  );
}

export interface LedgerLine {
  entryId: bigint;
  transactionId: bigint;
  orderId: string;
  type: string;
  account: "accrued" | "payable";
  /** From the creator's point of view: positive = balance goes up. */
  amount: bigint;
  attributionVersion: number;
  reason: string;
  createdAt: number;
}

export async function listCreatorLedger(pool: Pool, creatorId: string, afterEntryId: bigint, limit: number): Promise<LedgerLine[]> {
  const { rows } = await pool.query<{
    id: bigint;
    transaction_id: bigint;
    order_id: string;
    type: string;
    kind: string;
    amount_paise: bigint;
    attribution_version: number;
    reason: string;
    created_at: Date;
  }>(
    `SELECT e.id, e.transaction_id, e.order_id, t.type, a.kind, e.amount_paise, t.attribution_version, t.reason, t.created_at
     FROM ledger_entries e
     JOIN ledger_accounts a ON a.id = e.account_id
     JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.creator_id = $1 AND e.id > $2
     ORDER BY e.id
     LIMIT $3`,
    [creatorId, afterEntryId.toString(), limit],
  );
  return rows.map((r) => ({
    entryId: r.id,
    transactionId: r.transaction_id,
    orderId: r.order_id,
    type: r.type,
    account: r.kind === "creator_payable" ? "payable" : "accrued",
    amount: -r.amount_paise,
    attributionVersion: r.attribution_version,
    reason: r.reason,
    createdAt: r.created_at.getTime(),
  }));
}