# Indexed literal search

Global search and `/api/threads?q=...` keep their existing literal substring
matching, ranking, ordering, pagination and public/private boundaries. Queries
are not interpreted as word, wildcard, fuzzy or FTS syntax. SQLite's existing
ASCII-only case folding is retained, including its non-ASCII case sensitivity.
`TW-<id>` still finds associated conversation content as well as literal mentions;
it does not change the query into an exclusive ID-only mode. The thread-list text
filter retains its original literal behavior, rather than acquiring ID syntax.

## Access paths and isolation

Schema v9 adds an FTS5 trigram index of SQLite-lowered reply bodies using an
external-content view, plus indexes for recent replies and scheduled-event lookup.
[SQLite's trigram tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
provides substring candidates. Quoted parameters and case-sensitive literal trigrams preserve candidates.
Global results retain the original `instr` predicate; indexed thread-filter
candidates also pass the original escaped `LIKE` predicate. These differ for
stored NUL characters: `LIKE` stops at NUL, while `instr` can find text after it.
The index must not erase that distinction, including in totals and pagination. Triggers maintain the index in the same transaction as
insert/edit/delete; thread title edits need no denormalized reply rewrite.

Global search probes recent replies and then uses indexed candidates if that
probe cannot supply the requested window. Body matches and each inherited-title
ranking bucket contribute at most `limit + offset + 1` candidates. The recent
probe examines `max(512, limit + offset + 1)` rows. This avoids enumerating millions
of matches for common body terms or common conversation titles while preserving
exact ordering and `has_more`. Rare thread-filter matches use indexed reply IDs;
frequent terms instead stop at the first matching reply per thread, preserving
honest totals without enumerating all matching reply postings.

One- and two-character queries, and queries containing NUL, retain a scan fallback.
They can be slower, as can deep offsets and unfavorable term distributions. The
latency targets below cover the measured ordinary queries, not every possible
literal. Successful responses are exact; the server does not silently truncate a
search to an arbitrary sample.

Search reads run on two lazy read-only worker connections using one WAL snapshot
per request. At most eight requests wait; total queue/execution time has a
five-second deadline. Overload or timeout returns HTTP 503 with retry/refinement
guidance. The client does not automatically retry. Abandoned HTTP searches are
removed or their reader is retired; retiring readers count toward the size limit
until they exit. Normal HTTP mutations, navigation and bootstrap remain outside
this pool. Browser global search, additional result pages and text filters abort
obsolete requests.

## Upgrade and operational cost

Take the backup described in README before upgrading. The v8→v9 upgrade builds the
index transactionally on existing content before the server starts listening.
It requires SQLite FTS5 with trigram support (present in the tested Node 24 build).
Index data is inside the same SQLite database and its normal backup; no external
search service or separate eventually consistent store is introduced.

The measured 10k-thread/3m-reply upgrade time and checkpointed database sizes are
recorded below and in the raw JSON. Reserve additional WAL and temporary-file
headroom beyond the checkpointed index growth. Startup migration is a maintenance
operation, not a background upgrade while requests are served. Steady-state reply
writes gain synchronous trigger work. The tests cover create/edit visibility,
rollback/delete consistency and reopening the migrated database.

## Reproduction and measurements

Run `npm ci --include=dev`, then
`node scripts/benchmark-search.mjs test-results/search-scale.json`.
`SEARCH_FIXTURE_THREADS` and `SEARCH_FIXTURE_REPLIES` can reduce the fixture for a
quick check. Defaults create an isolated v8 database with 10,000 threads ×300
mixed-length replies, three million matching events and inbox records, then time
the actual v9 upgrade. No board data or real credentials are used. Synthetic
databases are removed afterward; only the explicitly selected JSON output remains.

The local review targets are median <500 ms, maximum <1,500 ms for each measured
search/filter, and simultaneous bootstrap <500 ms. These are executable local
regression budgets, not a production SLA or percentile estimate. Each warm query
has three standalone samples and three separate overlapping-bootstrap samples,
with bootstrap dispatched five milliseconds after the search. First-call latency
is retained separately. A four-caller mixed scenario also runs with bootstrap.
The benchmark client and server share a Node process, so synchronous bootstrap
work can delay the client's collection of search responses in overlapping samples;
standalone search times and overlapping times are deliberately reported separately.
The data volume reproduces #12's cardinalities with simpler synthetic text. The
original pre-optimization measurements are historical context, not a controlled
before/after run of this implementation.

Measured on Node 24.22.0 / SQLite 3.53.4, one warm shared-host run after the stored-NUL correction.

| Query | Endpoint | Median | Maximum | Maximum simultaneous bootstrap |
| --- | --- | ---: | ---: | ---: |
| unique | global | 9.5 ms | 9.8 ms | 126.5 ms |
| unique | threads | 7.1 ms | 7.6 ms | 121.6 ms |
| common | global | 7.5 ms | 8.2 ms | 119.4 ms |
| common | threads | 172.1 ms | 180.4 ms | 126.0 ms |
| common-title | global | 23.5 ms | 24.1 ms | 124.0 ms |
| common-title | threads | 118.9 ms | 132.6 ms | 130.0 ms |
| absent | global | 7.0 ms | 7.5 ms | 117.0 ms |
| absent | threads | 4.1 ms | 5.4 ms | 132.9 ms |
| ID | global | 8.7 ms | 10.5 ms | 127.4 ms |
| ID | threads | 4.7 ms | 4.8 ms | 125.6 ms |

Migration: 83.0 seconds; checkpointed database 0.96 GB before / 2.41 GB after.
Four concurrent search/filter callers plus bootstrap completed in 296.7 ms; bootstrap took 124.1 ms.

Global first-call latency (including lazy reader startup) was retained separately in [the raw report](indexed-search.json). The ID row for the thread filter is a literal absent query, not an ID lookup; exact-ID lookup belongs to global search. All proposed local budgets passed. Tests also verify index visibility after HTTP create/edit, rollback/delete consistency, migration idempotence, title/body ranking overlap, literal punctuation/Unicode/stored-NUL parity, private reminders/admin boundaries, and queue/cancellation/deadline behavior.
