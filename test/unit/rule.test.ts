/**
 * BE-E-13: attribution edge cases on the pure rule (no database).
 * Timestamps are epoch ms; T is the anchor (a checkout_start one minute before createdAt).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { attribute, computeAnchor, type Checkout, type Interaction, type StoryRef } from "../../src/attribution/rule.js";
import { getRule } from "../../src/attribution/ruleConfig.js";
import { deriveServerTs } from "../../src/ingest/serverTs.js";
import { HOUR, MINUTE, SECOND } from "../../src/lib/time.js";

const rule = getRule("v1");
const T = Date.parse("2026-09-13T08:39:10Z");
const CREATED = T + MINUTE;

const stories = new Map<string, StoryRef>([
  ["sty_0108", { creatorId: "crt_0001", taggedProductIds: new Set(["prd_0031"]) }],
  ["sty_0109", { creatorId: "crt_0015", taggedProductIds: new Set(["prd_0006"]) }],
  ["sty_0200", { creatorId: "crt_0099", taggedProductIds: new Set(["prd_0031"]) }],
  ["sty_0300", { creatorId: "crt_0099", taggedProductIds: new Set(["prd_0032"]) }], // other product, same vendor
]);

const order = (productIds: string[] = ["prd_0031"], userId = "usr_A") => ({ userId, createdAt: CREATED, productIds: new Set(productIds) });
const checkoutAt = (serverTs: number, userId: string | null = "usr_A"): Checkout => ({ eventId: `c-${serverTs}`, userId, serverTs });
const anchorCheckout = [checkoutAt(T)];

let n = 0;
function view(storyId: string, watchMs: number | null, serverTs: number, over: Partial<Interaction> = {}): Interaction {
  n++;
  return { eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: "story_view", userId: "usr_A", serverTs, receivedAt: serverTs + SECOND, storyId, productId: null, watchMs, ...over };
}
function tap(storyId: string, productId: string, serverTs: number, over: Partial<Interaction> = {}): Interaction {
  n++;
  return { eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: "story_product_tap", userId: "usr_A", serverTs, receivedAt: serverTs + SECOND, storyId, productId, watchMs: null, ...over };
}

function winner(interactions: Interaction[], productIds?: string[], checkouts: Checkout[] = anchorCheckout) {
  const r = attribute(order(productIds), checkouts, interactions, stories, rule);
  return r.attributed ? { storyId: r.storyId, creatorId: r.creatorId, eventId: r.winner.eventId } : null;
}

describe("attribution rule: window boundaries", () => {
  it("counts an interaction exactly 72 h before the anchor (inclusive)", () => {
    const v = view("sty_0108", 4000, T - 72 * HOUR);
    expect(winner([v])?.eventId).toBe(v.eventId);
  });

  it("ignores an interaction 72 h + 1 s before the anchor", () => {
    expect(winner([view("sty_0108", 4000, T - 72 * HOUR - SECOND)])).toBeNull();
  });

  it("counts an interaction exactly at the anchor, ignores one 1 ms after it", () => {
    const atAnchor = view("sty_0108", 4000, T);
    expect(winner([atAnchor])?.eventId).toBe(atAnchor.eventId);
    expect(winner([view("sty_0108", 4000, T + 1)])).toBeNull();
  });
});

describe("attribution rule: qualifying interactions", () => {
  it("story_view needs watchMs >= 3000: 2999 does not qualify, 3000 does", () => {
    expect(winner([view("sty_0108", 2999, T - HOUR)])).toBeNull();
    expect(winner([view("sty_0108", 3000, T - HOUR)])?.storyId).toBe("sty_0108");
  });

  it("a non-integer or missing watchMs never qualifies", () => {
    expect(winner([view("sty_0108", 3000.5, T - HOUR)])).toBeNull();
    expect(winner([view("sty_0108", null, T - HOUR)])).toBeNull();
  });

  it("a view of a story tagging only ANOTHER product of the same vendor does not match", () => {
    expect(winner([view("sty_0300", 10_000, T - HOUR)], ["prd_0031"])).toBeNull();
  });

  it("a tap on a product that is in a different order of the same checkout does not match this order", () => {
    const tapOther = tap("sty_0109", "prd_0006", T - HOUR);
    expect(winner([tapOther], ["prd_0031"])).toBeNull(); // vnd_0024 order
    expect(winner([tapOther], ["prd_0006"])?.creatorId).toBe("crt_0015"); // vnd_0016 order, same anchor
  });

  it("a newer non-qualifying event does not displace an older qualifying one", () => {
    const old = view("sty_0108", 4200, T - 50 * HOUR);
    const tooShort = view("sty_0200", 1500, T - HOUR);
    const otherProductTap = tap("sty_0200", "prd_0006", T - 30 * MINUTE);
    expect(winner([old, tooShort, otherProductTap])?.eventId).toBe(old.eventId);
  });

  it("ignores logged-out events and other users' events", () => {
    expect(winner([view("sty_0108", 5000, T - HOUR, { userId: null })])).toBeNull();
    expect(winner([view("sty_0108", 5000, T - HOUR, { userId: "usr_B" })])).toBeNull();
  });

  it("ignores unknown stories (even with a matching tapped product)", () => {
    expect(winner([view("sty_9999", 5000, T - HOUR)])).toBeNull();
    expect(winner([tap("sty_9999", "prd_0031", T - HOUR)])).toBeNull();
  });

  it("takes the creator from the story, never from client props", () => {
    // Interactions carry no creatorId at all; the creator comes from the story lookup.
    expect(winner([tap("sty_0200", "prd_0031", T - HOUR)])?.creatorId).toBe("crt_0099");
  });
});

describe("attribution rule: winner and ties", () => {
  it("picks the greatest serverTs", () => {
    const a = view("sty_0108", 5000, T - 5 * HOUR);
    const b = tap("sty_0200", "prd_0031", T - 2 * HOUR);
    expect(winner([a, b])?.eventId).toBe(b.eventId);
    expect(winner([b, a])?.eventId).toBe(b.eventId);
  });

  it("breaks a serverTs tie on greater receivedAt, then on greater event id", () => {
    const ts = T - HOUR;
    const early = view("sty_0108", 5000, ts, { eventId: "ffffffff-0000-4000-8000-000000000000", receivedAt: ts + 1000 });
    const late = tap("sty_0200", "prd_0031", ts, { eventId: "00000000-0000-4000-8000-000000000000", receivedAt: ts + 2000 });
    expect(winner([early, late])?.eventId).toBe(late.eventId);

    const x = view("sty_0108", 5000, ts, { eventId: "aaaaaaaa-0000-4000-8000-000000000000", receivedAt: ts });
    const y = tap("sty_0200", "prd_0031", ts, { eventId: "bbbbbbbb-0000-4000-8000-000000000000", receivedAt: ts });
    expect(winner([x, y])?.eventId).toBe(y.eventId);
    expect(winner([y, x])?.eventId).toBe(y.eventId);
  });
});

describe("attribution rule: anchor", () => {
  it("falls back to order.createdAt when there is no checkout_start", () => {
    expect(computeAnchor(order(), [], rule)).toEqual({ source: "order_created", at: CREATED, eventId: null });
    // Interaction between T and createdAt only counts because the anchor moved to createdAt.
    const betweenCheckoutAndOrder = view("sty_0108", 5000, T + 30 * SECOND);
    expect(winner([betweenCheckoutAndOrder], undefined, [])?.eventId).toBe(betweenCheckoutAndOrder.eventId);
    expect(winner([betweenCheckoutAndOrder], undefined, anchorCheckout)).toBeNull();
  });

  it("uses the latest checkout_start within [createdAt - 1 h, createdAt]", () => {
    const anchors = [checkoutAt(CREATED - HOUR - 1), checkoutAt(CREATED - 20 * MINUTE), checkoutAt(CREATED - 5 * MINUTE), checkoutAt(CREATED + 1)];
    expect(computeAnchor(order(), anchors, rule)).toMatchObject({ source: "checkout_start", at: CREATED - 5 * MINUTE });
  });

  it("accepts a checkout exactly 1 h before createdAt, ignores other users' checkouts", () => {
    expect(computeAnchor(order(), [checkoutAt(CREATED - HOUR)], rule)).toMatchObject({ at: CREATED - HOUR });
    expect(computeAnchor(order(), [checkoutAt(CREATED - MINUTE, "usr_B")], rule).source).toBe("order_created");
  });
});

describe("attribution rule: skewed device clock corrected by sentAt (section 3.3)", () => {
  it("reproduces the assignment example: phone 5.5 h fast", () => {
    const receivedAt = Date.parse("2026-09-13T08:35:12Z");
    const sentAt = Date.parse("2026-09-13T14:05:09Z");
    const clientTs = Date.parse("2026-09-13T14:04:31Z");
    expect(new Date(deriveServerTs(clientTs, receivedAt, sentAt)).toISOString()).toBe("2026-09-13T08:34:34.000Z");
  });

  it("a view that looks 5 h in the future on the phone lands inside the window once corrected", () => {
    const skew = 5 * HOUR;
    const receivedAt = T + 10 * SECOND;
    const phoneClientTs = T - 2 * HOUR + skew;
    const serverTs = deriveServerTs(phoneClientTs, receivedAt, receivedAt + skew);
    expect(serverTs).toBe(T - 2 * HOUR);
    const raw = view("sty_0108", 4000, phoneClientTs);
    const corrected = view("sty_0108", 4000, serverTs);
    expect(winner([raw])).toBeNull(); // uncorrected: after the anchor, ignored
    expect(winner([corrected])?.storyId).toBe("sty_0108");
  });

  it("never puts serverTs after receivedAt, and uses receivedAt without sentAt", () => {
    expect(deriveServerTs(T + HOUR, T, T - HOUR)).toBe(T);
    expect(deriveServerTs(T - HOUR, T, null)).toBe(T);
  });
});

describe("attribution rule: AC-2 (pure form)", () => {
  it("attributes each order of a multi-vendor checkout independently", () => {
    const v50 = view("sty_0108", 4200, T - 50 * HOUR);
    const tap10 = tap("sty_0109", "prd_0006", T - 10 * HOUR);
    const v1 = view("sty_0108", 1500, T - HOUR);
    const all = [v50, tap10, v1];
    expect(winner(all, ["prd_0031"])).toEqual({ storyId: "sty_0108", creatorId: "crt_0001", eventId: v50.eventId });
    expect(winner(all, ["prd_0006"])).toEqual({ storyId: "sty_0109", creatorId: "crt_0015", eventId: tap10.eventId });
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------
const storyIdArb = fc.constantFrom("sty_0108", "sty_0109", "sty_0200", "sty_0300", "sty_9999");
const productArb = fc.constantFrom("prd_0031", "prd_0032", "prd_0006", "prd_9999");
const interactionArb: fc.Arbitrary<Interaction> = fc
  .record({
    tap: fc.boolean(),
    userId: fc.constantFrom<string | null>("usr_A", "usr_A", "usr_A", "usr_B", null),
    offset: fc.integer({ min: -80 * HOUR, max: 2 * HOUR }),
    received: fc.integer({ min: 0, max: 5000 }),
    storyId: storyIdArb,
    productId: productArb,
    watchMs: fc.integer({ min: 0, max: 8000 }),
    id: fc.uuid(),
  })
  .map((r) => ({
    eventId: r.id,
    name: r.tap ? ("story_product_tap" as const) : ("story_view" as const),
    userId: r.userId,
    serverTs: T + r.offset,
    receivedAt: T + r.offset + r.received,
    storyId: r.storyId,
    productId: r.tap ? r.productId : null,
    watchMs: r.tap ? null : r.watchMs,
  }));

describe("attribution rule: properties", () => {
  it("is independent of input order", () => {
    const eventsAndPermutation = fc
      .array(interactionArb, { maxLength: 30 })
      .chain((events) => fc.tuple(fc.constant(events), fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length })));
    fc.assert(
      fc.property(eventsAndPermutation, ([events, shuffled]) => {
        expect(winner(shuffled)).toEqual(winner(events));
      }),
    );
  });

  it("the winner qualifies, is in the window, and no other qualifying event is later", () => {
    fc.assert(
      fc.property(fc.array(interactionArb, { maxLength: 30 }), (events) => {
        const r = attribute(order(), anchorCheckout, events, stories, rule);
        if (!r.attributed) {
          // then nothing in the window qualifies
          const any = events.some(
            (e) =>
              e.serverTs >= T - rule.windowMs &&
              e.serverTs <= T &&
              attribute(order(), anchorCheckout, [e], stories, rule).attributed,
          );
          expect(any).toBe(false);
          return;
        }
        expect(r.winner.serverTs).toBeGreaterThanOrEqual(T - rule.windowMs);
        expect(r.winner.serverTs).toBeLessThanOrEqual(T);
        for (const e of events) {
          if (e === r.winner) continue;
          const alone = attribute(order(), anchorCheckout, [e], stories, rule);
          if (alone.attributed) {
            const later = e.serverTs > r.winner.serverTs || (e.serverTs === r.winner.serverTs && e.receivedAt > r.winner.receivedAt);
            expect(later).toBe(false);
          }
        }
      }),
    );
  });

  it("adding non-qualifying noise never changes the result", () => {
    const noiseArb = fc.oneof(
      interactionArb.map((e) => ({ ...e, userId: null })),
      interactionArb.map((e) => ({ ...e, name: "story_view" as const, productId: null, watchMs: 2999 })),
      interactionArb.map((e) => ({ ...e, serverTs: T - rule.windowMs - SECOND })),
      interactionArb.map((e) => ({ ...e, storyId: "sty_9999" })),
    );
    fc.assert(
      fc.property(fc.array(interactionArb, { maxLength: 20 }), fc.array(noiseArb, { maxLength: 20 }), (events, noise) => {
        expect(winner([...events, ...noise])).toEqual(winner(events));
      }),
    );
  });
});