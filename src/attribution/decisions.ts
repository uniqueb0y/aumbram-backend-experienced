import type { Queryable } from "../db/pool.js";
import { ms, msOrNull } from "../db/rows.js";

export type DecisionReason = "initial" | "late_event" | "reattribution_job";

export interface DecisionRow {
  orderId: string;
  version: number;
  attributed: boolean;
  storyId: string | null;
  creatorId: string | null;
  qualifyingEventId: string | null;
  qualifyingEventName: string | null;
  qualifyingServerTs: number | null;
  anchorSource: "checkout_start" | "order_created";
  anchorAt: number;
  anchorEventId: string | null;
  commissionRateBps: number | null;
  commissionPaise: bigint | null;
  ruleVersion: string;
  reason: DecisionReason;
  triggerEventId: string | null;
  decidedAt: number;
}

interface DecisionDbRow {
  order_id: string;
  version: number;
  attributed: boolean;
  story_id: string | null;
  creator_id: string | null;
  qualifying_event_id: string | null;
  qualifying_event_name: string | null;
  qualifying_server_ts: Date | null;
  anchor_source: "checkout_start" | "order_created";
  anchor_at: Date;
  anchor_event_id: string | null;
  commission_rate_bps: number | null;
  commission_paise: bigint | null;
  rule_version: string;
  reason: DecisionReason;
  trigger_event_id: string | null;
  decided_at: Date;
}

const DECISION_COLUMNS = `order_id, version, attributed, story_id, creator_id, qualifying_event_id::text,
  qualifying_event_name, qualifying_server_ts, anchor_source, anchor_at, anchor_event_id::text,
  commission_rate_bps, commission_paise, rule_version, reason, trigger_event_id::text, decided_at`;

function mapDecision(r: DecisionDbRow): DecisionRow {
  return {
    orderId: r.order_id,
    version: r.version,
    attributed: r.attributed,
    storyId: r.story_id,
    creatorId: r.creator_id,
    qualifyingEventId: r.qualifying_event_id,
    qualifyingEventName: r.qualifying_event_name,
    qualifyingServerTs: msOrNull(r.qualifying_server_ts),
    anchorSource: r.anchor_source,
    anchorAt: ms(r.anchor_at),
    anchorEventId: r.anchor_event_id,
    commissionRateBps: r.commission_rate_bps,
    commissionPaise: r.commission_paise,
    ruleVersion: r.rule_version,
    reason: r.reason,
    triggerEventId: r.trigger_event_id,
    decidedAt: ms(r.decided_at),
  };
}

export async function getDecision(db: Queryable, orderId: string, version: number): Promise<DecisionRow | null> {
  if (version < 1) return null;
  const { rows } = await db.query<DecisionDbRow>(
    `SELECT ${DECISION_COLUMNS} FROM attribution_decisions WHERE order_id = $1 AND version = $2`,
    [orderId, version],
  );
  return rows[0] ? mapDecision(rows[0]) : null;
}

export async function listDecisions(db: Queryable, orderId: string): Promise<DecisionRow[]> {
  const { rows } = await db.query<DecisionDbRow>(
    `SELECT ${DECISION_COLUMNS} FROM attribution_decisions WHERE order_id = $1 ORDER BY version`,
    [orderId],
  );
  return rows.map(mapDecision);
}

export interface NewDecision {
  orderId: string;
  version: number;
  attributed: boolean;
  storyId: string | null;
  creatorId: string | null;
  qualifyingEventId: string | null;
  qualifyingEventName: string | null;
  qualifyingServerTs: number | null;
  anchorSource: "checkout_start" | "order_created";
  anchorAt: number;
  anchorEventId: string | null;
  commissionRateBps: number | null;
  commissionPaise: bigint | null;
  ruleVersion: string;
  reason: DecisionReason;
  triggerEventId: string | null;
}

export async function insertDecision(tx: Queryable, d: NewDecision): Promise<DecisionRow> {
  const toTs = (v: number | null) => (v === null ? null : new Date(v).toISOString());
  const { rows } = await tx.query<DecisionDbRow>(
    `INSERT INTO attribution_decisions (order_id, version, attributed, story_id, creator_id, qualifying_event_id,
       qualifying_event_name, qualifying_server_ts, anchor_source, anchor_at, anchor_event_id, commission_rate_bps,
       commission_paise, rule_version, reason, trigger_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${DECISION_COLUMNS}`,
    [
      d.orderId,
      d.version,
      d.attributed,
      d.storyId,
      d.creatorId,
      d.qualifyingEventId,
      d.qualifyingEventName,
      toTs(d.qualifyingServerTs),
      d.anchorSource,
      toTs(d.anchorAt),
      d.anchorEventId,
      d.commissionRateBps,
      d.commissionPaise === null ? null : d.commissionPaise.toString(),
      d.ruleVersion,
      d.reason,
      d.triggerEventId,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("decision insert returned no row");
  return mapDecision(row);
}