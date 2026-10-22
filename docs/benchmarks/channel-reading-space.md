# Channel overview reading space

TW-214 follows Geoffrey's request in TW-27 reply601. The channel stream now uses
one compact header containing channel identity, view selection, navigation,
global search and a Controls disclosure. Channel description, subscription,
management and new-thread actions remain in Controls alongside search and
assignee/status filters. A visible filtered indicator with an accessible
description identifies an active filter when the controls are closed.

Channel messages reuse the compact composer from thread replies. Writing,
dropping or attaching files expands it; collapse retains text, attachments and
thread-option fields. The existing Enter-to-send and Shift+Enter semantics
remain unchanged for channel creation. Formatting/audience help and thread
options remain available when expanded. All work and Board keep their existing
page controls. Channel entries retain their original text size and width.

## Local measurements

Same 24-message fixture, same historical message and scroll offset, production
Chromium build. The scrollable history is measured against app height while
the Jump to latest control is visible. Expanded controls or writing
intentionally use more space.

| Viewport   | Before | After | After share |
| ---------- | -----: | ----: | ----------: |
| 1440 × 900 |  329px | 726px |       80.7% |
| 1440 × 600 |  114px | 426px |       71.0% |
| 390 × 700  |   99px | 494px |       70.6% |

All three local observations meet the proposed 70% idle-reading target.
Raw dimensions are in [channel-reading-space.json](channel-reading-space.json).
Matching screenshots are attached to TW-214. These are local layout
measurements, not physical-device keyboard/IME guarantees.

## Reproduction

Build the relevant checkout, then run:

```sh
TMPDIR=/tmp CHANNEL_SPACE_EVIDENCE=/path/to/evidence node --test --test-concurrency=1 tests/channel-reading-space-browser.mjs
```

For the baseline, copy the regression file into the baseline checkout without
changing its application source, build it, and set CHANNEL_SPACE_BASELINE=1.
The baseline mode captures the existing layout and skips new-control checks.
Both evidence flags are optional for normal regression runs.

The three viewport scenarios check reading height, horizontal overflow,
Controls and composer resize anchoring, long drafts, formatting, thread
options, attachments, keyboard expansion, incoming messages while reading
history, entering/returning from a thread, successful creation, active filters,
view switching and global search. Existing channel/paging coverage checks
draft restoration across channels/views, upload/send failures, mentions,
bounded old-history traversal and return-to-latest after filtered creation.
