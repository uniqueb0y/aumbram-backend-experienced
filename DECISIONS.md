# Decision Log

Every decision taken on this project, with the reason it was made. **Skim the index first**; each entry below has the full reasoning.

- Entries are **append-only**. To change a decision, add a new entry and mark the old one `Superseded by D-xxx`.
- **Categories:** `ARCHITECTURE` (shape of the system) · `IMPLEMENTATION` (how a part is built) · `SPEC` (how an ambiguous rule in the assignment is interpreted) · `TOOLING` (libraries, build, tests) · `SCOPE` (what is built or cut).
- **Status:** `Accepted` · `Superseded by D-xxx` · `Proposed`.

---

## Index: all decisions at a glance

| ID | Category | Decision | Status |
|---|---|---|---|
| D-001 | TOOLING | ***TypeScript (strict) on Node.js 22 LTS*** | Accepted |
| D-002 | TOOLING | ***Fastify for HTTP*** (validation part superseded by D-013) | Superseded by D-013 (partly) |
| D-003 | ARCHITECTURE | ***Postgres is the only datastore, and also the queue (`SKIP LOCKED` inbox tables)*** | Accepted |
| D-004 | IMPLEMENTATION | ***Raw SQL via `pg`, plain `.sql` migrations, no ORM*** | Accepted |
| D-005 | IMPLEMENTATION | ***Money is `bigint` paise in TS and `BIGINT` in SQL; commission uses BigInt floor division*** | Accepted |
| D-006 | ARCHITECTURE | ***Double-entry, append-only ledger with guarantees enforced by DB triggers and unique keys*** | Accepted |
| D-007 | ARCHITECTURE | ***Attribution decisions are versioned and append-only; orders lock at payable; late changes go to an audit table*** | Accepted |
| D-008 | ARCHITECTURE | ***Backpressure: per-client token bucket → 429; queue depth or age → 503; both send `Retry-After`*** | Accepted |
| D-009 | TOOLING | ***Vitest + fast-check, run against real Postgres*** | Accepted |
| D-010 | TOOLING | ***k6 for load testing*** | Superseded by D-014 |
| D-011 | SCOPE | ***Priority: Must → docs/load evidence → Should → Stretch*** | Accepted |
| D-012 | TOOLING | ***Git on `main`; `.gitignore` blocks secrets and generated data*** | Accepted |
| D-013 | IMPLEMENTATION | ***Hand-written validators instead of Ajv/JSON-schema*** | Accepted |
| D-014 | TOOLING | ***Own Node load-replay script instead of k6*** | Accepted |
| D-015 | TOOLING | ***TypeScript 5.9.3, not 7.x*** | Accepted |
| D-016 | ARCHITECTURE | ***Two processes: `api` (ingest + reads) and `worker` (consumers, sweep, invariant checker)*** | Accepted |
| D-017 | ARCHITECTURE | ***Per-user advisory locks serialise attribution between the event consumer and the order consumer*** | Accepted |
| D-018 | ARCHITECTURE | ***Ledger effects come from a "desired vs held" reconcile, not from event transitions*** | Accepted |
| D-019 | IMPLEMENTATION | ***Idempotency key per ledger effect: `<type>:<orderId>:v<attributionVersion>`*** | Accepted |
| D-020 | SPEC | ***Attribution runs on the first order event of any status, not only `created`*** | Accepted |
| D-021 | SPEC | ***Orders also lock when `returned` or `cancelled`, and unattributed orders lock when the return window closes*** | Accepted |
| D-022 | SPEC | ***`returned` after payable reverses from the payable account; `return_requested` after payable changes nothing*** | Accepted |
| D-023 | SPEC | ***A tap matches on `props.productId` only; we don't also require the story to tag that product*** | Accepted |
| D-024 | SPEC | ***A new attribution version is written only when the winner, the anchor or attributed/not changes*** | Accepted |
| D-025 | SPEC | ***The first order snapshot wins; later snapshots are ignored (logged if they differ)*** | Accepted |
| D-026 | IMPLEMENTATION | ***Ingest is one SQL statement: insert events + enqueue, sorted by id, `ON CONFLICT DO NOTHING`*** | Accepted |
| D-027 | IMPLEMENTATION | ***Events containing a U+0000 (NUL) character are rejected; an empty-string `userId` is treated as null*** | Accepted |
| D-028 | SPEC | ***Payload size over 1 MB → 413; event count outside 1–500 → 422*** | Accepted |
| D-029 | IMPLEMENTATION | ***Rate-limit key is the client IP, budget counted in events rather than requests*** | Accepted |
| D-030 | ARCHITECTURE | ***Attribution rule parameters live in versioned config; every decision records `rule_version`*** | Accepted |
| D-031 | IMPLEMENTATION | ***Read endpoints accept either key; `/v1/internal/*` accepts only the internal token*** | Accepted |
| D-032 | IMPLEMENTATION | ***Ledger sign convention: debit = +, credit = −; creator balances are shown as −Σ*** | Accepted |
| D-033 | IMPLEMENTATION | ***Stories whose creator isn't in `creators` count as unknown (never match)*** | Accepted |
| D-034 | TOOLING | ***Keep `prom-client` 15 despite npm deprecation notice*** | Accepted |
| D-035 | IMPLEMENTATION | ***Auth runs in `onRequest` (before the body is read), not `preHandler`*** | Accepted |
| D-036 | IMPLEMENTATION | ***Poison messages: batch fails → retry one by one → dead-letter table; the queue never blocks*** | Accepted |
| D-037 | TOOLING | ***Ledger property tests split in two: concurrent (invariants + dedupe) and sequential (bit-identical replay)*** | Accepted |
| D-038 | IMPLEMENTATION | ***Per-request access logs off; metrics carry volume and latency, handlers log correlated lines (batchId, orderId)*** | Accepted |
| D-039 | SPEC | ***Ingest response: `accepted` = newly stored, `duplicates` = valid but already known; `accepted + duplicates + rejected = batch size`*** | Accepted |
| D-040 | IMPLEMENTATION | ***Order events processed one message per transaction; event queue processed in batches of 1,000*** | Accepted |
| D-041 | ARCHITECTURE | ***Tune Postgres checkpoints for write-heavy ingest (`max_wal_size=4GB`, `checkpoint_timeout=15min`); never relax `fsync`/`synchronous_commit`*** | Accepted |
| D-042 | TOOLING | ***Official load-test numbers come from inside the compose network; host-side numbers are reported alongside*** | Accepted |
| D-043 | IMPLEMENTATION | ***Rejected experiment: making the worker wait for fuller batches (fewer commits) did not reduce ingest tail latency; reverted*** | Rejected |
| D-044 | TOOLING | ***Latency tail is attributed to host memory pressure (measured), not the design; reported honestly, not tuned away with unsafe settings*** | Accepted |

