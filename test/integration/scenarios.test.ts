/**
 * Acceptance criteria AC-2..AC-7 end to end: HTTP API -> queues -> real
 * consumers -> Postgres. Time is controlled with a fixed clock (ingest
 * receivedAt) and explicit `asOf` for the sweep.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "../../src/db/pool.js";
import { checkInvariants } from "../../src/ledger/invariants.js";
import { DAY, fixedClock, HOUR, MINUTE, SECOND } from "../../src/lib/time.js";
import { makeApp } from "../helpers/app.js";
import { checkout, getJson, sendBatch, sendOrderEvent, sweep, tap, view, type OrderSpec } from "../helpers/builders.js";
import { count, createTestPool, drain, resetDb, seedFixtures } from "../helpers/db.js";

const T = Date.parse("2026-09-13T08:39:10Z"); // checkout_start (the anchor)
const CREATED = T + 50 * SECOND;
const ORDER_A: OrderSpec = { orderId: "ord_A", vendorId: "vnd_0024", variantId: "var_00095", subtotal: 259800, createdAt: CREATED };
const ORDER_B: OrderSpec = { orderId: "ord_B", vendorId: "vnd_0016", variantId: "var_00010", subtotal: 100000, createdAt: CREATED };

let pool: Pool;
let app: FastifyInstance;
const clock = fixedClock(T);

beforeAll(async () => {
  pool = createTestPool(16);
  app = (await makeApp(pool, { clock })).app;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  await seedFixtures(pool);
  clock.set(T);
});

/** Sends a batch from a phone with an accurate clock, received at `receivedAt` (serverTs = clientTs). */
async function phoneBatch(events: unknown[], receivedAt: number) {
  clock.set(receivedAt);
  const res = await sendBatch(app, events, receivedAt);
  expect(res.status).toBe(202);
  await drain(pool);
  return res;
}

async function orderEvent(o: OrderSpec, status: string, at: number) {
  await sendOrderEvent(app, o, status, at);
  await drain(pool);
}

async function attribution(orderId: string) {
  const res = await getJson(app, `/v1/orders/${orderId}/attribution?history=true`);
  expect(res.status).toBe(200);
  return res.body as {
    attributed: boolean;
    storyId: string | null;
    creatorId: string | null;
    qualifyingEvent: { id: string; name: string; serverTs: string } | null;
    anchor: { source: string; at: string };
    commission: { amount: number } | null;
    commissionRateBps: number | null;
    version: number;
    locked: boolean;
    history: Array<{ version: number; creatorId: string | null; reason: string; triggerEventId: string | null }>;
    lateLockedEvents: Array<{ wouldBeCreatorId: string | null; triggerEventId: string | null }>;
  };
}

async function earnings(creatorId: string) {
  const res = await getJson(app, `/v1/creators/${creatorId}/earnings`);
  expect(res.status).toBe(200);
  return res.body as {
    accrued: { amount: number };
    payable: { amount: number };
    reversed: { amount: number };
    lifetimeEarned: { amount: number };
    orderCounts: { accrued: number; payable: number; reversed: number };
    ledgerSequence: number;
  };
}

async function ledgerFor(orderId: string) {
  const { rows } = await pool.query<{ type: string; creator_id: string; amount_paise: bigint }>(
    "SELECT type, creator_id, amount_paise FROM ledger_transactions WHERE order_id = $1 ORDER BY id",
    [orderId],
  );
  return rows.map((r) => `${r.type}:${r.creator_id}:${r.amount_paise}`);
}

async function expectLedgerHealthy() {
  const report = await checkInvariants(pool);
  expect(report).toMatchObject({ ok: true, totalSum: "0" });
}

// AC-2 setup: v50 = qualifying view at T-50h, a tap for another vendor's product at T-10h,
// a too-short view at T-1h, the checkout at T; then one checkout -> two vendor orders.
const V50 = view("sty_0108", 4200, T - 50 * HOUR);
const TAP10 = tap("sty_0109", "prd_0006", T - 10 * HOUR);
async function ac2() {
  await phoneBatch([V50, TAP10, view("sty_0108", 1500, T - HOUR), checkout(T)], T + 20 * SECOND);
  await orderEvent(ORDER_A, "created", CREATED);
  await orderEvent(ORDER_B, "created", CREATED);
}

