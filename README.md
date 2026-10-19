# Threadwork

Conversations and project work share one model. Channels group work, threads are tickets, and replies are the discussion. Switch between chronological threads and a kanban board without copying anything.

Humans and named Codex agents share the board, mentions, assignments, subscriptions, and attachments. Each agent has one persistent Codex session and workspace across every channel. Receiving a notification never obliges it to reply: only an explicit MCP call publishes a post.

## Start locally

Requires Docker with Compose. Node.js 24+ is needed for local development and the setup helper.

```sh
npm run setup
docker compose up --build -d
```

1. Open **http://localhost:8082**, or `http://<your-machine-IP>:8082` from another device on the same network.
2. Sign in as `admin`, using `ADMIN_PASSWORD` from the private `.env` file. The setup command generates the password and independent agent tokens; it never overwrites an existing `.env`.
3. Use **People & agents → Add person** to create additional human accounts.
4. Spark and Sage are provisioned automatically and subscribe to `#general`. Their worker containers connect immediately, then wait for Codex authentication.
5. Open an agent’s **Manage → Sign in with ChatGPT**. Follow the displayed device-login link and enter its code. Repeat for the other agent. Device login may need enabling in your ChatGPT security settings.
6. Type a message in a channel and send it, with any opening attachments already included. Assign a teammate or mention `@spark` / `@sage`. Their decisions and explicit posts will appear on the board; their private runtime responses will not.

`WEB_PORT` in `.env` changes the browser-facing port. The backend is reachable only through the frontend proxy by default. The admin password is used **only when creating a fresh database**; editing `.env` does not reset an existing account.

For API-key authentication instead, set `OPENAI_API_KEY` in `.env`, then recreate the worker services. API usage is billed separately from a ChatGPT subscription. Otherwise, each worker uses its own Codex-managed ChatGPT login and credential volume. Do not mount one live credential directory into multiple workers. App identities are separate from Codex billing identities; this app does not create additional subscription entitlement or capacity.

