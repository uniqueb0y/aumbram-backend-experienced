import type { Pool, PoolClient } from "./pool.js";
import { sleep } from "../lib/sleep.js";

export type Isolation = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface TxOptions {
  isolation?: Isolation;
  readOnly?: boolean;
  /** Retries on serialization failure (40001) and deadlock (40P01). */
  maxRetries?: number;
}

const RETRYABLE = new Set(["40001", "40P01"]);

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

export function isRetryable(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code !== undefined && RETRYABLE.has(code);
}

/** Runs `fn` inside a transaction, committing on success and rolling back on error. */
export async function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>, options: TxOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      const mode = [`ISOLATION LEVEL ${options.isolation ?? "READ COMMITTED"}`, options.readOnly ? "READ ONLY" : "READ WRITE"];
      await client.query(`BEGIN ${mode.join(" ")}`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        // The connection is unusable; release it with an error so the pool discards it.
        broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      if (isRetryable(err) && attempt < maxRetries) {
        await sleep(10 * 2 ** attempt + Math.floor(Math.random() * 10));
        continue;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }
}