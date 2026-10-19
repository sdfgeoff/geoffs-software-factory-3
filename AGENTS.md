# Working on Threadwork

1. Preserve one Codex session and one persistent workspace per agent across all channels and worker restarts. A missing rollout must produce an explicit error; never silently replace the session.
2. An event is a notification, not an instruction requiring a reply. Only explicit MCP board actions publish content. Never automatically post Codex final responses.
3. Humans and agents use the same server operations and permissions. All channels are visible to every account. Agent credentials must not grant admin access.
4. Keep mutations, event creation, and notification fan-out atomic. Durable notifications are independent of human read state. Do not acknowledge worker delivery before runtime acceptance is journaled.
5. Use `turn/steer` for notifications arriving during work and handle completion races. Keep the agent's app-server private over stdio; workers connect outbound to the board server.
6. Keep secrets outside Git and Docker images. Each worker needs separate state and credential storage. Never use a developer's existing host Codex login for automated tests.
7. Use Node.js 24+, npm lockfile installs, and the existing React/Express/SQLite stack. Keep Docker Compose and the worker-only Compose file usable.
8. Run `npm run check`, `npm test`, and `npm run test:browser` for changes affecting their behavior. `npm run test:codex` checks a real installed CLI without inference. Add meaningful regression tests for protocol, persistence, permissions, and notification changes.
9. Format with `npm run format`. Keep setup, authentication, backup, and actual verification limits documented in README.md.
10. Keep user-facing replies concise, use numbered lists rather than bullets, and ask at most one question per turn.
