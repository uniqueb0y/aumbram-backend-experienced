/**
 * Database side of attribution: load the inputs for one order, run the pure
 * rule, and persist a new decision version when the outcome changed.
 *
 * Callers must hold the user's advisory lock and the order's row lock.
 */
import type { Queryable } from "../db/pool.js";
import { iso } from "../db/rows.js";
import { commissionFor } from "../lib/money.js";
import { lateLockedEvents } from "../metrics.js";
import type { OrderRow } from "../orders/repo.js";
import { getDecision, insertDecision, type DecisionReason, type DecisionRow } from "./decisions.js";
import { attribute, type Attribution, type Checkout, type Interaction, type InteractionName, type StoryRef } from "./rule.js";
import type { RuleParams } from "./ruleConfig.js";

export interface EvaluationContext {
  rule: RuleParams;
  reason: DecisionReason;
  /** Events that caused this evaluation (for audit), most relevant first. */
  triggerEventIds: readonly string[];
}

export type EvaluationResult =
  | { outcome: "unchanged"; decision: DecisionRow }
  | { outcome: "changed"; decision: DecisionRow; previous: DecisionRow | null }
  | { outcome: "late_locked"; decision: DecisionRow; wouldBe: Attribution };

interface AttributionInputs {
  checkouts: Checkout[];
  interactions: Interaction[];
  stories: Map<string, StoryRef>;
}

export async function loadAttributionInputs(db: Queryable, order: OrderRow, rule: RuleParams): Promise<AttributionInputs> {
  const anchorFrom = order.createdAt - rule.anchorLookbackMs;
  const interactionsFrom = anchorFrom - rule.windowMs;

  const checkouts = await db.query<{ event_id: string; server_ts: Date }>(
    `SELECT event_id::text, server_ts FROM checkouts
     WHERE user_id = $1 AND server_ts BETWEEN $2 AND $3`,
    [order.userId, iso(anchorFrom), iso(order.createdAt)],
  );
  const interactions = await db.query<{
    event_id: string;
    name: InteractionName;
    server_ts: Date;
    received_at: Date;
    story_id: string | null;
    product_id: string | null;
    watch_ms: bigint | null;
  }>(
    `SELECT event_id::text, name, server_ts, received_at, story_id, product_id, watch_ms FROM interactions
     WHERE user_id = $1 AND server_ts BETWEEN $2 AND $3`,
    [order.userId, iso(interactionsFrom), iso(order.createdAt)],
  );

  const storyIds = [...new Set(interactions.rows.map((r) => r.story_id).filter((s): s is string => s !== null))];
  const stories = new Map<string, StoryRef>();
  if (storyIds.length > 0) {
    // Stories whose creator has no known rate are treated as unknown (DECISIONS D-033).
    const { rows } = await db.query<{ id: string; creator_id: string; tagged_product_ids: string[] }>(
      `SELECT s.id, s.creator_id, s.tagged_product_ids
       FROM stories s JOIN creators c ON c.id = s.creator_id
       WHERE s.id = ANY($1::text[])`,
      [storyIds],
    );
    for (const r of rows) stories.set(r.id, { creatorId: r.creator_id, taggedProductIds: new Set(r.tagged_product_ids) });
  }

  return {
    checkouts: checkouts.rows.map((r) => ({ eventId: r.event_id, userId: order.userId, serverTs: r.server_ts.getTime() })),
    interactions: interactions.rows.map((r) => ({
      eventId: r.event_id,
      name: r.name,
      userId: order.userId,
      serverTs: r.server_ts.getTime(),
      receivedAt: r.received_at.getTime(),
      storyId: r.story_id,
      productId: r.product_id,
      watchMs: r.watch_ms === null ? null : Number(r.watch_ms),
    })),
    stories,
  };
}

