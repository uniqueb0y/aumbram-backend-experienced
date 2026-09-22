/** Part A: ingestion over HTTP against real Postgres. */
import { gzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "../../src/db/pool.js";
import { fixedClock, MINUTE, toIso } from "../../src/lib/time.js";
import { appHeaders, internalHeaders, makeApp, type TestApp } from "../helpers/app.js";
import { event, sendBatch, uuid, view } from "../helpers/builders.js";
import { count, createTestPool, drain, resetDb, seedFixtures } from "../helpers/db.js";

let pool: Pool;
let t: TestApp;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createTestPool();
  t = await makeApp(pool);
  app = t.app;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  await seedFixtures(pool);
});

const NOW = Date.now();

describe("POST /v1/events/batch", () => {
  it("accepts valid events and lists invalid ones (partial acceptance)", async () => {
    const events = [view("sty_0108", 4000, NOW), { ...view("sty_0108", 4000, NOW), id: "bad" }, event({ name: "checkout_start", clientTs: NOW }), { name: "nope" }];
    const res = await sendBatch(app, events, NOW);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: 2, duplicates: 0 });
    expect(res.body.rejected).toEqual([
      { index: 1, id: "bad", code: "INVALID_ID", message: expect.any(String) },
      { index: 3, id: null, code: "INVALID_ID", message: expect.any(String) },
    ]);
    expect(await count(pool, "SELECT count(*) AS n FROM events")).toBe(2);
    expect(await count(pool, "SELECT count(*) AS n FROM event_queue")).toBe(2);
  });

  it("treats evt_<uuid> and <uuid> as the same event", async () => {
    const id = uuid();
    const first = await sendBatch(app, [view("sty_0108", 4000, NOW, { id: `evt_${id}` })], NOW);
    const second = await sendBatch(app, [view("sty_0108", 4000, NOW, { id: id.toUpperCase() })], NOW);
    expect(first.body).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(second.body).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(await count(pool, "SELECT count(*) AS n FROM events")).toBe(1);
  });

  it("AC-1: 100 events with 2 internal duplicates, sent 3x concurrently -> exactly 98 stored and processed", async () => {
    const events = Array.from({ length: 98 }, (_, i) => view("sty_0108", 3000 + i, NOW - i * MINUTE, { userId: `usr_${i % 7}` }));
    const batch = [...events, events[3], events[40]]; // 100 events, 2 internal duplicates
    const results = await Promise.all([sendBatch(app, batch, NOW), sendBatch(app, batch, NOW), sendBatch(app, batch, NOW)]);
    expect(results.map((r) => r.status)).toEqual([202, 202, 202]);
    const totalAccepted = results.reduce((s, r) => s + Number(r.body.accepted), 0);
    expect(totalAccepted).toBe(98);
    expect(results.every((r) => Number(r.body.accepted) + Number(r.body.duplicates) === 100)).toBe(true);

    await drain(pool, { eventConsumers: 3 });
    expect(await count(pool, "SELECT count(*) AS n FROM events")).toBe(98);
    expect(await count(pool, "SELECT count(*) AS n FROM interactions")).toBe(98);
    expect(await count(pool, "SELECT count(*) AS n FROM event_queue")).toBe(0);
  });

  it("stores clientTs, receivedAt and the derived serverTs (section 3.3 example)", async () => {
    const clock = fixedClock(Date.parse("2026-09-13T08:35:12Z"));
    const skewed = await makeApp(pool, { clock });
    try {
      const e = view("sty_0108", 4200, Date.parse("2026-09-13T14:04:31Z"));
      const res = await sendBatch(skewed.app, [e], Date.parse("2026-09-13T14:05:09Z"));
      expect(res.body.receivedAt).toBe("2026-09-13T08:35:12Z");
      const { rows } = await pool.query<{ client_ts: Date; received_at: Date; server_ts: Date }>("SELECT client_ts, received_at, server_ts FROM events");
      expect(rows[0]?.client_ts.toISOString()).toBe("2026-09-13T14:04:31.000Z");
      expect(rows[0]?.received_at.toISOString()).toBe("2026-09-13T08:35:12.000Z");
      expect(rows[0]?.server_ts.toISOString()).toBe("2026-09-13T08:34:34.000Z");
    } finally {
      await skewed.app.close();
    }
  });

  it("rejects an event containing a NUL character without failing the batch", async () => {
    const res = await sendBatch(app, [view("sty\x00x", 4000, NOW), view("sty_0108", 4000, NOW)], NOW);
    expect(res.body).toMatchObject({ accepted: 1, rejected: [{ index: 0, code: "INVALID_STRING" }] });
  });

  it("enforces batch size (422) and body size (413)", async () => {
    const tooMany = await sendBatch(app, Array.from({ length: 501 }, () => view("sty_0108", 1, NOW)), NOW);
    expect(tooMany.status).toBe(422);
    expect(tooMany.body).toMatchObject({ error: { code: "BATCH_SIZE_INVALID" } });

    const huge = { events: [view("sty_0108", 1, NOW, { props: { storyId: "s", watchMs: 1, pad: "x".repeat(1_100_000) } })] };
    const res = await app.inject({ method: "POST", url: "/v1/events/batch", headers: appHeaders, payload: huge });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("accepts gzip bodies and rejects a zip bomb by decompressed size", async () => {
    const body = JSON.stringify({ sentAt: toIso(NOW), events: [view("sty_0108", 4000, NOW)] });
    const ok = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { ...appHeaders, "content-encoding": "gzip" },
      payload: gzipSync(body),
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ accepted: 1 });

    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x20)); // 20 MB of spaces -> ~20 KB gzip
    expect(bomb.length).toBeLessThan(100_000);
    const res = await app.inject({ method: "POST", url: "/v1/events/batch", headers: { ...appHeaders, "content-encoding": "gzip" }, payload: bomb });
    expect(res.statusCode).toBe(413);

    const notGzip = await app.inject({ method: "POST", url: "/v1/events/batch", headers: { ...appHeaders, "content-encoding": "gzip" }, payload: "plain" });
    expect(notGzip.statusCode).toBe(400);

    const br = await app.inject({ method: "POST", url: "/v1/events/batch", headers: { ...appHeaders, "content-encoding": "br" }, payload: body });
    expect(br.statusCode).toBe(415);
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/events/batch", headers: appHeaders, payload: "{nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
  });
});

