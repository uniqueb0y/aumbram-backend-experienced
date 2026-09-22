/**
 * The attribution rule (assignment section 3.2) as a pure function.
 *
 * No I/O and no clock: everything the rule needs is passed in, so it can be
 * table-tested, property-tested and changed without touching storage code.
 * All timestamps are epoch milliseconds.
 */
import type { RuleParams } from "./ruleConfig.js";

export type InteractionName = "story_view" | "story_product_tap";

export interface Interaction {
  eventId: string;
  name: InteractionName;
  userId: string | null;
  serverTs: number;
  receivedAt: number;
  storyId: string | null;
  productId: string | null;
  watchMs: number | null;
}

export interface Checkout {
  eventId: string;
  userId: string | null;
  serverTs: number;
}

export interface OrderForAttribution {
  userId: string;
  createdAt: number;
  /** Products in the order's lines (variants already resolved; unknown variants dropped). */
  productIds: ReadonlySet<string>;
}

export interface StoryRef {
  creatorId: string;
  taggedProductIds: ReadonlySet<string>;
}

/** Known stories by id. A story missing from the map is "unknown" and never matches. */
export type StoryLookup = ReadonlyMap<string, StoryRef>;

export type Anchor =
  | { source: "checkout_start"; at: number; eventId: string }
  | { source: "order_created"; at: number; eventId: null };

export type Attribution =
  | { attributed: false; anchor: Anchor }
  | { attributed: true; anchor: Anchor; winner: Interaction; storyId: string; creatorId: string };

/**
 * Anchor = serverTs of the user's latest checkout_start with
 * createdAt - lookback <= serverTs <= createdAt; otherwise order.createdAt.
 */
export function computeAnchor(order: OrderForAttribution, checkouts: readonly Checkout[], rule: RuleParams): Anchor {
  const earliest = order.createdAt - rule.anchorLookbackMs;
  let best: Checkout | null = null;
  for (const c of checkouts) {
    if (c.userId === null || c.userId !== order.userId) continue;
    if (c.serverTs < earliest || c.serverTs > order.createdAt) continue;
    if (best === null || c.serverTs > best.serverTs || (c.serverTs === best.serverTs && c.eventId > best.eventId)) {
      best = c;
    }
  }
  return best === null
    ? { source: "order_created", at: order.createdAt, eventId: null }
    : { source: "checkout_start", at: best.serverTs, eventId: best.eventId };
}

/**
 * Candidate + product match. Returns the story (for its creator) when the
 * interaction qualifies for this order, otherwise null. The time window is
 * checked separately.
 */
export function qualifyingStory(
  ev: Interaction,
  order: OrderForAttribution,
  stories: StoryLookup,
  rule: RuleParams,
): StoryRef | null {
  if (ev.userId === null || ev.userId !== order.userId) return null;
  if (ev.storyId === null) return null;
  const story = stories.get(ev.storyId);
  if (story === undefined) return null;

  if (ev.name === "story_view") {
    if (ev.watchMs === null || !Number.isInteger(ev.watchMs) || ev.watchMs < rule.minWatchMs) return null;
    for (const productId of story.taggedProductIds) {
      if (order.productIds.has(productId)) return story;
    }
    return null;
  }
  // story_product_tap: the tapped product must be in the order (section 3.2, see DECISIONS D-023).
  return ev.productId !== null && order.productIds.has(ev.productId) ? story : null;
}

/** Winner ordering: greatest serverTs, then greatest receivedAt, then lexicographically greatest id. */
export function isLaterThan(a: Interaction, b: Interaction): boolean {
  if (a.serverTs !== b.serverTs) return a.serverTs > b.serverTs;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt > b.receivedAt;
  return a.eventId > b.eventId;
}

export function attribute(
  order: OrderForAttribution,
  checkouts: readonly Checkout[],
  interactions: readonly Interaction[],
  stories: StoryLookup,
  rule: RuleParams,
): Attribution {
  const anchor = computeAnchor(order, checkouts, rule);
  const windowStart = anchor.at - rule.windowMs;

  let winner: Interaction | null = null;
  let winnerStory: StoryRef | null = null;
  for (const ev of interactions) {
    if (ev.serverTs < windowStart || ev.serverTs > anchor.at) continue; // inclusive on both ends
    const story = qualifyingStory(ev, order, stories, rule);
    if (story === null) continue;
    if (winner === null || isLaterThan(ev, winner)) {
      winner = ev;
      winnerStory = story;
    }
  }

  if (winner === null || winnerStory === null || winner.storyId === null) {
    return { attributed: false, anchor };
  }
  return { attributed: true, anchor, winner, storyId: winner.storyId, creatorId: winnerStory.creatorId };
}