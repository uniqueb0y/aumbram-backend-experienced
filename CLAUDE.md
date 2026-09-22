# CLAUDE.md

Guidance for Claude (and humans) working in this repository.

## What this repo is

A take-home assignment for Aumbram (Indian social-commerce platform): **Backend 3 – Events, Attribution & Creator Commission**, Experienced level.
Time box **8–10 h** of focused work (going over is *not* a positive signal), 7-day window.

We build a production-shaped pipeline: **events → attribution → commission ledger**, plus a design doc for 10M DAU.

| Part | What | Key requirement IDs |
|---|---|---|
| A. Ingestion | `POST /v1/events/batch`: validate, derive `serverTs`, durable 202, dedupe, backpressure | BE-E-01..05 |
| B. Attribution | Rule engine triggered by order `created`, versioned decisions, late-event re-evaluation, `GET /v1/orders/{id}/attribution` | BE-E-06..08 |
| C. Ledger | Append-only double-entry ledger in Postgres, accrue → payable → reverse, sweep job, `GET /v1/creators/{id}/earnings` | BE-E-09..12 |
| D. Docs | `docs/design.md` (8 required sections), `docs/loadtest.md` | BE-E-15, BE-E-05 |
| Tests / ops | Attribution edge-case tests, ledger property tests, `docker compose up` plus ≤2 commands, e2e demo script | BE-E-13, 14, 16 |

Acceptance criteria **AC-1..AC-7** (assignment §4) are the concrete scenarios every test suite must cover.

Suggested time split (§6): ingestion+queue 2.5 h · load test 1 h · attribution 2.5 h · ledger 2 h · design doc 2 h.

## Source-of-truth documents

| File | Contents |
|---|---|
| [START-HERE.md](START-HERE.md) | Reading order |
| [backend/3-experienced-events-attribution-commission.md](backend/3-experienced-events-attribution-commission.md) | **The assignment.** API contracts, exact rule, requirements, NFRs, deliverables |
| [shared/domain-model.md](shared/domain-model.md) | Entities, conventions, order state machine, shared attribution rule |
| [shared/company-brief.md](shared/company-brief.md) | Context, ground rules, **mandatory README template** |
| [shared/evaluation-rubric.md](shared/evaluation-rubric.md) | Scoring, gates G1–G3, red and green flags |
| [shared/mock-data/generate.mjs](shared/mock-data/generate.mjs) | Deterministic zero-dependency data generator (Node 18+) |

**Precedence when they conflict:** assignment > domain model > mock data. If something is ambiguous, write the assumption down in `README.md` and `DECISIONS.md`.

## Decision log

**[DECISIONS.md](DECISIONS.md) records every non-trivial decision and the reason for it.** Update it in the same change as the code it affects. Never rewrite an old entry; supersede it with a new one.

## Non-negotiable rules (quick reference)

### Attribution rule (§3.2, implement exactly)
- **Anchor**: `serverTs` of the user's latest `checkout_start` with `order.createdAt − 1h ≤ serverTs ≤ order.createdAt`; otherwise `order.createdAt`. Orders in a multi-vendor checkout share the anchor and are attributed independently.
- **Candidate**: same non-null `userId`, and either `story_view` with **integer** `props.watchMs ≥ 3000` or a `story_product_tap`.
- **Product match**: for a tap, `props.productId` is in the order lines. For a view, the story (from `stories.json`) tags ≥1 product in the order lines. Unknown stories or products never match.
- **Window**: `anchor − 72h ≤ serverTs ≤ anchor`, **inclusive on both ends**.
- **Winner**: max `serverTs` → then max `receivedAt` → then lexicographically greatest event id.
- **Creator**: `story.creatorId` from `stories.json`. **Never** `props.creatorId`.
- **Commission**: `floor(subtotal × bps / 10000)`, integer arithmetic only. Subtotal excludes shipping. The rate is snapshotted at first attribution to that creator.
- **Lifecycle**: accrue on `delivered` (if attributed) → payable when `now ≥ deliveredAt + 7d` and no `return_requested` → reverse on `returned`, or on re-attribution after accrual.
- Provisional until payable, then **locked**. A late event that would change a locked attribution is recorded but changes nothing.

### `serverTs` derivation (§3.3)
```
receivedAt = server clock at batch arrival
offset     = receivedAt − batch.sentAt
serverTs   = min(receivedAt, event.clientTs + offset)   // sentAt missing/unparseable → serverTs = receivedAt
```
Store `clientTs`, `receivedAt` and `serverTs`.

### Ingestion
- 1–500 events per batch, ≤ 1 MB **decompressed** (413/422). Partial acceptance: `rejected: [{index,id,code,message}]`.
- Dedupe key = lower-cased UUID with the optional `evt_` prefix stripped. `evt_<uuid>` and `<uuid>` are the same event.
- **202 = durably committed** (survives `kill -9`). No in-memory buffering.
- No per-event DB lookups of story or product at ingest.
- 429 (per-client) / 503 (system lag), both with `Retry-After`.

