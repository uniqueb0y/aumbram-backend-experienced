import { HOUR } from "../lib/time.js";

/** Parameters of the attribution rule. Every decision records the version that produced it. */
export interface RuleParams {
  readonly version: string;
  /** Interactions count if `anchor - windowMs <= serverTs <= anchor`. */
  readonly windowMs: number;
  /** A story_view qualifies if integer watchMs >= minWatchMs. */
  readonly minWatchMs: number;
  /** A checkout_start anchors the order if `createdAt - anchorLookbackMs <= serverTs <= createdAt`. */
  readonly anchorLookbackMs: number;
}

export const RULES: Readonly<Record<string, RuleParams>> = {
  v1: { version: "v1", windowMs: 72 * HOUR, minWatchMs: 3000, anchorLookbackMs: 1 * HOUR },
};

export function getRule(version: string): RuleParams {
  const rule = RULES[version];
  if (!rule) throw new Error(`Unknown attribution rule version "${version}". Known: ${Object.keys(RULES).join(", ")}`);
  return rule;
}