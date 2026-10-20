import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { createApi } from "./api.mjs";
import { prepareBranchWorkspace } from "./git-workspace.mjs";

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
const server = new McpServer({ name: "threadwork", version: "0.1.0" });
const id = z.number().int().positive();
const result = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
function tool(name, description, schema, fn) {
  server.registerTool(
    name,
    { description, inputSchema: schema },
    async (args) => {
      try {
        return result(await fn(args));
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
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
tool(
  "list_threads",
  "List work items in chronological start order. Optional channel, assignee, text search, and offset (500 per page).",
  {
    channel_id: id.optional(),
    assignee_id: id.optional(),
    query: z.string().optional(),
    offset: z.number().int().min(0).optional(),
  },
  (args) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries({
      channel: args.channel_id,
      assignee: args.assignee_id,
      q: args.query,
      offset: args.offset,
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
  "Edit title/description, change status, assign or unassign a work item.",
  {
    thread_id: id,
    title: z.string().optional(),
    body: z.string().optional(),
    status_id: id.optional(),
    assignee_id: id.nullable().optional(),
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
  "Download an attachment to an existing directory in your workspace. Read the file using your normal tools.",
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
        content: [
          {
            type: "image",
            mimeType: mime,
            data: Buffer.from(await response.arrayBuffer()).toString("base64"),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
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
await server.connect(new StdioServerTransport());
