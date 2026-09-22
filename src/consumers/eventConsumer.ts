/**
 * Event consumer: claims a batch from event_queue, updates the interaction
 * index, and re-evaluates the orders a new interaction or checkout could affect.
 * The claim (DELETE) and all effects commit in ONE transaction, so an event's
 * effects happen exactly once even if the worker crashes mid-batch.
 */
import { evaluateOrder } from "../attribution/engine.js";
import type { RuleParams } from "../attribution/ruleConfig.js";
import type { Pool, PoolClient } from "../db/pool.js";
import { iso } from "../db/rows.js";
import { withTransaction } from "../db/tx.js";
import { isPlainObject } from "../ingest/validate.js";
import { reconcileOrderLedger } from "../ledger/reconcile.js";
import { errorMessage } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { attributionEvaluations, consumerBatchDuration, consumerEvents, deadLetters, eventToProcessed } from "../metrics.js";
import { lockOrder, lockUsers } from "../orders/repo.js";

export interface EventConsumerDeps {
  pool: Pool;
  rule: RuleParams;
  log: Logger;
  batchSize: number;
}

interface ClaimedEvent {
  id: string;
  user_id: string | null;
  session_id: string;
  name: string;
  props: unknown;
  server_ts: Date;
  received_at: Date;
  source: "live" | "backfill";
}

interface InteractionRecord {
  event_id: string;
  user_id: string;
  name: "story_view" | "story_product_tap";
  server_ts: string;
  received_at: string;
  story_id: string | null;
  product_id: string | null;
  watch_ms: number | null;
}