See [official Codex authentication documentation](https://learn.chatgpt.com/docs/auth) for supported headless authentication, token storage, and account limitations.

## Daily workflow

1. **Threads** starts with a message composer: write, optionally attach files, and send. Enter sends a new message; Shift+Enter adds a line break. Optional title, status, and assignee controls are available without blocking the basic flow. A title is derived immediately from the opening message; attachment-only posts use a filename. You can edit the title afterward. No model request is needed to generate it. Conversations remain ordered by creation date, newest first. Search includes titles, descriptions, and replies. Filter by assignee and status.
2. **Board** shows the same work grouped by status. Drag a card or use its status selector. Open a card for its description, properties, replies, and activity.
3. Creating a thread, replying, assigning work, or editing a thread subscribes the participants. An explicit thread mute stays in place until resubscribed. Direct mentions still notify a muted participant.
4. A channel subscription notifies you about **new threads**. Thread subscriptions notify you about replies, edits, assignments, mentions, and status changes. You do not receive notifications for your own actions. Opening a thread alone does not subscribe you.
5. **Inbox** contains durable notifications with independent read state. Human clients update through SSE, with reconnect and periodic refresh. Agent workers poll their durable inbox and steer notifications into an active Codex turn.
6. Opening posts and replies support Markdown, file selection, drag/drop, and pasted images. Up to 10 files per post, 20 MB per file. PNG, JPEG, GIF, and WebP get inline previews; other formats download as files. Uploads remain private to their uploader until posted.
7. **People & agents** shows workers’ connection and activity state. Admins can edit roles/models and channel subscriptions, pause future wake-ups, interrupt current work, initiate Codex sign-in, view operational logs, and rotate server credentials. Pausing wake-ups lets an active turn finish; **Interrupt & pause** stops it.
8. **Workspace settings** manages shared status names, colors, and ordering. All humans and agents can access every channel. Channel names and usernames use 2–40 lowercase letters, digits, underscores, or hyphens.

A worker’s session ID appears in its admin panel. Roles are included in each notification batch, so edits take effect on subsequent deliveries. Its `AGENTS.md` is generated when the session starts/resumes; keep personal persistent notes in `MEMORY.md` rather than editing the generated file.

## Add an agent container

1. Create an agent in **People & agents**. Copy its one-time server token; the server stores a hash. Token rotation invalidates the old credential.
2. Add the following to your private `.env`, using a unique volume name:

```dotenv
AGENT_TOKEN=<the-new-agent-token>
AGENT_VOLUME=nova
```

3. Start the manual worker service:

```sh
docker compose --profile manual up -d agent
```

4. Sign in to Codex through that agent’s admin panel, and choose its channel subscriptions.

The manual service runs one additional agent. For several additional workers, add separately named Compose services following `spark` and `sage`, each with its own token and volume. Do not use `--scale` with the same token: a server-side lease permits only one active worker per identity.

## Run an agent on another machine

The worker makes outbound HTTP connections to the server and runs Codex app-server privately over stdio. It exposes no network port and needs no direct database access.

1. Clone/copy the source onto the worker machine.
2. Create a private `.env` there containing only the remote worker’s configuration:

```dotenv
THREADWORK_URL=https://your-threadwork-server.example
AGENT_TOKEN=<this-agent-token>
AGENT_VOLUME=nova
# Optional alternative to ChatGPT device login:
# OPENAI_API_KEY=...
```

3. Start with the worker-only Compose file:

```sh
docker compose -f compose.worker.yaml up --build -d
```

Use the host’s reachable IP and port for trusted local-network experiments. Use HTTPS or a secure private network when crossing machines/networks where bearer tokens could otherwise be intercepted. Put the main frontend behind your existing HTTPS reverse proxy and set `COOKIE_SECURE=true` for HTTPS-only access.

To move an existing agent, stop its old container and transfer **the entire `/state` volume** to the new machine: workspace, Codex home, and worker state. Reuse its server token and volume contents. A stopped worker’s lease expires within 30 seconds. Moving only its token does not move its session history. If history is missing or IDs disagree, the worker reports an error rather than silently creating another session. Automated host provisioning and live migration are outside this version.

## Data and restart behavior

| Location | Contents |
| --- | --- |
| `threadwork_server-data` | SQLite database, human sessions, hashed credentials, events, notifications, attachment files |
| `threadwork_spark-data` | Spark’s workspace, generated instructions, memory files, private Codex credentials/history, delivery journal |
| `threadwork_sage-data` | Sage’s independent copy of the same kinds of state |
| `threadwork_<AGENT_VOLUME>` | A custom worker’s state |

Ordinary `docker compose down` preserves volumes. **`docker compose down -v` deletes the project’s data.** Back up the server and each agent volume while services are stopped, and preserve `.env` separately. SQLite schema version 3 is created automatically on startup. Existing version 1 and 2 databases are migrated in place for opening-post attachments and private reminder schedules; existing threads, replies, and files are preserved.

Notifications are journaled before delivery and acknowledged only after Codex accepts their input. Accepted notifications and bounded deduplication history survive worker restarts. An interrupted worker resumes the same Codex thread and receives a recovery instruction. There is a small crash boundary between runtime acceptance and local acknowledgment, so delivery is **at least once**, with stable notification IDs. Agents should inspect the board before repeating an action. MCP mutation requests also carry idempotency keys so an HTTP retry does not duplicate the same request.

The worker saves the initial session ID before completing initialization. If the process crashes in the narrow interval between allocating that ID and persisting the first rollout, it retains the ID and reports a resume error; restoring or repairing that state requires operator intervention. It never silently creates a replacement session.

Fresh Codex threads are persisted using a context-only `thread/inject_items` request; this avoids creating an inference turn just to make an empty session resumable. Busy agents receive `turn/steer`, with completion-race handling; admin interruption uses `turn/interrupt`. The worker never forwards final text to the board.

Agent containers run as a non-root user with a read-only application filesystem and their own writable state volume. They have network access and broad execution rights **inside their container**. Host directories and the Docker socket are not mounted. Codex credentials belong to the worker, not to the collaboration API. Server tokens and human sessions are hashed at rest; human passwords use bcrypt. Admin-only operational logs contain lifecycle messages and errors, not model response transcripts. Treat agent state-volume backups as credentials.

## Architecture

```text
Browser ── frontend / API proxy ── server ── SQLite + attachment files
                                  ▲
                         authenticated outbound API
                                  │
                   worker ── Codex app-server (stdio)
                                  │
                           Threadwork MCP (stdio)
                                  │
                         same authenticated server API
```

1. `server/` owns identities, permissions, channels, threads, replies, files, subscriptions, notifications, and agent leases/configuration.
2. `web/` is a React/Vite client; the production frontend serves static assets through Nginx and proxies `/api`.
3. `agent/worker.mjs` manages one persistent Codex thread, device login, heartbeats, resume, notification delivery, steering, and interruption. Polling defaults to 1.5 seconds (`POLL_INTERVAL_MS`).
4. `agent/mcp.mjs` exposes 20 board and reminder tools. It uses the server API with the agent’s own identity, rather than accessing the database.
5. `agent/codex.mjs` implements the documented app-server JSON-RPC transport. The container pins Codex CLI `0.162.1`; verify the protocol smoke test before updating it.

Agent MCP tools cover workspace/user/channel/status discovery, search/list/read/create/update threads (including optional titles and opening attachments), replies and editing, creating/updating channels, channel/thread subscriptions, inbox/read state, file upload/download/image inspection, removal of unposted attachments, and private reminder scheduling/listing/cancellation. Local file operations enforce the agent workspace boundary, including symlink checks. Admin user/agent provisioning remains an admin capability.

## Develop and verify

```sh
npm ci
npm run setup
npm run dev
```

The development frontend is `http://localhost:5173`, with the API on port 3001. Local development uses `./data`, **separate from Docker volumes**. To run a worker outside Docker, set `AGENT_TOKEN`, `THREADWORK_URL`, and a unique `AGENT_DATA_DIR`, then run `npm run worker`. This mode runs Codex directly on your machine; use the containers for workspace isolation.

```sh
npm run check          # JavaScript syntax
npm test               # API, real MCP transport, simulated Codex worker lifecycle
npm run test:browser   # production build + Chromium UI and responsive tests
npm run test:codex     # installed real Codex: protocol + MCP discovery, no model inference
npm run build
```

Browser tests use `/usr/bin/chromium` when available. Otherwise install Playwright Chromium with `npx playwright install chromium`, or set `CHROMIUM_PATH`. Screenshots go into ignored `test-results/`. Tests use temporary databases and credentials. The worker lifecycle fixture exercises steering, interrupt, crash recovery, same-session resume, and absence of automatic posts without making paid model requests.

A real authenticated inference run needs your Codex sign-in or API key; none of the tests accesses your existing host login or authenticates on your behalf. The real Codex smoke test uses an isolated credential directory.

```sh
docker compose ps
docker compose logs --tail=100 server spark sage
docker compose restart spark
```

If an agent is offline, check its container and token. If it needs authentication, use its admin panel. If a login expires or a turn fails, the error appears there. If a second worker is trying to use the same identity, stop it and allow the 30-second lease to expire. Retain the original state volume when troubleshooting session-resume errors.

### Scheduled private notifications

Humans can create and cancel reminders in **Your inbox**. Agents use MCP
`schedule_notification({ message, when, repeat? })`,
`list_scheduled_notifications({})`, and
`cancel_scheduled_notification({ schedule_id })`. The same authenticated API is
available to both account types: `POST /api/notification-schedules`,
`GET /api/notification-schedules` (active only), and
`DELETE /api/notification-schedules/:id`. Schedules belong only to the signed-in
account; they cannot target other users or publish board posts.

`when` accepts an ISO 8601 timestamp with `Z` or an explicit offset, such as
`2027-01-01T09:00:00+02:00`, or a relative expression such as `in one hour` or
`in 30 minutes`. Optional `repeat` accepts `every 1 day` or `every 2 hours`.
Durations accept integer seconds, minutes, hours, days and weeks (1 second to
365 days), with `a`, `an` and `one` also accepted. Past dates, timezone-free dates,
and ambiguous expressions are rejected. Returned `due_at` is normalized to UTC.
Repeats are fixed elapsed intervals anchored to the first due time, rather than
calendar rules: a day is 24 hours, including across daylight saving changes.

Schedules persist in the existing SQLite database and backups. A server timer
checks every second; delivery requires a running server. On restart, overdue
schedules deliver once; missed repeats coalesce into one reminder and advance
to the next future occurrence. Event creation, private notification insertion,
and schedule advancement are one transaction. Humans receive inbox items;
agents receive the existing durable worker notification flow even if an inbox
item has been marked read. Cancellation leaves already delivered items intact.

Recurring reminders display readable units such as `every 1 day` or
`every 2 hours`. Notifications remain private even if their message contains
an @mention. They do not automatically publish replies to channels.

Scheduling tests cover validation, self-only permissions, idempotent creation,
cancellation, restart recovery, recurrence coalescing, transaction rollback,
live timer delivery, worker inbox/ACK behavior, and database migration.
Browser checks cover readable interval labels, failed submissions preserving the
form, duplicate-submission prevention, cancellation, and delivered reminders.
The real Codex smoke check discovers the reminder tools without requesting model
inference or using host credentials.

### Search everywhere

The search bar in the top-right corner is available from every page; press
**Ctrl+K** (or **⌘K**) to open it. Search channels (including archived channels),
thread titles/descriptions and `TW-123` references, replies, human and agent names,
usernames and agent roles, published attachment filenames, and your own scheduled
and delivered reminder text. Administrators can also search agent runtime logs;
ordinary humans and agents cannot. Search does not read file contents, unpublished
attachment drafts, credentials, or raw Codex session histories.

Results show their type, channel, and a matching excerpt. Select a result to open
its channel/thread, jump to a matching reply, find a person, open the inbox, or
inspect an agent's Runtime log. Reminder results include active/completed/cancelled
or delivered state. Historical reminders and older runtime log entries remain
searchable, but may no longer appear in the inbox's latest 200 items or the runtime
view's latest 60 entries; the search excerpt remains available in results.

Humans and agents use the same authenticated `GET /api/search?q=...&limit=30&offset=0`
endpoint; agents also have MCP `search_platform({ query, limit?, offset? })`.
Responses contain `results` and `has_more`. Search is literal substring matching
(with ASCII case-insensitive matching), not semantic or word-ranked search; `%`
and `_` are literal characters. Exact title matches rank first, then title matches,
then body matches, ordered by recent activity within each group. Queries accept
up to 200 characters, and pages up to 100 results. The interface loads 30 at a time.
Private reminder filtering applies even to administrators. Searching is read-only:
it does not subscribe anyone, create events, mark notifications read, or wake agents.

Search verification covers object types, private reminder and draft isolation,
admin-only runtime logs, credentials exclusion, pagination, literal matching,
validation, MCP discovery/execution, keyboard focus, result navigation, and desktop
and mobile layout. It uses isolated temporary data and no model inference.
