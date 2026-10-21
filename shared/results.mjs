import { z } from "zod";
import { publicErrorSchema } from "./errors.mjs";

// Public wire contracts. Strict objects fail closed if a server accidentally sends
// internal columns; user-authored content stays in its documented string/payload fields.
const id = z.number().int().positive(),
  count = z.number().int().nonnegative();
const s = z.string(),
  ns = s.nullable(),
  ni = id.nullable();
const flag = z.union([z.boolean(), z.number().int().min(0).max(1)]);
const obj = (shape) => z.object(shape).strict();
const payload = z.record(z.unknown());
const optional = (shape) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()]));
export const userResult = obj({
  id,
  username: s,
  name: s,
  kind: z.enum(["human", "agent"]),
  admin: z.boolean(),
  created_at: s,
});
export const channelResult = obj({
  id,
  name: s,
  description: s,
  created_by: id,
  archived: flag,
  created_at: s,
  ...optional({ subscribed: flag, thread_count: count }),
});
export const attachmentResult = obj({
  id: s,
  reply_id: ni,
  owner_id: id,
  name: s,
  mime: s,
  size: count,
  created_at: s,
  ...optional({ thread_id: ni }),
});
export const claimResult = obj({
  user_id: id,
  kind: z.enum(["work", "review"]),
  thread_id: ni,
  branch_id: ni,
  submission_id: ni,
  commit_hash: ns,
  commit: ns.optional(),
  created_at: s,
});
export const ticketSubmissionResult = obj({
  id,
  thread_id: id,
  worker_id: id,
  submitted_by: id,
  summary: s,
  state: s,
  created_at: s,
  ...optional({ review_claim_user_id: ni }),
});
const workState = {
  current_submission: ticketSubmissionResult.nullable(),
  active_claim: claimResult.nullable(),
};
export const workStateResult = obj(workState);
export const replyResult = obj({
  id,
  thread_id: id,
  author_id: id,
  body: s,
  created_at: s,
  edited_at: ns,
  ...optional({
    author_name: s,
    author_username: s,
    author_kind: s,
    attachments: z.array(attachmentResult),
  }),
});
const eventShape = {
  id,
  type: s,
  actor_id: id,
  thread_id: ni,
  channel_id: ni,
  payload,
  created_at: s,
  ...optional({ actor_name: s, actor_username: s }),
};
export const eventResult = obj(eventShape);
export const threadResult = obj({
  id,
  channel_id: id,
  title: s,
  body: s,
  status_id: id,
  assignee_id: ni,
  created_by: id,
  created_at: s,
  updated_at: s,
  ...optional({
    channel_name: s,
    author_name: s,
    author_username: s,
    author_kind: s,
    assignee_name: ns,
    assignee_kind: ns,
    status_name: s,
    status_color: s,
    reply_count: count,
    archived: flag,
    subscribed: z.boolean(),
    attachments: z.array(attachmentResult),
    replies: z.array(replyResult),
    activity: z.array(eventResult),
    ...workState,
  }),
});
export const branchSubmissionResult = obj({
  branch_id: id,
  commit_hash: s,
  submitted_by: id,
  state: s,
  created_at: s,
});
const branchState = optional({
  submitted_commit: ns,
  submission: branchSubmissionResult.nullable(),
  review_claim_user_id: ni,
  review_claim: claimResult.nullable(),
});
export const pullRequestResult = obj({
  number: ni,
  url: ns,
  state: z.enum(["open", "closed", "merged"]),
  head_commit: s,
  base_commit: s,
  merge_commit: ns,
  approval_stale: z.boolean().optional(),
  synced_at: ns,
  error: ns,
});
const branchShape = {
  id,
  repository_id: id,
  name: s,
  owner_id: id,
  state: s,
  head_commit: s,
  created_at: s,
  merged_at: ns,
  ...optional({
    repository_name: s,
    owner_name: s,
    thread_ids: z.array(id),
    merge_mode: z.enum(["direct", "pull_request"]),
    pull_request: pullRequestResult.nullable(),
  }),
  ...branchState,
};
const branchReviewResult = obj({
  id,
  branch_id: id,
  reviewer_id: id,
  commit_hash: s,
  target_commit: s,
  decision: z.enum(["approved", "changes_requested"]),
  body: s,
  require_human: flag,
  created_at: s,
  ...optional({ reviewer_name: s, reviewer_kind: s }),
});
export const branchResult = obj({
  ...branchShape,
  ...optional({
    reviews: z.array(branchReviewResult),
    dependencies: z.array(obj(branchShape)),
  }),
});
export const repositoryResult = obj({
  id,
  name: s,
  url: s,
  main_branch: s,
  require_human: flag,
  created_by: id,
  created_at: s,
  credential_configured: z.boolean(),
  ...optional({
    merge_mode: z.enum(["direct", "pull_request"]),
    pr_provider: z.literal("github").nullable(),
    github_owner: ns,
    github_repo: ns,
    github_token_configured: z.boolean(),
  }),
});
const capabilities = obj({ user_id: id, can_work: flag, can_review: flag });
const agent = obj({
  user_id: id,
  role: s,
  model: s,
  desired: s,
  state: s,
  session_id: ns,
  heartbeat_at: ns,
  error: ns,
  auth_status: s,
  name: s,
  username: s,
});
const status = obj({ id, name: s, color: s, position: z.number().int() });
export const workspaceResult = obj({
  user: userResult,
  users: z.array(userResult),
  channels: z.array(channelResult),
  statuses: z.array(status),
  agents: z.array(agent),
  unread: count,
  ...optional({ sync_revision: s, public_origin: ns }),
});
export const orchestrationResult = obj({
  repositories: z.array(repositoryResult),
  branches: z.array(branchResult),
  capabilities: z.array(capabilities),
});
const ticketReviewQueue = obj({
  kind: z.literal("ticket"),
  id,
  submission_id: id,
  thread_id: id,
  summary: s,
  owner_id: id,
  owner_name: s,
  created_at: s,
  title: s,
  channel_id: id,
  channel_name: s,
  review_claim_user_id: ni,
});
const branchReviewQueue = obj({
  ...branchShape,
  kind: z.literal("branch"),
  branch_id: id,
  submitted_at: s,
});
export const queueResult = obj({
  work: z.array(threadResult),
  reviews: z.array(z.union([ticketReviewQueue, branchReviewQueue])),
  active_claim: claimResult.nullable(),
});
export const preferencesResult = obj({
  notify_ready_work: z.boolean(),
  notify_ready_reviews: z.boolean(),
});
export const notificationResult = obj({
  ...eventShape,
  event_id: id,
  user_id: id,
  read_at: ns,
  accepted_at: ns,
  channel_name: ns,
});
export const scheduleResult = obj({
  id,
  user_id: id,
  message: s,
  due_at: s,
  interval_ms: z.number().int().positive().nullable(),
  state: z.enum(["active", "completed", "cancelled"]),
  created_at: s,
  last_fired_at: ns,
});
const searchHit = obj({
  kind: s,
  id: z.union([id, s]),
  title: s,
  channel_id: ni,
  channel_name: ns,
  thread_id: ni,
  reply_id: ni,
  created_at: s,
  label: s,
  agent_id: ni,
  snippet: s,
});
export const searchResult = obj({
  results: z.array(searchHit),
  has_more: z.boolean(),
});
const ok = obj({ ok: z.literal(true) }),
  path = obj({ path: s });