interface Trigger {
  userId: string;
  serverTs: number;
  kind: "interaction" | "checkout";
  eventId: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Extracts the interaction-index row for an event, or null if the rule never looks at it. */
export function toInteraction(e: ClaimedEvent): InteractionRecord | null {
  if (e.user_id === null) return null;
  if (e.name !== "story_view" && e.name !== "story_product_tap") return null;
  const props = isPlainObject(e.props) ? e.props : {};
  const watchMs = props.watchMs;
  return {
    event_id: e.id,
    user_id: e.user_id,
    name: e.name,
    server_ts: e.server_ts.toISOString(),
    received_at: e.received_at.toISOString(),
    story_id: str(props.storyId),
    product_id: e.name === "story_product_tap" ? str(props.productId) : null,
    watch_ms: typeof watchMs === "number" && Number.isSafeInteger(watchMs) ? watchMs : null,
  };
}

async function claim(tx: PoolClient, limit: number): Promise<ClaimedEvent[]> {
  const { rows } = await tx.query<ClaimedEvent>(
    `WITH claimed AS (
       DELETE FROM event_queue
       WHERE seq IN (SELECT seq FROM event_queue ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING event_id
     )
     SELECT e.id::text AS id, e.user_id, e.session_id, e.name, e.props, e.server_ts, e.received_at, e.source
     FROM claimed c JOIN events e ON e.id = c.event_id`,
    [limit],
  );
  return rows;
}

/** Re-evaluates the orders that the given triggers could affect. Returns evaluation outcomes. */
export async function reevaluateAffectedOrders(tx: PoolClient, triggers: readonly Trigger[], rule: RuleParams, log: Logger): Promise<void> {
  if (triggers.length === 0) return;
  await lockUsers(
    tx,
    triggers.map((t) => t.userId),
  );

  // An interaction at t can matter to orders whose anchor is in [t, t + window];
  // the anchor is within `lookback` before createdAt, so createdAt in [t, t + window + lookback].
  // A checkout at t can only move the anchor of orders created in [t, t + lookback].
  const { rows } = await tx.query<{ order_id: string; event_id: string }>(
    `SELECT o.id AS order_id, t.event_id
     FROM jsonb_to_recordset($1::jsonb) AS t(user_id text, ts timestamptz, kind text, event_id text)
     JOIN orders o ON o.user_id = t.user_id
      AND o.created_at >= t.ts
      AND o.created_at <= t.ts + (CASE WHEN t.kind = 'checkout' THEN $2::bigint ELSE $3::bigint END) * interval '1 millisecond'
     ORDER BY o.id`,
    [
      JSON.stringify(triggers.map((t) => ({ user_id: t.userId, ts: iso(t.serverTs), kind: t.kind, event_id: t.eventId }))),
      rule.anchorLookbackMs,
      rule.anchorLookbackMs + rule.windowMs,
    ],
  );

  const byOrder = new Map<string, string[]>();
  for (const r of rows) {
    const list = byOrder.get(r.order_id) ?? [];
    list.push(r.event_id);
    byOrder.set(r.order_id, list);
  }

  for (const [orderId, triggerEventIds] of byOrder) {
    const order = await lockOrder(tx, orderId);
    if (order === null || order.attributionVersion === 0) continue;
    const result = await evaluateOrder(tx, order, { rule, reason: "late_event", triggerEventIds });
    attributionEvaluations.inc({ trigger: "event", outcome: result.outcome });
    if (result.outcome === "changed") {
      const postings = await reconcileOrderLedger(tx, order, "reattribution");
      log.info(
        { orderId, version: result.decision.version, creatorId: result.decision.creatorId, postings: postings.map((p) => p.idempotencyKey) },
        "attribution changed by late event",
      );
    } else if (result.outcome === "late_locked") {
      log.info({ orderId, triggerEventIds }, "late event would change a locked attribution; recorded only");
    }
  }
}

/** Processes one batch. Returns the number of events claimed (0 = queue empty). */
export async function consumeEventBatch(deps: EventConsumerDeps, limit = deps.batchSize, onClaimed?: (ids: string[]) => void): Promise<number> {
  const started = process.hrtime.bigint();
  const count = await withTransaction(deps.pool, async (tx) => {
    const events = await claim(tx, limit);
    onClaimed?.(events.map((e) => e.id));
    if (events.length === 0) return 0;

    const interactions: InteractionRecord[] = [];
    const checkouts: Array<{ event_id: string; user_id: string; server_ts: string; received_at: string }> = [];
    const triggers: Trigger[] = [];
    for (const e of events) {
      const interaction = toInteraction(e);
      if (interaction !== null) {
        interactions.push(interaction);
        triggers.push({ userId: interaction.user_id, serverTs: e.server_ts.getTime(), kind: "interaction", eventId: e.id });
      } else if (e.name === "checkout_start" && e.user_id !== null) {
        checkouts.push({ event_id: e.id, user_id: e.user_id, server_ts: e.server_ts.toISOString(), received_at: e.received_at.toISOString() });
        triggers.push({ userId: e.user_id, serverTs: e.server_ts.getTime(), kind: "checkout", eventId: e.id });
      }
    }

    if (interactions.length > 0) {
      await tx.query(
        `INSERT INTO interactions (event_id, user_id, name, server_ts, received_at, story_id, product_id, watch_ms)
         SELECT event_id, user_id, name, server_ts, received_at, story_id, product_id, watch_ms
         FROM jsonb_to_recordset($1::jsonb) AS x(event_id uuid, user_id text, name text, server_ts timestamptz,
           received_at timestamptz, story_id text, product_id text, watch_ms bigint)
         ON CONFLICT (event_id) DO NOTHING`,
        [JSON.stringify(interactions)],
      );
    }
    if (checkouts.length > 0) {
      await tx.query(
        `INSERT INTO checkouts (event_id, user_id, server_ts, received_at)
         SELECT event_id, user_id, server_ts, received_at
         FROM jsonb_to_recordset($1::jsonb) AS x(event_id uuid, user_id text, server_ts timestamptz, received_at timestamptz)
         ON CONFLICT (event_id) DO NOTHING`,
        [JSON.stringify(checkouts)],
      );
    }

    await reevaluateAffectedOrders(tx, triggers, deps.rule, deps.log);

    const now = Date.now();
    for (const e of events) {
      if (e.source === "live") eventToProcessed.observe(Math.max(0, now - e.received_at.getTime()) / 1000);
    }
    return events.length;
  });
  if (count > 0) {
    consumerEvents.inc(count);
    consumerBatchDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
  }
  return count;
}

async function deadLetterEvent(pool: Pool, eventId: string, error: string): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await tx.query("DELETE FROM event_queue WHERE event_id = $1", [eventId]);
    await tx.query("INSERT INTO event_dead_letters (event_id, error) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING", [eventId, error]);
  });
  deadLetters.inc({ queue: "events" });
}

/**
 * Consumes a batch; if the batch fails for a non-transient reason, falls back to
 * one-event transactions so a single poison event is dead-lettered instead of
 * blocking the queue forever.
 */
export async function consumeEventsSafely(deps: EventConsumerDeps): Promise<number> {
  try {
    return await consumeEventBatch(deps);
  } catch (batchErr) {
    deps.log.error({ err: errorMessage(batchErr) }, "event batch failed; isolating events one by one");
    let processed = 0;
    for (let i = 0; i < deps.batchSize; i++) {
      let claimed: string[] = [];
      try {
        const n = await consumeEventBatch(deps, 1, (ids) => {
          claimed = ids;
        });
        if (n === 0) break;
        processed += n;
      } catch (err) {
        const eventId = claimed[0];
        if (eventId === undefined) throw err;
        deps.log.error({ eventId, err: errorMessage(err) }, "poison event moved to dead letters");
        await deadLetterEvent(deps.pool, eventId, errorMessage(err));
      }
    }
    return processed;
  }
}