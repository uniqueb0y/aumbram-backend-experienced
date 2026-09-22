/**
 * Load test (BE-E-05): replays events.csv against POST /v1/events/batch at a
 * fixed arrival rate (open model), then waits for consumers to drain and
 * checks correctness: every unique id sent is stored and processed.
 *
 *   node dist/loadtest/replay.js --file shared/mock-data/big/events.csv --rate 2500 --duration 150
 *
 * Env: API_URL, APP_KEY, DATABASE_URL (for the correctness check), WORKER_METRICS_URL.
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { createInterface } from "node:readline";
import pg from "pg";
import { normalizeEventId } from "../src/lib/ids.js";
import { CSV_HEADER, csvEventToApiEvent, parseCsvLine, toCsvEvent } from "../src/tools/csv.js";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : fallback;
};
const FILE = arg("file", "shared/mock-data/big/events.csv");
const RATE = Number(arg("rate", "2500")); // events per second
const DURATION_S = Number(arg("duration", "150"));
const BATCH = Number(arg("batch", "100"));
const MAX_IN_FLIGHT = Number(arg("max-in-flight", "256"));
const DRAIN_TIMEOUT_S = Number(arg("drain-timeout", "180"));
// A salt remaps every event id deterministically (hash(salt + id) as a UUID), so repeated runs
// against the same database insert fresh events while the CSV's own duplicates stay duplicates.
const SALT = arg("salt", "");
const API = process.env.API_URL ?? "http://localhost:8080";
const APP_KEY = process.env.APP_KEY ?? "dev_app_key_change_me";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://aumbram:aumbram@localhost:55432/aumbram";
const WORKER_METRICS = process.env.WORKER_METRICS_URL ?? "http://localhost:9091/metrics";

interface Sample {
  t: number;
  phase: "load" | "drain";
  eventDepth: number;
  oldestAgeSeconds: number;
}

const latencies: number[] = [];
const status = new Map<number, number>();
const sentIds = new Set<string>();
let acceptedEvents = 0;
let duplicateEvents = 0;
let rejectedEvents = 0;
let retries = 0;
let networkErrors = 0;
let inFlight = 0;
let skippedForInFlight = 0;

function saltedId(id: string): string {
  const h = createHash("sha1").update(`${SALT}:${id.toLowerCase()}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function* batches(): AsyncGenerator<Record<string, unknown>[]> {
  const lines = createInterface({ input: createReadStream(FILE, "utf8"), crlfDelay: Infinity });
  let batch: Record<string, unknown>[] = [];
  for await (const line of lines) {
    if (line === CSV_HEADER || line.trim() === "") continue;
    const csv = toCsvEvent(parseCsvLine(line));
    if (csv === null) continue;
    const event = csvEventToApiEvent(csv);
    if (SALT !== "") event.id = saltedId(csv.eventId);
    batch.push(event);
    if (batch.length === BATCH) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

async function send(events: Record<string, unknown>[], attempt = 0): Promise<void> {
  const body = JSON.stringify({ sentAt: new Date().toISOString(), events });
  const started = performance.now();
  inFlight++;
  try {
    const res = await fetch(`${API}/v1/events/batch`, { method: "POST", headers: { "content-type": "application/json", "x-app-key": APP_KEY }, body });
    const text = await res.text();
    latencies.push(performance.now() - started);
    status.set(res.status, (status.get(res.status) ?? 0) + 1);
    if (res.status === 202) {
      const json = JSON.parse(text) as { accepted: number; duplicates: number; rejected: Array<{ index: number }> };
      acceptedEvents += json.accepted;
      duplicateEvents += json.duplicates;
      rejectedEvents += json.rejected.length;
      const rejected = new Set(json.rejected.map((r) => r.index));
      events.forEach((e, i) => {
        const id = normalizeEventId(e.id);
        if (id !== null && !rejected.has(i)) sentIds.add(id);
      });
    } else if ((res.status === 429 || res.status === 503) && attempt < 20) {
      // Clients retry the SAME batch after Retry-After; dedupe makes it safe.
      retries++;
      const wait = Number(res.headers.get("retry-after") ?? "1") * 1000;
      setTimeout(() => void send(events, attempt + 1), wait);
    }
  } catch {
    networkErrors++;
    status.set(0, (status.get(0) ?? 0) + 1);
  } finally {
    inFlight--;
  }
}

async function health(): Promise<{ eventDepth: number; eventOldestAgeSeconds: number } | null> {
  try {
    const res = await fetch(`${API}/health`);
    const json = (await res.json()) as { queue?: { eventDepth: number; eventOldestAgeSeconds: number } };
    return json.queue ?? null;
  } catch {
    return null;
  }
}

async function scrapeHistogram(name: string): Promise<Map<string, number>> {
  const buckets = new Map<string, number>();
  try {
    const text = await (await fetch(WORKER_METRICS)).text();
    for (const line of text.split("\n")) {
      const m = new RegExp(`^${name}_bucket\\{le="([^"]+)"\\} (\\d+(?:\\.\\d+)?)`).exec(line);
      if (m?.[1] && m[2]) buckets.set(m[1], Number(m[2]));
    }
  } catch {
    // worker metrics are optional for the report
  }
  return buckets;
}

function histogramQuantile(before: Map<string, number>, after: Map<string, number>, q: number): string {
  const les = [...after.keys()].sort((a, b) => (a === "+Inf" ? 1 : b === "+Inf" ? -1 : Number(a) - Number(b)));
  const total = (after.get("+Inf") ?? 0) - (before.get("+Inf") ?? 0);
  if (total <= 0) return "n/a";
  for (const le of les) {
    const c = (after.get(le) ?? 0) - (before.get(le) ?? 0);
    if (c >= q * total) return le === "+Inf" ? "> max bucket" : `<= ${le} s`;
  }
  return "n/a";
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;

async function main(): Promise<void> {
  const h0 = await health();
  if (h0 === null) throw new Error(`API not reachable at ${API}`);
  const lagBefore = await scrapeHistogram("event_to_processed_seconds");
  const samples: Sample[] = [];
  const t0 = Date.now();
  const sampler = setInterval(() => {
    void health().then((h) => {
      if (h) samples.push({ t: Math.round((Date.now() - t0) / 1000), phase: Date.now() - t0 <= DURATION_S * 1000 ? "load" : "drain", eventDepth: h.eventDepth, oldestAgeSeconds: h.eventOldestAgeSeconds });
    });
  }, 5000);

  // Open-model scheduler: batch k is due at t0 + k * interval, regardless of responses.
  const intervalMs = (BATCH / RATE) * 1000;
  const source = batches();
  let k = 0;
  let exhausted = false;
  process.stdout.write(`Replaying ${FILE} at ${RATE} events/s in batches of ${BATCH} for ${DURATION_S}s -> ${API}\n`);
  while (Date.now() - t0 < DURATION_S * 1000) {
    const due = t0 + k * intervalMs;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const next = await source.next();
    if (next.done) {
      exhausted = true;
      break;
    }
    if (inFlight >= MAX_IN_FLIGHT) skippedForInFlight++;
    void send(next.value);
    k++;
  }
  const loadEnded = Date.now();
  while (inFlight > 0) await new Promise((r) => setTimeout(r, 50));
  const sendSeconds = (loadEnded - t0) / 1000;

  // Drain: wait until the queue is empty (lag back to ~0).
  let drainedAfter: number | null = null;
  while (Date.now() - loadEnded < DRAIN_TIMEOUT_S * 1000) {
    const h = await health();
    if (h && h.eventDepth === 0) {
      drainedAfter = (Date.now() - loadEnded) / 1000;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  clearInterval(sampler);
  const lagAfter = await scrapeHistogram("event_to_processed_seconds");

  // Correctness: every unique id the API accepted is stored, and none is still queued.
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const ids = [...sentIds];
  let stored = 0;
  let stillQueued = 0;
  for (let i = 0; i < ids.length; i += 20_000) {
    const chunk = ids.slice(i, i + 20_000);
    const r = await client.query<{ stored: string; queued: string }>(
      `SELECT (SELECT count(*) FROM events WHERE id = ANY($1::uuid[])) AS stored,
              (SELECT count(*) FROM event_queue WHERE event_id = ANY($1::uuid[])) AS queued`,
      [chunk],
    );
    stored += Number(r.rows[0]?.stored ?? 0);
    stillQueued += Number(r.rows[0]?.queued ?? 0);
  }
  await client.end();

  const sorted = [...latencies].sort((a, b) => a - b);
  const requests = latencies.length;
  const report = {
    machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, ramGb: Math.round(totalmem() / 2 ** 30) },
    config: { file: FILE, salt: SALT, targetRate: RATE, batch: BATCH, durationS: DURATION_S, exhaustedInput: exhausted },
    throughput: {
      sendSeconds: Number(sendSeconds.toFixed(1)),
      batchesSent: k,
      acceptedEventsPerSec: Math.round(acceptedEvents / sendSeconds),
      offeredEventsPerSec: Math.round((k * BATCH) / sendSeconds),
    },
    latencyMs: { p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted[sorted.length - 1] },
    responses: Object.fromEntries([...status].map(([s, n]) => [s === 0 ? "network_error" : String(s), n])),
    rates: {
      errorRate: Number(((requests - (status.get(202) ?? 0) - (status.get(429) ?? 0) - (status.get(503) ?? 0)) / Math.max(1, requests)).toFixed(4)),
      rate429: Number(((status.get(429) ?? 0) / Math.max(1, requests)).toFixed(4)),
      rate503: Number(((status.get(503) ?? 0) / Math.max(1, requests)).toFixed(4)),
      retries,
      networkErrors,
      skippedForInFlight,
    },
    events: { accepted: acceptedEvents, duplicates: duplicateEvents, rejected: rejectedEvents },
    lag: {
      drainedSecondsAfterLoad: drainedAfter,
      eventToProcessedP95: histogramQuantile(lagBefore, lagAfter, 0.95),
      eventToProcessedP99: histogramQuantile(lagBefore, lagAfter, 0.99),
      samples,
    },
    correctness: { uniqueIdsSent: ids.length, storedInEvents: stored, stillQueued, processed: stored - stillQueued, pass: stored === ids.length && stillQueued === 0 },
  };

  mkdirSync("loadtest/results", { recursive: true });
  const out = `loadtest/results/run-${new Date(t0).toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nWrote ${out}\n`);
  process.exit(report.correctness.pass ? 0 : 2);
}

main().catch((err: unknown) => {
  process.stderr.write(`load test failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});