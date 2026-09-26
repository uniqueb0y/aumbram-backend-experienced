# Backend 3: Events, Attribution & Creator Commission — Aditya Singh

A production-shaped pipeline that turns mobile analytics **events → attribution → a creator commission ledger**, plus a design for 10M DAU.

- TypeScript on Node 22, with PostgreSQL 16 as both the system of record and the queue.
- Every decision and the reason for it is in **[DECISIONS.md](DECISIONS.md)** (44 entries; the decision itself is in bold italics).

| Doc | What |
|---|---|
| [docs/design.md](docs/design.md) | Scale model, architecture at scale, tiering, backfill, delivery semantics, observability, failure modes, trade-offs |
| [docs/loadtest.md](docs/loadtest.md) | Machine, commands, every run (including failed and invalid ones), bottleneck evidence |
| [DECISIONS.md](DECISIONS.md) | Decision log (ARCHITECTURE / IMPLEMENTATION / SPEC / TOOLING / SCOPE) |

## Run it

Requirements: **Docker** with Compose v2. Node.js ≥ 22.12 only if you want to run tests or tools on the host.

```bash
docker compose up -d --build       # postgres → setup (migrate + seed) → api :8080 + worker :9091
docker compose run --rm demo       # scripted end-to-end demo (BE-E-16)
```

- `setup` seeds creators, products and stories from the provided generator (deterministic seed), so the demo's ids exist.
- Default dev secrets (`dev_app_key_change_me` / `dev_internal_token_change_me`) are compose defaults. Copy `.env.example` to `.env` to override. No real secrets are in the repo.

```bash
# Tests (98): unit + integration against real Postgres
docker compose run --rm test
# or on the host:  npm ci && docker compose up -d postgres && npm test

# Load test (needs the 500k-event CSV, git-ignored)
node shared/mock-data/generate.mjs --events 500000 --out shared/mock-data/big
docker compose run --rm loadtest      # 2,500 ev/s for 150 s, inside the compose network
```

| Endpoint | Auth |
|---|---|
| `POST /v1/events/batch` (gzip supported) | `X-App-Key` |
| `POST /v1/internal/order-events` | `X-Internal-Token` |
| `POST /v1/internal/jobs/commission-sweep` `{ "asOf": "…" }` | `X-Internal-Token` |
| `GET /v1/orders/{id}/attribution[?history=true]` | either key |
| `GET /v1/creators/{id}/earnings` | either key |
| `GET /v1/creators/{id}/ledger?cursor=&limit=` | either key |
| `GET /health`, `GET /metrics` (api); `GET :9091/metrics` (worker) | open |

**CLI:** `docker compose exec api node dist/src/main/cli.js` followed by one of:
- `migrate`
- `seed <dir>`
- `sweep --as-of <iso>`
- `check-invariants`
- `backfill-events --file <csv>`
- `reattribute --from <iso> --to <iso>`

## What I built

**Must have**

| ID | Status | Where / evidence |
|---|---|---|
| BE-E-01 ingest API, partial acceptance, `serverTs`, durable 202 | ✅ | `src/ingest/*`, `src/api/routes/events.ts`; one-statement insert + enqueue (D-026) |
| BE-E-02 exact dedupe under concurrency and restarts | ✅ | PK on the normalised UUID; AC-1 test (3 concurrent sends → 98) |
| BE-E-03 bounded queue, lag metric, 429/503 + `Retry-After` | ✅ | `queueMonitor.ts`, `rateLimiter.ts`; tests for both; queue choice below |
| BE-E-04 ≥ 2,000 ev/s for 120 s, p95 < 200 ms, lag recovers | ⚠️ **partial** | Throughput, lag and correctness ✅ in every run. Latency: server-side 95.7% < 200 ms, but client p95 241 ms / p99 1.6 s. The tail is the Windows host paging the Docker VM (measured; [loadtest.md](docs/loadtest.md), D-044) |
| BE-E-05 load-test script + report + correctness check | ✅ | `loadtest/replay.ts`, [docs/loadtest.md](docs/loadtest.md), raw JSON in `docs/loadtest-evidence/` |
| BE-E-06 attribution engine, exact §3.2 | ✅ | pure `src/attribution/rule.ts`; DB side `engine.ts` |
| BE-E-07 late events, versioned decisions, locked + audit | ✅ | `attribution_decisions` (append-only), `late_locked_events`; AC-3/4/5 tests |
| BE-E-08 `GET /v1/orders/{id}/attribution` | ✅ | winner, anchor, rate, version, lock; `?history=true` adds all versions + late-locked events |
| BE-E-09 append-only double-entry ledger in Postgres | ✅ | triggers forbid UPDATE/DELETE/TRUNCATE; deferred constraint enforces Σ=0 per transaction (tested) |
| BE-E-10 accrue / payable / reverse / re-attribute, at most once | ✅ | pure planner `src/ledger/plan.ts` + unique idempotency keys (D-018, D-019) |
| BE-E-11 earnings from one snapshot under concurrency | ✅ | `REPEATABLE READ READ ONLY`; AC-7 polls while 4 workers apply 200 orders' `delivered` messages, each sent twice |
| BE-E-12 integer paise end to end | ✅ | `bigint` / `BIGINT`; 99999 @ 700 bps → 6999 tested |
| BE-E-13 attribution edge cases | ✅ | `test/unit/rule.test.ts`: every listed case + 3 properties; provisional vs locked in `scenarios.test.ts` |
| BE-E-14 ledger invariants, property-based | ✅ | `test/integration/ledger.property.test.ts` (random duplicated, shuffled, concurrent sequences; replay) |
| BE-E-15 design doc | ✅ | [docs/design.md](docs/design.md) |
| BE-E-16 `docker compose up` + ≤ 2 commands, scripted demo | ✅ | `docker compose up -d --build` then `docker compose run --rm demo` |

