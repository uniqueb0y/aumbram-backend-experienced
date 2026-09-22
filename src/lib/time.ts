export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// Strict ISO-8601 with an explicit offset: 2026-09-13T08:30:00Z / 2026-09-13T08:30:00.123+05:30
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Parses a strict ISO-8601 timestamp to epoch milliseconds, or null if invalid. */
export function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO_RE.exec(value);
  if (!m) return null;
  // Normalise fractional seconds to milliseconds so Date.parse behaves identically everywhere.
  const fraction = m[2] ? m[2].slice(0, 4).padEnd(4, "0") : "";
  const ms = Date.parse(`${m[1]}${fraction}${m[3]}`);
  return Number.isFinite(ms) ? ms : null;
}

/** Formats epoch ms as ISO-8601 UTC, omitting milliseconds when they are zero. */
export function toIso(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}

/** Injectable clock, so tests and the sweep can control "now". */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function fixedClock(start: number): Clock & { set(ms: number): void; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}