---

## D-001: Language: TypeScript (strict) on Node.js 22 LTS
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Build everything (API, consumers, tests, scripts) in TypeScript with `strict: true` on Node 22 LTS.***
- **Why:**
  - The provided mock-data generator is Node, so there's one runtime for data, replay and the app.
  - The throughput target (≥2,000 events/s in batches of 100) is about 20 req/s. The bottleneck is Postgres I/O, not CPU.
  - Fastest route to a complete, well-tested system inside a 10 h box. `fast-check` gives mature property-based testing (BE-E-13/14; C6 is 15% of the score).
  - Strict TS avoids the rubric's "`any` everywhere" red flag.
- **Alternatives:** Go (cheaper per event, but the target doesn't need it, and it's slower to write within the time box); Java/Kotlin (heavier setup); Python (async and GIL make p95 < 200 ms riskier).
- **Consequences:** JS `number` is unsafe for money, hence D-005. Scale by running more processes (D-016).

## D-002: HTTP framework: Fastify
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted for Fastify; *the Ajv/JSON-schema part is superseded by D-013*
- **Decision:** ***Fastify for all HTTP endpoints.***
- **Why:** Low per-request overhead. The `preParsing` hook and `bodyLimit` make gzip with a decompressed-size cap (zip-bomb safety) straightforward. It uses pino for JSON logs, and its default JSON parser (`secure-json-parse`) strips `__proto__` from untrusted input.
- **Alternatives:** Express (slower, weaker typing); NestJS (too much abstraction for this scope, a rubric red flag).

