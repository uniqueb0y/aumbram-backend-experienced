/**
 * BE-E-14: ledger invariants under random order-event sequences that are
 * duplicated, shuffled and processed concurrently by several workers, with
 * sweeps and late (re-attributing) events interleaved.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "../../src/db/pool.js";
import { ingestEvents } from "../../src/ingest/ingestBatch.js";
import { checkInvariants } from "../../src/ledger/invariants.js";
import { getEarnings } from "../../src/ledger/read.js";
import { commissionFor } from "../../src/lib/money.js";
import { DAY, HOUR, SECOND, toIso } from "../../src/lib/time.js";
import { recordOrderEvent } from "../../src/orders/intake.js";
import { runCommissionSweep } from "../../src/orders/sweep.js";
import type { OrderStatus } from "../../src/orders/validate.js";
import { createTestPool, drain, resetDb, seedFixtures } from "../helpers/db.js";

const T = Date.parse("2026-09-13T08:00:00Z");
const RATES: Record<string, number> = { crt_0001: 300, crt_0099: 700 };

let pool: Pool;
beforeAll(() => {
  pool = createTestPool(16);
});
afterAll(async () => {
  await pool.end();
});

/** Legal lifecycle paths of the domain state machine (prefixes are generated below). */
const PATHS: OrderStatus[][] = [
  ["created", "paid", "packed", "shipped", "delivered", "return_requested", "returned"],
  ["created", "confirmed", "packed", "shipped", "delivered", "return_requested", "returned"],
  ["created", "paid", "packed", "cancelled"],
];

interface OrderPlan {
  subtotal: number;
  statuses: OrderStatus[];
}

type Step =
  | { kind: "order"; order: number; status: OrderStatus; copies: number }
  | { kind: "sweep"; afterDays: number }
  | { kind: "late"; order: number };

const orderPlanArb: fc.Arbitrary<OrderPlan> = fc
  .record({ subtotal: fc.integer({ min: 0, max: 2_000_000 }), path: fc.constantFrom(...PATHS), stop: fc.integer({ min: 1, max: 7 }) })
  .map(({ subtotal, path, stop }) => ({ subtotal, statuses: path.slice(0, Math.min(stop, path.length)) }));

const scenarioArb = fc
  .array(orderPlanArb, { minLength: 1, maxLength: 6 })
  .chain((orders) => {
    const orderSteps: Step[] = orders.flatMap((o, i) =>
      o.statuses.map((status) => ({ kind: "order" as const, order: i, status, copies: 1 })),
    );
    const extra = fc.array(
      fc.oneof(
        fc.record({ kind: fc.constant("sweep" as const), afterDays: fc.integer({ min: 0, max: 12 }) }),
        fc.record({ kind: fc.constant("late" as const), order: fc.integer({ min: 0, max: orders.length - 1 }) }),
      ),
      { maxLength: 4 },
    );
    return fc.tuple(
      fc.constant(orders),
      fc.shuffledSubarray(orderSteps, { minLength: orderSteps.length, maxLength: orderSteps.length }),
      fc.array(fc.integer({ min: 1, max: 3 }), { minLength: orderSteps.length, maxLength: orderSteps.length }),
      extra,
      fc.integer({ min: 1, max: 4 }),
    );
  })
  .map(([orders, shuffled, copies, extra, workers]) => {
    const steps: Step[] = shuffled.map((s, i) => (s.kind === "order" ? { ...s, copies: copies[i] ?? 1 } : s));
    // interleave sweeps / late events at deterministic positions
    extra.forEach((e, i) => steps.splice(Math.min(steps.length, (i * 7) % (steps.length + 1)), 0, e));
    return { orders, steps, workers };
  });

const orderId = (i: number) => `ord_p${i}`;
const userId = (i: number) => `usr_p${i}`;
const createdAt = (i: number) => T + i * SECOND;
const deliveredAt = T + DAY;

interface RunOptions {
  /** Drain after every step, events before orders: fully deterministic processing order. */
  sequential?: boolean;
  includeSweeps?: boolean;
}

