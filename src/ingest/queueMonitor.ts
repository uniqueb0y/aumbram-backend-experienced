import type { Pool } from "../db/pool.js";
import type { Logger } from "../lib/logger.js";
import { errorMessage } from "../lib/errors.js";

export interface QueueStats {
  /** Queue depth, counted up to `depthCap` (enough to decide saturation cheaply). */
  eventDepth: number;
  eventOldestAgeSeconds: number;
  orderDepth: number;
  observedAt: number;
}

/** Reads queue depth and age of the oldest item. Uses DB time so app/DB clock skew does not matter. */
export async function readQueueStats(pool: Pool, depthCap: number): Promise<QueueStats> {
  const { rows } = await pool.query<{ event_depth: bigint; oldest_age: number | null; order_depth: bigint }>(
    `SELECT
       (SELECT count(*) FROM (SELECT 1 FROM event_queue LIMIT $1) q) AS event_depth,
       (SELECT extract(epoch FROM now() - enqueued_at)::float8 FROM event_queue ORDER BY seq LIMIT 1) AS oldest_age,
       (SELECT count(*) FROM (SELECT 1 FROM order_event_queue LIMIT $1) q) AS order_depth`,
    [depthCap],
  );
  const row = rows[0];
  return {
    eventDepth: Number(row?.event_depth ?? 0n),
    eventOldestAgeSeconds: Math.max(0, row?.oldest_age ?? 0),
    orderDepth: Number(row?.order_depth ?? 0n),
    observedAt: Date.now(),
  };
}

export interface SaturationPolicy {
  maxDepth: number;
  maxLagSeconds: number;
  retryAfterSeconds: number;
}

export type Saturation = { saturated: false } | { saturated: true; reason: string; retryAfterSeconds: number };

/**
 * Polls queue stats in the background so the ingest hot path never counts rows.
 * Ingestion sheds load (503) while the queue is over its depth or lag budget.
 */
export class QueueMonitor {
  private stats: QueueStats | null = null;
  private timer: NodeJS.Timeout | null = null;
  private onStats: ((s: QueueStats) => void) | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly policy: SaturationPolicy,
    private readonly intervalMs: number,
    private readonly log: Logger,
  ) {}

  subscribe(fn: (s: QueueStats) => void): void {
    this.onStats = fn;
  }

  async refresh(): Promise<QueueStats | null> {
    try {
      this.stats = await readQueueStats(this.pool, this.policy.maxDepth + 1);
      this.onStats?.(this.stats);
    } catch (err) {
      this.log.warn({ err: errorMessage(err) }, "queue monitor refresh failed");
    }
    return this.stats;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current(): QueueStats | null {
    return this.stats;
  }

  saturation(): Saturation {
    const s = this.stats;
    if (s === null) return { saturated: false };
    if (s.eventDepth >= this.policy.maxDepth) {
      return { saturated: true, reason: `queue depth ${s.eventDepth} >= ${this.policy.maxDepth}`, retryAfterSeconds: this.policy.retryAfterSeconds };
    }
    if (s.eventOldestAgeSeconds >= this.policy.maxLagSeconds) {
      return {
        saturated: true,
        reason: `queue lag ${s.eventOldestAgeSeconds.toFixed(1)}s >= ${this.policy.maxLagSeconds}s`,
        retryAfterSeconds: this.policy.retryAfterSeconds,
      };
    }
    return { saturated: false };
  }
}