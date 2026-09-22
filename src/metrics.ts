import client from "prom-client";
import type { Pool } from "./db/pool.js";

/**
 * Prometheus metrics. Process-level counters live here; the API process also
 * registers DB-derived gauges (ledger totals, late-locked count, invariant
 * result) so a single scrape of the API answers "is the money right?".
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const reg = { registers: [registry] };

// ---- ingestion (api) ----
export const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5],
  ...reg,
});
export const ingestEvents = new client.Counter({
  name: "ingest_events_total",
  help: "Events received by outcome (accepted = newly stored)",
  labelNames: ["result"] as const,
  ...reg,
});
export const ingestRejects = new client.Counter({
  name: "ingest_rejected_events_total",
  help: "Rejected events by reject code",
  labelNames: ["code"] as const,
  ...reg,
});
export const ingestBatches = new client.Counter({
  name: "ingest_batches_total",
  help: "Batches by outcome (accepted, throttled_429, shed_503, invalid, error)",
  labelNames: ["outcome"] as const,
  ...reg,
});
export const queueDepth = new client.Gauge({
  name: "queue_depth",
  help: "Items waiting in a work queue (capped at QUEUE_MAX_DEPTH+1)",
  labelNames: ["queue"] as const,
  ...reg,
});
export const queueOldestAge = new client.Gauge({
  name: "queue_oldest_age_seconds",
  help: "Age of the oldest item in the event queue (consumer lag)",
  ...reg,
});

// ---- consumers (worker) ----
export const consumerEvents = new client.Counter({
  name: "consumer_events_processed_total",
  help: "Events processed by the event consumer",
  ...reg,
});
export const consumerBatchDuration = new client.Histogram({
  name: "consumer_batch_duration_seconds",
  help: "Event consumer batch duration",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  ...reg,
});
export const eventToProcessed = new client.Histogram({
  name: "event_to_processed_seconds",
  help: "Time from ingest (receivedAt) to consumer processing, live events only",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  ...reg,
});
export const attributionEvaluations = new client.Counter({
  name: "attribution_evaluations_total",
  help: "Attribution evaluations by trigger and outcome",
  labelNames: ["trigger", "outcome"] as const,
  ...reg,
});
export const lateLockedEvents = new client.Counter({
  name: "attribution_late_locked_total",
  help: "Late events that would have changed a locked attribution",
  ...reg,
});
export const ledgerPostings = new client.Counter({
  name: "ledger_transactions_posted_total",
  help: "Ledger transactions posted by type",
  labelNames: ["type"] as const,
  ...reg,
});
export const orderEventsProcessed = new client.Counter({
  name: "order_events_processed_total",
  help: "Order lifecycle messages processed by status",
  labelNames: ["status"] as const,
  ...reg,
});
export const deadLetters = new client.Counter({
  name: "dead_letters_total",
  help: "Messages moved to a dead-letter table",
  labelNames: ["queue"] as const,
  ...reg,
});
export const sweepOrders = new client.Counter({
  name: "sweep_orders_total",
  help: "Orders settled by the commission sweep",
  labelNames: ["result"] as const,
  ...reg,
});
export const invariantOk = new client.Gauge({
  name: "ledger_invariants_ok",
  help: "Worker: 1 if the last invariant check passed, 0 if it found a violation, -1 if not run yet",
  ...reg,
});
invariantOk.set(-1);

let dbGaugesRegistered = false;

/** DB-derived gauges, computed at scrape time (API process only). Idempotent. */
export function registerDbGauges(pool: Pool): void {
  if (dbGaugesRegistered) return;
  dbGaugesRegistered = true;
  new client.Gauge({
    name: "db_ledger_transactions",
    help: "Ledger transactions in the database by type",
    labelNames: ["type"] as const,
    registers: [registry],
    async collect() {
      const { rows } = await pool.query<{ type: string; n: bigint }>("SELECT type, count(*) AS n FROM ledger_transactions GROUP BY type");
      this.reset();
      for (const r of rows) this.set({ type: r.type }, Number(r.n));
    },
  });
  new client.Gauge({
    name: "db_late_locked_events",
    help: "Late events recorded against locked attributions",
    registers: [registry],
    async collect() {
      const { rows } = await pool.query<{ n: bigint }>("SELECT count(*) AS n FROM late_locked_events");
      this.set(Number(rows[0]?.n ?? 0n));
    },
  });
  new client.Gauge({
    name: "db_attribution_reevaluations_changed",
    help: "Attribution decisions beyond version 1 (re-evaluations that changed the outcome)",
    registers: [registry],
    async collect() {
      const { rows } = await pool.query<{ n: bigint }>("SELECT count(*) AS n FROM attribution_decisions WHERE version > 1");
      this.set(Number(rows[0]?.n ?? 0n));
    },
  });
  new client.Gauge({
    name: "db_ledger_invariants_ok",
    help: "Result of the most recent invariant check (1 ok, 0 violated, -1 never run)",
    registers: [registry],
    async collect() {
      const { rows } = await pool.query<{ ok: boolean }>("SELECT ok FROM invariant_checks ORDER BY id DESC LIMIT 1");
      const row = rows[0];
      this.set(row === undefined ? -1 : row.ok ? 1 : 0);
    },
  });
  new client.Gauge({
    name: "db_dead_letters",
    help: "Rows in dead-letter tables",
    labelNames: ["queue"] as const,
    registers: [registry],
    async collect() {
      const { rows } = await pool.query<{ events: bigint; orders: bigint }>(
        "SELECT (SELECT count(*) FROM event_dead_letters) AS events, (SELECT count(*) FROM order_event_dead_letters) AS orders",
      );
      this.set({ queue: "events" }, Number(rows[0]?.events ?? 0n));
      this.set({ queue: "order_events" }, Number(rows[0]?.orders ?? 0n));
    },
  });
}