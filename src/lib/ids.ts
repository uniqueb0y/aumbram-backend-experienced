const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Normalises a client event id to its dedupe key: the lower-cased UUID with an
 * optional `evt_` prefix removed. `evt_<uuid>` and `<uuid>` are the same event.
 */
export function normalizeEventId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const lowered = raw.toLowerCase();
  const bare = lowered.startsWith("evt_") ? lowered.slice(4) : lowered;
  return UUID_RE.test(bare) ? bare : null;
}