/** A late offline batch: tap on prd_0031 in sty_0200 (crt_0099), corrected serverTs T-2h. */
const lateTap = () => tap("sty_0200", "prd_0031", T - 2 * HOUR);

describe("AC-2: last qualifying interaction", () => {
  it("attributes each order of the checkout independently and explains winner and anchor", async () => {
    await ac2();
    const a = await attribution("ord_A");
    expect(a).toMatchObject({
      attributed: true,
      storyId: "sty_0108",
      creatorId: "crt_0001",
      qualifyingEvent: { id: V50.id, name: "story_view" },
      anchor: { source: "checkout_start", at: "2026-09-13T08:39:10Z" },
      commissionRateBps: 300,
      commission: { amount: 7794 },
      version: 1,
      locked: false,
    });
    const b = await attribution("ord_B");
    expect(b).toMatchObject({ storyId: "sty_0109", creatorId: "crt_0015", qualifyingEvent: { id: TAP10.id }, commission: { amount: 5000 } });
  });

  it("falls back to order.createdAt as the anchor when there is no checkout_start", async () => {
    await phoneBatch([view("sty_0108", 4200, T - HOUR)], T);
    await orderEvent(ORDER_A, "created", CREATED);
    expect((await attribution("ord_A")).anchor).toEqual({ source: "order_created", at: "2026-09-13T08:40:00Z" });
  });
});

describe("AC-3: late event while provisional", () => {
  it("creates attribution version 2 for the new creator; after delivery only the new creator accrues", async () => {
    await ac2();
    const late = lateTap();
    await phoneBatch([late], T + 5 * HOUR); // offline phone, uploads 5 h later

    const a = await attribution("ord_A");
    expect(a).toMatchObject({ version: 2, creatorId: "crt_0099", storyId: "sty_0200", qualifyingEvent: { id: late.id }, commission: { amount: 18186 } });
    expect(a.history.map((h) => [h.version, h.creatorId, h.reason])).toEqual([
      [1, "crt_0001", "initial"],
      [2, "crt_0099", "late_event"],
    ]);
    expect(a.history[1]?.triggerEventId).toBe(late.id);

    await orderEvent(ORDER_A, "delivered", T + 2 * DAY);
    expect(await ledgerFor("ord_A")).toEqual(["accrue:crt_0099:18186"]);
    expect((await earnings("crt_0099")).accrued.amount).toBe(18186);
    expect((await earnings("crt_0001")).accrued.amount).toBe(0);
    await expectLedgerHealthy();
  });
});

describe("AC-4: late event after accrual, before payable", () => {
  it("posts X accrue -> X reverse -> Y accrue, sums to zero, and restores X's accrued balance", async () => {
    await ac2();
    const before = await earnings("crt_0001");
    await orderEvent(ORDER_A, "delivered", T + 2 * DAY);
    expect((await earnings("crt_0001")).accrued.amount).toBe(before.accrued.amount + 7794);

    await phoneBatch([lateTap()], T + 3 * DAY);
    expect(await ledgerFor("ord_A")).toEqual(["accrue:crt_0001:7794", "reverse:crt_0001:7794", "accrue:crt_0099:18186"]);
    const x = await earnings("crt_0001");
    expect(x.accrued.amount).toBe(before.accrued.amount);
    expect(x.reversed.amount).toBe(7794);
    expect((await earnings("crt_0099")).accrued.amount).toBe(18186);
    await expectLedgerHealthy();
  });
});