### Money, security, integrity
- Money is integer **paise**: `BIGINT` in SQL and `bigint` in TS. Never `number` for amounts, never floats.
- Ledger is append-only and double-entry. Σ entries = 0 per transaction. No UPDATE/DELETE (enforced by the DB). Corrections are compensating entries.
- Each business effect happens **at most once per order**, even with duplicate or out-of-order order events and concurrent workers.
- `X-App-Key` for ingestion; `X-Internal-Token` for `/v1/internal/*`. Both come from env. The app key must not open internal endpoints.
- No PII (phones, addresses) in logs. Event `props` are untrusted.
- Conventions: ISO-8601 UTC timestamps, camelCase JSON, error shape `{ "error": { code, message, details } }`, cursor pagination.

## Mock-data quirks to handle

- `events.csv`: ~1% duplicate `event_id`s, ~5% of devices skewed by hours, 15% empty `user_id`, ~9% of views under 3 s, rare `prd_9999`, bare UUID ids (no `evt_`), `server_ts` sometimes going backwards within a session.
- `stories.json`: 11 of 120 stories tag no products. `expiresAt` is display-only.
- `products.json`: variants are nested. Map variant → product → vendor from here.
- `orders.json`: stored `attribution` and `purchase` event links are **random, not ground truth**. Build attribution tests from hand-written fixtures.
- `purchase` events are analytics only. Orders come only from `POST /v1/internal/order-events`.

Generate data with:
```bash
node shared/mock-data/generate.mjs --out shared/mock-data/out              # 50k events
node shared/mock-data/generate.mjs --events 500000 --out shared/mock-data/big  # load test
```
Generated directories must not be committed.

## Tech stack (see DECISIONS.md for the reasons)

- **TypeScript 5.9 (strict)** on **Node.js 22 LTS** (D-001, D-015)
- **Fastify 5** with hand-written typed validators (D-002, D-013)
- **PostgreSQL 16** as the only datastore, including the **Postgres-based queue** (`FOR UPDATE SKIP LOCKED`) (D-003)
- **`pg`** with raw SQL, no ORM; plain SQL migrations (D-004)
- **Vitest** + **fast-check**, run against real Postgres (D-009, D-037)
- Own Node load-replay script, run inside the compose network (D-014, D-042)
- `docker-compose` with pinned images: `postgres`, one-shot `setup` (migrate + seed), `api`, `worker`; tools profile: `demo`, `test`, `loadtest`

## Layout

```
src/
  api/          Fastify app, routes, auth hooks, gzip limiter, error mapping
  ingest/       validation, id normalisation, serverTs derivation, store, rate limiter, queue monitor
  consumers/    event consumer (interaction index + re-evaluation), order-event consumer
  attribution/  rule.ts (PURE rule), ruleConfig.ts (versioned params), engine.ts (DB side), decisions.ts
  ledger/       plan.ts (PURE planner), posting.ts (only writer), reconcile.ts, read.ts, invariants.ts
  orders/       validation, intake, processor, sweep, repo (locks)
  tools/        seed, backfill (CSV, trusts server_ts), reattribute, csv parser
  main/         api.ts, worker.ts, cli.ts entrypoints
migrations/     plain .sql, ordered
test/unit/      rule (BE-E-13 + properties), ledger planner, validators
test/integration/ ingest (AC-1, auth, gzip, backpressure), scenarios (AC-2..7), ledger properties (BE-E-14)
loadtest/       replay.ts; results/ is git-ignored
scripts/        demo.ts (end-to-end)
docs/           design.md, loadtest.md
```

## Commands

| Task | Command |
|---|---|
| Start everything (migrate + seed + api + worker) | `docker compose up -d --build` |
| End-to-end demo | `docker compose run --rm demo` |
| Tests (against compose Postgres) | `docker compose run --rm test`, or on the host `npm ci && npm test` (needs `docker compose up -d postgres`) |
| Unit tests only (no DB) | `npm run test:unit` |
| Typecheck / build | `npm run typecheck` / `npm run build` |
| Load test | `node shared/mock-data/generate.mjs --events 500000 --out shared/mock-data/big` then `docker compose run --rm loadtest` |
| CLI | `docker compose exec api node dist/src/main/cli.js <migrate|seed dir|sweep --as-of iso|check-invariants|backfill-events --file f|reattribute --from iso --to iso>` |
| Ports | API 8080, worker metrics 9091, Postgres 55432 (host) |

## Environment gotchas (Windows dev box)

- The Claude Code Write/Edit tools' hook was unreliable in this session; files were written via PowerShell here-strings.
- In Git Bash, prefix `docker compose exec` commands that pass container paths with `MSYS_NO_PATHCONV=1`.
- Never type the U+0000 JSON escape sequence literally in tool commands (the harness turns it into a real NUL byte). In code, write the NUL character as a backslash-x00 escape.

## Working agreement

1. Log decisions in `DECISIONS.md` as they are made.
2. The attribution rule stays a **pure function** (inputs: order, candidate events, stories, clock) so it can be table- and property-tested and changed live in the review call.
3. Ledger posting lives only in `src/ledger/`. Idempotency comes from DB unique constraints, not from application checks.
4. Avoid the rubric red flags: no `any`, no `catch {}`, no float money, no committed secrets (`.env.example` only), no giant single file, and make no README claims about features that don't exist.
5. Measure, don't guess: EXPLAIN plans and load-test output go into the docs.
6. The final `README.md` must follow the template in `shared/company-brief.md`, including the BE-E checklist, AI usage and time spent.
