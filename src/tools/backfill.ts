/**
 * Historical import (BE-E-21): loads events.csv TRUSTING its server_ts column
 * (no section 3.3 derivation) and enqueues the new events, so the normal consumer
 * path indexes them and re-evaluates provisional orders. Idempotent: re-running
 * inserts nothing new (primary-key dedupe).
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Pool } from "../db/pool.js";
import { storeEvents, type EventRow } from "../ingest/store.js";
import { validateEvent } from "../ingest/validate.js";
import { parseIsoTimestamp } from "../lib/time.js";
import { CSV_HEADER, csvEventToApiEvent, parseCsvLine, toCsvEvent } from "./csv.js";

export interface BackfillResult {
  rows: number;
  inserted: number;
  duplicates: number;
  rejected: number;
}

export async function backfillEventsCsv(pool: Pool, file: string, batchSize = 1000): Promise<BackfillResult> {
  const result: BackfillResult = { rows: 0, inserted: 0, duplicates: 0, rejected: 0 };
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  const batchId = randomUUID();
  let pending = new Map<string, EventRow>();
  let pendingValid = 0;

  const flush = async () => {
    if (pending.size === 0) return;
    const inserted = await storeEvents(pool, [...pending.values()]);
    result.inserted += inserted.length;
    result.duplicates += pendingValid - inserted.length;
    pending = new Map();
    pendingValid = 0;
  };

  let first = true;
  for await (const line of lines) {
    if (first) {
      first = false;
      if (line.trim() === CSV_HEADER) continue;
    }
    if (line.trim() === "") continue;
    result.rows++;
    const csv = toCsvEvent(parseCsvLine(line));
    const serverTs = csv ? parseIsoTimestamp(csv.serverTs) : null;
    const check = csv ? validateEvent(csvEventToApiEvent(csv)) : null;
    if (csv === null || serverTs === null || check === null || !check.ok) {
      result.rejected++;
      continue;
    }
    const e = check.event;
    pendingValid++;
    if (!pending.has(e.id)) {
      pending.set(e.id, {
        id: e.id,
        userId: e.userId,
        sessionId: e.sessionId,
        name: e.name,
        props: e.props,
        clientTs: e.clientTs,
        receivedAt: serverTs, // historical mode: trust server_ts
        serverTs,
        device: e.device,
        batchId,
        source: "backfill",
      });
    }
    if (pending.size >= batchSize) await flush();
  }
  await flush();
  return result;
}