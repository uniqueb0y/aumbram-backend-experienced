import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "./pool.js";
import { withTransaction } from "./tx.js";

const MIGRATION_LOCK_KEY = 72_000_001;

/** Applies every not-yet-applied `NNN_name.sql` file in order, each in its own transaction. */
export async function migrate(pool: Pool, dir: string, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    const didApply = await withTransaction(pool, async (tx) => {
      // Serialise concurrent migrators (e.g. several containers starting at once).
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const exists = await tx.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
      if (exists.rowCount) return false;
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      return true;
    });
    if (didApply) {
      applied.push(file);
      log(`applied migration ${file}`);
    }
  }
  return applied;
}