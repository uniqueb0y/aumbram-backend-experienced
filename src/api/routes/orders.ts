import type { FastifyInstance } from "fastify";
import { listDecisions, getDecision, type DecisionRow } from "../../attribution/decisions.js";
import type { Pool } from "../../db/pool.js";
import { ApiError } from "../../lib/errors.js";
import { moneyJson } from "../../lib/money.js";
import { toIso } from "../../lib/time.js";
import { recordOrderEvent } from "../../orders/intake.js";
import { getOrder } from "../../orders/repo.js";
import { validateOrderEvent } from "../../orders/validate.js";
import type { AuthHooks } from "../auth.js";

function decisionJson(d: DecisionRow) {
  return {
    version: d.version,
    attributed: d.attributed,
    storyId: d.storyId,
    creatorId: d.creatorId,
    qualifyingEvent:
      d.qualifyingEventId === null
        ? null
        : { id: d.qualifyingEventId, name: d.qualifyingEventName, serverTs: d.qualifyingServerTs === null ? null : toIso(d.qualifyingServerTs) },
    anchor: { source: d.anchorSource, at: toIso(d.anchorAt), eventId: d.anchorEventId },
    commissionRateBps: d.commissionRateBps,
    commission: d.commissionPaise === null ? null : moneyJson(d.commissionPaise),
    ruleVersion: d.ruleVersion,
    reason: d.reason,
    triggerEventId: d.triggerEventId,
    decidedAt: toIso(d.decidedAt),
  };
}

export function registerOrderRoutes(app: FastifyInstance, deps: { pool: Pool; auth: AuthHooks }): void {
  app.post("/v1/internal/order-events", { onRequest: deps.auth.internal }, async (request, reply) => {
    const check = validateOrderEvent(request.body);
    if (!check.ok) throw new ApiError(422, "VALIDATION_ERROR", check.message, { field: check.field });
    const { duplicate } = await recordOrderEvent(deps.pool, check.message);
    request.log.info({ orderId: check.message.orderId, status: check.message.status, duplicate }, "order event accepted");
    return reply.code(202).send({ orderId: check.message.orderId, status: check.message.status, duplicate });
  });

  app.get<{ Params: { orderId: string }; Querystring: { history?: string } }>(
    "/v1/orders/:orderId/attribution",
    { onRequest: deps.auth.any },
    async (request) => {
      const { orderId } = request.params;
      const order = await getOrder(deps.pool, orderId);
      const current = order ? await getDecision(deps.pool, orderId, order.attributionVersion) : null;
      if (order === null || current === null) throw new ApiError(404, "NOT_FOUND", `no attribution for order ${orderId} (unknown or not processed yet)`);

      const body: Record<string, unknown> = {
        orderId,
        attributed: current.attributed,
        storyId: current.storyId,
        creatorId: current.creatorId,
        qualifyingEvent: decisionJson(current).qualifyingEvent,
        anchor: { source: current.anchorSource, at: toIso(current.anchorAt) },
        commissionRateBps: current.commissionRateBps,
        commission: current.commissionPaise === null ? null : moneyJson(current.commissionPaise),
        version: current.version,
        locked: order.lockedAt !== null,
        lockReason: order.lockReason,
        ruleVersion: current.ruleVersion,
        decidedAt: toIso(current.decidedAt),
      };
      if (request.query.history === "true") {
        const [history, late] = await Promise.all([
          listDecisions(deps.pool, orderId),
          deps.pool.query<{ trigger_event_id: string | null; would_be_creator_id: string | null; would_be_event_id: string | null; recorded_at: Date }>(
            `SELECT trigger_event_id::text, would_be_creator_id, would_be_event_id::text, recorded_at
             FROM late_locked_events WHERE order_id = $1 ORDER BY id`,
            [orderId],
          ),
        ]);
        body.history = history.map(decisionJson);
        body.lateLockedEvents = late.rows.map((r) => ({
          triggerEventId: r.trigger_event_id,
          wouldBeCreatorId: r.would_be_creator_id,
          wouldBeEventId: r.would_be_event_id,
          recordedAt: toIso(r.recorded_at.getTime()),
        }));
      }
      return body;
    },
  );
}