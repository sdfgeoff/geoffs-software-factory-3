import { z } from "zod";

// HTTP accepts numeric strings in paths, query parameters and existing JSON
// bodies. MCP advertises and accepts typed numbers. All constraints live here.
export const requestId = ({ coerce = true } = {}) =>
  (coerce ? z.coerce.number() : z.number()).int().positive();
export const messageText = z.string().max(50000);
export const attachmentId = z.string().uuid();
export const attachmentIds = z.array(attachmentId).max(10).default([]);
export const commitSha = z
  .string()
  .regex(/^[a-f0-9]{40}$/, "Use a full commit SHA");
export const channelName = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{1,39}$/,
    "Use 2–40 lowercase letters, numbers, underscores or hyphens.",
  );
export const branchName = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
  .refine(
    (v) =>
      !v.includes("..") &&
      !v.includes("//") &&
      !v.includes("@{") &&
      !v.endsWith("/") &&
      !v.endsWith(".") &&
      !v.split("/").some((s) => s.startsWith(".") || s.endsWith(".lock")),
    "Invalid branch name",
  );
export const reviewDecision = z.enum(["approved", "changes_requested"]);
export const threadCursorParts = z.tuple([
  z.string().min(1).max(40),
  requestId(),
]);
export const threadCursor = z
  .string()
  .refine(
    (value) => threadCursorParts.safeParse(value.split("|")).success,
    "Use a timestamp|positive-ID cursor returned by the server",
  );
export function threadListFields({ coerce = true } = {}) {
  const id = requestId({ coerce });
  const number = () => (coerce ? z.coerce.number() : z.number());
  return {
    channel: id.optional(),
    assignee: id.optional(),
    // Legacy HTTP truncates q to 200 characters and clamps offset; the adapter
    // retains that behavior instead of rejecting previously valid requests.
    q: z.string().optional(),
    ids: z.array(id).min(1).max(200).optional(),
    offset: number().int().min(0).optional(),
    paged: z.literal("1").optional(),
    limit: number().int().min(1).max(100).default(50),
    before: threadCursor.optional(),
    after: threadCursor.optional(),
    status: id.optional(),
  };
}
export function requestContracts({ coerce = true } = {}) {
  const id = requestId({ coerce });
  const number = () => (coerce ? z.coerce.number() : z.number());
  const subscription = z.object({ subscribed: z.boolean() });
  const revision = z.object({ commit: commitSha }).strict();
  return {
    workPreferences: z
      .object({
        notify_ready_work: z.boolean(),
        notify_ready_reviews: z.boolean(),
      })
      .strict(),
    claimTicket: z
      .object({ expected_updated_at: z.string().optional() })
      .strict(),
    submitWork: z.object({ summary: messageText.default("") }).strict(),
    ticketSubmission: z.object({ submission_id: id }),
    // The HTTP release endpoint historically permits omission to release the
    // current claim. MCP keeps its existing required revision argument.
    releaseTicketReview: z.object({ submission_id: id.optional() }),
    reviewTicket: z
      .object({
        submission_id: id,
        decision: reviewDecision,
        body: messageText.default(""),
      })
      .strict(),
    branchRevision: revision,
    createBranch: z
      .object({
        name: branchName,
        thread_ids: z.array(id).max(100).default([]),
        base: commitSha.optional(),
      })
      .strict(),
    linkBranch: z.object({ thread_id: id }).strict(),
    handoffBranch: z.object({ owner_id: id }).strict(),
    branchDependency: z.object({ depends_on_id: id }).strict(),
    reviewBranch: z
      .object({
        commit: commitSha,
        target_commit: commitSha.optional(),
        decision: reviewDecision,
        body: messageText.default(""),
        require_human: z.boolean().default(false),
      })
      .strict(),
    createThread: z.object({
      channel_id: id,
      title: z.string().trim().max(240).optional(),
      body: messageText.default(""),
      attachment_ids: attachmentIds,
      status_id: id.optional(),
      assignee_id: id.nullable().optional(),
    }),
    updateThread: z.object({
      title: z.string().trim().min(1).max(240).optional(),
      body: messageText.optional(),
      status_id: id.optional(),
      assignee_id: id.nullable().optional(),
      expected_updated_at: z.string().optional(),
    }),
    postReply: z.object({
      body: messageText.default(""),
      attachment_ids: attachmentIds,
    }),
    editReply: z.object({ body: messageText }),
    createChannel: z.object({
      name: channelName,
      description: z.string().max(1000).default(""),
    }),
    updateChannel: z.object({
      name: channelName.optional(),
      description: z.string().max(1000).optional(),
      archived: z.boolean().optional(),
    }),
    subscription,
    markRead: z.object({ ids: z.array(id).max(200).optional() }),
    schedule: z
      .object({
        message: z.string().trim().min(1).max(50000),
        when: z.string().min(1).max(100),
        repeat: z.string().min(1).max(100).optional(),
      })
      .strict(),
    search: z.object({
      q: z.string().trim().max(200).default(""),
      limit: number().int().min(1).max(100).default(30),
      offset: number().int().min(0).max(1000000).default(0),
    }),
  };
}
export const httpRequests = requestContracts();
export const mcpRequests = requestContracts({ coerce: false });
