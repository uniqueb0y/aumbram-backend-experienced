import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/api/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { Pool } from "../../src/db/pool.js";
import { QueueMonitor, type SaturationPolicy } from "../../src/ingest/queueMonitor.js";
import { TokenBucketLimiter } from "../../src/ingest/rateLimiter.js";
import { systemClock, type Clock } from "../../src/lib/time.js";
import { silentLogger } from "./db.js";
import { TEST_APP_KEY, TEST_DB_URL, TEST_INTERNAL_TOKEN } from "./env.js";

export interface TestApp {
  app: FastifyInstance;
  config: Config;
  monitor: QueueMonitor;
}

export async function makeApp(
  pool: Pool,
  opts: { clock?: Clock; env?: Record<string, string>; policy?: Partial<SaturationPolicy> } = {},
): Promise<TestApp> {
  const config = loadConfig({
    DATABASE_URL: TEST_DB_URL,
    APP_KEY: TEST_APP_KEY,
    INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    LOG_LEVEL: "silent",
    ...opts.env,
  });
  const clock = opts.clock ?? systemClock;
  const monitor = new QueueMonitor(
    pool,
    {
      maxDepth: config.queue.maxDepth,
      maxLagSeconds: config.queue.maxLagSeconds,
      retryAfterSeconds: config.queue.retryAfterSeconds,
      ...opts.policy,
    },
    config.queue.monitorIntervalMs,
    silentLogger,
  );
  const limiter = new TokenBucketLimiter(config.ingest.rateLimitEventsPerSec, config.ingest.rateLimitBurst, clock);
  const app = await buildApp({ config, pool, clock, monitor, limiter, logger: silentLogger });
  return { app, config, monitor };
}

export const appHeaders = { "x-app-key": TEST_APP_KEY, "content-type": "application/json" };
export const internalHeaders = { "x-internal-token": TEST_INTERNAL_TOKEN, "content-type": "application/json" };