const workChange = z.union([threadResult, workStateResult]);
const branchNames = [
  "read_branch",
  "create_branch",
  "link_branch",
  "handoff_branch",
  "add_branch_dependency",
  "remove_branch_dependency",
  "submit_branch_review",
  "claim_branch_review",
  "release_branch_review",
  "review_branch",
  "request_branch_merge",
  "sync_branch_pull_request",
];
export const threadPageResult = obj({
  items: z.array(threadResult),
  total: count,
  statusCounts: z.record(count),
  older: ns,
  newer: ns,
});
export const toolResults = {
  workspace_overview: workspaceResult,
  work_queue: queueResult,
  set_work_notifications: preferencesResult,
  claim_ticket: threadResult,
  release_ticket_claim: workChange,
  submit_ticket_work: threadResult,
  claim_ticket_review: workChange,
  release_ticket_review: workChange,
  review_ticket: threadResult,
  orchestration_overview: orchestrationResult,
  list_branches: z.array(branchResult),
  ...Object.fromEntries(branchNames.map((name) => [name, branchResult])),
  read_branch_diff: obj({ commit: s, target_commit: s, diff: s }),
  prepare_branch_workspace: obj({
    path: s,
    branch_id: id,
    branch: s,
    remote: s,
    preserved: z.boolean(),
    message: s,
  }),
  list_threads: z.union([z.array(threadResult), threadPageResult]),
  search_platform: searchResult,
  read_thread: threadResult,
  create_thread: threadResult,
  update_thread: threadResult,
  post_reply: replyResult,
  edit_reply: ok,
  create_channel: channelResult,
  update_channel: channelResult,
  subscribe_channel: ok,
  subscribe_thread: ok,
  read_inbox: z.array(notificationResult),
  mark_notifications_read: ok,
  schedule_notification: scheduleResult,
  list_scheduled_notifications: z.array(scheduleResult),
  cancel_scheduled_notification: scheduleResult,
  upload_attachment: attachmentResult,
  download_attachment: path,
  delete_unposted_attachment: ok,
  view_image_attachment: obj({ mimeType: s }),
  desktop_launch: obj({ pid: id, log_path: s, message: s }),
  desktop_list_windows: obj({ windows: z.array(obj({ id: s, title: s })) }),
  desktop_input: ok,
  desktop_screenshot: path,
};

