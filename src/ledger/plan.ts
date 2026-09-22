/**
 * Pure ledger planning: given what the ledger currently holds for an order and
 * what it should hold, return the ledger transactions that move one to the other.
 *
 * Because effects are derived from state rather than from individual order
 * events, duplicated or out-of-order messages converge to the same ledger, and
 * re-running the planner on a settled order is a no-op.
 */
export type Bucket = "accrued" | "payable";

/** Commission held (or to be held) for one order. */
export interface Position {
  bucket: Bucket;
  creatorId: string;
  amount: bigint;
  /** Attribution version that produced this accrual (part of the idempotency key). */
  attributionVersion: number;
}

export type PostingType = "accrue" | "make_payable" | "reverse";

export interface PlannedPosting {
  type: PostingType;
  orderId: string;
  creatorId: string;
  amount: bigint;
  attributionVersion: number;
  /** For `reverse`: the bucket the commission is taken back from. */
  fromBucket: Bucket | null;
  idempotencyKey: string;
}

export interface OrderMoneyState {
  deliveredAt: number | null;
  returnedAt: number | null;
  cancelledAt: number | null;
  payableAt: number | null;
}

export interface CurrentAttribution {
  version: number;
  attributed: boolean;
  creatorId: string | null;
  commission: bigint | null;
}

/** What the ledger should hold for an order right now. */
export function desiredPosition(order: OrderMoneyState, attribution: CurrentAttribution | null): Position | null {
  if (order.deliveredAt === null) return null; // accrues on delivered
  if (order.returnedAt !== null || order.cancelledAt !== null) return null; // reversed / never earned
  if (attribution === null || !attribution.attributed || attribution.creatorId === null || attribution.commission === null) {
    return null;
  }
  if (attribution.commission === 0n) return null; // nothing to post (zero-value entries are not allowed)
  return {
    bucket: order.payableAt !== null ? "payable" : "accrued",
    creatorId: attribution.creatorId,
    amount: attribution.commission,
    attributionVersion: attribution.version,
  };
}

function posting(type: PostingType, orderId: string, p: Position, fromBucket: Bucket | null): PlannedPosting {
  const prefix = type === "make_payable" ? "payable" : type;
  return {
    type,
    orderId,
    creatorId: p.creatorId,
    amount: p.amount,
    attributionVersion: p.attributionVersion,
    fromBucket,
    idempotencyKey: `${prefix}:${orderId}:v${p.attributionVersion}`,
  };
}

export interface Plan {
  postings: PlannedPosting[];
  /** Position after the postings are applied. */
  resulting: Position | null;
}

export function planPostings(orderId: string, held: Position | null, desired: Position | null): Plan {
  if (held !== null && desired !== null && held.creatorId === desired.creatorId && held.amount === desired.amount) {
    // Same creator and amount: at most move accrued -> payable. Payable never moves back to accrued.
    if (held.bucket === "accrued" && desired.bucket === "payable") {
      return { postings: [posting("make_payable", orderId, held, null)], resulting: { ...held, bucket: "payable" } };
    }
    return { postings: [], resulting: held };
  }

  const postings: PlannedPosting[] = [];
  if (held !== null) postings.push(posting("reverse", orderId, held, held.bucket));
  if (desired !== null) {
    postings.push(posting("accrue", orderId, desired, null));
    if (desired.bucket === "payable") postings.push(posting("make_payable", orderId, desired, null));
  }
  return { postings, resulting: desired };
}