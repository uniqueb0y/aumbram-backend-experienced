# Load test (BE-E-05)

**Result.** On this laptop, throughput, correctness, consumer lag and durability under `kill -9` pass in every run. The latency target is **met server-side at p95 but not at p99**, and not at client-observed p95. The tail is caused by the Windows host paging the Docker VM (measured below, D-044). It is not caused by the ingest path.

| Target (§4, §5) | Official run (2,000 ev/s, 150 s, fresh volume) | Status |
|---|---|---|
| ≥ 2,000 events/s sustained ≥ 120 s | 2,001 ev/s offered, **1,981 ev/s newly stored** for 150 s; the other ~1% were the CSV's own duplicates | ✅ |
| p95 < 200 ms (batches of 100) | server-side **95.7% of batches < 200 ms**; client-observed p95 **241 ms** | ⚠️ server ✅ / client ❌ |
| p99 < 500 ms | server-side 98.5% < 500 ms; client p99 **1,570 ms** | ❌ |
| No 5xx except intentional 503 | 3,001 × `202`, 0 × 5xx, 0 × 429/503 | ✅ |
| Lag back to ~0 within 60 s of load stopping | **queue empty 1.1 s** after the load stopped | ✅ |
| Freshness: event → re-evaluation p95 < 5 s | `event_to_processed_seconds` p95 **≤ 0.5 s**, p99 ≤ 1 s | ✅ |
| Correctness: unique ids processed = unique ids sent | **297,209 = 297,209**, 0 still queued | ✅ |
| Zero accepted events lost across `kill -9` | chaos run: 88,164 = 88,164 after killing worker and API | ✅ |

## Machine

- Laptop: Intel Core i7-7700HQ @ 2.80 GHz (4 cores / 8 threads), **8 GB RAM**, Windows 10 Pro.
- Docker Desktop 29.2 (WSL2 backend), VM with 8 vCPUs and 4 GB RAM. Postgres 16.4 in that VM with `shared_buffers=256MB`, `synchronous_commit=on`, `fsync=on` and checkpoint tuning (D-041).
- Measured disk: `pg_test_fsync` → `fdatasync` 3.8 ms/op (~266 ops/s) on the Docker volume.

## How to reproduce

```bash
node shared/mock-data/generate.mjs --events 500000 --out shared/mock-data/big   # ~115 MB, git-ignored
docker compose down -v && docker compose up -d --build                           # fresh volume
docker compose run --rm loadtest                                                 # 2,500 ev/s, 150 s (default)
# the official run below:
docker compose run --rm loadtest node dist/loadtest/replay.js --file /data/events.csv --rate 2000 --duration 150 --salt final
```

