/**
 * Money is integer paise, carried as `bigint` from the database to the HTTP edge.
 * Floats are never used for amounts.
 */
export const CURRENCY = "INR";

export interface MoneyJson {
  amount: number;
  currency: string;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** floor(subtotal * rateBps / 10000) with integer arithmetic only. */
export function commissionFor(subtotalPaise: bigint, rateBps: number): bigint {
  if (subtotalPaise < 0n) throw new RangeError(`subtotal must be >= 0, got ${subtotalPaise}`);
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new RangeError(`commission rate must be an integer in [0, 10000] bps, got ${rateBps}`);
  }
  // BigInt division truncates toward zero, which equals floor for non-negative operands.
  return (subtotalPaise * BigInt(rateBps)) / 10_000n;
}

/** Converts paise to a JSON number, refusing values that would lose precision. */
export function toJsonAmount(paise: bigint): number {
  if (paise > MAX_SAFE || paise < -MAX_SAFE) {
    throw new RangeError(`amount ${paise} cannot be represented exactly in JSON`);
  }
  return Number(paise);
}

export function moneyJson(paise: bigint): MoneyJson {
  return { amount: toJsonAmount(paise), currency: CURRENCY };
}

/** Parses a JSON amount into paise. Only non-negative safe integers are accepted. */
export function parsePaise(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return BigInt(value);
}