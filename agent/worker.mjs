import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApi } from "./api.mjs";
import { CodexClient, notificationPrompt } from "./codex.mjs";
import { workerMcpConfig } from "./mcp-config.mjs";

const instance = randomUUID();
const root = resolve(process.env.AGENT_DATA_DIR || ".agent-data");
const workspace = resolve(
  process.env.AGENT_WORKSPACE || join(root, "workspace"),
);
const codexHome = resolve(process.env.CODEX_HOME || join(root, "codex"));
mkdirSync(workspace, { recursive: true });
mkdirSync(codexHome, { recursive: true });
chmodSync(codexHome, 0o700);
const stateFile = join(root, "state.json");
let disk = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : { sessionId: null, active: false, pending: [], accepted: [] };
function save() {
  writeFileSync(stateFile + ".tmp", JSON.stringify(disk), { mode: 0o600 });
  renameSync(stateFile + ".tmp", stateFile);
}
const api = createApi({ instance });
let client,
  config,
  activeTurn = null,
  state = "starting",
  auth = "unknown",
  error = null,
  login = null,
  loginGeneration = 0,
  loginHandled = false,
  stopped = false,
  stopVersion = null,
  recover = disk.active;
let completedTurns = new Set();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopped = true;
    client?.stop();
  });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function log(message, level = "info") {
  console.log(`[${level}] ${message}`);
  await api("/worker/log", {
    method: "POST",
    body: { message: message.slice(0, 2000), level },
  }).catch(() => {});
}
function instructions() {
  return `# Threadwork agent workspace\n\nYou are ${config.name} (@${config.username}).\n\n${config.role}\n\nUse the threadwork MCP server to read and update the board. Every board post must be an explicit MCP call. You may remain silent. Notifications can steer your ongoing work. Keep persistent notes in MEMORY.md. Never disclose credentials or environment secrets. You have one session across all channels. Managed repository work is optional: use orchestration_overview and branch tools to discover eligible work, create or accept an explicit branch handoff, then prepare_branch_workspace for an isolated checkout. Use ordinary Git through the configured board gateway; upstream credentials belong to the server. Review requires explicit capability and applies to an exact commit. Approval never automatically merges: the worker or a human requests the merge. Changes requested remain with the original worker until explicit handoff. Do not push main directly. No branch or approved plan is required for investigation, discussion, or creating follow-up tickets. Work pickup: check work_queue for eligible work in your subscribed channels. If your work preferences enable Ready work notifications, proactively consider suitable queued tickets when available; use claim_ticket before starting, never race by assigning through update_thread. Generally hold one active work/review block. Finish your claimed work and explicitly submit its output: submit_ticket_work for non-code outputs (including creating tickets), or submit_branch_review for each exact pushed code revision. Submission frees capacity but keeps you responsible for requested changes and merges. If review notifications are enabled and you have review capability, proactively consider queued reviews, claim the exact branch revision or ticket submission, inspect/test the evidence, then approve or request changes with review_branch/review_ticket. You may defer unsuitable work or remain in an existing conversation; notifications never require a reply. After branch approval, request_branch_merge yourself and update the ticket to Done only when its scope is complete. Resume your reserved requested fixes with claim_ticket when free; do not hand them to another worker implicitly. If you give up a claim, release it explicitly so it does not remain stuck. Browser/GUI tools: when THREADWORK_DESKTOP=true you have an isolated virtual Linux desktop. Use chrome_devtools MCP for browser navigation, DOM/accessibility inspection, console/network debugging and page screenshots. Browser profile persists across worker restarts. Use threadwork desktop_launch, desktop_list_windows, desktop_input, and desktop_screenshot for native applications, or launch project development servers via your shell. localhost is your worker container; the board UI is http://frontend on the local Compose network (remote workers use their configured public board URL). Save screenshots inside your workspace, inspect them, and use upload_attachment plus post_reply only when you choose to share. The desktop is private and does not show or control the human host desktop. Graphical processes stop when the worker container restarts.\n`;
}
async function connect() {
  // A private CODEX_HOME avoids inheriting the host's tools or conversations.
  writeFileSync(
    join(codexHome, "config.toml"),
    workerMcpConfig({
      workspace,
      stateDir: root,
      desktop: process.env.THREADWORK_DESKTOP === "true",
    }),
    { mode: 0o600 },
  );
  client = new CodexClient({
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      AGENT_WORKSPACE: workspace,
      WORKER_INSTANCE: instance,
    },
  });
  client.on("closed", () => {
    error = "Codex process disconnected; resuming the same session";
    state = "error";
    activeTurn = null;
    client = null;
    recover = disk.active;
  });
  client.on("notification", (message) => {
    if (message.method === "turn/completed") {
      const turn = message.params.turn;
      completedTurns.add(turn.id);
      if (completedTurns.size > 100)
        completedTurns.delete(completedTurns.values().next().value);
      if (!activeTurn || activeTurn === turn.id) {
        activeTurn = null;
        disk.active = false;
        save();
        state = config?.desired === "paused" ? "paused" : "idle";
      }
      if (turn.status === "failed") {
        state = "error";
        error = turn.error?.message || "Codex turn failed";
        log(error, "error");
      } else
        log(`Turn ${turn.status}. No runtime output was posted to the board.`);
    }
    if (message.method === "account/login/completed") {
      loginGeneration++;
      login = null;
      loginHandled = false;
      error = message.params.success
        ? null
        : message.params.error || "Login failed";
      if (error) log(error, "error");
    }
  });
  await client.initialize();
  if (process.env.OPENAI_API_KEY)
    await client.call("account/login/start", {
      type: "apiKey",
      apiKey: process.env.OPENAI_API_KEY,
    });
  await log("Connected to Codex app-server.");
}
async function ensureSession() {
  if (
    disk.sessionId &&
    config.session_id &&
    disk.sessionId !== config.session_id
  )
    throw new Error(
      "Session mismatch: restore the correct agent volume instead of creating a replacement session.",
    );
  const threadId = disk.sessionId || config.session_id;
  writeFileSync(join(workspace, "AGENTS.md"), instructions());
  const params = {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ...(config.model ? { model: config.model } : {}),
  };
  const result = threadId
    ? await client.call("thread/resume", { ...params, threadId })
    : await client.call("thread/start", params);
  // Record identity before any further RPC: an initialization failure must never
  // silently replace this agent's session with another one.
  disk.sessionId = result.thread.id;
  if (!threadId) disk.initialized = false;
  save();
  if (!threadId || disk.initialized === false) {
    // Codex does not flush an empty rollout. Persist a context item without running a model turn.
    await client.call("thread/inject_items", {
      threadId: result.thread.id,
      items: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Persistent Threadwork agent ${config.name} (@${config.username}) initialized. This establishes the workspace identity; no action or reply is requested.`,
            },
          ],
        },
      ],
    });
    disk.initialized = true;
    save();
  }
  await log(
    `${threadId ? "Resumed" : "Created"} persistent session ${disk.sessionId}.`,
  );
}
async function heartbeat() {
  config = await api("/worker/heartbeat", {
    method: "POST",
    body: {
      instance_id: instance,
      state,
      session_id: disk.sessionId,
      auth_status: auth,
      error,
      login_url: login?.verificationUrl || null,
      login_code: login?.userCode || null,
      login_handled: loginHandled,
    },
  });
  if (disk.agentId && disk.agentId !== config.user_id)
    throw new Error(
      "This volume belongs to another agent; use a separate volume.",
    );
  disk.agentId = config.user_id;
  save();
  loginHandled = false;
  return config;
}
let sessionReady = false;
const identity = await createApi({ instance: null })("/me");
if (disk.agentId && disk.agentId !== identity.id)
  throw new Error(
    "This volume belongs to another agent; use a separate volume.",
  );

// A crashed worker's lease expires within 30 seconds. Wait without opening another Codex process.
while (!stopped) {
  try {
    await heartbeat();
    break;
  } catch (cause) {
    if (cause.status !== 409) throw cause;
    await delay(2000);
  }
}
let heartbeatBusy = false;
const heartbeatTimer = setInterval(async () => {
  if (heartbeatBusy || stopped) return;
  heartbeatBusy = true;
  try {
    await heartbeat();
  } catch (cause) {
    if (cause.status === 409 || cause.status === 401) {
      stopped = true;
      error = cause.message;
      client?.stop();
    }
  } finally {
    heartbeatBusy = false;
  }
}, 5000);
await log(`Worker online for @${config.username}. Workspace: ${workspace}`);
while (!stopped) {
  try {
    await heartbeat();
    if (stopped) break;
    if (!client) {
      await connect();
      sessionReady = false;
    }
    const account = await client.call("account/read", {});
    auth = account.account?.type || "not_signed_in";
    if (config.login_requested && !login) {
      const generation = loginGeneration;
      const pendingLogin = await client.call("account/login/start", {
        type: "chatgptDeviceCode",
      });
      if (generation === loginGeneration) login = pendingLogin;
      loginHandled = true;
      await heartbeat();
      await log("Device login requested. Complete it from the admin panel.");
    }
    if (!account.account && !process.env.OPENAI_API_KEY) {
      state = "auth_required";
      await delay(2000);
      continue;
    }
    if (!sessionReady) {
      if (stopped) break;
      await ensureSession();
      sessionReady = true;
      await heartbeat();
    }
    if (stopVersion === null) stopVersion = config.stop_version;
    if (config.stop_version !== stopVersion) {
      stopVersion = config.stop_version;
      if (activeTurn)
        await client.call("turn/interrupt", {
          threadId: disk.sessionId,
          turnId: activeTurn,
        });
      recover = false;
      disk.active = false;
      save();
      await log("Work interrupted by admin.");
    }
    if (config.desired === "paused") {
      state = activeTurn ? "working" : "paused";
      await delay(1000);
      continue;
    }
    const incoming = await api("/worker/inbox");
    const unseen = incoming.filter(
      (n) =>
        !disk.accepted.includes(n.id) &&
        !disk.pending.some((p) => p.id === n.id),
    );
    if (unseen.length) {
      disk.pending.push(...unseen);
      save();
    }
    const duplicates = incoming.filter((n) => disk.accepted.includes(n.id));
    if (duplicates.length)
      await api("/worker/ack", {
        method: "POST",
        body: { ids: duplicates.map((n) => n.id) },
      });
    if (disk.pending.length || recover) {
      const batch = disk.pending.slice(0, 30);
      const prompt =
        notificationPrompt(config, batch) +
        (recover
          ? "\nThe worker restarted during a previous turn. Review your existing context and workspace, then continue or stop as appropriate. Avoid repeating actions already recorded on the board."
          : "");
      const input = [{ type: "text", text: prompt }];
      const runtime = client;
      if (stopped) break;
      if (!runtime || runtime.closed) continue;
      if (activeTurn) {
        try {
          await runtime.call("turn/steer", {
            threadId: disk.sessionId,
            expectedTurnId: activeTurn,
            input,
          });
        } catch (steerError) {
          // A turn may finish between reading activeTurn and steering. Keep the batch and start it next loop.
          if (!activeTurn || completedTurns.has(activeTurn)) {
            activeTurn = null;
            continue;
          }
          throw steerError;
        }
        await log(`Steered active turn with ${batch.length} notification(s).`);
      } else {
        const turn = await runtime.call("turn/start", {
          threadId: disk.sessionId,
          input,
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
          ...(config.model ? { model: config.model } : {}),
        });
        activeTurn = completedTurns.has(turn.turn.id) ? null : turn.turn.id;
        await log(`Started turn with ${batch.length} notification(s).`);
      }
      if (runtime !== client || runtime.closed || stopped)
        throw new Error(
          "Codex disconnected before delivery was journaled; retaining notifications for replay.",
        );
      // Save acceptance before ACK: a crash can replay an id, but cannot lose an undelivered notification.
      disk.active = !!activeTurn;
      disk.accepted = [...disk.accepted, ...batch.map((n) => n.id)].slice(
        -2000,
      );
      disk.pending = disk.pending.filter(
        (n) => !batch.some((b) => b.id === n.id),
      );
      save();
      recover = false;
      if (batch.length)
        await api("/worker/ack", {
          method: "POST",
          body: { ids: batch.map((n) => n.id) },
        });
      error = null;
    }
    state = activeTurn ? "working" : error ? "error" : "idle";
  } catch (cause) {
    error = cause.message;
    state = "error";
    if (cause.status === 409 || cause.status === 401) {
      console.error(error);
      client?.stop();
      process.exitCode = 1;
      break;
    }
    await log(error, "error");
    if (client?.closed) {
      client = null;
      sessionReady = false;
    }
    await delay(3000);
  }
  await delay(Number(process.env.POLL_INTERVAL_MS || 1500));
}
clearInterval(heartbeatTimer);
client?.stop();
