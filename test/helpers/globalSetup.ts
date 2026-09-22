import pg from "pg";
import { resolve } from "node:path";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { TEST_DB_URL } from "./env.js";

/**
 * Creates the test database if needed and applies migrations. If Postgres is
 * not reachable, pure unit tests still run; integration tests will fail with a
 * connection error that says what to start.
 */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DB_URL);
  const dbName = url.pathname.replace(/^\//, "");
  const adminUrl = new URL(TEST_DB_URL);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    process.stderr.write(
      `\n[test setup] Postgres not reachable at ${adminUrl.host} (${err instanceof Error ? err.message : String(err)}).\n` +
        "[test setup] Start it with `docker compose up -d postgres`. Only pure unit tests will pass.\n\n",
    );
    return;
  }
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, "")}"`);
  } finally {
    await admin.end();
  }

  const pool = createPool(TEST_DB_URL, 2, "aumbram-test-setup");
  try {
    await migrate(pool, resolve("migrations"));
  } finally {
    await pool.end();
  }
}