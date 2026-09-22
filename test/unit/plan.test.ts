import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { desiredPosition, planPostings, type Position } from "../../src/ledger/plan.js";

const accrued = (creatorId: string, amount: bigint, v = 1): Position => ({ bucket: "accrued", creatorId, amount, attributionVersion: v });
const payable = (creatorId: string, amount: bigint, v = 1): Position => ({ bucket: "payable", creatorId, amount, attributionVersion: v });
const types = (held: Position | null, desired: Position | null) => planPostings("ord_1", held, desired).postings.map((p) => `${p.type}:${p.creatorId}`);

describe("planPostings (table)", () => {
  it.each([
    ["nothing -> nothing", null, null, []],
    ["nothing -> accrued", null, accrued("X", 100n), ["accrue:X"]],
    ["accrued -> nothing (returned / unattributed)", accrued("X", 100n), null, ["reverse:X"]],
    ["accrued X -> accrued Y (re-attribution)", accrued("X", 100n), accrued("Y", 150n, 2), ["reverse:X", "accrue:Y"]],
    ["accrued X -> accrued X (same creator, new version)", accrued("X", 100n), accrued("X", 100n, 2), []],
    ["accrued -> payable", accrued("X", 100n), payable("X", 100n), ["make_payable:X"]],
    ["payable -> payable", payable("X", 100n), payable("X", 100n), []],
    ["payable -> nothing (returned after payable: clawback)", payable("X", 100n), null, ["reverse:X"]],
    ["payable never moves back to accrued", payable("X", 100n), accrued("X", 100n), []],
  ] as const)("%s", (_name, held, desired, expected) => {
    expect(types(held, desired)).toEqual(expected);
  });

  it("uses one idempotency key per effect and attribution version", () => {
    const plan = planPostings("ord_1", accrued("X", 100n, 1), accrued("Y", 150n, 2));
    expect(plan.postings.map((p) => p.idempotencyKey)).toEqual(["reverse:ord_1:v1", "accrue:ord_1:v2"]);
  });

  it("reverses from the bucket the commission sits in", () => {
    expect(planPostings("o", payable("X", 5n), null).postings[0]?.fromBucket).toBe("payable");
    expect(planPostings("o", accrued("X", 5n), null).postings[0]?.fromBucket).toBe("accrued");
  });
});

describe("desiredPosition", () => {
  const attr = { version: 3, attributed: true, creatorId: "X", commission: 7794n };
  const base = { deliveredAt: null, returnedAt: null, cancelledAt: null, payableAt: null };
  it("accrues only after delivery, pays after the sweep, and nothing after return/cancel", () => {
    expect(desiredPosition(base, attr)).toBeNull();
    expect(desiredPosition({ ...base, deliveredAt: 1 }, attr)).toEqual(accrued("X", 7794n, 3));
    expect(desiredPosition({ ...base, deliveredAt: 1, payableAt: 2 }, attr)).toEqual(payable("X", 7794n, 3));
    expect(desiredPosition({ ...base, deliveredAt: 1, returnedAt: 2 }, attr)).toBeNull();
    expect(desiredPosition({ ...base, deliveredAt: 1, cancelledAt: 2 }, attr)).toBeNull();
    expect(desiredPosition({ ...base, deliveredAt: 1 }, { ...attr, attributed: false, creatorId: null, commission: null })).toBeNull();
    expect(desiredPosition({ ...base, deliveredAt: 1 }, { ...attr, commission: 0n })).toBeNull();
  });
});

// Property: applying the planned postings to a simple balance model always lands
// exactly on the desired position, and every posting balances (sum of entries = 0).
const positionArb: fc.Arbitrary<Position | null> = fc.option(
  fc.record({
    bucket: fc.constantFrom<"accrued" | "payable">("accrued", "payable"),
    creatorId: fc.constantFrom("X", "Y", "Z"),
    amount: fc.bigInt({ min: 1n, max: 1_000_000n }),
    attributionVersion: fc.integer({ min: 1, max: 5 }),
  }),
);

describe("planPostings (properties)", () => {
  it("moves balances from held to desired (payable is never demoted)", () => {
    fc.assert(
      fc.property(positionArb, positionArb, (held, desired) => {
        const balances = new Map<string, bigint>();
        const add = (k: string, v: bigint) => balances.set(k, (balances.get(k) ?? 0n) + v);
        if (held) add(`${held.creatorId}:${held.bucket}`, held.amount);
        const plan = planPostings("o", held, desired);
        for (const p of plan.postings) {
          if (p.type === "accrue") add(`${p.creatorId}:accrued`, p.amount);
          if (p.type === "make_payable") {
            add(`${p.creatorId}:accrued`, -p.amount);
            add(`${p.creatorId}:payable`, p.amount);
          }
          if (p.type === "reverse") add(`${p.creatorId}:${p.fromBucket}`, -p.amount);
        }
        const nonZero = [...balances].filter(([, v]) => v !== 0n);
        for (const [, v] of nonZero) expect(v > 0n).toBe(true); // never negative
        const r = plan.resulting;
        if (r === null) expect(nonZero).toEqual([]);
        else expect(nonZero).toEqual([[`${r.creatorId}:${r.bucket}`, r.amount]]);
        // Planning again from the result is a no-op (idempotent convergence).
        expect(planPostings("o", r, desired).postings).toEqual([]);
      }),
    );
  });
});