describe("auth", () => {
  it("requires the app key for ingestion; the internal token does not open it", async () => {
    const payload = { events: [view("sty_0108", 4000, NOW)] };
    expect((await app.inject({ method: "POST", url: "/v1/events/batch", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/events/batch", headers: { ...appHeaders, "x-app-key": "wrong" }, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/events/batch", headers: internalHeaders, payload })).statusCode).toBe(401);
  });

  it("internal endpoints are not reachable with the app key", async () => {
    const sweep = await app.inject({ method: "POST", url: "/v1/internal/jobs/commission-sweep", headers: appHeaders, payload: {} });
    expect(sweep.statusCode).toBe(401);
    const orders = await app.inject({ method: "POST", url: "/v1/internal/order-events", headers: appHeaders, payload: {} });
    expect(orders.statusCode).toBe(401);
    expect(orders.json()).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
  });
});

describe("backpressure", () => {
  it("returns 429 with Retry-After when a client exceeds its event budget", async () => {
    const limited = await makeApp(pool, { env: { RATE_LIMIT_EVENTS_PER_SEC: "10", RATE_LIMIT_BURST: "500" } });
    try {
      const batch = Array.from({ length: 300 }, () => view("sty_0108", 4000, NOW));
      expect((await sendBatch(limited.app, batch, NOW)).status).toBe(202);
      const second = await sendBatch(limited.app, Array.from({ length: 300 }, () => view("sty_0108", 4000, NOW)), NOW);
      expect(second.status).toBe(429);
      expect(Number(second.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(second.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
    } finally {
      await limited.app.close();
    }
  });

  it("returns 503 with Retry-After while the queue is over its depth budget, and recovers once drained", async () => {
    const shed = await makeApp(pool, { policy: { maxDepth: 5, retryAfterSeconds: 7 } });
    try {
      await sendBatch(shed.app, Array.from({ length: 10 }, () => view("sty_0108", 4000, NOW)), NOW);
      await shed.monitor.refresh();
      const res = await sendBatch(shed.app, [view("sty_0108", 4000, NOW)], NOW);
      expect(res.status).toBe(503);
      expect(res.headers["retry-after"]).toBe("7");
      const health = await shed.app.inject({ method: "GET", url: "/health" });
      expect(health.json()).toMatchObject({ status: "degraded", queue: { saturated: true } });

      await drain(pool);
      await shed.monitor.refresh();
      expect((await sendBatch(shed.app, [view("sty_0108", 4000, NOW)], NOW)).status).toBe(202);
    } finally {
      await shed.app.close();
    }
  });
});

describe("ops endpoints", () => {
  it("/health reports DB and queue status; /metrics exposes ingest and ledger metrics", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", db: { ok: true }, queue: { eventDepth: 0 } });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain("ingest_events_total");
    expect(metrics.body).toContain("db_ledger_invariants_ok");
    expect(metrics.body).toContain("queue_oldest_age_seconds");
  });

});