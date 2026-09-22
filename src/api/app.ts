import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Pool } from "../db/pool.js";
import type { QueueMonitor } from "../ingest/queueMonitor.js";
import type { TokenBucketLimiter } from "../ingest/rateLimiter.js";
import type { Logger } from "../lib/logger.js";
import type { Clock } from "../lib/time.js";
import { httpDuration, registerDbGauges } from "../metrics.js";
import { authHooks } from "./auth.js";
import { installErrorHandling } from "./errorHandler.js";
import { registerCreatorRoutes } from "./routes/creators.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerOrderRoutes } from "./routes/orders.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
  clock: Clock;
  monitor: QueueMonitor;
  limiter: TokenBucketLimiter;
  logger: Logger;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const fastifyLogger: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance: fastifyLogger,
    // Per-request access logs are too chatty at 20+ req/s; metrics cover volume and
    // latency, and handlers log correlated lines (batchId / orderId) where useful.
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: deps.config.ingest.maxBytes,
    trustProxy: false,
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    httpDuration.observe({ method: request.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
    if (reply.statusCode >= 500) {
      request.log.warn({ route, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "request failed");
    }
  });

  registerDbGauges(deps.pool);
  installErrorHandling(app);
  const auth = authHooks(deps.config.appKey, deps.config.internalToken);

  registerEventRoutes(app, {
    pool: deps.pool,
    clock: deps.clock,
    auth,
    monitor: deps.monitor,
    limiter: deps.limiter,
    maxEvents: deps.config.ingest.maxEvents,
    maxBytes: deps.config.ingest.maxBytes,
  });
  registerOrderRoutes(app, { pool: deps.pool, auth });
  registerCreatorRoutes(app, { pool: deps.pool, auth });
  registerJobRoutes(app, { pool: deps.pool, auth, clock: deps.clock });
  registerOpsRoutes(app, { pool: deps.pool, monitor: deps.monitor });

  await app.ready();
  return app;
}