## D-003: Queue: Postgres-based; Postgres 16 is the only datastore
- **Category:** ARCHITECTURE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Ingest inserts into `events` (PK = normalised UUID) and `event_queue` in the same statement/transaction. Consumers claim work with `DELETE … WHERE seq IN (SELECT … FOR UPDATE SKIP LOCKED)` and commit their effects in the same transaction as the claim.***
- **Why:**
  - **Durable 202** = the commit returned. There is no second system whose fsync or ack semantics must line up.
  - **Exact dedupe** comes from the primary key, correct under concurrency and across restarts (BE-E-02, AC-1).
  - **Effectively-once effects**: the queue "ack" (the DELETE) and the side effects share one transaction. There's no gap between "offset committed" and "effect written".
  - The lag metric is one indexed query (depth + age of the oldest row).
  - The spec explicitly accepts a Postgres-only design if it meets the numbers. Fewer moving parts makes gate G1 (runs in 10 minutes) easier.
- **Alternatives:**
  - Redis Streams: fast, but a second durability story (AOF fsync policy decides whether a 202 is honest), and dedupe still needs Postgres.
  - Kafka/Redpanda: the right answer at 500M events/day (see design.md), but heavy on a laptop, and it needs an outbox or offset-with-result coordination to get the same guarantees.
- **Consequences:** Write amplification (event row + queue row) and vacuum churn on `event_queue`. Mitigated by batch claims and aggressive autovacuum settings on that one table.

## D-004: Data access: raw SQL via `pg`, no ORM
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Use `node-postgres` with hand-written, parameterised SQL. Migrations are ordered `.sql` files applied by a ~40-line runner.***
- **Why:** Ledger correctness depends on locks, isolation, unique constraints and triggers. They must be visible and reviewable (C4, C7), and the reviewer will ask for live changes.
- **Alternatives:** Prisma or TypeORM (hide locking, awkward with triggers); Kysely (fine, but adds a layer for little gain).

## D-005: Money as integer paise (`bigint` / `BIGINT`)
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Amounts are `bigint` in TS and `BIGINT` in SQL. `pg` parses int8 and numeric as `bigint`. Commission = `(subtotal * BigInt(bps)) / 10000n`. BigInt division truncates, which is floor for non-negative values. Amounts are converted to JSON numbers only at the HTTP edge, and that conversion throws if unsafe (> 2^53).***
- **Why:** BE-E-12. Float money is a universal red flag. Check: 99999 × 700 / 10000 → **6999**.

## D-006: Double-entry, append-only ledger enforced by the database
- **Category:** ARCHITECTURE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***`ledger_accounts` (platform `commission_expense`, per-creator `accrued` and `payable`), `ledger_transactions` (unique `idempotency_key`) and `ledger_entries` (signed BIGINT, never 0). Row triggers reject UPDATE/DELETE. A TRUNCATE trigger rejects unless the test-only GUC `aumbram.allow_truncate=on` is set. A deferred constraint trigger checks Σ(entries) = 0 per ledger transaction at commit.***
- **Why:** BE-E-09/10/11. The guarantees live in the database, so no buggy or concurrent worker can break them. Nobody writes balances; they are sums, so a hot creator never causes row contention.
- **Revisit if:** earnings reads get slow. Then add periodic balance checkpoints (see design.md).

## D-007: Versioned attribution, locking and late-locked audit
- **Category:** ARCHITECTURE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***`attribution_decisions(order_id, version)` is append-only (a trigger blocks UPDATE/DELETE), and `orders.attribution_version` points at the current one. New qualifying interactions or checkouts re-evaluate the orders they could affect. Locked orders are evaluated too, but a changed outcome is written to `late_locked_events` instead of a new version.***
- **Why:** BE-E-07, AC-3..5. History is never overwritten, and "why is my commission ₹X?" can be answered from the version trail.

