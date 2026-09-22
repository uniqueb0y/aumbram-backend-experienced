import { buildApp } from "../api/app.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { QueueMonitor } from "../ingest/queueMonitor.js";
import { TokenBucketLimiter } from "../ingest/rateLimiter.js";
import { createLogger } from "../lib/logger.js";
import { systemClock } from "../lib/time.js";
import { queueDepth, queueOldestAge } from "../metrics.js";
import { exitOnConfigError } from "./shared.js";

const config = exitOnConfigError(loadConfig);
const logger = createLogger(config.logLevel, "api");
const pool = createPool(config.databaseUrl, config.pgPoolMax, "aumbram-api");

const monitor = new QueueMonitor(
  pool,
  { maxDepth: config.queue.maxDepth, maxLagSeconds: config.queue.maxLagSeconds, retryAfterSeconds: config.queue.retryAfterSeconds },
  config.queue.monitorIntervalMs,
  logger,
);
monitor.subscribe((s) => {
  queueDepth.set({ queue: "events" }, s.eventDepth);
  queueDepth.set({ queue: "order_events" }, s.orderDepth);
  queueOldestAge.set(s.eventOldestAgeSeconds);
});
monitor.start();

const limiter = new TokenBucketLimiter(config.ingest.rateLimitEventsPerSec, config.ingest.rateLimitBurst, systemClock);
const app = await buildApp({ config, pool, clock: systemClock, monitor, limiter, logger });
await app.listen({ host: config.host, port: config.port });
logger.info({ port: config.port }, "api listening");

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  monitor.stop();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));