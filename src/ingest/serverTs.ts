/**
 * serverTs derivation (assignment section 3.3).
 *
 *   offset   = receivedAt - sentAt          (sentAt = phone clock at send time)
 *   serverTs = min(receivedAt, clientTs + offset)
 *
 * One batch shares one device clock, so the offset corrects skew while
 * preserving the real order of events that were buffered offline.
 * Without a usable sentAt, serverTs = receivedAt.
 */
export function deriveServerTs(clientTs: number, receivedAt: number, sentAt: number | null): number {
  if (sentAt === null) return receivedAt;
  return Math.min(receivedAt, clientTs + (receivedAt - sentAt));
}