## D-008: Backpressure design
- **Category:** ARCHITECTURE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***A token bucket per client (D-029) → `429` with `Retry-After` = time to refill. A lag monitor (1 s poll) → `503` with `Retry-After` when queue depth ≥ `QUEUE_MAX_DEPTH` or oldest item age ≥ `QUEUE_MAX_LAG_SECONDS`. DB pool acquisition timeouts also → `503`.***
- **Why:** BE-E-03. The queue is bounded by that depth threshold. Clients retry the same batch, and dedupe makes retries safe. The monitor is cached, so no per-request `count(*)`.
- **Note:** The bucket is per instance, which is fine on a laptop. The distributed version is in design.md.

## D-009: Tests: Vitest + fast-check against real Postgres
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Pure attribution rule tests are table-driven plus property-based. The AC-1..7 scenarios and ledger invariants run against the real Postgres from docker-compose (database `aumbram_test`), sequentially, with truncation between tests.***
- **Why:** Requirements BE-E-13/14 and the deliverables checklist ask for real Postgres. Property tests catch boundary and ordering bugs that example tests miss.

## D-010: Load testing with k6
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** ***Superseded by D-014***

## D-011: Scope-cut order
- **Category:** SCOPE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Must-haves → design doc and load evidence (never cut) → Should-haves → Stretch.***
- **Why:** Assignment §6. Gate G2 needs ≥80% of Must-haves, and cuts are fine only when explained.

## D-012: Version control
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Git repo on `main`. The root `.gitignore` excludes `node_modules/`, `dist/`, `.env*` (except `.env.example`), `shared/mock-data/out/`, `shared/mock-data/big/` and load-test results.***
- **Why:** A private Git repo is the preferred submission format. §7 says no secrets or generated data may be committed.

## D-013: Hand-written validators instead of Ajv / JSON-schema
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted (supersedes the validation part of D-002)
- **Decision:** ***Validate the batch envelope, each event and order-event bodies with small typed validator functions that return `{code, message}`.***
- **Why:** Partial acceptance needs a precise per-event `rejected[{index,id,code,message}]` with our own error codes. A failing schema would reject the whole request or need error-mapping glue. The hand-written checks are also plain TS that the reviewer can change live, and they narrow `unknown` to typed values without casts.
- **Alternatives:** Ajv per-event with error mapping (more code for worse messages); zod (extra dependency for the same result).

## D-014: Own Node load-replay script instead of k6
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted (supersedes D-010)
- **Decision:** ***`loadtest/replay.ts` streams `big/events.csv` into batches of 100, sends them at a fixed arrival rate (open model), records p50/p95/p99, throughput, error/429/503 rates, samples queue lag from `/health` every 5 s during the load and for 60 s after, and runs the correctness check (unique ids sent = rows in `events`, queue empty).***
- **Why:** The spec allows "your own". k6 would need the ~125 MB CSV loaded into a SharedArray (heavy on an 8 GB laptop) and separate tooling for lag sampling and the SQL correctness check. One script gives one reproducible command and one report.
- **Consequences:** We own the percentile maths. It's simple: sort all latencies, about 3,000 samples per run.

## D-015: TypeScript 5.9.3, not 7.x
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Pin `typescript@5.9.3`.***
- **Why:** 7.x is the new native (Go-based) compiler line. For a graded submission, a proven toolchain beats compile speed, and nothing here needs 7.x features.

## D-016: Two processes: `api` and `worker`
- **Category:** ARCHITECTURE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***The `api` process handles ingest, order-event intake, reads, `/metrics`, `/health` and the sweep endpoint. The `worker` process runs the event consumers, order-event consumers, an optional scheduled sweep and the invariant checker, and exposes its own `/metrics`. Workers can run as several replicas.***
- **Why:** Ingest latency stays isolated from consumer CPU. Workers scale independently (Stretch BE-E-24), and killing a worker proves durability (BE-E-26).

