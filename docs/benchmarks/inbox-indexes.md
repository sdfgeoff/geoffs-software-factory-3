# Inbox indexes: 3 million notifications

Measured on 2026-10-20 with Node 24.22.0, current application code based on
`82ce3ef`, and the two schema-v6 indexes. The raw samples and query plans are in
[inbox-indexes.json](inbox-indexes.json). This is a warm, local synthetic run on
shared hardware, not a production SLA or a concurrent-client capacity test.

The fixture matches stress test #12: 10,000 threads, 300 mixed-length replies per
thread, 3 million replies/events, 51 authors, and one hot channel. One recipient
has 3 million notifications, 300,000 unread. The benchmark adds 30 notifications
for a second recipient in its isolated copy; both phases check that their inbox
contains only their own 30 records. All measured API responses returned 200.

## Full HTTP results

Each endpoint has one unrecorded warm-up followed by five sequential samples.
Timing includes HTTP, response-body transfer and client JSON parsing. Inbox
responses contain the latest 200 records in descending notification-ID order and
are 198,925 bytes in both phases. Bootstrap responses are 7,362 bytes.

| Operation | Before median / max | After median / max |
| --- | ---: | ---: |
| GET /api/inbox | 7,295.8 / 7,321.5 ms | 2.90 / 3.53 ms |
| GET /api/bootstrap | 244.40 / 244.97 ms | 12.99 / 13.42 ms |

The before phase uses the same application and copied fixture with only the two
new indexes dropped. The after phase closes and reopens the app through the real
v5→v6 upgrade. No other local test jobs ran during these measurements. Phase
order was before then after; cache/host variability is not eliminated.

## Access paths and costs

- Before: inbox uses `notification_inbox(user_id,accepted_at,id)` and a temporary
  B-tree for ordering. After: it uses `notification_latest(user_id,id)` with no
  sort, feeding the latest records directly into primary-key event/author joins.
- Unread counts use `notification_unread(user_id) WHERE read_at IS NULL`. Counting
  still visits the recipient's unread index entries (300,000 here); this is not a
  constant-time maintained counter.
- Worker delivery continues to use `notification_inbox` with recipient and
  `accepted_at IS NULL`, preserving oldest-first delivery independently of reads.
- Reopening through the upgrade took 1,379.3 ms. The additional indexes occupied
  41,828,352 bytes (39.89 MiB, about 0.92% of the pre-upgrade allocated database).
  This uses allocated pages excluding the freelist immediately before/after
  migration. Physical file growth is smaller because free pages were reused.

Three committed SQL batches per case, each on the copied fixture:

| Mutation batch | Before median / max | After median / max |
| --- | ---: | ---: |
| Insert 1,000 event + notification pairs | 8.10 / 8.66 ms | 9.14 / 9.19 ms |
| Mark 1,000 unread notifications read | 11.21 / 12.18 ms | 13.78 / 14.36 ms |
| Restore those 1,000 notifications unread | 10.68 / 16.01 ms | 13.62 / 13.72 ms |

Insert batches use short synthetic event payloads and 10% unread notifications;
these measure index maintenance with transaction commit, not full posting API
latency or fan-out. Cleanup is excluded. Read/unread batches include statement
preparation and commit; three samples are insufficient for tail estimates.

## Reproduce

Use new directories; the scripts refuse to overwrite an existing destination.
The seeder creates only synthetic data. The benchmark copies the stopped,
checkpointed fixture, leaving its input untouched. Its output includes a database
with synthetic users and sessions; the committed report excludes that database.

```sh
node scripts/seed-inbox-benchmark.mjs /path/to/new-fixture 10000
node scripts/benchmark-inbox.mjs /path/to/new-fixture /path/to/new-results
```

The seed took about 158 seconds and used a 4.54 GB database in this run; allow
space for another copy and SQLite's upgrade work. The original measured fixture
was generated with the reviewed stress-test #12 seeder using the same seed loop;
the repository seeder was also smoke-tested at one thread (300 replies).

## Correctness and upgrade verification

The upgrade creates both indexes with `IF NOT EXISTS` inside the existing schema
transaction and advances `user_version` to 6. Existing read/accepted values stay
intact. Tests reopen an upgraded v5 database twice, assert all three access paths,
verify recipient isolation and selected/all reads, restore NULL read state,
and confirm that human-style reads leave worker notifications pending until ACK.
All 58 unit/integration tests and all 11 browser scenarios pass. Formatting,
production build and syntax checks pass. No production data or deployment was
changed by this benchmark.
