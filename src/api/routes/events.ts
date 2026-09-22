import type { FastifyInstance } from "fastify";
import type { Pool } from "../../db/pool.js";
import { ingestEvents } from "../../ingest/ingestBatch.js";
import type { QueueMonitor } from "../../ingest/queueMonitor.js";
import type { TokenBucketLimiter } from "../../ingest/rateLimiter.js";
import { validateEnvelope } from "../../ingest/validate.js";
import { ApiError } from "../../lib/errors.js";
import { toIso, type Clock } from "../../lib/time.js";
import { ingestBatches, ingestEvents as ingestEventsMetric, ingestRejects } from "../../metrics.js";
import type { AuthHooks } from "../auth.js";
import { gunzipWithLimit, isGzip } from "../gzip.js";

export interface EventRouteDeps {
  pool: Pool;
  clock: Clock;
  auth: AuthHooks;
  monitor: QueueMonitor;
  limiter: TokenBucketLimiter;
  maxEvents: number;
  maxBytes: number;
}

export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDeps): void {
  app.post(
    "/v1/events/batch",
    {
      bodyLimit: deps.maxBytes,
      onRequest: deps.auth.app,
      preParsing: async (request, _reply, payload) => (isGzip(request.headers["content-encoding"]) ? gunzipWithLimit(payload, deps.maxBytes) : payload),
    },
    async (request, reply) => {
      const envelope = validateEnvelope(request.body, deps.maxEvents);
      if (!envelope.ok) {
        ingestBatches.inc({ outcome: "invalid" });
        throw new ApiError(envelope.status, envelope.code, envelope.message);
      }

      // System lag first (503), then the per-client budget (429). Both carry Retry-After;
      // clients retry the same batch and dedupe makes that safe.
      const saturation = deps.monitor.saturation();
      if (saturation.saturated) {
        ingestBatches.inc({ outcome: "shed_503" });
        throw new ApiError(503, "SERVICE_OVERLOADED", `ingestion is shedding load: ${saturation.reason}`, undefined, {
          "Retry-After": String(saturation.retryAfterSeconds),
        });
      }
      const budget = deps.limiter.take(request.ip, envelope.events.length);
      if (!budget.ok) {
        ingestBatches.inc({ outcome: "throttled_429" });
        throw new ApiError(429, "RATE_LIMITED", "too many events from this client", undefined, {
          "Retry-After": String(budget.retryAfterSeconds),
        });
      }

      const outcome = await ingestEvents(deps.pool, envelope.events, envelope.sentAt, deps.clock.now(), request.id);

      ingestBatches.inc({ outcome: "accepted" });
      ingestEventsMetric.inc({ result: "accepted" }, outcome.accepted);
      ingestEventsMetric.inc({ result: "duplicate" }, outcome.duplicates);
      ingestEventsMetric.inc({ result: "rejected" }, outcome.rejected.length);
      for (const r of outcome.rejected) ingestRejects.inc({ code: r.code });
      request.log.debug({ batchId: outcome.batchId, accepted: outcome.accepted, duplicates: outcome.duplicates, rejected: outcome.rejected.length }, "batch ingested");

      return reply.code(202).send({
        batchId: outcome.batchId,
        receivedAt: toIso(outcome.receivedAt),
        accepted: outcome.accepted,
        duplicates: outcome.duplicates,
        rejected: outcome.rejected,
      });
    },
  );
}