## D-017: Per-user advisory locks for attribution
- **Category:** ARCHITECTURE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Before touching a user's orders, both the event consumer and the order consumer take `pg_advisory_xact_lock(hashtextextended(user_id, 0))`. The event consumer takes all its users' locks in one statement, sorted by key. Lock order is always user lock(s) → order row locks (sorted by order id). The sweep takes only order row locks.***
- **Why:** Without this there is a write-skew race. The event consumer inserts an interaction and doesn't see the uncommitted order, while the order consumer inserts the order and doesn't see the uncommitted interaction. The order would stay wrongly attributed. With the lock, whichever transaction goes second sees the first one's commit (READ COMMITTED takes a fresh snapshot per statement). The fixed lock order prevents deadlocks, and 40P01/40001 are retried anyway.
- **Alternatives:** SERIALIZABLE isolation (correct, but retry storms under load and harder to reason about in the review call).

## D-018: Ledger effects come from reconciliation ("desired vs held")
- **Category:** ARCHITECTURE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Each order row records what the ledger currently holds for it (`ledger_bucket`, `ledger_creator_id`, `ledger_amount_paise`, `ledger_attribution_version`). After any change (order status, new attribution version, sweep), a pure function `planPostings(held, desired)` returns the ledger transactions needed to move from held to desired. Desired is derived from the order's state: not delivered / returned / cancelled / unattributed → nothing; payable_at set → payable; otherwise accrued.***
- **Why:** Order events arrive duplicated and out of order (for example `returned` before `delivered`). Deriving effects from state instead of from transitions makes processing convergent and idempotent. Re-processing any message is a no-op, and the planner is a pure function that can be table-tested.

## D-019: Ledger idempotency keys
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***`accrue:<orderId>:v<version>`, `payable:<orderId>:v<version>`, `reverse:<orderId>:v<version>`, where version is the attribution version that was accrued. The key column is UNIQUE.***
- **Why:** BE-E-10 says "each business effect at most once per order". The order row lock serialises the work, and the unique key is the DB-level backstop if that ever fails.

## D-020: Attribution is triggered by the first order event of any status
- **Category:** SPEC · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***The first message for an order, whatever its status, creates the order and computes attribution version 1.***
- **Why:** §3.4 B says statuses may arrive out of order (`delivered` before `created`) and every message carries the full snapshot. Waiting for `created` would leave a delivered order unattributed.

## D-021: What locks an attribution
- **Category:** SPEC · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Locked when (a) the sweep makes the order payable (deliveredAt + 7 d passed with no return requested), whether or not it is attributed, or (b) the order is `returned` or `cancelled`. Locking is recorded as `locked_at` + `lock_reason`.***
- **Why:** The spec defines locking only via "payable". Without (a), an unattributed order could gain an attribution and accrue months later. With (b), terminal orders have no money at stake, so re-attributing them is just noise.

## D-022: Returns vs payable
- **Category:** SPEC · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***`return_requested` arriving after the order is payable does not move it back. `returned` arriving after payable reverses the commission from the creator's payable account (a clawback). An order in `return_requested` that is never `returned` stays accrued indefinitely.***
- **Why:** The spec only defines "reverse on returned". Keeping payable → accrued one-way stops balances from going back and forth. The clawback cannot make payable negative because payouts aren't built. With payouts, it would have to become a receivable (design.md).

## D-023: Tap matching follows the §3.2 table literally
- **Category:** SPEC · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***A `story_product_tap` qualifies if `props.productId` is in the order lines and the story is known (it provides the creator). We don't additionally require that the story tags that product.***
- **Why:** That's the executable rule the assignment gives (FAQ 8: implement as written, argue in the design doc). The design doc's trade-offs section recommends adding the tag check as an anti-spoofing measure.

