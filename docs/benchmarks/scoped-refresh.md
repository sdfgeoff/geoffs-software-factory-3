# Scoped browser refresh benchmark

This measures #17 on the merged conversation-workspace layout, comparing
`5a03bd0` (schema 8, including inbox/event indexes and agent activity) with the
scoped-refresh candidate. It is separate from #16's initial loading/DOM work.
Final integration also includes `1a26168`'s worker-fleet changes, which do not
change the measured application paths; regression checks run on that integration.

## Reproducer and measurement

Build both checkouts, then run sequentially, with no overlapping test/build jobs:

```sh
node scripts/benchmark-refresh.mjs /path/to/baseline /path/to/stopped-fixture /new/before
node scripts/benchmark-refresh.mjs /path/to/candidate /path/to/stopped-fixture /new/after
```

Each run copies the same checkpointed synthetic #12 fixture: 10,000 threads,
300 replies each (3 million replies/events), mixed message sizes, one hot channel,
51 authors, and a heavy recipient. Input data is untouched. The local server
upgrades its isolated copy. The browser uses Chromium headless at 1440×1000 with
a synthetic session. No production server, credentials or live workspace data is
used. Only JSON reports are committed; database/session files are excluded.

Actions target DOM controls to avoid whole-page accessibility-tree traversal cost.
Channel readiness waits for the final pagination response and rendered entry count.
Each action records first visible completion and then allows API responses to settle
(one second without a new API response, up to 45 seconds). Request counts/bytes
cover the whole action window, including that settlement; naturally overlapping
20-second fallback polls are included. Bytes are decoded response bodies, not
compressed wire bytes. SSE's open stream and fixture writes via APIRequestContext
are excluded from page request totals. Writes submitted through the browser are
included. The idle observation lasts 32 seconds.

These are single sequential local runs on shared hardware, not medians, tail
latencies, sustained throughput or a production SLA. A preliminary harness run
was discarded after discovering that channel readiness could be reported before
pagination completed; the committed reports use the corrected wait and settlement.

## Behavior and limits

Unchanged checks use the authenticated revision endpoint. Changed summaries retain
server filtering, sorting and ownership boundaries. A selected conversation updates
independently; its hidden origin list catches up on return. Repeated Markdown bodies
skip parsing, and the mounted hidden origin avoids unnecessary render work.

A restart, invalid/expired cursor, broad metadata change, more than 200 changed IDs
or more than 256 invalidation entries of missed history falls back to authoritative recovery.
That recovery still loads all pages when the list becomes visible. Initial loading
and DOM size remain unbounded and are #16's scope. The journal is per server process;
multiple independent web processes would require shared invalidation/version state.
SQLite is still synchronous, and large search/metadata payloads remain separate
scalability limits. Durable worker notifications, privacy and acceptance state are
unchanged. Transient failed summary/detail/bootstrap loads retry on the next check;
a loaded conversation and draft remain visible while a transient detail refresh fails.

## Observed results

Raw reports: [baseline](scoped-refresh-before.json),
[candidate](scoped-refresh-after.json). Each value is one observation.

| Action | Visible time before → after | Requests before → after | Decoded bytes before → after | Full list pages before → after |
| --- | ---: | ---: | ---: | ---: |
| all-work-ready | 4.73 → 4.58 s | 22 → 23 | 5,329,172 → 5,329,326 | 21 → 21 |
| idle-32-seconds | 32.00 → 32.00 s | 22 → 1 | 5,329,172 → 97 | 21 → 0 |
| channel-ready | 11.46 → 8.96 s | 23 → 22 | 5,595,375 → 5,321,907 | 22 → 21 |
| channel-send | 16.01 → 3.75 s | 28 → 4 | 6,143,019 → 8,204 | 24 → 0 |
| open-conversation | 4.96 → 0.69 s | 2 → 2 | 317,397 → 317,397 | 0 → 0 |
| reply-send | 7.74 → 0.33 s | 34 → 5 | 7,095,095 → 325,046 | 24 → 0 |
| incoming-selected-reply | 5.72 → 0.23 s | 24 → 4 | 5,647,009 → 324,911 | 21 → 0 |
| return-to-channel | 7.17 → 3.77 s | 4 → 2 | 590,877 → 618 | 1 → 0 |
| incoming-channel-thread | 9.30 → 2.81 s | 27 → 3 | 6,661,053 → 7,955 | 26 → 0 |

The idle duration is the fixed observation window, not response latency. Baseline
page totals exceed 21 in some action windows because local acknowledgement, SSE
and periodic refreshes overlap; partial pages and metadata reads count too. The
candidate performs no full list requests during the observed idle/send/incoming/
return windows. Both runs report no page errors.

Initial loading still fetches 21 pages (~5.3 MB). Channel send/return/incoming
rendering remains 2.81–3.77 seconds because the entire channel DOM is still retained
and updated. This is substantial remaining UI work, even with network refreshes
scoped; it should be evaluated with #16 rather than presented as solved here.

Verification also includes automated pagination/fallback, coalescing, hidden-origin,
response-race, failed-detail retry/draft retention and stream reconnect scenarios.
No production deployment or mobile device performance test was performed. These
measurements do not establish a latency budget; that remains a review decision.

## Validation record

On integration with `1a26168`, syntax checking and the serial unit/integration run
passed (84 passed; one upstream Docker Compose test skipped because Compose is
unavailable). The initial parallel run on the preceding base had two timing-sensitive
failures: the reminder test observed an extra elapsed delivery and the worker test
missed its short active-state window. Both pass in the serial full run. No tests
were weakened or production timers changed to address those failures. The initial
expanded browser scenario had an incorrect toast selector; it was corrected before
the final browser run. Build output reports a large-chunk advisory (main JavaScript about 502 kB, versus
499 kB in the baseline); code splitting is not part of this change.

The final integrated browser run passes all 13 scenarios, including existing
1440px/390px reading positions, navigation, drafts, inbox/reminder/privacy and
search behavior, plus the new 510-thread refresh regression. Final checks:
`npm run check`, changed-code Prettier, `git diff --check`,
`TMPDIR=/state/workspace/test-tmp node --test --test-concurrency=1 tests/*.test.mjs`,
and `TMPDIR=/state/workspace/test-tmp npm run test:browser`.

Bootstrap ordering is additionally covered by a delayed older snapshot and stale
401 arriving after a newer rename, followed by an unchanged 20-second fallback.
Only the latest request in the same session may publish bootstrap state or errors;
a failed latest request still recovers on the next unchanged check. The updated
full browser suite passes all 14 cases; syntax, formatting and build also pass.
The backend is unchanged in this follow-up: the preceding serial 84-pass/one-skip
unit evidence and normal-traffic scale measurements were not rerun for this
frontend ordering guard.
