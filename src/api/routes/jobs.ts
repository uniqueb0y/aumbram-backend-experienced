import type { FastifyInstance } from "fastify";
import type { Pool } from "../../db/pool.js";
import { isPlainObject } from "../../ingest/validate.js";
import { ApiError } from "../../lib/errors.js";
import { parseIsoTimestamp, toIso, type Clock } from "../../lib/time.js";
import { runCommissionSweep } from "../../orders/sweep.js";
import type { AuthHooks } from "../auth.js";

export function registerJobRoutes(app: FastifyInstance, deps: { pool: Pool; auth: AuthHooks; clock: Clock }): void {
  app.post("/v1/internal/jobs/commission-sweep", { onRequest: deps.auth.internal }, async (request) => {
    const body = request.body ?? {};
    if (!isPlainObject(body)) throw new ApiError(400, "INVALID_BODY", "body must be a JSON object");
    let asOf = deps.clock.now();
    if (body.asOf !== undefined) {
      const parsed = parseIsoTimestamp(body.asOf);
      if (parsed === null) throw new ApiError(422, "VALIDATION_ERROR", "asOf must be an ISO-8601 timestamp", { field: "asOf" });
      asOf = parsed;
    }
    const result = await runCommissionSweep(deps.pool, asOf);
    request.log.info(result, "commission sweep finished");
    return { ...result, asOf: toIso(result.asOf) };
  });
}