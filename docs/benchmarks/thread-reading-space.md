# Conversation reading space

Ticket #27 replaces the separate global/conversation bars and fixed properties
with one compact header and an on-demand Details region. Search, navigation,
following, editing and copying links remain available. The full title and
origin accompany Status/Assignee inside Details.

The reply composer starts as one row, expands when focused or attaching files,
grows with its text up to a bounded height, and can collapse while retaining
text and attachment drafts. Formatting, audience information and the keyboard
send shortcut are available in its expanded help. Existing reading anchors
handle header/composer resizing and incoming replies while reading history.

## Measurements

Single local headless Chromium run, same 24-reply fixture and reply anchor,
unchanged 14px message text, production build. Captured while reading history
with the Jump to latest control visible. Values measure the scrollable reading
region against app height; they do not include the header or composer.

| Viewport   | Before | After | After share |
| ---------- | -----: | ----: | ----------: |
| 1440 × 900 |  380px | 727px |       80.8% |
| 1440 × 600 |  153px | 427px |       71.2% |
| 390 × 700  |  196px | 511px |       73.0% |

The proposed 70% idle reading target passes at all three sizes. Expanded
Details or a draft intentionally uses additional space. Measurements are
local observations, not cross-browser performance guarantees. Raw dimensions
are in [thread-reading-space.json](thread-reading-space.json). Matching
before/after screenshots are attached to the ticket.

## Reproduction and coverage

Run a baseline checkout with:

```sh
READING_BASELINE=1 READING_SPACE_EVIDENCE=/path/to/evidence node --test --test-concurrency=1 tests/reading-space-browser.mjs
```

The test file must be copied to that checkout without changing its application
source. Build that checkout first. Run the changed checkout without
READING_BASELINE after building it to verify the target and interactions.
READING_SPACE_EVIDENCE is optional; it writes measurements and PNGs outside Git.

The regression checks Details/status/assignee, a long draft and expanded
formatting, collapse/reopen, keyboard expansion, attachment retention, incoming
replies while scrolled up, posting, search access and horizontal overflow.
The existing reading/navigation browser scenarios continue to cover targets,
history, origin scroll restoration, resize, images and shared links.
