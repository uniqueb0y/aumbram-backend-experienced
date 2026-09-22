import { pino } from "pino";
import { consumeEventsSafely } from "../../src/consumers/eventConsumer.js";
import { consumeOneOrderEvent } from "../../src/consumers/orderEventConsumer.js";
import { getRule, type RuleParams } from "../../src/attribution/ruleConfig.js";
import { createPool, type Pool } from "../../src/db/pool.js";
import { ensureCreatorAccounts } from "../../src/ledger/posting.js";
import type { Logger } from "../../src/lib/logger.js";
import { TEST_DB_URL } from "./env.js";

export const silentLogger: Logger = pino({ level: "silent" });
export const rule: RuleParams = getRule("v1");

export function createTestPool(max = 12): Pool {
  return createPool(TEST_DB_URL, max, "aumbram-test");
}

const TABLES = [
  "ledger_entries",
  "ledger_transactions",
  "ledger_accounts",
  "late_locked_events",
  "attribution_decisions",
  "orders",
  "order_event_dead_letters",
  "order_event_queue",
  "order_events",
  "checkouts",
  "interactions",
  "event_dead_letters",
  "event_queue",
  "events",
  "invariant_checks",
  "stories",
  "variants",
  "products",
  "creators",
];

/** Empties every table. Append-only tables need the explicit test-only opt-in. */
export async function resetDb(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL aumbram.allow_truncate = 'on'");
    await client.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    await client.query("INSERT INTO ledger_accounts (code, kind) VALUES ('platform:commission_expense', 'platform_commission_expense')");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface ReferenceFixtures {
  creators: Array<{ id: string; rateBps: number }>;
  products: Array<{ id: string; vendorId: string; variants: string[] }>;
  stories: Array<{ id: string; creatorId: string; tags: string[] }>;
}

/**
 * Hand-written reference data (the generator does not link events to orders).
 * Names follow the assignment's AC-2 wording.
 */
export const FIXTURES: ReferenceFixtures = {
  creators: [
    { id: "crt_0001", rateBps: 300 },
    { id: "crt_0015", rateBps: 500 },
    { id: "crt_0099", rateBps: 700 },
    { id: "crt_0100", rateBps: 1000 },
  ],
  products: [
    { id: "prd_0031", vendorId: "vnd_0024", variants: ["var_00095"] },
    { id: "prd_0032", vendorId: "vnd_0024", variants: ["var_00096"] },
    { id: "prd_0006", vendorId: "vnd_0016", variants: ["var_00010"] },
  ],
  stories: [
    { id: "sty_0108", creatorId: "crt_0001", tags: ["prd_0031"] },
    { id: "sty_0109", creatorId: "crt_0015", tags: ["prd_0006"] },
    { id: "sty_0200", creatorId: "crt_0099", tags: ["prd_0031"] },
    { id: "sty_0300", creatorId: "crt_0099", tags: ["prd_0032"] },
    { id: "sty_0400", creatorId: "crt_0100", tags: [] },
  ],
};

export async function seedFixtures(pool: Pool, fixtures: ReferenceFixtures = FIXTURES): Promise<void> {
  for (const c of fixtures.creators) {
    await pool.query("INSERT INTO creators (id, commission_rate_bps) VALUES ($1, $2)", [c.id, c.rateBps]);
    await ensureCreatorAccounts(pool, c.id);
  }
  for (const p of fixtures.products) {
    await pool.query("INSERT INTO products (id, vendor_id) VALUES ($1, $2)", [p.id, p.vendorId]);
    for (const v of p.variants) await pool.query("INSERT INTO variants (id, product_id) VALUES ($1, $2)", [v, p.id]);
  }
  for (const s of fixtures.stories) {
    await pool.query("INSERT INTO stories (id, creator_id, tagged_product_ids) VALUES ($1, $2, $3)", [s.id, s.creatorId, s.tags]);
  }
}

/**
 * Runs the real consumers (several concurrently if asked) until both queues are
 * empty: the synchronous equivalent of letting the worker catch up.
 */
export async function drain(pool: Pool, opts: { eventConsumers?: number; orderConsumers?: number; sequential?: boolean } = {}): Promise<void> {
  const eventDeps = { pool, rule, log: silentLogger, batchSize: 500 };
  const orderDeps = { pool, rule, log: silentLogger };
  for (;;) {
    if (opts.sequential) {
      // Deterministic order: all events first, then all order messages.
      while ((await consumeEventsSafely(eventDeps)) > 0);
      while (await consumeOneOrderEvent(orderDeps));
    }
    const events = Array.from({ length: opts.sequential ? 0 : (opts.eventConsumers ?? 1) }, async () => {
      while ((await consumeEventsSafely(eventDeps)) > 0);
    });
    const orders = Array.from({ length: opts.sequential ? 0 : (opts.orderConsumers ?? 1) }, async () => {
      while (await consumeOneOrderEvent(orderDeps));
    });
    if (!opts.sequential) await Promise.all([...events, ...orders]);
    const { rows } = await pool.query<{ n: bigint }>("SELECT (SELECT count(*) FROM event_queue) + (SELECT count(*) FROM order_event_queue) AS n");
    if ((rows[0]?.n ?? 0n) === 0n) return;
  }
}

export async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: bigint }>(sql, params);
  return Number(rows[0]?.n ?? 0n);
}