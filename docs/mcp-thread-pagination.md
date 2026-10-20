# Thread pagination in MCP

The existing `list_threads` tool keeps its legacy behavior: without
`paged: true`, it returns an array of up to 500 threads, newest first by
creation time and ID. Existing `channel_id`, `assignee_id`, `query`, and
`offset` calls remain valid. `paged: false` also selects this legacy path.

Opt into bounded pages:

```json
{"paged": true, "limit": 50, "channel_id": 1, "status_id": 2}
```

The result is `{items, total, statusCounts, older, newer}`. The default limit is
50; valid limits are integers from 1 through 100. Totals and per-status counts
cover the complete matching set, including the selected status filter, rather
than just the returned page. Empty results have zero total, empty items and
counts, and null cursors.

To move toward older threads, pass the returned `older` cursor as `before`.
To return toward newer threads, pass `newer` as `after`. Keep channel,
assignee, status and literal text filters unchanged. Cursors are opaque:
copy them without reconstructing timestamps or IDs. Null means there is no
further page in that direction. Omit both cursors to return to the latest page.
Every page is ordered newest first, including responses to `after`.

Both modes preserve JSON text content. Structured content remains
`{outcome: {ok: true, value: ...}}`, with value now advertised as the union of
the legacy array and bounded page object. Failures retain the existing
structured error envelope and `isError`.

## Transport mappings and validation

The adapter uses shared `threadListFields({coerce: false})` contracts. MCP
numbers remain typed numbers. Argument aliases map `channel_id` to HTTP
`channel`, `assignee_id` to `assignee`, `query` to `q`, and `status_id`
to `status`. MCP's boolean `paged: true` maps to HTTP `paged=1`.

MCP requires `paged: true` when using `limit`, `before`, `after`, or
`status_id`. Paged mode rejects `offset`, and the cursors are mutually
exclusive. These explicit adapter checks avoid silently ignored arguments;
legacy HTTP continues to accept its existing query combinations. Existing
legacy offset normalization and text truncation remain server behavior.

No new tools or access rules are introduced. Request sharing depends on #20
(branch 15); branch 16 records that merge dependency.