**Should have**

| ID | Status | Notes |
|---|---|---|
| BE-E-17 gzip, zip-bomb safe | ✅ | decompressed-size cap; tested with a 20 MB → 20 KB bomb (413) |
| BE-E-18 `/metrics` | ✅ | ingest rates, rejects by code, duplicates, queue lag, consumer throughput, evaluations by outcome, late-locked, ledger transactions by type, invariant result |
| BE-E-19 scheduled invariant checker | ✅ | worker every 60 s + `cli check-invariants`; records results, logs `LEDGER_INVARIANT_VIOLATION` |
| BE-E-20 creator ledger listing | ✅ | cursor-paginated, tested |
| BE-E-21 backfill + re-attribution | ✅ | `cli backfill-events` (trusts `server_ts`), `cli reattribute`; `test/integration/tools.test.ts` |
| BE-E-22 session stitching | ❌ not done | DPDP consent question first; plan in design.md §8 |

**Stretch**

| ID | Status | Notes |
|---|---|---|
| BE-E-23 payouts | ❌ | needs the receivable model for post-payout clawbacks (design.md §8) |
| BE-E-24 horizontal consumers | ⚠️ partial | several workers are safe (`--scale worker=N`): `SKIP LOCKED` + per-user advisory locks. No partitioning by `userId`; that's the Kafka design at scale |
| BE-E-25 rule versioning | ✅ | `ruleConfig.ts`; every decision stores `rule_version` |
| BE-E-26 chaos test | ✅ (manual run) | `kill -9` of worker then API during load: 88,164 / 88,164 accepted ids stored and processed ([loadtest.md](docs/loadtest.md), run 8). Scripted as commands, not an automated test |

## Architecture & key decisions

```
phones ──POST batch──► api ──1 SQL statement──► events + event_queue ──SKIP LOCKED──► worker
order svc ─POST──────► api ─► order_events + order_event_queue ──────────────────────► worker
worker: interaction index → pure rule → new decision version → pure ledger planner → ledger (Σ=0)
sweep(asOf): delivered + 7 d, no return → payable + locked      earnings: one REPEATABLE READ snapshot
```

- **Queue choice: Postgres, not Kafka or Redis (D-003).**
  - The consumer's claim (`DELETE … SKIP LOCKED`) and its effects commit in **one transaction**, so effects are exactly-once without idempotency plumbing between two systems.
  - "202 = durable" is simply "the commit returned".
  - Rejected alternative: **Redis Streams** would add a second durability story (the AOF fsync policy decides whether a 202 is honest) and still need Postgres for dedupe.
  - Kafka is the answer at 500M/day (design.md §2) but is heavy on a laptop.
- **Backpressure (D-008, D-029).**
  - A per-client token bucket counted in events → `429`.
  - A background lag monitor → `503` when queue depth ≥ 200k or the oldest item is ≥ 60 s old.
  - Pool-acquisition timeouts → `503`.
  - All carry `Retry-After`. Clients resend the same batch and dedupe makes that safe.
- **Where "exactly once" effects come from, in this implementation:**
  - Events: PK `ON CONFLICT DO NOTHING` at ingest. The claim and its effects share one transaction in the consumer.
  - Order messages: PK `(orderId, status)` at intake. Processing derives the ledger from *state* (`planPostings(held, desired)`), so duplicates and out-of-order messages converge (D-018).
  - Ledger: an order row lock plus a **UNIQUE idempotency key** per effect (`accrue|payable|reverse:<order>:v<version>`), and a **deferred Σ=0 constraint**.