## D-024: When a new attribution version is written
- **Category:** SPEC · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Write version N+1 only if `attributed`, the qualifying event id, or the anchor (source + time) differs from version N. A new version with the same creator doesn't touch the ledger. The rate snapshot for a creator is the rate on the order's earliest decision for that creator.***
- **Why:** Re-evaluations are frequent (every qualifying event for the user). Writing a version per re-evaluation would flood the history with no-ops. The ledger only cares about creator and amount.

## D-025: First order snapshot wins
- **Category:** SPEC · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***The order row (user, vendor, lines, subtotal, createdAt) is taken from the first message. Later messages only add status timestamps (the first occurrence of each status wins). Differing snapshots are logged as warnings.***
- **Why:** The domain model says prices are frozen at checkout. Letting a later message rewrite the subtotal would silently change commission.

## D-026: Ingest in one SQL statement
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***`WITH ins AS (INSERT INTO events SELECT … FROM jsonb_to_recordset($1) ORDER BY id ON CONFLICT (id) DO NOTHING RETURNING id) INSERT INTO event_queue … SELECT FROM ins`, which is one round trip and one implicit transaction.***
- **Why:** Durable, atomic and deduplicated in one statement. Inserting in id order means two concurrent batches containing the same ids take row locks in the same order, so they can't deadlock. The returned row count gives an exact `duplicates` figure.

## D-027: Hostile-input handling in events
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Reject an event (`INVALID_STRING`/`INVALID_PROPS`) if any string or prop contains U+0000 (NUL), which Postgres text/jsonb cannot store and would fail the whole batch. Limit id-like strings to 128 characters. Treat `userId: ""` as `null`.***
- **Why:** One bad event must not turn a batch into a 500 (partial acceptance). The CSV encodes logged-out users as an empty `user_id`.

## D-028: Size errors
- **Category:** SPEC · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Body over 1 MB (after decompression) → `413 PAYLOAD_TOO_LARGE`. `events` empty or over 500 items → `422 BATCH_SIZE_INVALID`.***
- **Why:** The spec allows "413 or 422". Bytes are a transport limit and count is a semantic one.

