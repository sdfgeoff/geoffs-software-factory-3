# Bounded conversation pages

The workspace now requests and renders at most 50 conversations at a time in
All work, Board and channel history. Older/newer/latest controls traverse stable
`created_at,id` cursors. Matching totals and per-status counts cover the whole
query, including unloaded pages. The legacy array API is unchanged. Channel
Markdown previews stop at 2,000 characters; opening a conversation retains access
to its complete content and replies. Reading positions are retained per query and
page; drafts are shared across pages. Jump to latest returns to the newest page.
A list invalidation reconciles that page and its totals together, preserving the
scoped refresh behavior from #17 without accumulating off-page summaries.

## Reproduction and budgets

Run `npm ci --include=dev`, `npm run build`, then
`THREAD_PAGE_STRESS=1 node --test tests/thread-pages-browser.mjs`.
The standard browser suite includes the same navigation regression with 10,000
threads and 3 replies per thread. Stress mode creates 300 replies per thread
(3 million replies), with matching 3 million events and inbox records, in an
isolated temporary SQLite database. No board data or credentials are used.

The local regression budget proposed in #16 is: first ready under 2 seconds,
maximum observed long task under 250 ms, fewer than 5,000 DOM elements, and less
than 100 MiB used JavaScript heap. These are explicit review targets and executable
assertions, not a production SLA. Exact-revision approval includes accepting these
budgets or requesting adjustment.

The raw single-run results are in `thread-pages.json`. The measured implementation is
`0766b94`; the subsequent integration of bootstrap response-ordering fix
`20301fd` changes no paging/query/render path, so the scale run was not repeated
for that integration. Chromium runs headless at
1440×1000 against the production build on a shared worker host. Timing starts
before navigation or the direct action; first-visible awaits a rendered row/card,
and ready also awaits the accurate page count. Two animation frames precede the
DOM/heap sample. Long tasks are observed in the page and reset before each measured
action. Heap is Chromium's `JSHeapUsedSize`, not whole-browser RSS or a leak test.
The Board action reuses the already loaded window and needs no list request.

| View | First visible | Ready | Longest task | DOM elements | JS heap |
| --- | ---: | ---: | ---: | ---: | ---: |
| All work | 437 ms | 445 ms | none ≥50 ms | 1,340 | 4.74 MiB |
| Channel | 124 ms | 127 ms | 61 ms | 1,137 | 7.50 MiB |
| Board | 88 ms | 90 ms | none ≥50 ms | 1,350 | 10.01 MiB |

All work and channel each issued one 50-item list request. Original #12 measurements
on pre-layout baseline `998645a` were 8.12/8.03 seconds and roughly 230k/160k DOM
nodes; those are historical context, not an isolated before/after comparison of
this branch. This fixture reproduces the cardinalities with simpler synthetic
content; results are single warm local samples, not percentile estimates or
attachment-heavy/real-device tests.

Navigation checks cover adjacent older/newer pages, keyboard paging, draft
retention, returning from a conversation to the older page, latest navigation,
Board counts, opening the oldest conversation directly, expanding a long preview, and revealing a saved message after posting from filtered older history. API checks traverse
tied-timestamp pages, preserve status/channel/assignee/search filters and totals,
and ensure concurrent inserts do not duplicate older-page entries. Existing
mobile/desktop reading-position and live-reply tests remain part of the suite.
