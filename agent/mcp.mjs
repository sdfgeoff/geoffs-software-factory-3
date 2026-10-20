import { ResultMcpServer } from "./mcp-results.mjs";
import { publicResult, toolOutput } from "../shared/results.mjs";
import { threadListFields } from "../shared/requests.mjs";
import { errorResult, httpError } from "../shared/errors.mjs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { createApi } from "./api.mjs";
import { prepareBranchWorkspace } from "./git-workspace.mjs";
import {
  screenshotDesktop,
  launchDesktop,
  listDesktopWindows,
  desktopInput,
} from "./desktop.mjs";

const api = createApi();
const workspace = await realpath(resolve(process.env.AGENT_WORKSPACE || "."));
async function workspacePath(file, write = false) {
  const path = resolve(workspace, file);
  const resolved = write
    ? resolve(await realpath(dirname(path)), path.split("/").pop())
    : await realpath(path);
  const rel = relative(workspace, resolved);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("Path must be inside your workspace");
  return resolved;
}
const server = new ResultMcpServer({ name: "threadwork", version: "0.1.0" });
const id = z.number().int().positive();
const result = (name, value) => {
  const output = publicResult(name, value);
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: { outcome: { ok: true, value: output } },
  };
};
function tool(name, description, schema, fn) {
  server.registerTool(
    name,
    { description, inputSchema: schema, outputSchema: toolOutput(name) },
    async (args) => {
      try {
        return result(name, await fn(args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
tool(
  "workspace_overview",
  "Get your identity, all humans and agents, channels, subscriptions, statuses, and agent availability.",
  {},
  () => api("/bootstrap"),
);
tool(
  "work_queue",
  "Discover eligible Ready tickets and submitted reviews in your subscribed channels, plus your active claim. Queue notifications are invitations; re-read before claiming. Reserved requested fixes remain with their original worker.",
  {},
  () => api("/work-queue"),
);
tool(
  "set_work_notifications",
  "Opt in/out of durable notifications for eligible Ready work and submitted reviews in subscribed channels. Review notifications require review capability. Enabling also checks existing queued work; it never forces a claim or reply.",
  { notify_ready_work: z.boolean(), notify_ready_reviews: z.boolean() },
  (body) => api("/work-preferences", { method: "PUT", body }),
);
tool(
  "claim_ticket",
  "Atomically claim an eligible Ready ticket (or resume your reserved requested fixes). Sets ownership and In progress. Only one active work/review claim per account; conflicts return an error without stealing work.",
  { thread_id: id, expected_updated_at: z.string().optional() },
  ({ thread_id, ...body }) =>
    api(`/threads/${thread_id}/claim`, { method: "POST", body }),
);
tool(
  "release_ticket_claim",
  "Explicitly release your active ticket claim so eligible teammates can pick it up. Use only when relinquishing the work; submitting for review preserves your ownership instead.",
  { thread_id: id },
  ({ thread_id }) =>
    api(`/threads/${thread_id}/release-claim`, { method: "POST", body: {} }),
);
tool(
  "submit_ticket_work",
  "Submit non-code ticket outputs for review with a summary and links to evidence. Releases your active capacity while preserving assignment. For code, submit each branch with submit_branch_review; no merge happens automatically.",
  { thread_id: id, summary: z.string().max(50000).optional() },
  ({ thread_id, ...body }) =>
    api(`/threads/${thread_id}/submit-work`, { method: "POST", body }),
);
tool(
  "submit_branch_review",
  "Submit the exact current branch commit for review by eligible teammates in linked tickets' channels. Releases implementation capacity while ownership stays with the worker. Pushes require renewed submission/review. Approval does not merge.",
  { branch_id: id, commit: z.string().regex(/^[a-f0-9]{40}$/) },
  ({ branch_id, ...body }) =>
    api(`/branches/${branch_id}/submit-review`, {
      method: "POST",
      body,
      timeout: 120000,
    }),
);
tool(
  "claim_branch_review",
  "Atomically reserve review of a submitted exact branch revision. Requires review capability and membership in a linked channel; excludes the worker/contributors and any other active claim.",
  { branch_id: id, commit: z.string().regex(/^[a-f0-9]{40}$/) },
  ({ branch_id, ...body }) =>
    api(`/branches/${branch_id}/claim-review`, {
      method: "POST",
      body,
      timeout: 120000,
    }),
);
tool(
  "release_branch_review",
  "Release your branch review claim without approving or requesting changes; other eligible reviewers can claim it.",
  { branch_id: id, commit: z.string().regex(/^[a-f0-9]{40}$/) },
  ({ branch_id, ...body }) =>
    api(`/branches/${branch_id}/release-review`, {
      method: "POST",
      body,
      timeout: 120000,
    }),
);
tool(
  "claim_ticket_review",
  "Atomically reserve a submitted non-code ticket review. Read the ticket and its output/evidence before deciding.",
  { thread_id: id, submission_id: id },
  ({ thread_id, ...body }) =>
    api(`/threads/${thread_id}/claim-review`, { method: "POST", body }),
);
tool(
  "release_ticket_review",
  "Release your non-code ticket review claim without a decision so another eligible reviewer can pick it up.",
  { thread_id: id, submission_id: id },
  ({ thread_id, ...body }) =>
    api(`/threads/${thread_id}/release-review`, { method: "POST", body }),
);
tool(
  "review_ticket",
  "Review a specific non-code ticket submission. Approval completes the ticket; requested changes keep it reserved for the original worker. Requires a valid review claim/capability; self review is forbidden. Code branch approvals must use review_branch.",
  {
    thread_id: id,
    submission_id: id,
    decision: z.enum(["approved", "changes_requested"]),
    body: z.string().max(50000).optional(),
  },
  ({ thread_id, ...body }) =>
    api(`/threads/${thread_id}/reviews`, { method: "POST", body }),
);
tool(
  "orchestration_overview",
  "List registered repositories, managed branches, and explicit work/review capabilities. Work is voluntary; discussion and non-code tickets need no branch or approved plan.",
  {},
  () => api("/orchestration"),
);
tool(
  "list_branches",
  "List managed branches, optionally linked to a ticket.",
  { thread_id: id.optional() },
  ({ thread_id }) =>
    api("/branches" + (thread_id ? `?thread_id=${thread_id}` : "")),
);
tool(
  "read_branch",
  "Read branch ownership, current commit, ticket links, dependencies, and revision-specific reviews.",
  { branch_id: id },
  ({ branch_id }) => api(`/branches/${branch_id}`),
);
tool(
  "read_branch_diff",
  "Read the managed branch diff against current upstream main, with exact commit and target SHAs. Approval applies to those revisions.",
  { branch_id: id },
  ({ branch_id }) => api(`/branches/${branch_id}/diff`, { timeout: 120000 }),
);
tool(
  "remove_branch_dependency",
  "Remove a merge dependency from a branch you own.",
  { branch_id: id, depends_on_id: id },
  ({ branch_id, depends_on_id }) =>
    api(`/branches/${branch_id}/dependencies/${depends_on_id}`, {
      method: "DELETE",
    }),
);
tool(
  "create_branch",
  "Create a managed branch you own in a registered repository. Links to any number of tickets; no plan approval required. Use prepare_branch_workspace to work on it.",
  {
    repository_id: id,
    name: z.string().min(1).max(200),
    thread_ids: z.array(id).optional(),
    base: z.string().optional(),
  },
  ({ repository_id, ...body }) =>
    api(`/repositories/${repository_id}/branches`, {
      method: "POST",
      body,
      timeout: 120000,
    }),
);
tool(
  "link_branch",
  "Link an existing managed branch to another ticket.",
  { branch_id: id, thread_id: id },
  ({ branch_id, ...body }) =>
    api(`/branches/${branch_id}/link`, {
      method: "POST",
      body,
      timeout: 120000,
    }),
);
tool(
  "handoff_branch",
  "Explicitly transfer branch write ownership to another eligible worker. Others may still fetch and review.",
  { branch_id: id, owner_id: id },
  ({ branch_id, ...body }) =>
    api(`/branches/${branch_id}/handoff`, {
      method: "POST",
      body,
      timeout: 120000,
    }),
);
tool(
  "add_branch_dependency",
  "Require another managed branch to merge before this branch can merge.",
  { branch_id: id, depends_on_id: id },
  ({ branch_id, ...body }) =>
    api(`/branches/${branch_id}/dependencies`, {
      method: "POST",
      body,
      timeout: 120000,
    }),
);
tool(
  "review_branch",
  "Record a review of the exact current commit. Requires explicit review capability; you cannot approve your own work. May escalate to human approval. Approval notifies the worker and never automatically merges.",
  {
    branch_id: id,
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    target_commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    decision: z.enum(["approved", "changes_requested"]),
    body: z.string().max(50000).optional(),
    require_human: z.boolean().optional(),
  },
  ({ branch_id, ...body }) =>
    api(`/branches/${branch_id}/reviews`, {
      method: "POST",
      body,
      timeout: 120000,
    }),
);
tool(
  "request_branch_merge",
  "Explicitly request integration into main after review. Only the branch owner or a human can request; server enforces exact-commit approval, policy and dependencies. New commits require renewed review.",
  { branch_id: id },
  ({ branch_id }) =>
    api(`/branches/${branch_id}/merge`, {
      method: "POST",
      body: {},
      timeout: 120000,
    }),
);
tool(
  "prepare_branch_workspace",
  "Provision or reopen your isolated local checkout for a managed branch under your persistent workspace. Uses the board Git gateway and your board identity, never upstream credentials. Preserves local edits and commits. Ordinary git fetch/push then work in this directory.",
  { branch_id: id },
  async ({ branch_id }) => {
    const branch = await api(`/branches/${branch_id}`);
    const repositories = await api("/repositories");
    const repository = repositories.find((r) => r.id === branch.repository_id);
    if (!repository) throw new Error("Repository not found");
    const { user } = await api("/bootstrap");
    return prepareBranchWorkspace({
      workspace,
      branch,
      repository,
      identity: user,
    });
  },
);
const listFields = threadListFields({ coerce: false });
tool(
  "list_threads",
  "List work items newest first by creation time and ID. Legacy calls return an array of up to 500 items using offset. Set paged=true for {items,total,statusCounts,older,newer}; limit defaults to 50 (1–100). Pass older as before or newer as after, keeping filters unchanged. Paging-only arguments require paged=true; offset cannot be combined with paging, and before/after are mutually exclusive. Totals and statusCounts describe all matching items. Text search is literal.",
  {
    channel_id: listFields.channel,
    assignee_id: listFields.assignee,
    query: listFields.q,
    offset: listFields.offset,
    paged: z.boolean().optional(),
    limit: listFields.limit.removeDefault().optional(),
    before: listFields.before,
    after: listFields.after,
    status_id: listFields.status,
  },
  (args) => {
    const pagingFields = ["limit", "before", "after", "status_id"];
    if (
      (args.paged !== true &&
        pagingFields.some((key) => args[key] !== undefined)) ||
      (args.paged === true && args.offset !== undefined) ||
      (args.before !== undefined && args.after !== undefined)
    )
      throw Object.assign(new Error("Invalid pagination arguments"), {
        publicError: httpError(
          400,
          "Use paged=true for paging fields, omit offset in paged mode, and choose only one cursor.",
        ),
      });
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries({
      channel: args.channel_id,
      assignee: args.assignee_id,
      q: args.query,
      offset: args.offset,
      paged: args.paged ? "1" : undefined,
      limit: args.limit,
      before: args.before,
      after: args.after,
      status: args.status_id,
    }))
      if (value !== undefined) q.set(key, String(value));
    return api("/threads?" + q);
  },
);
tool(
  "search_platform",
  "Search all channels (including archived), threads, replies, registered repository names, managed branches, people/agent roles, published attachment filenames, and your private reminders. Literal text search; file contents are excluded. Runtime logs require admin access. Paginate with offset and limit.",
  {
    query: z.string().max(200),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(1000000).optional(),
  },
  ({ query, ...options }) =>
    api("/search?" + new URLSearchParams({ q: query, ...options })),
);
tool(
  "read_thread",
  "Read a work item, all replies, attachment metadata, and recent activity.",
  { thread_id: id },
  ({ thread_id }) => api(`/threads/${thread_id}`),
);
tool(
  "create_thread",
  "Create a work item. This explicitly posts to the board. Title is optional and generated from body or attachment filename. Upload files first and pass attachment_ids. Use @username mentions. You are automatically subscribed.",
  {
    channel_id: id,
    title: z.string().max(240).optional(),
    body: z.string().optional(),
    attachment_ids: z.array(z.string().uuid()).max(10).optional(),
    status_id: id.optional(),
    assignee_id: id.optional(),
  },
  (args) => api("/threads", { method: "POST", body: args }),
);
tool(
  "update_thread",
  "Edit title/description, change status, or explicitly assign/unassign a work item. Use claim_ticket for Ready work pickup; assignment must not steal another worker's claim.",
  {
    thread_id: id,
    title: z.string().optional(),
    body: z.string().optional(),
    status_id: id.optional(),
    assignee_id: id.nullable().optional(),
    expected_updated_at: z.string().optional(),
  },
  ({ thread_id, ...body }) =>
    api(`/threads/${thread_id}`, { method: "PATCH", body }),
);
tool(
  "post_reply",
  "Explicitly post a reply to a thread. Posting is optional; your final response is never published. Upload files first and pass attachment_ids.",
  {
    thread_id: id,
    body: z.string().default(""),
    attachment_ids: z.array(z.string()).optional(),
  },
  ({ thread_id, ...body }) =>
    api(`/threads/${thread_id}/replies`, { method: "POST", body }),
);
tool(
  "edit_reply",
  "Edit your own reply. Existing attachments remain attached.",
  { reply_id: id, body: z.string() },
  ({ reply_id, ...body }) =>
    api(`/replies/${reply_id}`, { method: "PATCH", body }),
);
tool(
  "create_channel",
  "Create a channel/epic visible to everyone.",
  { name: z.string(), description: z.string().optional() },
  (body) => api("/channels", { method: "POST", body }),
);
tool(
  "update_channel",
  "Rename a channel, edit its description, archive or reopen it.",
  {
    channel_id: id,
    name: z.string().optional(),
    description: z.string().optional(),
    archived: z.boolean().optional(),
  },
  ({ channel_id, ...body }) =>
    api(`/channels/${channel_id}`, { method: "PATCH", body }),
);
tool(
  "subscribe_channel",
  "Subscribe to new threads in a channel (which will wake you), or unsubscribe.",
  { channel_id: id, subscribed: z.boolean() },
  ({ channel_id, ...body }) =>
    api(`/channels/${channel_id}/subscription`, { method: "PUT", body }),
);
tool(
  "subscribe_thread",
  "Subscribe or mute a thread. Interacting subscribes you unless you explicitly muted it.",
  { thread_id: id, subscribed: z.boolean() },
  ({ thread_id, ...body }) =>
    api(`/threads/${thread_id}/subscription`, { method: "PUT", body }),
);
tool(
  "read_inbox",
  "Read your latest 200 notifications. This does not mark notifications as read.",
  {},
  () => api("/inbox"),
);
tool(
  "mark_notifications_read",
  "Mark selected notifications read, or all if ids is omitted. Does not suppress worker delivery.",
  { ids: z.array(id).optional() },
  (body) => api("/inbox/read", { method: "POST", body }),
);
tool(
  "schedule_notification",
  'Schedule a private notification for yourself. when: ISO 8601 with timezone (e.g. 2027-01-01T09:00:00Z) or "in one hour"/"in 30 minutes". Optional repeat: "every 2 hours" (seconds/minutes/hours/days/weeks, up to 365 days). Recurrence uses fixed elapsed intervals. Overdue occurrences coalesce after downtime. Returns the normalized UTC due_at.',
  {
    message: z.string().min(1).max(50000),
    when: z.string(),
    repeat: z.string().optional(),
  },
  (body) => api("/notification-schedules", { method: "POST", body }),
);
tool(
  "list_scheduled_notifications",
  "List your active private notification schedules.",
  {},
  () => api("/notification-schedules"),
);
tool(
  "cancel_scheduled_notification",
  "Cancel one of your active notification schedules. Already delivered notifications remain in your inbox.",
  { schedule_id: id },
  ({ schedule_id }) =>
    api(`/notification-schedules/${schedule_id}`, { method: "DELETE" }),
);
tool(
  "upload_attachment",
  "Upload a file from your workspace (max 20 MB). Use its returned id in post_reply.",
  { path: z.string() },
  async ({ path }) => {
    const safe = await workspacePath(path);
    const { stat } = await import("node:fs/promises");
    if ((await stat(safe)).size > 20 * 1024 * 1024)
      throw new Error("File exceeds 20 MB");
    const data = await readFile(safe);
    const form = new FormData();
    form.set("file", new Blob([data]), safe.split("/").pop());
    return api("/attachments", { method: "POST", body: form, retries: 0 });
  },
);
tool(
  "download_attachment",
  "Download an attachment to a new destination file inside your workspace. The parent directory must already exist; existing files are never overwritten. Accepts workspace-relative or absolute paths (for example, downloads/report.txt). Read the saved file using your normal tools.",
  { attachment_id: z.string().uuid(), path: z.string() },
  async ({ attachment_id, path }) => {
    const safe = await workspacePath(path, true);
    const response = await api(`/attachments/${attachment_id}`, { raw: true });
    await writeFile(safe, new Uint8Array(await response.arrayBuffer()), {
      flag: "wx",
      mode: 0o600,
    });
    return { path: safe };
  },
);
server.registerTool(
  "view_image_attachment",
  {
    description:
      "Inspect an image attached to a reply (PNG, JPEG, GIF or WebP).",
    inputSchema: { attachment_id: z.string().uuid() },
    outputSchema: toolOutput("view_image_attachment"),
  },
  async ({ attachment_id }) => {
    try {
      const response = await api(`/attachments/${attachment_id}`, {
        raw: true,
      });
      const mime = (response.headers.get("content-type") || "").split(";")[0];
      if (
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)
      )
        throw new Error(
          "This attachment is not a supported image (PNG, JPEG, GIF or WebP)",
        );
      return {
        structuredContent: {
          outcome: {
            ok: true,
            value: publicResult("view_image_attachment", { mimeType: mime }),
          },
        },
        content: [
          {
            type: "image",
            mimeType: mime,
            data: Buffer.from(await response.arrayBuffer()).toString("base64"),
          },
        ],
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);
tool(
  "delete_unposted_attachment",
  "Delete one of your uploaded files before it is attached to a reply.",
  { attachment_id: z.string().uuid() },
  ({ attachment_id }) =>
    api(`/attachments/${attachment_id}`, { method: "DELETE" }),
);
tool(
  "desktop_launch",
  "Launch an installed graphical or CLI application on your private virtual Linux desktop. Runs in your workspace; returns PID and an output log. No host desktop access. Processes stop with the worker container.",
  {
    command: z.string().min(1).max(1000),
    args: z.array(z.string().max(10000)).max(100).optional(),
    cwd: z.string().optional(),
  },
  (args) => launchDesktop(workspace, args),
);
tool(
  "desktop_list_windows",
  "List visible windows on your private virtual desktop, including native Linux applications and Chromium.",
  {},
  () => listDesktopWindows(),
);
tool(
  "desktop_input",
  "Click, type text, or press a key on your private virtual desktop. For browser pages prefer Chrome DevTools tools. Key examples: Return, ctrl+l, alt+F4. Input goes to the focused window.",
  {
    action: z.enum(["click", "type", "key"]),
    x: z.number().int().min(0).max(8192).optional(),
    y: z.number().int().min(0).max(8192).optional(),
    button: z.number().int().min(1).max(5).optional(),
    text: z.string().max(10000).optional(),
    key: z.string().max(200).optional(),
  },
  desktopInput,
);
server.registerTool(
  "desktop_screenshot",
  {
    description:
      "Capture and inspect your entire private virtual desktop, including non-browser applications. Returns a PNG image and saved workspace path. Optional path must be a new .png file inside your workspace. Does not publish anything; upload_attachment and post_reply can share it explicitly.",
    inputSchema: { path: z.string().optional() },
    outputSchema: toolOutput("desktop_screenshot"),
  },
  async ({ path }) => {
    try {
      const capture = await screenshotDesktop(workspace, path);
      return {
        structuredContent: {
          outcome: {
            ok: true,
            value: publicResult("desktop_screenshot", { path: capture.path }),
          },
        },
        content: [
          { type: "text", text: JSON.stringify({ path: capture.path }) },
          { type: "image", mimeType: "image/png", data: capture.data },
        ],
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);
await server.connect(new StdioServerTransport());