describe("AC-5: late event after payable", () => {
  it("leaves attribution and ledger unchanged and records a late-locked event", async () => {
    await ac2();
    const D = T + 2 * DAY;
    await orderEvent(ORDER_A, "delivered", D);
    expect((await sweep(app, D + 7 * DAY - SECOND)).madePayable).toBe(0); // one second early
    expect((await sweep(app, D + 7 * DAY)).madePayable).toBe(1); // exactly deliveredAt + 7 d
    expect((await earnings("crt_0001")).payable.amount).toBe(7794);
    const ledgerBefore = await ledgerFor("ord_A");

    const late = lateTap();
    await phoneBatch([late], D + 8 * DAY);

    const a = await attribution("ord_A");
    expect(a).toMatchObject({ version: 1, creatorId: "crt_0001", locked: true });
    expect(a.lateLockedEvents).toEqual([expect.objectContaining({ wouldBeCreatorId: "crt_0099", triggerEventId: late.id })]);
    expect(await ledgerFor("ord_A")).toEqual(ledgerBefore);
    expect(await count(pool, "SELECT count(*) AS n FROM late_locked_events")).toBe(1);

    // Re-processing is idempotent: the same late event does not add a second audit record.
    await phoneBatch([late], D + 9 * DAY);
    expect(await count(pool, "SELECT count(*) AS n FROM late_locked_events")).toBe(1);
    await expectLedgerHealthy();
  });
});

describe("AC-6: return", () => {
  it("never becomes payable once a return is requested, and reverses exactly once", async () => {
    await ac2();
    const D = T + 2 * DAY;
    await orderEvent(ORDER_A, "delivered", D);
    for (let day = 1; day <= 10; day++) {
      if (day === 7) await orderEvent(ORDER_A, "return_requested", D + 6 * DAY + 23 * HOUR);
      if (day === 9) {
        // `returned` delivered three times, concurrently
        await Promise.all([1, 2, 3].map(() => sendOrderEvent(app, ORDER_A, "returned", D + 9 * DAY)));
        await drain(pool, { orderConsumers: 3 });
      }
      await sweep(app, D + day * DAY);
      expect((await earnings("crt_0001")).payable.amount).toBe(0);
    }
    expect(await ledgerFor("ord_A")).toEqual(["accrue:crt_0001:7794", "reverse:crt_0001:7794"]);
    const e = await earnings("crt_0001");
    expect(e).toMatchObject({ accrued: { amount: 0 }, payable: { amount: 0 }, reversed: { amount: 7794 }, orderCounts: { reversed: 1 } });
    await expectLedgerHealthy();
  });
});

describe("AC-7: concurrent earnings", () => {
  it("every poll is internally consistent while 200 orders are delivered twice across workers", async () => {
    const commission = 2999; // floor(99999 * 300 / 10000)
    await phoneBatch([view("sty_0108", 4000, T - HOUR), checkout(T)], T + SECOND);
    const orders: OrderSpec[] = Array.from({ length: 200 }, (_, i) => ({
      orderId: `ord_${String(i).padStart(4, "0")}`,
      vendorId: "vnd_0024",
      variantId: "var_00095",
      subtotal: 99999,
      createdAt: T + (i + 1) * SECOND,
    }));
    for (const o of orders) await sendOrderEvent(app, o, "created", o.createdAt);
    await drain(pool, { orderConsumers: 4 });

    // Each delivered message sent twice, concurrently.
    await Promise.all(orders.flatMap((o) => [sendOrderEvent(app, o, "delivered", T + DAY), sendOrderEvent(app, o, "delivered", T + DAY)]));

    let done = false;
    const polls: Array<Awaited<ReturnType<typeof earnings>>> = [];
    const poller = (async () => {
      while (!done) polls.push(await earnings("crt_0001"));
    })();
    await drain(pool, { orderConsumers: 4 });
    done = true;
    await poller;
    polls.push(await earnings("crt_0001"));

    expect(polls.length).toBeGreaterThan(2);
    let previous = -1;
    for (const p of polls) {
      expect(p.accrued.amount).toBe(p.orderCounts.accrued * commission); // never a half-applied transaction
      expect(p.lifetimeEarned.amount).toBe(p.accrued.amount + p.payable.amount);
      expect(p.accrued.amount).toBeGreaterThanOrEqual(previous);
      previous = p.accrued.amount;
    }
    const last = polls[polls.length - 1];
    expect(last?.accrued.amount).toBe(200 * commission);
    expect(await count(pool, "SELECT count(*) AS n FROM ledger_transactions WHERE type = 'accrue'")).toBe(200);
    await expectLedgerHealthy();
  });
});

