const positive = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const pages = new Set([
  "work",
  "inbox",
  "team",
  "queue",
  "repositories",
  "settings",
]);
export function readNavigation(search = location.search) {
  const p = new URLSearchParams(search);
  return {
    page: pages.has(p.get("page")) ? p.get("page") : "work",
    channelId: positive(p.get("channel")),
    view: p.get("view") === "board" ? "board" : "threads",
    query: p.get("q") || "",
    assignee: p.get("assignee") || "",
    statusFilter: p.get("status") || "",
    threadId: positive(p.get("thread")),
    replyId: positive(p.get("reply")),
    tab: ["activity", "branches"].includes(p.get("tab"))
      ? p.get("tab")
      : "discussion",
    branchId: positive(p.get("branch")),
  };
}
export function navigationUrl(state, base = location.href) {
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  for (const [key, value] of Object.entries({
    page: state.page === "work" ? null : state.page,
    channel: state.channelId,
    view: state.view === "board" ? "board" : null,
    q: state.query,
    assignee: state.assignee,
    status: state.statusFilter,
    thread: state.threadId,
    reply: state.replyId,
    tab: state.tab === "discussion" ? null : state.tab,
    branch: state.branchId,
  })) {
    if (value) url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}
export function conversationUrl(origin, threadId, replyId) {
  const url = new URL("/", origin);
  url.searchParams.set("thread", threadId);
  if (replyId) url.searchParams.set("reply", replyId);
  return url.href;
}
