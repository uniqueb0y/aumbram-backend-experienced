/** BE-E-21: historical CSV import (trusting server_ts) and idempotent re-attribution over a range. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "../../src/db/pool.js";
import { recordOrderEvent } from "../../src/orders/intake.js";
import { HOUR } from "../../src/lib/time.js";
import { backfillEventsCsv } from "../../src/tools/backfill.js";
import { CSV_HEADER } from "../../src/tools/csv.js";
import { reattributeRange } from "../../src/tools/reattribute.js";
import { count, createTestPool, drain, resetDb, rule, seedFixtures } from "../helpers/db.js";

let pool: Pool;
beforeAll(() => {
  pool = createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  await seedFixtures(pool);
});

const T = Date.parse("2026-08-10T12:00:00Z");
const row = (id: string, name: string, props: Record<string, unknown>, clientTs: string, serverTs: string, userId = "usr_H") =>
  [id, userId, "sess-h", name, `"${JSON.stringify(props).replace(/"/g, '""')}"`, clientTs, serverTs, "android", '"Redmi Note 12"', "4g"].join(",");

function writeCsv(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "aumbram-csv-"));
  const file = join(dir, "events.csv");
  writeFileSync(file, [CSV_HEADER, ...lines].join("\n") + "\n");
  return file;
}

describe("backfill-events", () => {
  it("imports trusting server_ts (no section 3.3 derivation), dedupes, and is idempotent", async () => {
    const viewId = "11111111-1111-4111-8111-111111111111";
    const file = writeCsv([
      // client clock is 6 h off; historical mode must keep server_ts as-is
      row(viewId, "story_view", { storyId: "sty_0108", watchMs: 5000 }, "2026-08-10T16:00:00Z", "2026-08-10T10:00:00Z"),
      row(viewId, "story_view", { storyId: "sty_0108", watchMs: 5000 }, "2026-08-10T16:00:00Z", "2026-08-10T10:00:00Z"), // duplicate row
      row("22222222-2222-4222-8222-222222222222", "checkout_start", {}, "2026-08-10T11:59:00Z", "2026-08-10T11:59:00Z"),
      row("not-a-uuid", "story_view", { storyId: "sty_0108", watchMs: 5000 }, "2026-08-10T11:00:00Z", "2026-08-10T11:00:00Z"),
    ]);
    expect(await backfillEventsCsv(pool, file)).toEqual({ rows: 4, inserted: 2, duplicates: 1, rejected: 1 });
    const { rows } = await pool.query<{ server_ts: Date; source: string }>("SELECT server_ts, source FROM events WHERE id = $1", [viewId]);
    expect(rows[0]?.server_ts.toISOString()).toBe("2026-08-10T10:00:00.000Z");
    expect(rows[0]?.source).toBe("backfill");

    expect(await backfillEventsCsv(pool, file)).toEqual({ rows: 4, inserted: 0, duplicates: 3, rejected: 1 });
    await drain(pool);
    expect(await count(pool, "SELECT count(*) AS n FROM interactions")).toBe(1);
  });
});

describe("reattribute", () => {
  it("re-runs attribution for a created_at range; only changed outcomes get a new version; re-running is a no-op", async () => {
    await recordOrderEvent(pool, {
      orderId: "ord_H",
      status: "created",
      occurredAt: T,
      order: { userId: "usr_H", vendorId: "vnd_0024", lines: [{ variantId: "var_00095", quantity: 1, unitPricePaise: 100000n }], subtotalPaise: 100000n, currency: "INR", createdAt: T },
    });
    await drain(pool);
    expect(await reattributeRange(pool, T - HOUR, T + HOUR, rule)).toEqual({ examined: 1, changed: 0, unchanged: 1, lateLocked: 0 });

    // An interaction lands in the index without going through the consumer (e.g. a repaired import).
    await pool.query(
      `INSERT INTO interactions (event_id, user_id, name, server_ts, received_at, story_id, watch_ms)
       VALUES ('33333333-3333-4333-8333-333333333333', 'usr_H', 'story_view', $1, $1, 'sty_0108', 4000)`,
      [new Date(T - HOUR).toISOString()],
    );
    expect(await reattributeRange(pool, T - HOUR, T + HOUR, rule)).toEqual({ examined: 1, changed: 1, unchanged: 0, lateLocked: 0 });
    expect(await reattributeRange(pool, T - HOUR, T + HOUR, rule)).toEqual({ examined: 1, changed: 0, unchanged: 1, lateLocked: 0 });
    const { rows } = await pool.query<{ version: number; creator_id: string | null; reason: string }>(
      "SELECT version, creator_id, reason FROM attribution_decisions WHERE order_id = 'ord_H' ORDER BY version",
    );
    expect(rows).toEqual([
      { version: 1, creator_id: null, reason: "initial" },
      { version: 2, creator_id: "crt_0001", reason: "reattribution_job" },
    ]);
  });
});