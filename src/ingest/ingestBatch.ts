import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/pool.js";
import { deriveServerTs } from "./serverTs.js";
import { storeEvents, type EventRow } from "./store.js";
import { validateEvent, type Rejection, type ValidEvent } from "./validate.js";

export interface IngestOutcome {
  batchId: string;
  receivedAt: number;
  /** Valid events newly stored and enqueued. */
  accepted: number;
  /** Valid events that were already stored (earlier batch, retry, or repeated within this batch). */
  duplicates: number;
  rejected: Rejection[];
}

/**
 * Validates each event independently (partial acceptance), derives serverTs,
 * collapses in-batch duplicates, and stores the rest. When this resolves, every
 * accepted event is committed to Postgres.
 */
export async function ingestEvents(
  db: Queryable,
  rawEvents: readonly unknown[],
  sentAt: number | null,
  receivedAt: number,
  batchId: string = randomUUID(),
): Promise<IngestOutcome> {
  const rejected: Rejection[] = [];
  const unique = new Map<string, ValidEvent>();
  let validCount = 0;

  rawEvents.forEach((raw, index) => {
    const check = validateEvent(raw);
    if (!check.ok) {
      const rawId = typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string" ? raw.id : null;
      rejected.push({ index, id: rawId, code: check.code, message: check.message });
      return;
    }
    validCount++;
    if (!unique.has(check.event.id)) unique.set(check.event.id, check.event);
  });

  const rows: EventRow[] = [...unique.values()].map((e) => ({
    id: e.id,
    userId: e.userId,
    sessionId: e.sessionId,
    name: e.name,
    props: e.props,
    clientTs: e.clientTs,
    receivedAt,
    serverTs: deriveServerTs(e.clientTs, receivedAt, sentAt),
    device: e.device,
    batchId,
    source: "live",
  }));

  const inserted = await storeEvents(db, rows);
  return { batchId, receivedAt, accepted: inserted.length, duplicates: validCount - inserted.length, rejected };
}