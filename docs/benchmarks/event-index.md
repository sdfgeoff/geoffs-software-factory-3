# Per-thread event index: 3 million events

Measured on 2026-10-20 with Node 24.22.0, application code based on `27fad999`,
and the schema-v7 `events(thread_id,id)` index. Raw samples, query plans and
response hashes are in [event-index.json](event-index.json).

The isolated fixture follows stress test #12: 10,000 threads, 300 mixed-length
replies and matching events per thread, 51 authors, one hot channel and 3 million
notifications. Events are grouped by thread: an old quiet conversation is far
from the global event tail. This distribution strongly affects the unindexed
baseline. These are warm local sequential measurements on shared hardware, not
a production SLA, cold-cache result or concurrent-client capacity test. No other
local test jobs ran during the benchmark; phase order was before then after.

## Full HTTP results

Each target has one unrecorded warm-up and five measured requests. Times include
HTTP, response transfer and client JSON parsing. The before phase uses the same
application and copied dataset with only `event_thread` dropped; both inbox
indexes remain present. The after phase reopens through the real v6→v7 upgrade.

| GET /api/threads/:id | Before median / max | After median / max |
| --- | ---: | ---: |
| Old, ID 1 | 769.48 / 902.91 ms | 8.09 / 13.54 ms |
| Middle, ID 5000 | 330.62 / 343.79 ms | 7.87 / 11.90 ms |
| Newest, ID 10000 | 7.13 / 9.52 ms | 7.94 / 16.80 ms |

Every response has 300 replies and the latest 100 activity records. The harness
checks ascending reply IDs, descending activity IDs, activity payloads and thread
ownership. Entire response SHA-256 hashes match before/after for each target.
Payload sizes are 317,353, 328,669 and 329,471 bytes respectively. All requests
returned 200. The newest conversation was already cheap; it shows no measured
improvement in this run.

Before, the activity plan scans the global events table. After, it searches
`event_thread (thread_id=?)` and joins actors by primary key, without a temporary
sort. The activity query and its latest-100 limit are unchanged.

## Storage, upgrade and write costs

The warm upgrade took 6,907.97 ms. The new index occupied 45,121,536 allocated
bytes (43.03 MiB), measured immediately before/after migration using page counts
excluding the freelist. Physical file growth differs because free pages are
reused. Startup builds the index transactionally with `IF NOT EXISTS` and
advances the schema to version 7.

Three committed SQL batches of 1,000 short-payload events per case:

| Insert distribution | Before median / max | After median / max |
| --- | ---: | ---: |
| All events in thread 1 | 5.61 / 6.50 ms | 7.31 / 7.55 ms |
| Events spread across threads 1–1000 | 6.84 / 15.28 ms | 150.25 / 154.06 ms |

**Spread inserts have a substantial measured cost increase:** approximately
143 ms per 1,000-event transaction in this profile. This tradeoff must accompany
assessment of the read improvement. These batches use the application's default
SQLite settings and short synthetic payloads; they measure event/index writes
and commit, excluding cleanup. They do not measure posting API latency,
notification fan-out, sustained throughput or per-request tail latency. Three
samples do not establish a general write budget. No cache or durability tuning
was introduced to offset the index cost.

## Correctness and reproduction

The regression test upgrades a v6 fixture with interleaved events from three
threads and workspace-level events, reopens it twice, and verifies preserved
events/notification states, indexed plans, the latest 100 activity records and
ascending reply order through the API. All 59 unit/integration tests and all 11
browser scenarios passed, as did formatting, syntax checks and the production
build. No production data or deployment was changed.

Use new output directories. The seeder creates synthetic data; the benchmark
copies a stopped/checkpointed fixture and leaves the input untouched:

```sh
node scripts/seed-inbox-benchmark.mjs /path/to/new-fixture 10000
node scripts/benchmark-events.mjs /path/to/new-fixture /path/to/new-results
```

Allow space for the approximately 4.54 GB fixture, another copy and SQLite's
upgrade work. This run reused the closed fixture from the inbox-index benchmark,
originally generated with the reviewed stress-test #12 seed loop. The committed
harness also passed a one-thread/300-reply smoke run. Database copies and their
synthetic sessions are excluded from the committed evidence.
