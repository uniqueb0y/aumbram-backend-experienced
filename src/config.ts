/**
 * Configuration from environment variables, validated once at startup.
 * Any invalid value stops the process with a list of every problem found.
 */
export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  appKey: string;
  internalToken: string;
  logLevel: string;
  pgPoolMax: number;
  ingest: {
    maxEvents: number;
    maxBytes: number;
    rateLimitEventsPerSec: number;
    rateLimitBurst: number;
  };
  queue: {
    maxDepth: number;
    maxLagSeconds: number;
    retryAfterSeconds: number;
    monitorIntervalMs: number;
  };
  worker: {
    eventConsumers: number;
    eventBatchSize: number;
    orderConsumers: number;
    idlePollMs: number;
    metricsPort: number;
    sweepIntervalSeconds: number;
    invariantCheckIntervalSeconds: number;
  };
  attributionRuleVersion: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const str = (name: string, fallback?: string): string => {
    const value = env[name] ?? fallback;
    if (value === undefined || value.trim() === "") {
      problems.push(`${name} is required`);
      return "";
    }
    return value;
  };

  const int = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
      return fallback;
    }
    return value;
  };

  const config: Config = {
    databaseUrl: str("DATABASE_URL"),
    host: env.HOST ?? "0.0.0.0",
    port: int("PORT", 8080, 1, 65535),
    appKey: str("APP_KEY"),
    internalToken: str("INTERNAL_TOKEN"),
    logLevel: env.LOG_LEVEL ?? "info",
    pgPoolMax: int("PG_POOL_MAX", 20, 2, 500),
    ingest: {
      maxEvents: int("INGEST_MAX_EVENTS", 500, 1, 10_000),
      maxBytes: int("INGEST_MAX_BYTES", 1_048_576, 1024),
      rateLimitEventsPerSec: int("RATE_LIMIT_EVENTS_PER_SEC", 10_000, 1),
      rateLimitBurst: int("RATE_LIMIT_BURST", 20_000, 1),
    },
    queue: {
      maxDepth: int("QUEUE_MAX_DEPTH", 200_000, 1),
      maxLagSeconds: int("QUEUE_MAX_LAG_SECONDS", 60, 1),
      retryAfterSeconds: int("QUEUE_RETRY_AFTER_SECONDS", 5, 1, 3600),
      monitorIntervalMs: int("QUEUE_MONITOR_INTERVAL_MS", 1000, 100),
    },
    worker: {
      eventConsumers: int("WORKER_EVENT_CONSUMERS", 2, 0, 64),
      eventBatchSize: int("WORKER_EVENT_BATCH_SIZE", 1000, 1, 10_000),
      orderConsumers: int("WORKER_ORDER_CONSUMERS", 2, 0, 64),
      idlePollMs: int("WORKER_IDLE_POLL_MS", 200, 10, 10_000),
      metricsPort: int("WORKER_METRICS_PORT", 9091, 1, 65535),
      sweepIntervalSeconds: int("SWEEP_INTERVAL_SECONDS", 0, 0),
      invariantCheckIntervalSeconds: int("INVARIANT_CHECK_INTERVAL_SECONDS", 60, 0),
    },
    attributionRuleVersion: env.ATTRIBUTION_RULE_VERSION ?? "v1",
  };

  if (config.appKey !== "" && config.appKey === config.internalToken) {
    problems.push("APP_KEY and INTERNAL_TOKEN must differ (internal endpoints must not open with the app key)");
  }
  if (config.ingest.rateLimitBurst < config.ingest.maxEvents) {
    problems.push("RATE_LIMIT_BURST must be >= INGEST_MAX_EVENTS, otherwise a full batch can never be admitted");
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}