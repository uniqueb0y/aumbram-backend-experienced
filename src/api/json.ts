import { toJsonAmount } from "../lib/money.js";

/** bigint counters and ids -> JSON numbers, refusing values that would lose precision. */
export const safeNumber = toJsonAmount;

export function encodeCursor(entryId: bigint): string {
  return Buffer.from(`e:${entryId.toString()}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): bigint | null {
  if (cursor === undefined || cursor === "") return 0n;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const m = /^e:(\d{1,19})$/.exec(decoded);
  return m?.[1] ? BigInt(m[1]) : null;
}