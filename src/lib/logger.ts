import { pino, type Logger } from "pino";

/**
 * JSON logs. Secrets are redacted. Request bodies are never logged, and order
 * events are logged by id only, because snapshots can carry PII.
 */
export const redactPaths = [
  "req.headers[\"x-app-key\"]",
  "req.headers[\"x-internal-token\"]",
  "req.headers.authorization",
  "*.phone",
  "*.shippingAddress",
];

export function createLogger(level: string, name: string): Logger {
  return pino({ level, name, redact: { paths: redactPaths, censor: "[redacted]" } });
}

export type { Logger };