describe("order lifecycle robustness", () => {
  it("handles `delivered` before `created` (out of order) and duplicates", async () => {
    await ac2();
    const C: OrderSpec = { ...ORDER_A, orderId: "ord_C" };
    await orderEvent(C, "delivered", T + DAY);
    await orderEvent(C, "delivered", T + DAY);
    await orderEvent(C, "created", CREATED);
    expect(await ledgerFor("ord_C")).toEqual(["accrue:crt_0001:7794"]);
    expect((await attribution("ord_C")).version).toBe(1);
  });

  it("never accrues when `returned` arrives before `delivered`", async () => {
    await ac2();
    await orderEvent(ORDER_A, "returned", T + 5 * DAY);
    await orderEvent(ORDER_A, "delivered", T + 2 * DAY);
    expect(await ledgerFor("ord_A")).toEqual([]);
    expect((await attribution("ord_A")).locked).toBe(true);
  });

  it("a later checkout that moves the anchor can un-attribute an order, reversing its accrual", async () => {
    // No checkout yet: anchor = createdAt, and a view 10 min before createdAt qualifies.
    await phoneBatch([view("sty_0108", 5000, CREATED - 10 * MINUTE)], CREATED);
    await orderEvent(ORDER_A, "created", CREATED);
    await orderEvent(ORDER_A, "delivered", T + DAY);
    expect(await ledgerFor("ord_A")).toEqual(["accrue:crt_0001:7794"]);

    // A delayed checkout_start 30 min before createdAt becomes the anchor; the view is now after it.
    await phoneBatch([checkout(CREATED - 30 * MINUTE)], T + 2 * DAY);
    const a = await attribution("ord_A");
    expect(a).toMatchObject({ version: 2, attributed: false, anchor: { source: "checkout_start" } });
    expect(await ledgerFor("ord_A")).toEqual(["accrue:crt_0001:7794", "reverse:crt_0001:7794"]);
    await expectLedgerHealthy();
  });

  it("snapshots the commission rate at the first attribution to a creator", async () => {
    await ac2(); // v1: crt_0001 at 300 bps
    await pool.query("UPDATE creators SET commission_rate_bps = 1000 WHERE id = 'crt_0001'");
    await phoneBatch([lateTap()], T + HOUR); // v2: crt_0099
    await phoneBatch([tap("sty_0108", "prd_0031", T - HOUR)], T + 2 * HOUR); // v3: back to crt_0001
    const a = await attribution("ord_A");
    expect(a).toMatchObject({ version: 3, creatorId: "crt_0001", commissionRateBps: 300, commission: { amount: 7794 } });
  });

  it("returns 404 for unknown orders and creators", async () => {
    expect((await getJson(app, "/v1/orders/ord_nope/attribution")).status).toBe(404);
    expect((await getJson(app, "/v1/creators/crt_nope/earnings")).status).toBe(404);
  });
});

describe("creator ledger listing (BE-E-20)", () => {
  it("pages through every entry with a cursor, line by line", async () => {
    await ac2();
    await orderEvent(ORDER_A, "delivered", T + 2 * DAY);
    await phoneBatch([lateTap()], T + 3 * DAY); // accrue, reverse for crt_0001
    const page1 = await getJson(app, "/v1/creators/crt_0001/ledger?limit=1");
    expect(page1.body).toMatchObject({ items: [{ orderId: "ord_A", type: "accrue", account: "accrued", amount: { amount: 7794 } }] });
    const cursor = page1.body.nextCursor as string;
    const page2 = await getJson(app, `/v1/creators/crt_0001/ledger?limit=10&cursor=${cursor}`);
    expect(page2.body).toMatchObject({ items: [{ type: "reverse", amount: { amount: -7794 } }], nextCursor: null });
    expect((await getJson(app, "/v1/creators/crt_0001/ledger?cursor=garbage")).status).toBe(400);
  });
});