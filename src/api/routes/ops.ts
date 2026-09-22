import type { FastifyInstance } from "fastify";
import type { Pool } from "../../db/pool.js";
import type { QueueMonitor } from "../../ingest/queueMonitor.js";
import { errorMessage } from "../../lib/errors.js";
import { registry } from "../../metrics.js";

export function registerOpsRoutes(app: FastifyInstance, deps: { pool: Pool; monitor: QueueMonitor }): void {
  /** Health reflects dependencies: DB reachability and queue status. 503 if the DB is down. */
  app.get("/health", async (_request, reply) => {
    const started = Date.now();
    let db: { ok: boolean; latencyMs?: number; error?: string };
    try {
      await deps.pool.query("SELECT 1");
      db = { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      db = { ok: false, error: errorMessage(err) };
    }
    const stats = db.ok ? await deps.monitor.refresh() : deps.monitor.current();
    const saturation = deps.monitor.saturation();
    const status = !db.ok ? "down" : saturation.saturated ? "degraded" : "ok";
    return reply.code(db.ok ? 200 : 503).send({
      status,
      db,
      queue: stats && {
        eventDepth: stats.eventDepth,
        eventOldestAgeSeconds: Number(stats.eventOldestAgeSeconds.toFixed(3)),
        orderEventDepth: stats.orderDepth,
        saturated: saturation.saturated,
        ...(saturation.saturated ? { reason: saturation.reason } : {}),
      },
    });
  });

  app.get("/metrics", async (_request, reply) => {
    const body = await registry.metrics();
    return reply.header("Content-Type", registry.contentType).send(body);
  });
}