async function runScenario(s: { orders: OrderPlan[]; steps: Step[]; workers: number }, opts: RunOptions = {}) {
  const includeSweeps = opts.includeSweeps ?? true;
  const drainStep = () => drain(pool, opts.sequential ? { sequential: true } : { eventConsumers: s.workers, orderConsumers: s.workers });
  // Each order's user viewed sty_0108 (crt_0001) one hour before the order.
  await ingestEvents(
    pool,
    s.orders.map((_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      userId: userId(i),
      sessionId: "s",
      name: "story_view",
      props: { storyId: "sty_0108", watchMs: 5000 },
      clientTs: toIso(createdAt(i) - HOUR),
    })),
    null,
    T,
  );
  await drain(pool);

  for (const step of s.steps) {
    if (step.kind === "order") {
      const o = s.orders[step.order];
      if (!o) continue;
      const at = step.status === "delivered" ? deliveredAt : step.status === "returned" ? T + 9 * DAY : T + 3 * DAY;
      const message = {
        orderId: orderId(step.order),
        status: step.status,
        occurredAt: at,
        order: {
          userId: userId(step.order),
          vendorId: "vnd_0024",
          lines: [{ variantId: "var_00095", quantity: 1, unitPricePaise: BigInt(o.subtotal) }],
          subtotalPaise: BigInt(o.subtotal),
          currency: "INR",
          createdAt: createdAt(step.order),
        },
      };
      await Promise.all(Array.from({ length: step.copies }, () => recordOrderEvent(pool, message)));
    } else if (step.kind === "late") {
      // A late tap by crt_0099's story that out-ranks the original view.
      await ingestEvents(
        pool,
        [
          {
            id: `00000000-0000-4000-9000-${String(step.order).padStart(12, "0")}`,
            userId: userId(step.order),
            sessionId: "s",
            name: "story_product_tap",
            props: { storyId: "sty_0200", productId: "prd_0031" },
            clientTs: toIso(createdAt(step.order) - 30 * SECOND),
          },
        ],
        null,
        T + 2 * DAY,
      );
    } else if (includeSweeps) {
      await drainStep();
      await runCommissionSweep(pool, deliveredAt + step.afterDays * DAY);
    }
    if (opts.sequential) await drainStep();
  }
  await drainStep();
}

/** Canonical ledger (ids and timestamps excluded), for replay comparison. */
async function canonicalLedger(): Promise<string[]> {
  const { rows } = await pool.query<{ k: string; code: string; amount_paise: bigint }>(
    `SELECT t.idempotency_key AS k, a.code, e.amount_paise
     FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id
     ORDER BY t.idempotency_key, a.code`,
  );
  return rows.map((r) => `${r.k}|${r.code}|${r.amount_paise}`);
}

async function assertInvariants(s: { orders: OrderPlan[] }) {
  // 1. Sum of all entries = 0 (and every transaction balances, no negative creator balance).
  const report = await checkInvariants(pool);
  expect(report).toMatchObject({ ok: true, totalSum: "0", unbalancedTransactions: 0, negativeCreatorBalances: 0 });

  // 2. Per-order net commission is 0 or exactly the expected floor-rounded amount,
  //    held by the creator of the order's current attribution.
  const { rows } = await pool.query<{ id: string; delivered_at: Date | null; returned_at: Date | null; cancelled_at: Date | null; creator_id: string | null; rate: number | null }>(
    `SELECT o.id, o.delivered_at, o.returned_at, o.cancelled_at, d.creator_id, d.commission_rate_bps AS rate
     FROM orders o JOIN attribution_decisions d ON d.order_id = o.id AND d.version = o.attribution_version`,
  );
  for (const r of rows) {
    const i = Number(r.id.slice("ord_p".length));
    const plan = s.orders[i];
    if (!plan) throw new Error(`unexpected order ${r.id}`);
    const { rows: nets } = await pool.query<{ creator_id: string; net: bigint }>(
      `SELECT a.creator_id, -sum(e.amount_paise) AS net
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       WHERE e.order_id = $1 AND a.creator_id IS NOT NULL GROUP BY a.creator_id`,
      [r.id],
    );
    const earning = r.delivered_at !== null && r.returned_at === null && r.cancelled_at === null && r.creator_id !== null;
    const expected = earning && r.creator_id ? commissionFor(BigInt(plan.subtotal), RATES[r.creator_id] ?? -1) : 0n;
    for (const n of nets) {
      expect(n.net === 0n || n.net === expected).toBe(true);
      expect(n.net).toBe(n.creator_id === r.creator_id ? expected : 0n);
    }
    if (expected > 0n) expect(nets.some((n) => n.creator_id === r.creator_id)).toBe(true);
  }

  // 3. Earnings = sum of entries per account.
  for (const creatorId of Object.keys(RATES)) {
    const e = await getEarnings(pool, creatorId);
    const { rows: sums } = await pool.query<{ kind: string; total: bigint }>(
      `SELECT a.kind, coalesce(-sum(e.amount_paise), 0) AS total FROM ledger_accounts a
       LEFT JOIN ledger_entries e ON e.account_id = a.id WHERE a.creator_id = $1 GROUP BY a.kind`,
      [creatorId],
    );
    const byKind = new Map(sums.map((x) => [x.kind, x.total]));
    expect(e.accrued).toBe(byKind.get("creator_accrued") ?? 0n);
    expect(e.payable).toBe(byKind.get("creator_payable") ?? 0n);
    expect(e.payable >= 0n && e.accrued >= 0n).toBe(true);
  }
}