// MCP requires a root object. Legacy content remains JSON(value); structured
// clients use outcome={ok:true,value} or {ok:false,error}, including array results.
export const toolOutput = (name) => {
  if (!toolResults[name])
    throw Error(`Missing public result contract: ${name}`);
  return {
    outcome: z.discriminatedUnion("ok", [
      obj({ ok: z.literal(true), value: toolResults[name] }),
      obj({ ok: z.literal(false), error: publicErrorSchema }),
    ]),
  };
};
export function publicResult(name, value) {
  const parsed = toolResults[name].safeParse(value);
  if (!parsed.success)
    throw Object.assign(new Error("Tool returned an invalid public result"), {
      publicCode: "INVALID_RESULT",
    });
  return parsed.data;
}

const subscribedResult = obj({ subscribed: z.boolean() });
toolResults.subscribe_channel = subscribedResult;
toolResults.subscribe_thread = subscribedResult;
// HTTP serialization and MCP share the same public value contracts. Transport
// mappings stay separate from the schemas and leave worker/admin/binary routes alone.
export function httpResultContract(method, path) {
  if (method === "GET") {
    const direct = {
      "/api/bootstrap": workspaceResult,
      "/api/work-queue": queueResult,
      "/api/work-preferences": preferencesResult,
      "/api/orchestration": orchestrationResult,
      "/api/repositories": z.array(repositoryResult),
      "/api/branches": z.array(branchResult),
      "/api/threads": z.union([z.array(threadResult), threadPageResult]),
      "/api/search": searchResult,
      "/api/inbox": z.array(notificationResult),
      "/api/notification-schedules": z.array(scheduleResult),
    };
    if (direct[path]) return direct[path];
    if (/^\/api\/threads\/\d+$/.test(path)) return threadResult;
    if (/^\/api\/branches\/\d+$/.test(path)) return branchResult;
    if (/^\/api\/branches\/\d+\/diff$/.test(path))
      return toolResults.read_branch_diff;
  }
  if (method === "PUT" && path === "/api/work-preferences")
    return preferencesResult;
  if (
    method === "PUT" &&
    /^\/api\/(threads|channels)\/\d+\/subscription$/.test(path)
  )
    return subscribedResult;
  if (method === "POST") {
    const direct = {
      "/api/threads": threadResult,
      "/api/channels": channelResult,
      "/api/attachments": attachmentResult,
      "/api/notification-schedules": scheduleResult,
      "/api/inbox/read": ok,
      "/api/repositories": repositoryResult,
    };
    if (direct[path]) return direct[path];
    if (/^\/api\/repositories\/\d+\/branches$/.test(path)) return branchResult;
    if (/^\/api\/branches\/\d+\/pull-request\/sync$/.test(path))
      return branchResult;
    if (
      /^\/api\/branches\/\d+\/(link|handoff|dependencies|submit-review|claim-review|release-review|reviews|merge)$/.test(
        path,
      )
    )
      return branchResult;
    if (/^\/api\/threads\/\d+\/replies$/.test(path)) return replyResult;
    if (
      /^\/api\/threads\/\d+\/(claim|release-claim|submit-work|claim-review|release-review|reviews)$/.test(
        path,
      )
    )
      return workChange;
  }
  if (method === "PATCH") {
    if (/^\/api\/repositories\/\d+$/.test(path)) return repositoryResult;
    if (/^\/api\/threads\/\d+$/.test(path)) return threadResult;
    if (/^\/api\/channels\/\d+$/.test(path)) return channelResult;
    if (/^\/api\/replies\/\d+$/.test(path)) return ok;
  }
  if (method === "DELETE") {
    if (/^\/api\/notification-schedules\/\d+$/.test(path))
      return scheduleResult;
    if (/^\/api\/branches\/\d+\/dependencies\/\d+$/.test(path))
      return branchResult;
    if (/^\/api\/attachments\/[^/]+$/.test(path)) return ok;
  }
  return null;
}
export function publicHttpResult(method, path, value) {
  const schema = httpResultContract(method, path);
  if (!schema) return value;
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw Object.assign(new Error("Invalid public response"), {
      status: 500,
      publicCode: "INVALID_RESULT",
    });
  return parsed.data;
}
