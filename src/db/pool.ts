import pg from "pg";

// BIGINT (int8) and NUMERIC come back as strings by default. We only ever store
// integer paise and integer sums, so parse both to bigint and never to number.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => BigInt(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => BigInt(value));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: a pool or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max: number, applicationName: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: applicationName,
    // Fail fast when the pool is exhausted so ingestion can answer 503 instead of queueing forever.
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on("error", () => undefined);
  return pool;
}