- **Races:** a per-user advisory lock serialises the event consumer and the order consumer for the same user. This prevents a write-skew where neither side sees the other's uncommitted row (D-017).
- **The two pure functions** a reviewer can change live: `attribute()` in `src/attribution/rule.ts` and `planPostings()` in `src/ledger/plan.ts`.

## Trade-offs and what I'd do with more time

- **The latency tail on this laptop** is caused by host memory pressure (8 GB Windows paging the Docker VM). I did not trade durability for it. Next step: re-measure on a Linux box.
- **Implemented as written but disagree with (D-023):** a tap counts even if the story doesn't tag the tapped product. I'd require the tag.
- **Next, in order:**
  1. Payouts with a receivable for post-payout clawbacks.
  2. Approved adjustment transactions.
  3. Balance checkpoints for hot creators.
  4. Rule shadow-runs.
  5. Kafka ingest keyed by `userId`, with an outbox to the ledger.
  6. Session stitching behind consent.

## Testing

`docker compose run --rm test` or `npm test`: **98 tests**, all against real Postgres except the pure unit tests.

| Suite | Covers |
|---|---|
| `test/unit/rule.test.ts` | BE-E-13: 72 h in / 72 h + 1 s out, 2999 vs 3000 ms, other-product view, a tap in the other order of the same checkout, a newer non-qualifying event, `serverTs` and receivedAt/id ties, logged-out, unknown story, anchor fallback, the §3.3 skew example, AC-2. Properties: order independence, the winner is maximal, noise never changes the result |
| `test/unit/plan.test.ts` | ledger planner table + a property: postings always move balances from held to desired, and re-planning is a no-op |
| `test/unit/validate.test.ts` | event, envelope, order and CSV validation; rounding cases |
| `test/integration/ingest.test.ts` | AC-1, partial acceptance, `evt_` normalisation, stored `serverTs`, NUL rejection, 413/422/400/415, gzip + zip bomb, auth separation, 429, 503 + recovery, `/health`, `/metrics` |
| `test/integration/scenarios.test.ts` | AC-2 … AC-7 through HTTP and the real consumers; out-of-order and duplicate statuses; an anchor shift that un-attributes; the rate snapshot; ledger listing |
| `test/integration/ledger.property.test.ts` | BE-E-14: Σ=0, per-order net ∈ {0, expected}, no negative balances, earnings = Σ entries, re-delivery changes nothing, identical ledger on replay; DB rejects UPDATE/DELETE/TRUNCATE and unbalanced transactions |
| `test/integration/tools.test.ts` | backfill (trusts `server_ts`, idempotent) and re-attribution over a range (idempotent) |

**Checked that the tests catch real bugs:**
- Deleting the reversal from the planner fails the property test with a shrunk counterexample.
- Making the 72 h bound exclusive fails the boundary test (D-037).

**Not tested automatically:**
- The chaos scenario (run manually, results in loadtest.md).
- Multi-worker scaling across processes (covered in-process by concurrent consumers in tests).

## Assumptions

Each is logged with its reason in DECISIONS.md.
- Attribution runs on the **first** order message of any status, since messages can arrive out of order and each carries the snapshot. The first snapshot wins (D-020, D-025).
- Orders **lock** when payable, and also when `returned`/`cancelled`. Unattributed orders lock when the return window closes (D-021).
- `return_requested` after payable doesn't un-pay. `returned` after payable claws back from payable. A return that is requested but never completed stays accrued (D-022).
- A new decision version is written only when the winner, the anchor or attributed/not changes. The rate snapshot is taken at the first decision for that creator (D-024).
- Ingest response: `accepted` = newly stored, `duplicates` = already known. They are exact and sum with `rejected` to the batch size (D-039).
- Body over 1 MB → 413; count outside 1–500 → 422 (D-028).
- An empty `userId` means logged out; NUL characters are rejected (D-027).
- Read endpoints accept either key (D-031). Stories whose creator is unknown never match (D-033).
- The status `created` is accepted in addition to the domain-model statuses.

## AI usage

- **Tool:** Claude Code (Anthropic, Claude Opus 5), used throughout as a pair programmer.
- **What it did:** under my direction it explored the brief, proposed the stack, and wrote the code, tests, load-test script and docs. It ran the tests, load tests and bottleneck investigation, and it keeps DECISIONS.md.
- **What changed along the way:**
  - k6 was replaced by our own replay script (D-014); Ajv by typed validators (D-013).
  - The worker batch-wait optimisation was rejected on evidence (D-043).
  - One load-test run was discarded as invalid (it replayed already-stored ids).
  - An unimplemented session-stitching config flag was removed rather than left in.
- **Understanding:** I have reviewed the design and can explain and modify any part of it.