(In Git Bash on Windows, prefix with `MSYS_NO_PATHCONV=1` so `/data/...` isn't rewritten.)

The script is [`loadtest/replay.ts`](../loadtest/replay.ts) (why our own script and not k6: D-014). It:
- streams `events.csv` into batches of 100 and sends them at a **fixed arrival rate** (open model: a slow response doesn't slow the offered load);
- retries 429/503 after `Retry-After`, like the SDK would;
- samples `/health` (queue depth and oldest-item age) every 5 s;
- afterwards, checks in Postgres that every id the API answered 202 for is in `events` and not in `event_queue`.

It runs **inside the compose network** (D-042): from the Windows host, Docker Desktop's port forwarding added 30–40 ms per request. `--salt` remaps ids deterministically so repeated runs insert fresh events. Raw JSON for every run is in [`docs/loadtest-evidence/`](loadtest-evidence/).

## Official run: 2,000 ev/s, 150 s, fresh volume (`final`)

| | Value |
|---|---|
| Batches sent / responses | 3,001 / 3,001 × `202` |
| Events accepted / duplicates / rejected | 297,209 / 2,891 / 0 |
| Client latency p50 / p95 / p99 / max | **21 / 241 / 1,570 / 2,673 ms** |
| Server latency histogram (`http_request_duration_seconds`, route `/v1/events/batch`) | ≤ 25 ms: 74.8% · ≤ 50 ms: 90.8% · ≤ 100 ms: 93.8% · **≤ 200 ms: 95.7%** · ≤ 500 ms: 98.5% · ≤ 1 s: 99.3% · ≤ 2.5 s: 100% |
| Error rate / 429 rate / 503 rate | 0 / 0 / 0 |
| Queue drained after load | 1.1 s |
| Event → processed (worker histogram) | p95 ≤ 0.5 s, p99 ≤ 1 s |
| Correctness | 297,209 unique ids sent = 297,209 stored = 297,209 processed ✅ |

**Lag over time** (from `/health`, every 5 s):

| t (s) | 5 | 15 | 25 | 35 | 40 | 45 | 60 | 75 | 90 | 100 | 110 | 121 | 135 | 141 | 150 (load stopped) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| queue depth | 100 | 98 | 297 | 200 | 298 | 398 | 98 | 0 | 98 | 397 | 396 | 397 | 0 | 395 | **0** |
| oldest item age (s) | 0.05 | 0.05 | 0.12 | 0.08 | 0.85 | 0.18 | 0.05 | 0 | 0.04 | 0.18 | 0.15 | 0.16 | 0 | 0.70 | **0** |

The consumers never fall behind: the queue holds at most a few batches, and the oldest item is always under 1 s old.

## All runs, including the ones that didn't count

| Run | Setup | Rate | Accepted ev/s | p50 | p95 | p99 | Correct | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | from Windows host, fresh DB after tests | 2,500 | 2,476 | 62 | 729 | 1,840 | ✅ | 9 × 503 from pool timeouts during a checkpoint that synced 15,820 files (test-suite churn) → D-041 |
| 2 | in-network, fresh volume, checkpoint tuning | 2,500 | 2,476 | 23 | 440 | 1,104 | ✅ | no 503s any more |
| 3 | in-network, **invalid** | 2,500 | 0 | 13 | 28 | 65 | – | replayed ids already stored: 100% duplicates, no writes. Discarded; led to `--salt` |
| 4 | in-network, warm (0.37M rows) | 2,500 | 2,475 | 23 | 232 | 856 | ✅ | |
| 5 | + worker partial-batch wait | 2,500 | 2,473 | 43 | 1,191 | 2,970 | ✅ | experiment rejected and reverted (D-043) |
| 6 | same config as run 4 (1.1M rows) | 2,500 | 2,476 | 54 | 1,726 | 2,337 | ✅ | host paging measured right after this run (below) |
| **7** | **official: fresh volume** | **2,000** | **1,981** | **21** | **241** | **1,570** | ✅ | |
| 8 | chaos: `kill -9` worker at 20 s, API at 35 s | 2,000 | – | – | – | – | ✅ | 890 × 202 + 311 connection errors while the API was down; **88,164 / 88,164** accepted ids stored and processed |

## Bottleneck analysis (evidence, not guesses)

1. **Steady-state cost per batch is small.**
   - `EXPLAIN (ANALYZE, BUFFERS)` of the ingest statement (100 rows, `jsonb_to_recordset` → `events` + `event_queue`): **8.6–16 ms**, all buffer hits.
   - WAL `fdatasync`: 3.8 ms.
   - Inside the container, a 100-event batch takes **p50 35 ms** end to end with the Node JSON work included, versus 63–77 ms from the Windows host (port-forward overhead → D-042).
   - The API's event loop never lagged more than 45 ms.
2. **Where ingest time goes under load.** Sampling `pg_stat_activity` every 100 ms for 60 s during run 4:

   | Ingest statement state | Samples |
   |---|---|
   | CPU (running) | 260 |
   | `LWLock:WALWrite` (waiting for another backend's WAL flush) | 254 |
   | `IO:WALSync` (own fsync) | 105 |
   | `Lock:transactionid` (concurrent insert of the same event id; dedupe working) | 10 |
   | `IO:DataFileExtend` + `IO:WALInitWrite` (growing files, new WAL segments) | 12 |

   About 55% of ingest time is the durable commit. That is inherent to "202 = committed" and is not fixable without breaking durability.
3. **The tail is the host, not Postgres.**
   - In run 6 the slow-statement log shows **unrelated statements on different backends all stalling ~1 s at the same instant**. That includes a `bind` (parse/plan only) and an advisory-lock `SELECT`, which no amount of database contention can stall.
   - Measured on the Windows host a few minutes after run 6, under the same running stack: **0.3 GB free of 7.9 GB**, was paging at **4,600–17,000 pages/s**, and the WSL2 VM process was resident at only 397 MB.
   - Windows was paging the Docker VM's memory, so every process inside it froze periodically.
   - That also explains why runs got slower as the table grew (a bigger working set to page) and why server-side and client-side numbers diverge (the load-generator container is frozen too).

## What was tried

| Change | Effect | Kept? |
|---|---|---|
| Checkpoint tuning (`max_wal_size=4GB`, `checkpoint_timeout=15min`) | removed checkpoint-driven 1 s commit stalls and all 503s (run 1 → run 2) | ✅ D-041 |
| Load generator inside the compose network | removed 30–40 ms port-forward overhead from every request | ✅ D-042 |
| Worker waits for fuller batches (fewer commits) | no improvement (run 5) | ❌ reverted, D-043 |
| `synchronous_commit=off`, `fsync=off`, unlogged tables, in-memory buffer | would hit any latency target | ❌ never: breaks "202 = durable" (D-044) |

**What would close the p99 gap:** the same containers on a Linux host or a machine that isn't memory-starved (no nested VM paging), or WAL on its own disk. I expect p99 to fall into the tens of milliseconds, because the no-stall per-batch cost is ~15 ms of database time plus ~20 ms of Node time. Not verified on other hardware, so it's stated here as a prediction, not a result.