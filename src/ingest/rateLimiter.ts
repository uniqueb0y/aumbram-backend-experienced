import type { Clock } from "../lib/time.js";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Token bucket per client key, counted in events (not requests), because a
 * batch can hold 1-500 events. In-memory and per instance (see DECISIONS D-008).
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly clock: Clock,
    private readonly maxKeys = 50_000,
  ) {}

  take(key: string, cost: number): TakeResult {
    const now = this.clock.now();
    const bucket = this.refill(key, now);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true };
    }
    const deficit = cost - bucket.tokens;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(deficit / this.ratePerSecond)) };
  }

  private refill(key: string, now: number): Bucket {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.evictIdle(now);
      bucket = { tokens: this.burst, updatedAt: now };
      this.buckets.set(key, bucket);
      return bucket;
    }
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSeconds * this.ratePerSecond);
    bucket.updatedAt = now;
    return bucket;
  }

  /** Drops buckets that are full again (idle long enough to have refilled), bounding memory. */
  private evictIdle(now: number): void {
    const fullAfterMs = (this.burst / this.ratePerSecond) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= fullAfterMs) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) this.buckets.delete(oldest.value);
    }
  }
}