## D-029: Rate-limit key and unit
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Token bucket keyed by client IP (the socket address; `X-Forwarded-For` isn't trusted without a known proxy). Tokens are events, not requests. Defaults are 10,000 events/s with a 20,000 burst, configurable via env.***
- **Why:** There is one shared app key for all phones, so it can't identify a client. Batches vary from 1 to 500 events, so counting requests would be unfair.

## D-030: Versioned rule parameters
- **Category:** ARCHITECTURE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***72 h, 3,000 ms and 1 h live in `src/attribution/ruleConfig.ts` under a version key (`v1`). `ATTRIBUTION_RULE_VERSION` picks the active one, and each decision stores `rule_version`.***
- **Why:** Stretch BE-E-25 at almost no cost. The design doc's "72 h → 48 h" backfill story depends on it.

## D-031: Which key opens which endpoint
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***`POST /v1/events/batch` accepts only `X-App-Key`. `/v1/internal/*` accepts only `X-Internal-Token`. The read endpoints (`/v1/orders/*`, `/v1/creators/*`) accept either. `/health` and `/metrics` are open (in production they'd sit on an internal port). Keys are compared in constant time.***
- **Why:** The security NFR says internal endpoints must not be reachable with the app key. Real end-user auth is out of scope (§6).

## D-032: Ledger sign convention
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Debit = positive, credit = negative. Accrue: expense +A, creator accrued −A. Make payable: accrued +A, payable −A. Reverse: accrued or payable +A, expense −A. A creator's balance (a liability) is reported as −Σ entries.***
- **Why:** The standard double-entry convention. Σ = 0 per transaction is then a simple `sum()` check.

## D-033: Unknown creators make a story unknown
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Stories are loaded by joining to `creators`. A story whose creator has no rate is treated as unknown and never matches.***
- **Why:** Commission needs a rate snapshot. Attributing to a creator we can't pay would create a liability with no owner.

## D-034: Keep `prom-client` 15
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Pin `prom-client@15.1.3` even though npm now says it is "replaced by @prometheus-io/client".***
- **Why:** The replacement was first published a month ago and is still at 0.x. prom-client 15 is the long-standing, widely used client with a stable API. Migrating later is mechanical: the metric definitions are all in `src/metrics.ts`.

## D-035: Authenticate before reading the body
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Key checks run in Fastify's `onRequest` hook.***
- **Why:** An unauthenticated client can't make us read, decompress or parse up to 1 MB. It's cheaper and removes a DoS vector.

## D-036: Poison-message handling
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***If an event batch fails with a non-transient error, the consumer retries the next events one at a time, each in its own transaction. The one that still fails is moved to `event_dead_letters` (queue delete + dead-letter insert, in one transaction). Order messages already run one per transaction and go to `order_event_dead_letters`.***
- **Why:** A single malformed row must not stop the pipeline (failure-mode table: "poison event"). Transient errors (serialisation, deadlock) are retried by `withTransaction` first, so they're never dead-lettered.

## D-037: Two ledger property tests instead of one
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Property 1 runs random duplicated and shuffled sequences with 1–4 concurrent workers. It checks Σ=0, per-order net ∈ {0, expected} held by the current creator, no negative balances, earnings = Σ entries, and that re-delivering every message changes nothing. Property 2 processes sequentially and checks that replaying on a fresh database gives a transaction-for-transaction identical ledger.***
- **Why:** With concurrent workers, the ledger **history** can legitimately differ between runs. A late event processed before or after `delivered` gives "accrue Y" or "accrue X → reverse X → accrue Y". The **balances** are always identical. So bit-identical replay is only a meaningful claim for a deterministic processing order.
- **Evidence:** Mutation checks. Removing the reversal from `planPostings` makes property 1 fail with a shrunk counterexample. Making the 72 h bound exclusive fails the boundary unit test.

## D-038: No per-request access logs
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***`disableRequestLogging: true`. Latency and volume go to `http_request_duration_seconds` and ingest counters. 5xx responses are logged as warnings. Ingest logs a debug line per batch with `batchId` (also returned to the client). The order pipeline logs `orderId` on every state or ledger change.***
- **Why:** At 20+ batches/s, access logs cost CPU on the hot path and add nothing that metrics don't already give. The support question "why is my commission ₹X?" is answered by the order-id log lines plus `GET /v1/orders/{id}/attribution?history=true`.

## D-039: Meaning of the ingest response counters
- **Category:** SPEC · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***`accepted` = events newly stored and enqueued by this request. `duplicates` = valid events that were already stored, or repeated within this batch. `rejected` = invalid events. They always sum to the batch size. The counts are exact, not best-effort: they come from `INSERT … RETURNING`.***
- **Why:** A client retrying a batch sees `accepted: 0, duplicates: N`, which tells it the earlier attempt landed. AC-1's three concurrent sends sum to exactly 98 accepted.

## D-040: Transaction granularity per queue
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Event consumer: up to 1,000 events per transaction (`WORKER_EVENT_BATCH_SIZE`). Order consumer: one message per transaction.***
- **Why:** Events are high-volume and mostly cheap (most are feed impressions the rule ignores), so batching amortises commit cost. Order messages are low-volume and each takes a user lock and an order row lock. One per transaction keeps lock ordering trivially deadlock-free (one user, then one order) and isolates poison messages without bisecting.

## D-041: Checkpoint tuning instead of weaker durability
- **Category:** ARCHITECTURE · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Run Postgres with `max_wal_size=4GB`, `checkpoint_timeout=15min`, `checkpoint_completion_target=0.9`, `wal_buffers=16MB`, `log_checkpoints=on`. Keep `fsync=on` and `synchronous_commit=on`.***
- **Why (measured):** The first load test (2,500 ev/s, from the host) met throughput and correctness but had p95 729 ms / p99 1,839 ms and nine 503s. Evidence:
  - `pg_test_fsync` on the Docker volume showed `fdatasync` ≈ 3.8 ms, so about 250 commits/s. Steady-state fsync is not the bottleneck.
  - `EXPLAIN ANALYZE` of the 100-row ingest statement showed about 10 ms, all buffer hits.
  - Postgres logged `COMMIT` durations of 1.1–1.4 s during a timed checkpoint that synced 15,820 files, which is file churn from the test suite's `TRUNCATE`s on the same cluster.
  - The 503s were connection-pool timeouts (2 s) caused by those stalled commits, not load shedding.
  - So the tail comes from checkpoint I/O bursts. Fewer and smoother checkpoints remove them.
- **Rejected:** `synchronous_commit=off` or `fsync=off` would make latency trivial but break "202 = durable" (it would not survive `kill -9` of Postgres or a power loss). That violates BE-E-01.
- **Consequences:** Crash recovery replays up to ~4 GB of WAL, which takes longer. That's fine for this workload. At scale this becomes storage-level tuning on dedicated disks (design.md).

## D-042: Where load is generated from
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***A `loadtest` compose service (`docker compose run --rm loadtest`) runs the replay inside the Docker network, so it measures the service rather than Docker Desktop's Windows → WSL2 port forwarding. The host-side run is still reported in `docs/loadtest.md`.***
- **Why (measured):** For identical 100-event batches, p50 was 35 ms inside the container versus 63–77 ms from the Windows host. About 30–40 ms per request is the Docker Desktop port-forward hop, which is not part of the system under test and doesn't exist in production. The in-network setup also makes the test reproducible for a reviewer with one command.

## D-043: Rejected experiment: worker partial-batch wait
- **Category:** IMPLEMENTATION · **Date:** 2026-09-22 · **Status:** Rejected (code reverted)
- **Decision:** ***Do not make the event consumer wait for fuller batches.***
- **Hypothesis tested:** Sampling `pg_stat_activity` during a 2,500 ev/s run showed ingest statements spending ~55% of their time on the WAL flush (`LWLock:WALWrite` 254 samples, `IO:WALSync` 105, CPU 260). Fewer, larger worker commits (a 250 ms wait when a claim returned less than half a batch) should mean less flush contention.
- **Result:** Worse or indistinguishable. Run 5: p95 1,190 ms vs run 4's 232 ms. Later runs (D-044) showed the dominant factor was elsewhere, so the change added complexity with no proven benefit. It was reverted.

## D-044: Where the ingest latency tail comes from (measured)
- **Category:** TOOLING · **Date:** 2026-09-22 · **Status:** Accepted
- **Decision:** ***Report the p95/p99 numbers as measured, with the cause. Do not buy latency with `synchronous_commit=off`, `fsync=off`, unlogged tables or an in-memory buffer, because that breaks "202 = durable".***
- **Evidence:**
  - Postgres slow-statement log during run 6: unrelated backends stalled for ~1 s at the same instant. This included a `bind` (parse/plan only, no I/O) and a `pg_advisory_xact_lock` select, alongside `COMMIT`s and inserts. Nothing inside the database can stall a `bind`, but a stall of the whole VM can.
  - Windows host, measured a few minutes after run 6 with the same stack running: 7.9 GB RAM total, **0.3 GB free**, **4,600–17,000 hard page faults/s**, "Memory Compression" 1.7 GB, and the WSL2 VM process (`vmmem`) resident at only 397 MB although the VM believed it had 2.7 GB of page cache. Windows was paging the Docker VM.
  - Runs degraded as the data set grew (0 → 1.5M events), consistent with a bigger working set under host memory pressure. The one checkpoint-driven stall seen earlier was fixed by D-041.
  - Steady-state cost with no stall: ~10 ms `EXPLAIN ANALYZE` for the 100-row insert, plus a ~4 ms fdatasync.
- **Consequence:** On this 8 GB laptop the throughput, correctness and lag targets are met in every run, but the p95 < 200 ms target is not met reliably. `docs/loadtest.md` lists every run, including the failures. The production answer (dedicated disks, no nested virtualisation, Kafka as the ingest log) is in `docs/design.md`.