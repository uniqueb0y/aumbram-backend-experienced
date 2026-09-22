# Backend 3: Events, Attribution & Creator Commission

| | |
|---|---|
| **Track** | Backend |
| **Level** | Experienced (Senior / Lead, 5+ years) |
| **Recommended effort** | 8–10 hours of focused work. Please don't go beyond 10. We'd rather read your cuts than your overtime. |
| **Submission window** | 7 calendar days from when you receive this |
| **Stack** | **Required:** PostgreSQL as the system of record for attribution and the ledger, `docker-compose` for every dependency, a reproducible load-test script, and a written design doc. **Your choice:** language (Node/TypeScript, Go, Java/Kotlin or Python), queue/log technology (Postgres-based queue, Redis Streams, Kafka/Redpanda, NATS JetStream…), and test and load tools. |
| **Deliverable format** | A private Git repository shared with us (preferred) or a zip, containing the code, `README.md` (per the [template](../shared/company-brief.md#submission-readme-template)), `docs/design.md` and `docs/loadtest.md` |

Please read the [candidate brief](../shared/company-brief.md), the [domain model](../shared/domain-model.md)
(especially **Event**, **Order**, the **state machine** and the **attribution rule**) and the
[evaluation rubric](../shared/evaluation-rubric.md) first.

---

## 1. The scenario

Ananya Singh (`@ananya.desi0`) earns her living from stories. Last month one story about a Bagru Collective Ajrakh kurta
drove dozens of orders, and her earnings screen said ₹3,120. Her own spreadsheet said about ₹4,000. When our team checked,
the numbers were both "right" in the way that makes a platform lose creators: events from phones that had been offline in a
Rajasthan village arrived a day late and were ignored, a retried upload was counted twice for another creator, and two
orders that were returned had been paid out anyway and quietly netted off later.

A creator's commission is **money owed to a real person**. It has to be explainable line by line, it must never double-count,
and it has to stay right while tens of thousands of mid-range Android phones stream analytics over patchy networks, and during
Diwali, when traffic multiplies.

Your job is to design and build the first production-shaped version of the pipeline that turns **events → attribution → commission ledger**,
and to write down how it becomes a system for 10M daily active users.

---

## 2. What you'll build

Four parts. Parts A–C are code. Part D is a document. All four are required.

```
  Mobile clients (batches, retries, offline replay)
          │  POST /v1/events/batch
          ▼
  ┌───────────────────┐  202 = durably accepted   ┌──────────────────────────┐
  │ A. Ingestion API   │─────────────────────────►│ queue / log (your choice) │
  │ validate · stamp   │  429/503 + Retry-After   └─────────────┬────────────┘
  │ serverTs · limits  │  when saturated                        │ consumers (at-least-once)
  └───────────────────┘                                         ▼
                                                  ┌──────────────────────────┐
  Order service                                   │ event store (dedupe by id)│
  POST /v1/internal/order-events ──────┐          └─────────────┬────────────┘
  (created, delivered, return_requested│                        │ qualifying story interactions
   returned, cancelled …)              ▼                        ▼
                                  ┌───────────────────────────────────────┐
                                  │ B. Attribution engine                  │
                                  │ shared rule · late events · versioned │
                                  └───────────────────┬───────────────────┘
                                                      │ attribution decisions
                                                      ▼
            clock / sweep job ──────────►┌───────────────────────────────────────┐
                                         │ C. Commission ledger (append-only,    │
                                         │    double-entry, Σ entries = 0)       │
                                         └───────────────────┬───────────────────┘
                                                             ▼
                                         GET /v1/creators/{id}/earnings

  D. docs/design.md: 10M DAU · 500M events/day · tiering · backfill · delivery semantics · observability · failure modes
```

---

## 3. Provided materials

### 3.1 Mock data

```bash
cd shared/mock-data
node generate.mjs --out ./out                              # reference data + 50k events
node generate.mjs --events 500000 --out ./big              # for load testing (~500k events)
```

| File | Use | Quirks you must handle (default seed) |
|---|---|---|
| `stories.json` | Story → `creatorId` and `taggedProducts` (the attribution rule needs both) | 11 of 120 stories tag no products. `expiresAt` is display-only and does **not** affect attribution. |
| `products.json` | Product → `vendorId`, variant → product | Variants are nested. `prd_9999` does not exist but appears in events. |
| `creators.json` | `commissionRateBps` (300, 500, 700 or 1000) | |
| `events.csv` | Load-test and dirty-data source (columns `event_id,user_id,session_id,name,props_json,client_ts,server_ts,os,model,network`) | About **1% duplicate `event_id`s** (identical rows). About **5% of devices** have clocks skewed by hours. **15%** of rows have an empty `user_id` (logged-out sessions). `story_view` carries `props.watchMs`, and about 9% of views are under 3 s. There are rare unknown `productId`s. `event_id` is a bare UUID (no `evt_` prefix). **Within a session, `server_ts` sometimes goes backwards** relative to row order. |
| `orders.json` | Shapes and volumes for order lifecycle input | The generator does **not** join orders to events: `purchase` events reference random orders, and the stored `attribution` field is **not ground truth** (most attributed orders reference a story that tags no product of the order's vendor). Build your attribution tests from hand-written fixtures, not from this file. |

### 3.2 Precise attribution rule (the shared rule, made executable)

The [shared rule](../shared/domain-model.md#attribution-rule-used-by-backend-full-stack-and-data-tracks):
*"A purchase is attributed to the last story the user interacted with (`story_view` ≥ 3s, or `story_product_tap`) for any product
in the order, from the same vendor, within 72 hours before `checkout_start`. If none qualifies, the order is unattributed."*

For this assignment, implement it as follows:

| Term | Definition |
|---|---|
| **Anchor time** | The `serverTs` of the user's latest `checkout_start` event with `serverTs ≤ order.createdAt` and `serverTs ≥ order.createdAt − 1 h`. If there is no such event, the anchor is `order.createdAt`. A multi-vendor checkout produces several orders that share one anchor, and each order is attributed **independently**. |
| **Candidate interaction** | An event with the same `userId` as the order (non-null), and either `name = story_view` with integer `props.watchMs ≥ 3000`, or `name = story_product_tap`. |
| **Product match** | For `story_product_tap`, `props.productId` is a product in the order's lines. For `story_view`, the story (looked up by `props.storyId` in `stories.json`) tags **at least one** product in the order's lines. Because an order has a single vendor, a match is always "from the same vendor". Unknown stories or products never match. |
| **Window** | `anchor − 72 h ≤ event.serverTs ≤ anchor` (inclusive on both ends). |
| **Winner** | The qualifying event with the greatest `serverTs`. Ties break on greater `receivedAt`, then on the lexicographically greater event id. |
| **Creator** | `story.creatorId` from `stories.json`. **Never** trust `props.creatorId` from the client. |
| **Commission** | `floor(order.subtotal.amount × commissionRateBps / 10000)` using **integer arithmetic only**. `subtotal` excludes shipping. The rate is snapshotted when the order is first attributed to that creator. |
| **Accrues** | When the order reaches `delivered`, if it is attributed. |
| **Payable** | When `now ≥ deliveredAt + 7 days` **and** the order has not entered `return_requested`. If a return is requested, commission stays accrued until the order is `returned` (reverse) or you document otherwise. |
| **Reverses** | When the order reaches `returned`, or when a re-attribution moves the order to a different creator (or to unattributed) after accrual. |

### 3.3 `serverTs` and late-arriving events

The domain model says "clocks on phones are wrong; trust `serverTs` for ordering". But a phone that was offline for
six hours uploads its batch late, so the *receive* time is also wrong for attribution. For this assignment, `serverTs` is
**computed by the server** from the batch envelope:

```
receivedAt = server clock when the batch arrived
offset     = receivedAt − batch.sentAt            (sentAt is the phone clock at send time)
serverTs   = min(receivedAt, event.clientTs + offset)
             (if sentAt is missing or unparseable: serverTs = receivedAt)
```

This corrects skewed clocks (the whole batch shares one device clock) and preserves the real order of offline events.
Store `clientTs`, `receivedAt` and `serverTs`. An event is **late** if it arrives after an attribution decision that it would have changed.

Late events must be handled:

- An attribution is **provisional** until the order's commission becomes payable. Until then, a newly ingested qualifying
  event must cause the affected order(s) to be re-evaluated. Attribution decisions are **versioned**: never update in place without history.
- Once commission is **payable**, the attribution is **locked**. A late event that would have changed it is recorded (for audit and metrics) but changes nothing.

### 3.4 API contract

The error shape, money and timestamp conventions follow the [domain model](../shared/domain-model.md#conventions).

#### A. Ingest a batch

```http
POST /v1/events/batch
X-App-Key: dev_app_key_change_me
Content-Type: application/json
Content-Encoding: gzip        (optional, Should-have)
```

```json
{
  "sentAt": "2026-09-13T14:05:09Z",
  "events": [
    {
      "id": "evt_6f1b0a52-7c1e-4d0b-9a61-3e2f5b7c9d10",
      "userId": "usr_001466",
      "sessionId": "0c677996-3fd9-45ac-a2c2-bb54760b7f1c",
      "name": "story_view",
      "props": { "storyId": "sty_0108", "creatorId": "crt_0001", "watchMs": 4200 },
      "clientTs": "2026-09-13T14:04:31Z",
      "device": { "os": "android", "model": "Redmi Note 12", "network": "3g" }
    },
    {
      "id": "0b7f7c1e-5d0b-4e61-8a61-9c2f5b7c3e11",
      "userId": "usr_001466",
      "sessionId": "0c677996-3fd9-45ac-a2c2-bb54760b7f1c",
      "name": "story_product_tap",
      "props": { "storyId": "sty_0108", "productId": "prd_0031" },
      "clientTs": "2026-09-13T14:04:40Z",
      "device": { "os": "android", "model": "Redmi Note 12", "network": "3g" }
    }
  ]
}
```

Response `202 Accepted`:

```json
{ "receivedAt": "2026-09-13T08:35:12Z", "accepted": 2, "duplicates": 0, "rejected": [] }
```

(In this example the phone's clock is about 5.5 hours fast. The stored `serverTs` of the first event will be `2026-09-13T08:34:34Z`.)

| Rule | Detail |
|---|---|
| Batch | 1–500 events, ≤ 1 MB after decompression. Otherwise `413 PAYLOAD_TOO_LARGE` or `422`. |
| `id` | Required. A UUID, optionally prefixed with `evt_`. The dedupe key is the lower-cased UUID, so `evt_<uuid>` and `<uuid>` are the **same** event. |
| `name` | One of the seven names in the domain model. |
| Required `props` | `feed_impression`: `feedItemId`, `position` · `card_tap`: `feedItemId` · `story_view`: `storyId`, `watchMs` (integer ≥ 0) · `story_product_tap`: `storyId`, `productId` · `add_to_cart`: `productId` · `checkout_start`: none · `purchase`: `orderId`. Extra props are kept. |
| Other fields | `sessionId` required. `userId` nullable. `clientTs` required (ISO-8601). `device` optional. |
| Partial acceptance | Invalid events are listed in `rejected: [{ "index", "id", "code", "message" }]`. Valid events in the same batch are still accepted. |
| **Meaning of 202** | Every accepted event is **durably** stored or enqueued (it would survive `kill -9` of the API process). An in-memory buffer does not count. |
| Duplicates | `duplicates` may be best-effort at request time, but downstream processing must be **exactly deduplicated**: a duplicate never counts twice anywhere. |
| No per-event DB lookups | Don't validate that `storyId` or `productId` exist during ingestion. Unknown references are accepted and ignored downstream. |
| Backpressure | When saturated, return `429` (per-client limit) or `503` (system lag), with `Retry-After`. Clients retry the same batch; dedupe makes that safe. |
| Auth | `X-App-Key` must match an env-configured key, otherwise `401`. |

#### B. Order lifecycle input and attribution read

```http
POST /v1/internal/order-events
X-Internal-Token: dev_internal_token_change_me
```

```json
{
  "orderId": "ord_000123",
  "status": "delivered",
  "occurredAt": "2026-09-15T11:20:00Z",
  "order": {
    "userId": "usr_001466",
    "vendorId": "vnd_0024",
    "lines": [{ "variantId": "var_00095", "quantity": 2, "unitPrice": { "amount": 129900, "currency": "INR" } }],
    "subtotal": { "amount": 259800, "currency": "INR" },
    "createdAt": "2026-09-13T08:40:00Z"
  }
}
```

- `status` is any order status from the domain model. Deduplicate on `(orderId, status)`. The service may receive statuses
  **out of order** (for example, `delivered` before `created`) and **more than once**. The full `order` snapshot is included in every message.
- Response: `202`. Processing may be asynchronous.

`GET /v1/orders/{orderId}/attribution` → `200`:

```json
{
  "orderId": "ord_000123",
  "attributed": true,
  "storyId": "sty_0108",
  "creatorId": "crt_0001",
  "qualifyingEvent": { "id": "0b7f7c1e-5d0b-4e61-8a61-9c2f5b7c3e11", "name": "story_product_tap", "serverTs": "2026-09-13T08:34:43Z" },
  "anchor": { "source": "checkout_start", "at": "2026-09-13T08:39:10Z" },
  "commissionRateBps": 300,
  "commission": { "amount": 7794, "currency": "INR" },
  "version": 2,
  "locked": false,
  "decidedAt": "2026-09-13T08:41:02Z"
}
```

#### C. Earnings

`GET /v1/creators/{creatorId}/earnings` → `200`:

```json
{
  "creatorId": "crt_0001",
  "asOf": "2026-09-23T00:00:00Z",
  "accrued":  { "amount": 15588, "currency": "INR" },
  "payable":  { "amount": 7794,  "currency": "INR" },
  "reversed": { "amount": 7794,  "currency": "INR" },
  "lifetimeEarned": { "amount": 23382, "currency": "INR" },
  "orderCounts": { "accrued": 2, "payable": 1, "reversed": 1 },
  "ledgerSequence": 184223
}
```

Here `accrued` and `payable` are **current balances**, `reversed` is lifetime reversals, and `lifetimeEarned = accrued + payable + everything ever paid out`
(payouts are a Stretch goal, so it's usually `accrued + payable`). All figures must come from **one consistent snapshot** of the ledger.

Also required: `POST /v1/internal/jobs/commission-sweep` with `{ "asOf": "…" }`, which runs the payable sweep as of a given time (the clock is injectable).

---

## 4. Requirements

IDs use the prefix `BE-E`.

### Must have

**Part A: Ingestion**

| ID | Requirement |
|---|---|
| **BE-E-01** | `POST /v1/events/batch` implementing every rule in §3.4 A, including partial acceptance, `serverTs` derivation (§3.3) and durable 202 semantics. |
| **BE-E-02** | Dedupe by normalised event id, correct under concurrency and across restarts. The same event sent in two concurrent batches is processed once. |
| **BE-E-03** | Queue/backpressure design, implemented: bounded capacity, a visible lag metric, and `429`/`503` + `Retry-After` when limits are hit. The README justifies your queue choice against at least one alternative. |
| **BE-E-04** | **Throughput:** sustain **≥ 2,000 events/s for ≥ 120 s** on a laptop, with **p95 ingest latency < 200 ms** for batches of 100, while consumers keep up (lag returns to near zero within 60 s of the load stopping). |
| **BE-E-05** | A **load-test script** in the repo (k6, autocannon, vegeta, Locust or your own) that replays `big/events.csv` in batches, plus `docs/loadtest.md` with machine specs, command, p50/p95/p99, throughput, error and 429 rates, lag over time (a table is fine) and a **correctness check**: count of unique event ids processed = count of unique ids sent. |

**Part B: Attribution**

| ID | Requirement |
|---|---|
| **BE-E-06** | An attribution engine implementing §3.2 **exactly**, triggered by order `created` events (and re-run as described in BE-E-07). |
| **BE-E-07** | Late events: a newly processed qualifying event re-evaluates the affected provisional orders. Decisions are versioned. Locked orders don't change, but late changes are recorded. |
| **BE-E-08** | `GET /v1/orders/{orderId}/attribution` as in §3.4 B, explaining the winning event and the anchor. |

**Part C: Ledger**

| ID | Requirement |
|---|---|
| **BE-E-09** | Append-only, **double-entry** ledger in Postgres. Every ledger transaction's entries sum to **0**. Entries are never updated or deleted, and corrections are new compensating entries. At minimum it has a platform commission-expense account and per-creator `accrued` and `payable` accounts. |
| **BE-E-10** | Lifecycle: accrue on `delivered` (if attributed), move to payable via the sweep when the return window has passed, reverse on `returned`, and reverse-then-re-accrue when a provisional attribution changes after accrual. Each business effect happens **at most once per order**, even with duplicate or out-of-order order events and concurrent workers. |
| **BE-E-11** | `GET /v1/creators/{creatorId}/earnings` read from a consistent snapshot, correct while order events are being applied concurrently. |
| **BE-E-12** | Money is integer paise (`BIGINT`) end to end, and commission uses integer floor division. |

**Tests and docs**

| ID | Requirement |
|---|---|
| **BE-E-13** | **Attribution edge cases** as table-driven and/or property-based tests. At minimum: exactly 72 h (in) and 72 h + 1 s (out); `watchMs` 2999 vs 3000; view of a story tagging only *another* product of the same vendor (no match); a tap on a product in a different order of the same checkout; a newer non-qualifying event after an older qualifying one; tie on `serverTs`; logged-out events; unknown story; no `checkout_start` (anchor fallback); a skewed device clock corrected by `sentAt`; and a late event changing a provisional attribution vs. a locked one. |
| **BE-E-14** | **Ledger invariants** as property-based (or randomised table-driven) tests. For random sequences of order events (duplicated, shuffled, concurrent): Σ of all entries = 0; per-order net commission ∈ {0, expected}; no creator's payable balance is ever negative; replaying the same input twice produces an identical ledger; earnings = sum of entries per account. Include rounding cases, for example a subtotal of 99999 at 700 bps → **6999** paise. |
| **BE-E-15** | **`docs/design.md`**, covering every section in §4.1. |
| **BE-E-16** | `docker compose up` plus at most two commands starts everything. The README includes a scripted end-to-end demo (shell script or test) that ingests events, sends order events, runs the sweep and prints earnings. |

#### Key acceptance criteria

- **AC-1 (dedupe under retry).** **Given** a batch of 100 events containing 2 internal duplicates, **when** the client sends it three times concurrently, **then** exactly 98 events are
  stored and processed, and aggregate counts (and any attribution they influence) reflect 98.
- **AC-2 (last qualifying interaction).** **Given** `usr_A` viewed `sty_0108` for 4.2 s at T−50 h (tags `prd_0031`), tapped `prd_0006` in `sty_0109` at T−10 h, and viewed `sty_0108` for 1.5 s at T−1 h,
  **when** an order from `vnd_0024` containing `prd_0031` is created with anchor T, **then** it is attributed to `sty_0108` / `crt_0001` via the T−50 h view. (The T−10 h tap is for another
  vendor's product. The T−1 h view is too short.) The same checkout's `vnd_0016` order containing `prd_0006` is attributed to `sty_0109` / `crt_0015`.
- **AC-3 (late event, provisional).** **Given** the order in AC-2 is attributed to `sty_0108` and not yet delivered, **when** an offline batch arrives containing a
  `story_product_tap` on `prd_0031` in a story by another creator, with a corrected `serverTs` of T−2 h, **then** attribution version 2 names the new creator, and after delivery only the new creator accrues.
- **AC-4 (late event, after accrual).** **Given** the order was delivered and commission accrued to creator X, **when** the late event from AC-3 arrives before the payable time, **then**
  the ledger shows X accrue → X reverse → Y accrue, Σ = 0, and X's accrued balance returns to its previous value.
- **AC-5 (locked).** **Given** the order's commission became payable at `deliveredAt + 7 d`, **when** a late qualifying event arrives, **then** attribution and ledger are unchanged, and
  the change is recorded as a late-locked event.
- **AC-6 (return).** **Given** an attributed order delivered at D, **when** `return_requested` arrives at D + 6 d 23 h and `returned` at D + 9 d, and the sweep runs daily,
  **then** the commission is never payable, and a reversal is posted exactly once, even if `returned` is delivered three times.
- **AC-7 (concurrent earnings).** **Given** 200 attributed orders for `crt_0001` whose `delivered` events are each sent twice, concurrently across your workers, while a client polls
  `/earnings`, **then** every poll returns internally consistent numbers (never a half-applied transaction), and the final accrued balance equals the sum of floor-rounded commissions for the 200 orders.

### Should have

| ID | Requirement |
|---|---|
| **BE-E-17** | `Content-Encoding: gzip` on ingestion, with limits applied to decompressed size (zip-bomb safe). |
| **BE-E-18** | `GET /metrics` (Prometheus): ingest rate, rejects by code, duplicate rate, queue lag, consumer throughput, attribution re-evaluations, late-locked count, ledger transactions by type, and an invariant check result. |
| **BE-E-19** | A scheduled **invariant checker** that verifies Σ entries = 0 and balance consistency, and logs/alerts on violation. |
| **BE-E-20** | `GET /v1/creators/{creatorId}/ledger?cursor=` listing entries with order id, type and amount, so a creator can reconcile line by line. |
| **BE-E-21** | A backfill/import command that loads `events.csv` trusting its `server_ts` column (historical mode, bypassing the §3.3 derivation), and re-runs attribution for a time range idempotently. |
| **BE-E-22** | Session stitching: logged-out events in a session are attributed to the user who logs in within that session (document the privacy trade-off). |

### Stretch

| ID | Requirement |
|---|---|
| **BE-E-23** | Payouts: a `payable → paid_out` transaction with an idempotent payout id and a per-creator minimum payout threshold. |
| **BE-E-24** | Horizontal consumer scaling demo: two or more consumer processes with partitioning (for example by `userId`), showing ordering and dedupe guarantees still hold. |
| **BE-E-25** | Rule versioning: attribution parameters (72 h, 3 s) come from a versioned config, and a decision records which rule version produced it. |
| **BE-E-26** | A chaos test: kill a consumer mid-batch during the load test and show zero loss and zero double-counting. |

### 4.1 Required design doc (`docs/design.md`)

About 4–8 pages. Diagrams can be ASCII or Mermaid. Numbers beat adjectives. Required sections:

1. **Scale model.** 10M DAU and 500M events/day. Work out average and peak events/s (state your peak factor, and a festive-day factor), bytes per event
   (assume ~400 bytes JSON if you have nothing better), daily and monthly raw volume, and compressed volume. Estimate the number of ingestion instances, partitions and consumers.
2. **Architecture at scale.** What changes from your laptop version: ingestion tier, the log/queue (partitioning key and why), dedupe at scale (window, memory,
   correctness beyond the window), the attribution store (per-user interaction index), and ledger scaling (partitioning, hot creators).
3. **Storage tiering.** Hot, warm and cold tiers for raw events, interaction indexes, attribution decisions and the ledger. For each: retention, format, access pattern and rough cost drivers.
   Note what must be kept long-term for financial and tax audit, and data-protection considerations for user-level events (India's DPDP Act, 2023).
4. **Reprocessing and backfill.** How to re-run attribution for 30 days after a bug fix or a rule change (for example 72 h → 48 h) without double-paying or clawing back locked commission
   silently. How ledger corrections are posted, and how you avoid overloading production.
5. **Delivery semantics.** Where you have at-least-once and where you get effectively-exactly-once *effects*, and exactly which mechanism provides each (idempotency keys, unique constraints, transactional outbox,
   consumer offsets committed with results, and so on). Be explicit about the windows where duplicates or loss can occur.
6. **Observability.** SLIs and SLOs (for example ingest availability, end-to-end event-to-attribution lag p95, ledger invariant violations = 0), dashboards, alerts with thresholds, and how a support engineer answers "why is
   my commission ₹X?" for a single order.
7. **Failure-mode table.** At least 8 rows with the columns *failure · detection · impact · mitigation · recovery*. Include at least: queue broker outage, consumer crash mid-batch, Postgres primary failover,
   poison event, a client bug flooding duplicates, a massive offline replay after a network outage, clock skew beyond your correction, a hot creator (viral story), and a bad rule deploy.
8. **Trade-offs and what you'd do next.** What you deliberately did not build, and the order you'd build it in.

---

## 5. Non-functional requirements

| Area | Target |
|---|---|
| **Ingestion throughput** | ≥ 2,000 events/s sustained for 120 s on a laptop (state the CPU and RAM), batches of 100 |
| **Ingestion latency** | p95 < 200 ms, p99 < 500 ms at that load. No 5xx except intentional `503` backpressure. |
| **Durability** | Zero accepted events lost across a `kill -9` of the API or a consumer (demonstrate at least once, or explain why it holds) |
| **Freshness** | Laptop: event-to-attribution re-evaluation p95 < 5 s under load. At scale: state your SLO in the design doc. |
| **Correctness** | Σ ledger entries = 0 always. Zero double accruals. Attribution matches §3.2 in every tested case. |
| **Security** | `X-App-Key` and `X-Internal-Token` from env. Internal endpoints are not reachable with the app key. Body size limits. No PII (phone numbers, addresses) in logs. Event `props` treated as untrusted input (never trust `creatorId` from props). |
| **Operability** | JSON logs with correlation ids (batch id and order id), a health endpoint that reports DB and queue status, config validated at startup, and consumers that resume cleanly after a restart. |

---

## 6. Constraints & rules

- **Required:** Postgres for attribution decisions and the ledger. You may use another store for the raw event log or queue, but it must run in `docker-compose` and you must justify it.
  A Postgres-only design (for example a `SKIP LOCKED` queue or partitioned tables) is perfectly acceptable if you can show it meets the numbers.
- **Not allowed:** managed cloud services (everything must run locally), or a stream-processing framework that implements the attribution logic for you (Flink/Spark SQL jobs etc.). We want to read *your* rule code.
- **AI assistants are allowed and must be disclosed.** At this level we'll probe design decisions deeply and ask you to change attribution or ledger code live.
- **Don't spend time on:** a UI, real auth/OAuth, a real order or checkout service (you only *receive* order events), Kubernetes manifests, cloud IaC, or perfecting the load test beyond the target.
- **Suggested time split:** ingestion + queue 2.5 h · load test 1 h · attribution 2.5 h · ledger 2 h · design doc 2 h. If you must cut, cut Stretch, then Should-haves, then **narrow**
  BE-E-07 (for example, support late events but skip the "locked" audit record), and say so. **Don't** cut the design doc, the ledger invariants, or the load-test evidence.

---

## 7. Deliverables & submission checklist

- [ ] Source code, migrations, `docker-compose.yml` (pinned images), `.env.example` (dev-only placeholder secrets)
- [ ] `README.md` per the [template](../shared/company-brief.md#submission-readme-template), including:
  - [ ] Run, test, load-test and end-to-end demo commands
  - [ ] BE-E Must / Should / Stretch checklist (done, partial or not done)
  - [ ] Queue choice and backpressure justification
  - [ ] Where "exactly once" effects come from in *your* implementation
  - [ ] Any interpretation of §3.2/§3.3 beyond what's written, with reasons
  - [ ] AI usage and time spent
- [ ] `docs/design.md` covering all 8 sections of §4.1
- [ ] `docs/loadtest.md` with machine specs, raw numbers and the correctness check
- [ ] Load-test script and the exact command used
- [ ] Attribution edge-case tests (BE-E-13) and ledger invariant tests (BE-E-14), running with one command against real Postgres
- [ ] End-to-end demo script (BE-E-16)
- [ ] No secrets or generated data committed

---

## 8. How you'll be evaluated

Scored on the 1–4 scale of the [shared rubric](../shared/evaluation-rubric.md) at the **Experienced** bar, after gate checks G1–G3.
At this level, **"nothing essential is forgiven"**, but scope cuts are fine **if explained**.

| Criterion | Weight | What great looks like for this assignment |
|---|---|---|
| C1 Functionality | **10%** | Ingestion, attribution, ledger and earnings work end to end from the demo script on a clean machine. |
| C2 Correctness & edge cases | **15%** | The rule is implemented exactly, including boundaries. Late events, duplicates, out-of-order order events and returns all produce the right money. |
| C3 Code quality & structure | **5%** | The attribution rule is a pure, readable function. Ledger posting is isolated. Ingestion, consumers and domain logic are cleanly separated. |
| C4 Architecture & design | **20%** | A defensible queue/backpressure design, a versioned attribution model and a real double-entry ledger. The design doc has credible numbers, a sharp failure-mode table and an honest account of delivery semantics. |
| C5 Performance | **10%** | ≥ 2,000 events/s with measured p95/p99, lag and a correctness check. The bottleneck is identified with evidence, not guessed. |
| C6 Testing | **15%** | Property-based or table-driven tests that would catch real bugs at the 72 h / 3 s boundaries and in ledger invariants under shuffled, duplicated input. |
| C7 Security & data integrity | **10%** | Durable 202, exact dedupe, append-only ledger with DB-enforced guarantees, untrusted props, and separate internal auth. |
| C9 Operability | **5%** | Meaningful metrics (lag, dedupe, late-locked, invariants), a health check that reflects dependencies, and structured logs that support "why is my commission ₹X?". |
| C10 Communication | **10%** | Clear README and design doc, explicit interpretations and cuts, measured claims only, and AI use disclosed. |
| **Total** | **100%** | |

---

## 9. FAQ / assumptions you can make

1. **Do I need the `orders.json` orders?** Not for correctness. Use them for realistic shapes, volumes and a load of order events if you want. Your attribution tests must use
   hand-built fixtures, because the generator does not link events to orders (see §3.1).
2. **What about `purchase` events?** They're analytics only. The source of truth for orders is `POST /v1/internal/order-events`. Don't attribute from `purchase` events.
3. **Can the attribution engine query Postgres for each order?** Yes, at laptop scale, if your interaction index is designed for it (for example a `(user_id, server_ts)` index on qualifying
   interactions only). Discuss in the design doc what replaces it at 500M events/day.
4. **What if an order's lines contain a product that isn't in `products.json`?** It can't match any story. Attribute on the remaining lines, or mark it unattributed if there are none.
5. **Does commission change if a creator's rate changes later?** No. Use the rate snapshotted at first attribution to that creator (§3.2).
6. **Are partial returns in scope?** No. Returns are order-level, per the domain model's state machine.
7. **Is Kafka expected?** No. Pick what you can justify and operate. We care more about the reasoning, the backpressure behaviour and the evidence than the brand name.
8. **I disagree with a rule in §3.2 or §3.3.** Good. Implement it as written, then argue for your alternative in the design doc's trade-offs section.
