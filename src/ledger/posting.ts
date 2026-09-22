/**
 * The only code that writes to the ledger. Each planned posting becomes one
 * ledger transaction with two entries that sum to zero (debit +, credit -).
 */
import type { Queryable } from "../db/pool.js";
import { ledgerPostings } from "../metrics.js";
import type { Bucket, PlannedPosting } from "./plan.js";

export const PLATFORM_EXPENSE_CODE = "platform:commission_expense";

type AccountKind = "platform_commission_expense" | "creator_accrued" | "creator_payable";

export function creatorAccountCode(creatorId: string, bucket: Bucket): string {
  return `creator:${creatorId}:${bucket}`;
}

async function ensureAccount(tx: Queryable, code: string, kind: AccountKind, creatorId: string | null): Promise<string> {
  const inserted = await tx.query<{ id: bigint }>(
    `INSERT INTO ledger_accounts (code, kind, creator_id) VALUES ($1, $2, $3)
     ON CONFLICT (code) DO NOTHING RETURNING id`,
    [code, kind, creatorId],
  );
  if (inserted.rows[0]) return inserted.rows[0].id.toString();
  // Already exists (possibly created by a concurrent transaction that has now committed).
  const existing = await tx.query<{ id: bigint }>("SELECT id FROM ledger_accounts WHERE code = $1", [code]);
  if (!existing.rows[0]) throw new Error(`ledger account ${code} missing`);
  return existing.rows[0].id.toString();
}

export async function ensureCreatorAccounts(tx: Queryable, creatorId: string): Promise<{ accrued: string; payable: string }> {
  return {
    accrued: await ensureAccount(tx, creatorAccountCode(creatorId, "accrued"), "creator_accrued", creatorId),
    payable: await ensureAccount(tx, creatorAccountCode(creatorId, "payable"), "creator_payable", creatorId),
  };
}

/** Entries for one posting, as [accountId, signed amount] pairs. */
async function entriesFor(tx: Queryable, p: PlannedPosting): Promise<Array<[string, bigint]>> {
  const expense = await ensureAccount(tx, PLATFORM_EXPENSE_CODE, "platform_commission_expense", null);
  const creator = await ensureCreatorAccounts(tx, p.creatorId);
  switch (p.type) {
    case "accrue":
      return [
        [expense, p.amount],
        [creator.accrued, -p.amount],
      ];
    case "make_payable":
      return [
        [creator.accrued, p.amount],
        [creator.payable, -p.amount],
      ];
    case "reverse": {
      const from = p.fromBucket === "payable" ? creator.payable : creator.accrued;
      return [
        [from, p.amount],
        [expense, -p.amount],
      ];
    }
  }
}

/**
 * Posts each planned transaction. The UNIQUE idempotency key makes a repeat of
 * the same business effect a no-op (returns false for that posting).
 */
export async function applyPostings(tx: Queryable, postings: readonly PlannedPosting[], reason: string): Promise<number> {
  let posted = 0;
  for (const p of postings) {
    const header = await tx.query<{ id: bigint }>(
      `INSERT INTO ledger_transactions (idempotency_key, type, order_id, creator_id, amount_paise, attribution_version, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [p.idempotencyKey, p.type, p.orderId, p.creatorId, p.amount.toString(), p.attributionVersion, reason],
    );
    const txnId = header.rows[0]?.id;
    if (txnId === undefined) continue; // this effect was already posted
    const entries = await entriesFor(tx, p);
    const values: string[] = [];
    const params: unknown[] = [txnId.toString(), p.orderId];
    for (const [accountId, amount] of entries) {
      params.push(accountId, amount.toString());
      values.push(`($1, $${params.length - 1}, $2, $${params.length})`);
    }
    await tx.query(`INSERT INTO ledger_entries (transaction_id, account_id, order_id, amount_paise) VALUES ${values.join(", ")}`, params);
    ledgerPostings.inc({ type: p.type });
    posted++;
  }
  return posted;
}