describe("ledger invariants (property-based)", () => {
  it("hold for random duplicated, shuffled order events processed concurrently by several workers", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await resetDb(pool);
        await seedFixtures(pool);
        await runScenario(scenario);
        await assertInvariants(scenario);

        // Re-delivering every message (retries, duplicate webhooks) changes nothing.
        const before = await canonicalLedger();
        await runScenario(scenario, { includeSweeps: false });
        expect(await canonicalLedger()).toEqual(before);
        await assertInvariants(scenario);
      }),
      { numRuns: 40 },
    );
  });

  it("replaying the same input on a fresh database produces an identical ledger", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await resetDb(pool);
        await seedFixtures(pool);
        await runScenario(scenario, { sequential: true });
        const first = await canonicalLedger();
        await assertInvariants(scenario);

        await resetDb(pool);
        await seedFixtures(pool);
        await runScenario(scenario, { sequential: true });
        expect(await canonicalLedger()).toEqual(first);
      }),
      { numRuns: 25 },
    );
  });
});

describe("ledger guarantees enforced by the database", () => {
  it("rejects UPDATE/DELETE of entries and unbalanced transactions", async () => {
    await resetDb(pool);
    await seedFixtures(pool);
    // A header without entries is itself unbalanced, so this autocommit insert must fail at commit.
    await expect(
      pool.query(
        "INSERT INTO ledger_transactions (idempotency_key, type, order_id, creator_id, amount_paise, attribution_version, reason) VALUES ('k1','accrue','o','crt_0001',100,1,'test')",
      ),
    ).rejects.toThrow(/unbalanced/);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const t = await client.query<{ id: bigint }>(
        "INSERT INTO ledger_transactions (idempotency_key, type, order_id, creator_id, amount_paise, attribution_version, reason) VALUES ('k2','accrue','o','crt_0001',100,1,'test') RETURNING id",
      );
      const acct = await client.query<{ id: bigint }>("SELECT id FROM ledger_accounts ORDER BY id LIMIT 2");
      await client.query("INSERT INTO ledger_entries (transaction_id, account_id, order_id, amount_paise) VALUES ($1, $2, 'o', 100), ($1, $3, 'o', -99)", [
        t.rows[0]?.id.toString(),
        acct.rows[0]?.id.toString(),
        acct.rows[1]?.id.toString(),
      ]);
      await expect(client.query("COMMIT")).rejects.toThrow(/unbalanced/);
    } finally {
      client.release();
    }

    await runScenario({ orders: [{ subtotal: 100000, statuses: ["created", "delivered"] }], steps: [
      { kind: "order", order: 0, status: "created", copies: 1 },
      { kind: "order", order: 0, status: "delivered", copies: 1 },
    ], workers: 1 });
    await expect(pool.query("UPDATE ledger_entries SET amount_paise = amount_paise * 2")).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM ledger_transactions")).rejects.toThrow(/append-only/);
    await expect(pool.query("TRUNCATE ledger_entries CASCADE")).rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE attribution_decisions SET creator_id = 'crt_0099'")).rejects.toThrow(/append-only/);
  });

  it("rounds with integer floor division: 99999 at 700 bps -> 6999", async () => {
    await resetDb(pool);
    await seedFixtures(pool);
    await pool.query("UPDATE creators SET commission_rate_bps = 700 WHERE id = 'crt_0001'");
    await runScenario({ orders: [{ subtotal: 99999, statuses: ["created", "delivered"] }], steps: [
      { kind: "order", order: 0, status: "created", copies: 1 },
      { kind: "order", order: 0, status: "delivered", copies: 2 },
    ], workers: 2 });
    const e = await getEarnings(pool, "crt_0001");
    expect(e.accrued).toBe(6999n);
  });
});