/** Same outcome = same attributed flag, same winning event and same anchor (DECISIONS D-024). */
export function sameOutcome(current: DecisionRow, next: Attribution): boolean {
  const nextEventId = next.attributed ? next.winner.eventId : null;
  return (
    current.attributed === next.attributed &&
    current.qualifyingEventId === nextEventId &&
    current.anchorSource === next.anchor.source &&
    current.anchorAt === next.anchor.at
  );
}

/** Rate snapshot: the rate on this order's first decision for the creator, else the creator's current rate. */
async function rateFor(db: Queryable, orderId: string, creatorId: string): Promise<number> {
  const snap = await db.query<{ commission_rate_bps: number }>(
    `SELECT commission_rate_bps FROM attribution_decisions
     WHERE order_id = $1 AND creator_id = $2 ORDER BY version LIMIT 1`,
    [orderId, creatorId],
  );
  if (snap.rows[0]) return snap.rows[0].commission_rate_bps;
  const current = await db.query<{ commission_rate_bps: number }>("SELECT commission_rate_bps FROM creators WHERE id = $1", [creatorId]);
  if (!current.rows[0]) throw new Error(`creator ${creatorId} has no commission rate`);
  return current.rows[0].commission_rate_bps;
}

export async function evaluateOrder(tx: Queryable, order: OrderRow, ctx: EvaluationContext): Promise<EvaluationResult> {
  const inputs = await loadAttributionInputs(tx, order, ctx.rule);
  const result = attribute(
    { userId: order.userId, createdAt: order.createdAt, productIds: new Set(order.productIds) },
    inputs.checkouts,
    inputs.interactions,
    inputs.stories,
    ctx.rule,
  );
  const current = await getDecision(tx, order.id, order.attributionVersion);

  if (current !== null && sameOutcome(current, result)) return { outcome: "unchanged", decision: current };

  // The trigger most relevant to the new outcome: the new winner if it is one of the triggers.
  const winnerId = result.attributed ? result.winner.eventId : null;
  const triggerEventId = winnerId !== null && ctx.triggerEventIds.includes(winnerId) ? winnerId : (ctx.triggerEventIds[0] ?? null);

  if (current !== null && order.lockedAt !== null) {
    const inserted = await tx.query(
      `INSERT INTO late_locked_events (order_id, trigger_event_id, locked_version, would_be_attributed,
         would_be_story_id, would_be_creator_id, would_be_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        order.id,
        triggerEventId,
        current.version,
        result.attributed,
        result.attributed ? result.storyId : null,
        result.attributed ? result.creatorId : null,
        winnerId,
      ],
    );
    if (inserted.rowCount) lateLockedEvents.inc();
    return { outcome: "late_locked", decision: current, wouldBe: result };
  }

  let rateBps: number | null = null;
  let commission: bigint | null = null;
  if (result.attributed) {
    rateBps = await rateFor(tx, order.id, result.creatorId);
    commission = commissionFor(order.subtotalPaise, rateBps);
  }

  const version = order.attributionVersion + 1;
  const decision = await insertDecision(tx, {
    orderId: order.id,
    version,
    attributed: result.attributed,
    storyId: result.attributed ? result.storyId : null,
    creatorId: result.attributed ? result.creatorId : null,
    qualifyingEventId: winnerId,
    qualifyingEventName: result.attributed ? result.winner.name : null,
    qualifyingServerTs: result.attributed ? result.winner.serverTs : null,
    anchorSource: result.anchor.source,
    anchorAt: result.anchor.at,
    anchorEventId: result.anchor.eventId,
    commissionRateBps: rateBps,
    commissionPaise: commission,
    ruleVersion: ctx.rule.version,
    reason: current === null ? "initial" : ctx.reason,
    triggerEventId: current === null && ctx.reason === "initial" ? null : triggerEventId,
  });
  await tx.query("UPDATE orders SET attribution_version = $2, updated_at = now() WHERE id = $1", [order.id, version]);
  order.attributionVersion = version;
  return { outcome: "changed", decision, previous: current };
}