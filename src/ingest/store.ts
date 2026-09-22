import type { Queryable } from "../db/pool.js";

/** One row for the `events` table, ready to insert. Timestamps are epoch ms. */
export interface EventRow {
  id: string;
  userId: string | null;
  sessionId: string;
  name: string;
  props: Record<string, unknown>;
  clientTs: number;
  receivedAt: number;
  serverTs: number;
  device: Record<string, unknown> | null;
  batchId: string;
  source: "live" | "backfill";
}

/**
 * Durably stores events and enqueues the new ones in ONE statement (one
 * implicit transaction). Returns the ids that were newly inserted; the rest
 * were duplicates of events already stored.
 *
 * Rows are inserted in id order so that concurrent batches containing the same
 * ids acquire row locks in the same order and cannot deadlock.
 */
export async function storeEvents(db: Queryable, rows: readonly EventRow[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const payload = rows.map((r) => ({
    id: r.id,
    user_id: r.userId,
    session_id: r.sessionId,
    name: r.name,
    props: r.props,
    client_ts: new Date(r.clientTs).toISOString(),
    received_at: new Date(r.receivedAt).toISOString(),
    server_ts: new Date(r.serverTs).toISOString(),
    device: r.device,
    batch_id: r.batchId,
    source: r.source,
  }));
  const result = await db.query<{ event_id: string }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         id uuid, user_id text, session_id text, name text, props jsonb,
         client_ts timestamptz, received_at timestamptz, server_ts timestamptz,
         device jsonb, batch_id uuid, source text)
     ), inserted AS (
       INSERT INTO events (id, user_id, session_id, name, props, client_ts, received_at, server_ts, device, batch_id, source)
       SELECT id, user_id, session_id, name, props, client_ts, received_at, server_ts, device, batch_id, source
       FROM input ORDER BY id
       ON CONFLICT (id) DO NOTHING
       RETURNING id
     )
     INSERT INTO event_queue (event_id)
     SELECT id FROM inserted ORDER BY id
     RETURNING event_id::text`,
    [JSON.stringify(payload)],
  );
  return result.rows.map((r) => r.event_id);
}