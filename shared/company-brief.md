# Aumbram — Candidate Brief

> Send this file along with any assignment. Every assignment assumes you have read it.

## Who we are

Aumbram is an early-stage **social-commerce platform for India**. We bring content,
community and marketplace commerce together so products are discovered through
**stories and creators** rather than search. Think of the moment a short video of a
hand-block-printed kurta makes someone stop scrolling — and two taps later they own it.

We work with **independent brands, artisans and small entrepreneurs**, and we build the
tools that help them grow a business, not just list a product.

## The core engineering constraint

Most e-commerce starts with intent: someone searches for what they already decided to buy.
Aumbram starts earlier. A user is scrolling a story or following a creator, and somewhere
in that flow **discovery has to turn into a transaction without breaking the experience that
got them there.**

That shapes almost every technical decision we make:

| Reality | What it means for engineering |
|---|---|
| Most users are on **mid-range Android phones** (₹10–18k devices, 3–4 GB RAM) | Main-thread budget matters. Long lists must virtualize. Images must be sized. |
| Networks are **patchy** (Slow 4G, tunnels, dropping to 3G) | Optimistic UI, retries with backoff, idempotent writes, skeletons, offline tolerance. |
| The discovery feed mixes **product, story, creator and promo cards** with live elements (stock left, price drops, live viewers) | Heterogeneous lists, partial updates, avoiding re-render storms. |
| Sellers are **artisans and small brands**, often not tech-savvy, often mobile-only | Vendor tools must be forgiving, fast and understandable. |
| Payments are **UPI-first**, with COD and cards | Async payment confirmation, webhooks, reconciliation, double-charge prevention. |
| Creators earn **commission on sales their content drives** | Attribution must be correct — it is money owed to real people. |
| Users read **English, Hindi and Hinglish** | Text length varies; don't hard-code strings; ₹ formatting uses the Indian system (₹1,24,999). |

## Glossary

| Term | Meaning |
|---|---|
| **Feed** | The main vertical discovery surface. A ranked list of heterogeneous *feed items*. |
| **Feed item / card** | One entry in the feed: `product`, `story`, `creator`, or `promo`. |
| **Story** | Short creator content (image or video segments) that can tag one or more products. |
| **Creator** | A user who publishes stories and earns commission on attributed sales. |
| **Vendor** | A seller — an artisan, brand or small business — that owns products and fulfils orders. |
| **Variant** | A purchasable version of a product (e.g. size M / colour Indigo) with its own stock and price. |
| **Quick-add** | Adding a product to cart straight from a card or story without leaving the feed. |
| **Attribution** | Linking a purchase back to the story/creator that drove it. |
| **Pincode** | Indian postal code (6 digits). Used to check delivery serviceability and COD. |
| **Paise** | 1/100 of a rupee. **All money is stored as integer paise.** ₹499.00 = `49900`. |

## Shared domain model

All assignments use the same model, described in [`domain-model.md`](./domain-model.md).
Mock data can be generated with [`mock-data/generate.mjs`](./mock-data/generate.mjs).

## How we evaluate (all tracks)

We use one rubric across every track, described in [`evaluation-rubric.md`](./evaluation-rubric.md).
In short, we care about, in this order:

1. **Does it work?** Can we run it from your README in under 10 minutes, and does it do the Must-have requirements?
2. **Is it correct under real conditions?** Slow networks, empty states, errors, duplicates, bad input.
3. **Is the code something we'd want to maintain?** Structure, naming, types, tests.
4. **Can you explain your trade-offs?** What you chose, what you skipped, and why.

We value **a smaller scope done well** over a large scope done shallowly. If you run out of
time, cut Stretch goals, then Should-haves — and tell us in your README what you'd do next.

## Ground rules

- **Time box.** Each assignment states a recommended effort. Please respect it; we do. Going
  far beyond it is not a positive signal.
- **AI assistants are allowed** (Copilot, Claude, ChatGPT, etc.), because they're part of how
  we work. You must fill in the *AI usage* section of your README, and you must be able to
  explain and modify any line of your submission in the follow-up call.
- **Open-source libraries are allowed** unless the assignment says otherwise. Justify
  anything heavy.
- **Don't publish the assignment text** publicly. A private repo shared with us, or a zip, is fine.
- **Questions are welcome.** If something is ambiguous, write down your assumption in the README and
  keep going. That counts as good judgement, not as a mistake.

## Submission README template

Every submission must include a `README.md` with these sections:

```markdown
# <Assignment name> — <Your name>

## Run it
<exact commands, required versions, env vars; must work on a clean machine>

## What I built
<Must / Should / Stretch checklist — mark what's done, partial, not done>

## Architecture & key decisions
<diagram or bullets; why these choices>

## Trade-offs and what I'd do with more time

## Testing
<what's tested, how to run, what isn't and why>

## Assumptions

## AI usage
<which tools, for which parts, what you changed or rejected>

## Time spent
<approximate hours>
```

## After you submit

1. We review within **3 working days** using the published rubric.
2. If you proceed, there is a **45–60 minute review call**. You walk us through the code, we ask
   "what if" questions, and we may pair with you on a small change to your own submission.
3. You get written feedback **either way**.
