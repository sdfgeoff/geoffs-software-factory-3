import {
  readNavigation,
  navigationUrl,
  conversationUrl,
} from "./navigation.mjs";
import useConversationScroll from "./useConversationScroll.jsx";
import ReminderComposer from "./ReminderComposer.jsx";
import { reminderTimeLabel } from "./reminder-time.mjs";
import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Hash,
  Plus,
  Search,
  LayoutGrid,
  MessageSquare,
  Bell,
  Users,
  Bot,
  Settings,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  ArrowRight,
  X,
  Paperclip,
  Send,
  Check,
  CheckCheck,
  MoreHorizontal,
  LogOut,
  Play,
  Pause,
  Square,
  Terminal,
  Copy,
  FileText,
  Download,
  Eye,
  EyeOff,
  LoaderCircle,
  Menu,
  ArrowLeft,
  Inbox,
  Compass,
  SlidersHorizontal,
  Pencil,
  Archive,
  RefreshCw,
  ExternalLink,
  AtSign,
  Image as ImageIcon,
  Columns3,
  Wifi,
  AlertCircle,
  CheckCircle2,
  ClipboardList,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./style.css";
import { RepositoriesPage, ThreadBranches } from "./Orchestration.jsx";
import {
  WorkQueuePage,
  WorkPreferences,
  ThreadWorkControl,
} from "./WorkQueue.jsx";

async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body:
      options.body instanceof FormData
        ? options.body
        : options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
  });
  const result = await response.json();
  if (!response.ok) {
    const e = new Error(result.error || "Something went wrong");
    e.status = response.status;
    throw e;
  }
  return result;
}
const Icon = ({ icon: I, size = 18, ...props }) => (
  <I size={size} strokeWidth={1.8} {...props} />
);
const date = (s) =>
  new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fullDate = (s) => new Date(s).toLocaleString();
const timeAgo = (s) => {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(s)) / 60000));
  return m < 1
    ? "just now"
    : m < 60
      ? `${m}m ago`
      : m < 1440
        ? `${Math.floor(m / 60)}h ago`
        : date(s);
};
function notificationVerb(notification) {
  if (
    notification.type === "work.reviewed" ||
    notification.type === "branch.reviewed"
  )
    return notification.payload.decision === "approved"
      ? "approved work in"
      : "requested changes in";
  return (
    {
      "notification.scheduled": "scheduled",
      "reply.created": "replied to",
      "thread.created": "started",
      "reply.edited": "edited a reply in",
      "work.ready": "made work available in",
      "review.ready": "made a review available in",
      "work.claimed": "claimed work in",
      "work.released": "released work in",
      "work.submitted": "submitted work for review in",
      "review.claimed": "claimed review of",
      "review.released": "released review of",
      "branch.submitted": "submitted a branch for review in",
      "branch.merged": "merged a branch in",
    }[notification.type] || "updated"
  );
}
function notificationSummary(notification) {
  const payload = notification.payload;
  if (payload.body || payload.summary)
    return (payload.body || payload.summary).slice(0, 160);
  const descriptions = {
    "work.ready": "Available for voluntary pickup in your Work queue.",
    "review.ready":
      "A submitted outcome is ready for review in your Work queue.",
    "work.claimed": "Implementation is reserved for this worker.",
    "work.released": "The active work claim was released.",
    "work.submitted":
      "Outcome submitted for review; the worker can claim more work.",
    "review.claimed": "This review is reserved for the reviewer.",
    "review.released": "The review is available for another eligible reviewer.",
    "branch.submitted":
      "The submitted commit is available for subscribed reviewers.",
  };
  if (descriptions[notification.type]) return descriptions[notification.type];
  if (payload.decision)
    return payload.decision === "approved"
      ? "The submitted revision was approved."
      : "Changes were requested from the original worker.";
  const changes = Object.keys(payload.changes || {})
    .map((key) => key.replace("_id", ""))
    .join(", ");
  return changes
    ? changes + " changed"
    : "Open the thread to inspect this activity.";
}
const sizeLabel = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const online = (a) =>
  a.heartbeat_at && Date.now() - Date.parse(a.heartbeat_at) < 30000;
const agentState = (a) => (!online(a) ? "offline" : a.state);
function Avatar({ user, size = "normal" }) {
  return (
    <span
      className={`avatar ${user?.kind === "agent" ? "agent-avatar" : ""} ${size}`}
      title={user?.name}
    >
      {user?.kind === "agent" ? (
        <Bot size={size === "small" ? 13 : 18} />
      ) : (
        user?.name
          ?.split(" ")
          .map((n) => n[0])
          .slice(0, 2)
          .join("")
          .toUpperCase() || "?"
      )}
    </span>
  );
}
function RichText({ children }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          img: ({ alt }) => (
            <span className="muted">
              [Image: {alt || "external image"} — use attachments for previews]
            </span>
          ),
        }}
      >
        {children || ""}
      </Markdown>
    </div>
  );
}
function Empty({ icon = MessageSquare, title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon icon={icon} size={28} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  initialFocus = "input,textarea,select,button",
  backdropClassName = "",
}) {
  const ref = useRef();
  useEffect(() => {
    const previous = document.activeElement;
    const el = ref.current;
    el.querySelector(initialFocus)?.focus();
    const key = (e) => {
      if (!el.contains(e.target)) return;
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const nodes = [
          ...el.querySelectorAll("button,input,textarea,select,a[href]"),
        ].filter((n) => !n.disabled);
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className={`modal-backdrop ${backdropClassName}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Login({ onLogin }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <div className="login-art">
        <div className="brand">
          <span className="brand-icon">
            <i />
            <i />
            <i />
          </span>
          threadwork<span className="brand-dot">®</span>
        </div>
        <div className="login-statement">
          <span className="eyebrow">A SHARED PLACE TO MAKE PROGRESS</span>
          <h1>
            Good work starts
            <br />
            with a conversation.
          </h1>
          <p>
            Bring the discussion, the decisions, and your AI teammates together.
          </p>
          <div className="login-illustration">
            <span>
              <MessageSquare /> Conversation
            </span>
            <ArrowRight />
            <span>
              <Columns3 /> Progress
            </span>
          </div>
        </div>
        <div className="login-footer">People and agents. On the same page.</div>
      </div>
      <div className="login-form">
        <div className="login-inner">
          <span className="eyebrow">YOUR WORKSPACE, CONNECTED</span>
          <h2>Welcome back.</h2>
          <p className="muted">Sign in to your local workspace.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              const f = new FormData(e.currentTarget);
              try {
                await api("/login", {
                  method: "POST",
                  body: Object.fromEntries(f),
                });
                onLogin();
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Username
              <input
                name="username"
                autoComplete="username"
                required
                autoFocus
                placeholder="Your username"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="Your password"
              />
            </label>
            {error && (
              <div className="error-inline" role="alert">
                {error}
              </div>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <>
                  Sign in <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <p className="login-help">
            New here? Ask your workspace admin for an account.
          </p>
        </div>
      </div>
    </main>
  );
}
function reminderInterval(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
    return "unknown interval";
  for (const [unit, size] of [
    ["week", 604800000],
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000],
    ["second", 1000],
  ]) {
    if (milliseconds % size === 0) {
      const count = milliseconds / size;
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `${milliseconds} milliseconds`;
}

function GlobalSearch({ onClose, onChoose, refreshKey, query, setQuery }) {
  const [results, setResults] = useState([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const fetching = useRef(false);
  const normalized = query.trim();
  useEffect(() => {
    const version = ++generation.current;
    let controller = new AbortController();
    setResults([]);
    setMore(false);
    setError("");
    setLoading(!!normalized);
    fetching.current = !!normalized;
    const timer = setTimeout(async () => {
      if (!normalized) return;
      try {
        const response = await api(
          "/search?" + new URLSearchParams({ q: normalized }),
          { signal: controller.signal },
        );
        if (version !== generation.current) return;
        setResults(response.results);
        setMore(response.has_more);
      } catch (e) {
        if (version === generation.current && e.name !== "AbortError")
          setError(e.message);
      } finally {
        if (version === generation.current) {
          setLoading(false);
          fetching.current = false;
        }
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
      generation.current++;
    };
  }, [normalized, refreshKey]);
  async function loadMore() {
    if (fetching.current) return;
    fetching.current = true;
    const version = generation.current;
    setLoading(true);
    setError("");
    try {
      const response = await api(
        "/search?" +
          new URLSearchParams({ q: normalized, offset: results.length }),
      );
      if (version !== generation.current) return;
      setResults((previous) => [...previous, ...response.results]);
      setMore(response.has_more);
    } catch (e) {
      if (version === generation.current) setError(e.message);
    } finally {
      if (version === generation.current) {
        setLoading(false);
        fetching.current = false;
      }
    }
  }
  return (
    <Dialog
      initialFocus='input[aria-label="Search everything"]'
      title="Search everywhere"
      backdropClassName="search-backdrop"
      subtitle="Channels, conversations, replies, people, attachments, and your reminders."
      onClose={onClose}
      wide
    >
      <div className="global-search-content">
        <label className="global-search-input">
          <Search size={19} />
          <input
            aria-label="Search everything"
            placeholder="Search everything…"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                document.querySelector(".global-search-result")?.focus();
              }
            }}
          />
        </label>
        <p className="global-search-summary" role="status">
          {loading
            ? "Searching…"
            : !normalized
              ? "Search across every channel, including archived channels."
              : results.length
                ? `${results.length} result${results.length === 1 ? "" : "s"}${more ? " · more available" : ""}`
                : "No results found."}
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div
          className="global-search-results"
          onKeyDown={(e) => {
            if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
            const buttons = [
              ...e.currentTarget.querySelectorAll(".global-search-result"),
            ];
            const index = buttons.indexOf(document.activeElement);
            if (index < 0) return;
            e.preventDefault();
            buttons[
              (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length
            ]?.focus();
          }}
        >
          {results.map((r) => (
            <button
              className="global-search-result"
              key={`${r.kind}-${r.id}`}
              onClick={() => onChoose(r)}
            >
              <span className="global-search-result-meta">
                {r.label}
                {r.channel_name ? ` · #${r.channel_name}` : ""}
              </span>
              <strong>
                {r.kind === "channel" ? "# " : ""}
                {r.title}
              </strong>
              {r.snippet && (
                <span className="global-search-snippet">{r.snippet}</span>
              )}
            </button>
          ))}
        </div>
        {more && (
          <button
            className="button secondary global-search-more"
            disabled={loading}
            onClick={loadMore}
          >
            Load more results
          </button>
        )}
        <p className="global-search-footnote">
          Search matches text and attachment filenames. File contents are
          excluded. Reminders are private to you; runtime logs require admin
          access.
        </p>
      </div>
    </Dialog>
  );
}

function App() {
  const entry = useRef(readNavigation()).current;
  const [data, setData] = useState(null),
    [auth, setAuth] = useState("loading"),
    [page, setPage] = useState(entry.page),
    [channelId, setChannelId] = useState(entry.channelId),
    [view, setView] = useState(() =>
      new URLSearchParams(location.search).has("view")
        ? entry.view
        : localStorage.getItem("tw_view") === "board"
          ? "board"
          : "threads",
    ),
    [threads, setThreads] = useState([]),
    [loadedChannelId, setLoadedChannelId] = useState(undefined),
    [loading, setLoading] = useState(false),
    [query, setQuery] = useState(entry.query),
    [search, setSearch] = useState(entry.query),
    [assignee, setAssignee] = useState(entry.assignee),
    [statusFilter, setStatusFilter] = useState(entry.statusFilter),
    [selectedId, setSelectedId] = useState(() => entry.threadId),
    [searchOpen, setSearchOpen] = useState(false),
    [globalSearchQuery, setGlobalSearchQuery] = useState(""),
    [detailVersion, setDetailVersion] = useState(0),
    [detailContext, setDetailContext] = useState({
      tab: entry.tab,
      branchId: entry.branchId,
      replyId: entry.replyId,
    }),
    [searchTarget, setSearchTarget] = useState(null),
    [detail, setDetail] = useState(null),
    [detailError, setDetailError] = useState(""),
    [modal, setModal] = useState(null),
    [toast, setToast] = useState(null),
    [mobile, setMobile] = useState(false),
    [connected, setConnected] = useState(true),
    [inbox, setInbox] = useState([]),
    [schedules, setSchedules] = useState([]),
    [reminderOpen, setReminderOpen] = useState(false),
    [refreshKey, setRefreshKey] = useState(0);
  const originFocus = useRef(null);
  const navigation = useRef(null);
  const applyNavigation = useRef(null);
  const closeNavigation = useRef(null);
  const returnContext = useRef(history.state?.twOrigin || null);
  navigation.current = {
    globalSearch: searchOpen,
    globalSearchQuery,
    page,
    channelId,
    view,
    query,
    assignee,
    statusFilter,
    threadId: selectedId,
    ...detailContext,
    scrollY: window.scrollY,
  };
  applyNavigation.current = (next, origin = null) => {
    const oldId = navigation.current.threadId;
    returnContext.current = origin;
    setSearchOpen(!!next.globalSearch);
    setGlobalSearchQuery(next.globalSearchQuery || "");
    setPage(next.page);
    setChannelId(next.channelId);
    setView(next.view);
    setQuery(next.query);
    setSearch(next.query);
    setAssignee(next.assignee);
    setStatusFilter(next.statusFilter);
    setSelectedId(next.threadId);
    setDetailContext({
      tab: next.tab || "discussion",
      branchId: next.branchId,
      replyId: next.replyId,
    });
    setDetailVersion((v) => v + 1);
    setDetailError("");
    if (oldId !== next.threadId) setDetail(null);
    if (!next.threadId)
      requestAnimationFrame(() => {
        if (next.globalSearch) {
          document.querySelector(".global-search-input input")?.focus();
          return;
        }
        window.scrollTo(0, next.scrollY || 0);
        if (
          originFocus.current?.isConnected &&
          !originFocus.current.closest("[hidden]")
        )
          originFocus.current.focus({ preventScroll: true });
        else
          document
            .querySelector(".origin-view button, .topbar button")
            ?.focus({ preventScroll: true });
      });
  };
  useEffect(() => {
    if (!history.state?.tw)
      history.replaceState(
        { tw: navigation.current },
        "",
        navigationUrl(navigation.current),
      );
    const pop = () =>
      applyNavigation.current(
        history.state?.tw || readNavigation(),
        history.state?.twOrigin || null,
      );
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  function closeThread() {
    if (!navigation.current.threadId) return;
    if (returnContext.current) history.back();
    else {
      const next = {
        ...navigation.current,
        page: "work",
        channelId: detail?.channel_id || channelId,
        threadId: null,
        replyId: null,
        tab: "discussion",
        branchId: null,
        query: "",
        assignee: "",
        statusFilter: "",
      };
      history.replaceState({ tw: next }, "", navigationUrl(next));
      applyNavigation.current(next);
    }
  }
  closeNavigation.current = closeThread;
  async function copyConversation(threadId, replyId) {
    const link = conversationUrl(
      data.public_origin || location.origin,
      threadId,
      replyId,
    );
    try {
      await navigator.clipboard.writeText(link);
      notify("Link copied");
    } catch {
      setModal({ type: "copy-link", link });
    }
  }
  const toastTimer = useRef();
  const searchNavigation = useRef(0);
  const readingPositions = useRef(new Map());
  const channelPositions = useRef(new Map());
  const composerDrafts = useRef(new Map());
  useEffect(() => {
    readingPositions.current.clear();
    channelPositions.current.clear();
    composerDrafts.current.clear();
  }, [data?.user.id]);
  const sessionVersion = useRef(0);
  const notify = useCallback((message, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({ message, error });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const load = useCallback(async () => {
    const version = sessionVersion.current;
    try {
      const b = await api("/bootstrap");
      if (version !== sessionVersion.current) return;
      setData(b);
      setAuth("signedIn");
    } catch (e) {
      if (version !== sessionVersion.current) return;
      if (e.status === 401) {
        sessionVersion.current += 1;
        setInbox([]);
        setSchedules([]);
        setAuth("signedOut");
        setData(null);
      } else notify(e.message, true);
    }
  }, [notify]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(query), 220);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (auth !== "signedIn") return;
    let stale = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (channelId) params.set("channel", channelId);
    if (search) params.set("q", search);
    if (assignee) params.set("assignee", assignee);
    params.set("limit", "500");
    const loadThreads = async () => {
      const result = [];
      while (!stale) {
        params.set("offset", String(result.length));
        const batch = await api("/threads?" + params);
        result.push(...batch);
        if (batch.length < 500) break;
      }
      return result;
    };
    loadThreads()
      .then((t) => {
        if (!stale) {
          setThreads(t);
          setLoadedChannelId(channelId);
        }
      })
      .catch((e) => notify(e.message, true))
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [auth, channelId, search, assignee, refreshKey]);
  useEffect(() => {
    if (!selectedId || auth !== "signedIn") {
      setDetail(null);
      return;
    }
    let stale = false;
    setDetailError("");
    api(`/threads/${selectedId}`)
      .then((d) => {
        if (!stale) setDetail(d);
      })
      .catch(() => {
        if (!stale) {
          setDetail(null);
          setDetailError(
            "This conversation is unavailable. It may have been removed, or you may not have access.",
          );
        }
      });
    return () => {
      stale = true;
    };
  }, [selectedId, refreshKey, auth]);
  useEffect(() => {
    if (page !== "inbox" || auth !== "signedIn") return;
    let stale = false;
    const version = sessionVersion.current;
    Promise.all([api("/inbox"), api("/notification-schedules")])
      .then(([items, scheduled]) => {
        if (stale || version !== sessionVersion.current) return;
        setInbox(items);
        setSchedules(scheduled);
      })
      .catch((e) => {
        if (!stale && version === sessionVersion.current)
          notify(e.message, true);
      });
    return () => {
      stale = true;
    };
  }, [page, auth, refreshKey, data?.user.id]);
  useEffect(() => {
    if (auth !== "signedIn") return;
    const es = new EventSource("/api/events");
    let timer;
    es.addEventListener("refresh", () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 120);
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const fallback = setInterval(refresh, 20000);
    return () => {
      es.close();
      clearTimeout(timer);
      clearInterval(fallback);
    };
  }, [auth]);
  useEffect(() => {
    if (!searchTarget || searchOpen) return;
    const target = document.getElementById(searchTarget);
    if (target) {
      target.scrollIntoView({ block: "center" });
      target.classList.add("search-target");
      const timer = setTimeout(() => {
        target.classList.remove("search-target");
        setSearchTarget(null);
      }, 3000);
      return () => {
        clearTimeout(timer);
        target.classList.remove("search-target");
      };
    }
  }, [searchTarget, searchOpen, detail, page, inbox, schedules]);
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape" && !e.target.closest?.(".dialog")) {
        if (!document.querySelector(".modal-backdrop"))
          closeNavigation.current?.();
        setMobile(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        const input = document.querySelector(".global-search-input input");
        if (input) input.focus();
        else setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  async function act(path, method, body) {
    try {
      const r = await api(path, { method, body });
      refresh();
      return r;
    } catch (e) {
      notify(e.message, true);
      throw e;
    }
  }
  function go(p, id = null) {
    const current = navigation.current;
    history.replaceState(
      { ...history.state, tw: current },
      "",
      navigationUrl(current),
    );
    const next = {
      ...current,
      page: p,
      channelId: id,
      threadId: null,
      replyId: null,
      branchId: null,
      globalSearch: false,
      tab: "discussion",
      query: "",
      statusFilter: "",
    };
    history.pushState({ tw: next }, "", navigationUrl(next));
    applyNavigation.current(next);
    setMobile(false);
  }
  function startThread() {
    if (view === "board") setModal({ type: "thread" });
    else document.getElementById("new-thread-message")?.focus();
  }
  function openThread(id, tab = "discussion", branchId = null, replyId = null) {
    const current = navigation.current;
    if (
      current.threadId === id &&
      (current.replyId || null) === replyId &&
      (current.branchId || null) === branchId &&
      current.tab === tab &&
      !current.globalSearch
    ) {
      setDetailVersion((v) => v + 1);
      return;
    }
    originFocus.current = document.activeElement;
    history.replaceState(
      { ...history.state, tw: current },
      "",
      navigationUrl(current),
    );
    const origin =
      current.threadId && !current.globalSearch
        ? returnContext.current
        : current;
    const next = {
      ...current,
      globalSearch: false,
      threadId: id,
      replyId,
      branchId,
      tab,
    };
    history.pushState({ tw: next, twOrigin: origin }, "", navigationUrl(next));
    applyNavigation.current(next, origin);
  }
  const changeStatus = async (id, status) => {
    try {
      await act(`/threads/${id}`, "PATCH", { status_id: Number(status) });
    } catch {}
  };
  if (auth === "signedOut") return <Login onLogin={load} />;
  if (!data)
    return (
      <div className="boot">
        <LoaderCircle className="spin" />
        <p>Opening your workspace…</p>
      </div>
    );
  const channel = data.channels.find((c) => c.id === channelId);
  const shown = threads.filter(
    (t) => !statusFilter || t.status_id === Number(statusFilter),
  );
  const activeAgents = data.agents.filter((a) => online(a)).length;
  return (
    <div className="app-shell">
      {mobile && (
        <div className="mobile-shade" onClick={() => setMobile(false)} />
      )}
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go("work");
          }}
        >
          <span className="brand-icon">
            <i />
            <i />
            <i />
          </span>
          threadwork<span className="brand-dot">®</span>
        </a>
        <div className="workspace-name">
          <span className="workspace-mark">W</span>
          <div>
            <strong>Our workspace</strong>
            <span>
              <i className="live-dot" /> Local network
            </span>
          </div>
          <span className="workspace-tag">V1</span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          <button
            className={page === "work" && !channelId ? "active" : ""}
            onClick={() => go("work")}
          >
            <Icon icon={Compass} />
            All work
            <span className="nav-count">
              {data.channels.reduce((s, c) => s + c.thread_count, 0)}
            </span>
          </button>
          <button
            className={page === "inbox" ? "active" : ""}
            onClick={() => go("inbox")}
          >
            <Icon icon={Inbox} />
            Inbox
            {data.unread > 0 && (
              <span className="unread-count">{data.unread}</span>
            )}
          </button>
          <button
            className={page === "team" ? "active" : ""}
            onClick={() => go("team")}
          >
            <Icon icon={Users} />
            People & agents
            <span className="nav-count">{data.users.length}</span>
          </button>
          <button
            className={page === "queue" ? "active" : ""}
            onClick={() => go("queue")}
          >
            <Icon icon={ClipboardList} />
            Work queue
          </button>
          <button
            className={page === "repositories" ? "active" : ""}
            onClick={() => go("repositories")}
          >
            <Icon icon={FileText} />
            Repositories
          </button>
        </nav>
        <div className="nav-label channel-label">
          CHANNELS
          <button
            aria-label="Create channel"
            onClick={() => setModal({ type: "channel" })}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav className="channel-nav">
          {data.channels
            .filter((c) => !c.archived)
            .map((c) => (
              <button
                key={c.id}
                aria-label={c.name}
                className={
                  page === "work" && channelId === c.id ? "active" : ""
                }
                onClick={() => go("work", c.id)}
              >
                <Hash size={17} />
                <span>{c.name}</span>
                {!!c.subscribed && (
                  <span className="subscription-dot" title="Subscribed" />
                )}
              </button>
            ))}
          {data.channels.some((c) => c.archived) && (
            <details>
              <summary>Archived channels</summary>
              {data.channels
                .filter((c) => c.archived)
                .map((c) => (
                  <button key={c.id} onClick={() => go("work", c.id)}>
                    <Archive size={16} />
                    {c.name}
                  </button>
                ))}
            </details>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="agent-presence">
            <span className="presence-symbol">
              <Bot size={17} />
            </span>
            <div>
              <strong>
                {activeAgents} agent{activeAgents === 1 ? "" : "s"} connected
              </strong>
              <span>Working alongside your team</span>
            </div>
          </div>
          {data.user.admin && (
            <button
              className={`settings-link ${page === "settings" ? "active" : ""}`}
              onClick={() => go("settings")}
            >
              <Settings size={17} />
              Workspace settings
            </button>
          )}
          <div className="profile">
            <Avatar user={data.user} />
            <div>
              <strong>{data.user.name}</strong>
              <span>{data.user.admin ? "Workspace admin" : "Team member"}</span>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                sessionVersion.current += 1;
                try {
                  await api("/logout", { method: "POST" });
                  setSelectedId(null);
                  setSearchOpen(false);
                  setSearchTarget(null);
                  setInbox([]);
                  setSchedules([]);
                  setData(null);
                  setAuth("signedOut");
                } catch (error) {
                  notify(error.message, true);
                }
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main
        className={`main ${selectedId ? "conversation-main" : page === "work" && channel && view === "threads" ? "channel-workspace" : ""}`}
      >
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-toggle"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {page === "work"
                ? channel
                  ? "# " + channel.name
                  : "All work"
                : page === "inbox"
                  ? "Inbox"
                  : page === "team"
                    ? "People & agents"
                    : page === "queue"
                      ? "Work queue"
                      : page === "repositories"
                        ? "Repositories"
                        : "Settings"}
            </strong>
          </div>
          <div className="topbar-right">
            <button
              className="global-search-trigger"
              onClick={() => setSearchOpen(true)}
              aria-label="Search everywhere"
              title="Search everywhere (Ctrl/⌘ K)"
            >
              <Search size={16} />
              <span>Search everything…</span>
              <kbd>⌘ K</kbd>
            </button>
            <span className={`connection ${connected ? "" : "disconnected"}`}>
              <Wifi size={13} />
              {connected ? "Live" : "Reconnecting"}
            </span>
            <button
              className="icon-button notification-button"
              onClick={() => go("inbox")}
              aria-label="Open inbox"
            >
              <Bell size={18} />
              {data.unread > 0 && <i />}
            </button>
            <Avatar user={data.user} size="small" />
          </div>
        </header>
        <div className="origin-view" hidden={!!selectedId}>
          {page === "work" && (
            <>
              <section className="page-heading">
                <div>
                  <div className="eyebrow">CONVERSATIONS INTO PROGRESS</div>
                  <h1>
                    {channel ? (
                      <>
                        <span className="heading-hash">#</span>
                        {channel.name}
                        {!!channel.archived && (
                          <span className="pill">Archived</span>
                        )}
                      </>
                    ) : (
                      "All work"
                    )}
                    <span className="heading-count">{threads.length}</span>
                  </h1>
                  <p>
                    {channel?.description ||
                      "Every conversation has a place. Every idea has a next step."}
                  </p>
                </div>
                <div className="heading-actions">
                  {channel && (
                    <>
                      <button
                        className={`button subtle ${channel.subscribed ? "subscribed" : ""}`}
                        onClick={() =>
                          act(`/channels/${channel.id}/subscription`, "PUT", {
                            subscribed: !channel.subscribed,
                          }).catch(() => {})
                        }
                      >
                        {channel.subscribed ? (
                          <Check size={16} />
                        ) : (
                          <Bell size={16} />
                        )}
                        <span>
                          {channel.subscribed ? "Subscribed" : "Subscribe"}
                        </span>
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Edit channel"
                        onClick={() => setModal({ type: "channel", channel })}
                      >
                        <MoreHorizontal size={20} />
                      </button>
                    </>
                  )}
                  <button
                    className="button primary"
                    disabled={!!channel?.archived}
                    onClick={startThread}
                  >
                    <Plus size={17} />
                    New thread
                  </button>
                </div>
              </section>
              <section className="work-toolbar">
                <div
                  className="view-switch"
                  role="group"
                  aria-label="Work view"
                >
                  <button
                    className={view === "threads" ? "selected" : ""}
                    aria-pressed={view === "threads"}
                    onClick={() => {
                      setView("threads");
                      localStorage.setItem("tw_view", "threads");
                    }}
                  >
                    <MessageSquare size={16} />
                    Threads
                  </button>
                  <button
                    className={view === "board" ? "selected" : ""}
                    aria-pressed={view === "board"}
                    onClick={() => {
                      setView("board");
                      localStorage.setItem("tw_view", "board");
                    }}
                  >
                    <Columns3 size={16} />
                    Board
                  </button>
                </div>
                <div className="toolbar-controls">
                  <label className="search">
                    <Search size={16} />
                    <input
                      id="conversation-search"
                      aria-label="Filter conversations"
                      placeholder="Search conversations…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <label className="filter-select">
                    <SlidersHorizontal size={15} />
                    <select
                      aria-label="Filter assignee"
                      value={assignee}
                      onChange={(e) => setAssignee(e.target.value)}
                    >
                      <option value="">Everyone</option>
                      {data.users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {view === "threads" && (
                    <select
                      aria-label="Filter status"
                      className="status-filter"
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                    >
                      <option value="">All statuses</option>
                      {data.statuses.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </section>
              {view === "threads" && !channel && (
                <ReplyComposer
                  creation
                  key={channelId || "all"}
                  data={data}
                  channelId={channelId}
                  users={data.users}
                  act={act}
                  notify={notify}
                  afterPost={() => {
                    setQuery("");
                    setSearch("");
                    setAssignee("");
                    setStatusFilter("");
                    notify("Message sent");
                  }}
                  textareaId="new-thread-message"
                  drafts={composerDrafts.current}
                  draftKey="all-work"
                />
              )}
              {channel && view === "threads" ? (
                <ChannelStream
                  key={channel.id}
                  channel={channel}
                  threads={shown}
                  loading={loading || loadedChannelId !== channelId}
                  data={data}
                  act={act}
                  notify={notify}
                  openThread={openThread}
                  positions={channelPositions.current}
                  drafts={composerDrafts.current}
                  afterPost={() => {
                    setQuery("");
                    setSearch("");
                    setAssignee("");
                    setStatusFilter("");
                    notify("Message sent");
                  }}
                />
              ) : (
                <>
                  <div className="work-meta">
                    <span>
                      {view === "threads"
                        ? "Conversations, in the order they began"
                        : "One conversation. A clear path forward."}
                    </span>
                    <span>
                      {loading ? (
                        <>
                          <LoaderCircle size={12} className="spin" />
                          Updating
                        </>
                      ) : (
                        <>
                          <span className="live-dot" />{" "}
                          {view === "threads" ? "Newest first" : "Live board"}
                        </>
                      )}
                    </span>
                  </div>
                  {!shown.length ? (
                    <Empty
                      title={
                        search
                          ? "No matching conversations"
                          : "Make room for your next idea."
                      }
                      icon={search ? Search : MessageSquare}
                      action={
                        !search && (
                          <button
                            className="button primary"
                            disabled={!!channel?.archived}
                            onClick={startThread}
                          >
                            <Plus size={16} />
                            Start a conversation
                          </button>
                        )
                      }
                    >
                      {search
                        ? "Try another search or adjust your filters."
                        : "Start a thread, bring in your teammates, and move the work forward together."}
                    </Empty>
                  ) : view === "threads" ? (
                    <section className="thread-list">
                      <div className="thread-list-head">
                        <span>CONVERSATION</span>
                        <span>STATUS</span>
                        <span>ASSIGNEE</span>
                        <span>STARTED</span>
                      </div>
                      {shown.map((t) => (
                        <button
                          className="thread-row"
                          key={t.id}
                          onClick={() => openThread(t.id)}
                        >
                          <div className="thread-main">
                            <span className="thread-symbol">
                              <MessageSquare size={19} />
                            </span>
                            <div>
                              <div className="thread-title">{t.title}</div>
                              <div className="thread-excerpt">
                                <span>#{t.channel_name}</span>
                                <span className="meta-dot">·</span>
                                <span>
                                  {t.body
                                    ?.replace(/[#*`>]/g, "")
                                    .slice(0, 90) ||
                                    `Started by ${t.author_name}`}
                                </span>
                                {t.reply_count > 0 && (
                                  <>
                                    <span className="meta-dot">·</span>
                                    <span className="reply-count">
                                      <MessageSquare size={12} />
                                      {t.reply_count}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                          <span className="status-pill">
                            <i style={{ background: t.status_color }} />
                            {t.status_name}
                          </span>
                          <div className="row-assignee">
                            {t.assignee_id ? (
                              <>
                                <Avatar
                                  user={data.users.find(
                                    (u) => u.id === t.assignee_id,
                                  )}
                                  size="small"
                                />
                                <span>{t.assignee_name}</span>
                              </>
                            ) : (
                              <span className="unassigned">Unassigned</span>
                            )}
                          </div>
                          <span className="thread-date">
                            {date(t.created_at)}
                            <ChevronRight size={15} />
                          </span>
                        </button>
                      ))}
                    </section>
                  ) : (
                    <section className="board">
                      {data.statuses.map((s) => (
                        <div
                          className="board-column"
                          key={s.id}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const id = Number(
                              e.dataTransfer.getData("text/thread-id"),
                            );
                            if (id) changeStatus(id, s.id);
                          }}
                        >
                          <header>
                            <span>
                              <i style={{ background: s.color }} />
                              {s.name}
                              <small>
                                {
                                  shown.filter((t) => t.status_id === s.id)
                                    .length
                                }
                              </small>
                            </span>
                            <button
                              className="icon-button"
                              aria-label={`New thread in ${s.name}`}
                              onClick={() =>
                                setModal({ type: "thread", status: s.id })
                              }
                            >
                              <Plus size={16} />
                            </button>
                          </header>
                          <div className="board-cards">
                            {shown
                              .filter((t) => t.status_id === s.id)
                              .map((t) => (
                                <article
                                  className="board-card"
                                  key={t.id}
                                  draggable
                                  onDragStart={(e) =>
                                    e.dataTransfer.setData(
                                      "text/thread-id",
                                      t.id,
                                    )
                                  }
                                >
                                  <button
                                    className="card-content"
                                    onClick={() => openThread(t.id)}
                                  >
                                    <div className="card-tag">
                                      <Hash size={12} />
                                      {t.channel_name}
                                      <span>TW-{t.id}</span>
                                    </div>
                                    <h3>{t.title}</h3>
                                    {t.body && (
                                      <p>
                                        {t.body
                                          .replace(/[#*`>]/g, "")
                                          .slice(0, 110)}
                                      </p>
                                    )}
                                  </button>
                                  <footer>
                                    <span>
                                      {t.reply_count > 0 ? (
                                        <>
                                          <MessageSquare size={13} />
                                          {t.reply_count}
                                        </>
                                      ) : (
                                        date(t.created_at)
                                      )}
                                    </span>
                                    <div>
                                      <select
                                        aria-label={`Status of ${t.title}`}
                                        value={t.status_id}
                                        onChange={(e) =>
                                          changeStatus(t.id, e.target.value)
                                        }
                                      >
                                        {data.statuses.map((s) => (
                                          <option key={s.id} value={s.id}>
                                            {s.name}
                                          </option>
                                        ))}
                                      </select>
                                      {t.assignee_id && (
                                        <Avatar
                                          user={data.users.find(
                                            (u) => u.id === t.assignee_id,
                                          )}
                                          size="small"
                                        />
                                      )}
                                    </div>
                                  </footer>
                                </article>
                              ))}
                            {!shown.some((t) => t.status_id === s.id) && (
                              <div className="column-empty">
                                Drop a thread here
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </section>
                  )}
                  <footer className="page-footer">
                    <span>
                      <MessageSquare size={13} /> A thread in conversation. A
                      ticket on the board.
                    </span>
                    <span>
                      Shared by people & agents{" "}
                      <span className="footer-spark">✳</span>
                    </span>
                  </footer>
                </>
              )}
            </>
          )}
          {page === "inbox" && (
            <>
              <section className="page-heading">
                <div>
                  <div className="eyebrow">STAY IN THE LOOP</div>
                  <h1>
                    Your inbox
                    <span className="heading-count">{data.unread}</span>
                  </h1>
                  <p>Replies, mentions, and changes to the work you follow.</p>
                </div>
                <div className="heading-actions">
                  <button
                    className="button primary"
                    onClick={() => setReminderOpen(true)}
                  >
                    <Bell size={16} />
                    New reminder
                  </button>
                  <button
                    className="button"
                    onClick={() =>
                      act("/inbox/read", "POST", {}).catch(() => {})
                    }
                  >
                    <CheckCheck size={16} />
                    Mark all read
                  </button>
                </div>
              </section>
              {reminderOpen && (
                <ReminderComposer
                  Dialog={Dialog}
                  onClose={() => setReminderOpen(false)}
                  onCreate={(body) =>
                    act("/notification-schedules", "POST", body)
                  }
                  onCreated={(saved) => {
                    setReminderOpen(false);
                    notify(
                      `Reminder scheduled for ${reminderTimeLabel(saved.due_at)}`,
                    );
                  }}
                />
              )}
              {schedules.length > 0 && (
                <section
                  className="reminder-upcoming"
                  aria-label="Upcoming reminders"
                >
                  <h2>
                    Upcoming <span>{schedules.length}</span>
                  </h2>
                  {schedules.map((schedule) => (
                    <div
                      className="reminder-row"
                      id={`reminder-${schedule.id}`}
                      key={schedule.id}
                    >
                      <div>
                        <strong>{schedule.message}</strong>
                        <p>
                          {reminderTimeLabel(schedule.due_at)}
                          {schedule.interval_ms
                            ? ` · every ${reminderInterval(schedule.interval_ms)}`
                            : ""}
                        </p>
                      </div>
                      <button
                        className="button"
                        onClick={() =>
                          act(
                            `/notification-schedules/${schedule.id}`,
                            "DELETE",
                          ).catch(() => {})
                        }
                        aria-label={`Cancel reminder: ${schedule.message}`}
                      >
                        Cancel
                      </button>
                    </div>
                  ))}
                </section>
              )}
              <div className="inbox-list">
                {inbox.length ? (
                  inbox.map((n) => (
                    <button
                      className={`inbox-item ${!n.read_at ? "unread" : ""}`}
                      id={`notification-${n.id}`}
                      key={n.id}
                      onClick={async () => {
                        await act("/inbox/read", "POST", { ids: [n.id] }).catch(
                          () => {},
                        );
                        if (n.thread_id)
                          openThread(
                            n.thread_id,
                            "discussion",
                            null,
                            n.payload.reply_id,
                          );
                      }}
                    >
                      <Avatar
                        user={data.users.find((u) => u.id === n.actor_id)}
                      />
                      <div>
                        <div className="inbox-title">
                          <strong>{n.actor_name}</strong> {notificationVerb(n)}{" "}
                          <strong>
                            {n.payload.title ||
                              (n.thread_id
                                ? `TW-${n.thread_id}`
                                : "the workspace")}
                          </strong>
                        </div>
                        <p>
                          {n.type === "notification.scheduled"
                            ? n.payload.body
                            : notificationSummary(n)}
                        </p>
                        <span>
                          {n.channel_name
                            ? `#${n.channel_name}`
                            : n.type === "notification.scheduled"
                              ? "Private reminder"
                              : "Workspace activity"}{" "}
                          <span className="meta-dot">·</span>{" "}
                          {timeAgo(n.created_at)}
                        </span>
                      </div>
                      {!n.read_at && <i className="inbox-unread-dot" />}
                    </button>
                  ))
                ) : (
                  <Empty title="You're all caught up." icon={Inbox}>
                    Subscribe to a channel or join a conversation to receive
                    updates here.
                  </Empty>
                )}
              </div>
            </>
          )}
          {page === "team" && (
            <>
              <section className="page-heading">
                <div>
                  <div className="eyebrow">YOUR TEAM, TOGETHER</div>
                  <h1>
                    People & agents
                    <span className="heading-count">{data.users.length}</span>
                  </h1>
                  <p>Different perspectives. One shared workspace.</p>
                </div>
                {data.user.admin && (
                  <div className="heading-actions">
                    <button
                      className="button"
                      onClick={() => setModal({ type: "user" })}
                    >
                      <Plus size={16} />
                      Add person
                    </button>
                    <button
                      className="button primary"
                      onClick={() => setModal({ type: "agent" })}
                    >
                      <Bot size={16} />
                      Create agent
                    </button>
                  </div>
                )}
              </section>
              <div className="team-section">
                <div className="section-title">
                  <h2>AI teammates</h2>
                  <span>Persistent sessions. Independent voices.</span>
                </div>
                <div className="team-grid">
                  {data.agents.map((a) => (
                    <article
                      className="agent-card"
                      id={`person-${a.user_id}`}
                      key={a.user_id}
                    >
                      <div className="agent-card-top">
                        <Avatar user={{ name: a.name, kind: "agent" }} />
                        <span className={`state-badge ${agentState(a)}`}>
                          <i />
                          {agentState(a).replace("_", " ")}
                        </span>
                      </div>
                      <h3>
                        {a.name}
                        <span>@{a.username}</span>
                      </h3>
                      <p>{a.role}</p>
                      <div className="agent-card-footer">
                        <span>
                          <Terminal size={13} />
                          {a.session_id
                            ? "Persistent session"
                            : "Awaiting first session"}
                        </span>
                        {data.user.admin && (
                          <button
                            className="text-button"
                            onClick={() =>
                              setModal({ type: "agent-detail", id: a.user_id })
                            }
                          >
                            Manage <ArrowUpRight size={14} />
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                  <button
                    className="agent-card add-agent"
                    onClick={() =>
                      data.user.admin
                        ? setModal({ type: "agent" })
                        : notify("Ask your admin to create an agent.")
                    }
                  >
                    <span>
                      <Plus size={24} />
                    </span>
                    <h3>A new perspective</h3>
                    <p>
                      Give an agent a name, a role,
                      <br />
                      and a place on your team.
                    </p>
                  </button>
                </div>
                <div className="section-title people-title">
                  <h2>People</h2>
                  <span>
                    {data.users.filter((u) => u.kind === "human").length}{" "}
                    members
                  </span>
                </div>
                <div className="people-list">
                  {data.users
                    .filter((u) => u.kind === "human")
                    .map((u) => (
                      <div
                        className="person-row"
                        id={`person-${u.id}`}
                        key={u.id}
                      >
                        <Avatar user={u} />
                        <div>
                          <strong>
                            {u.name}
                            {u.id === data.user.id && <small>you</small>}
                          </strong>
                          <span>@{u.username}</span>
                        </div>
                        <span className="pill">
                          {u.admin ? "Admin" : "Member"}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </>
          )}
          {page === "queue" && (
            <WorkQueuePage
              key={data.user.id}
              api={api}
              data={data}
              refreshKey={refreshKey}
              openThread={openThread}
            />
          )}
          {page === "repositories" && (
            <RepositoriesPage
              key={data.user.id}
              api={api}
              data={data}
              refreshKey={refreshKey}
              notify={notify}
            />
          )}
          {page === "settings" && data.user.admin && (
            <SettingsPage
              data={data}
              act={act}
              setModal={setModal}
              notify={notify}
            />
          )}
        </div>
        {selectedId && (
          <section
            className="thread-detail conversation-workspace"
            aria-label="Conversation"
          >
            {detail ? (
              <ThreadDetail
                key={`${selectedId}:${detailVersion}`}
                thread={detail}
                initialTab={detailContext.tab}
                initialBranchId={detailContext.branchId}
                initialReplyId={detailContext.replyId}
                readingPositions={readingPositions.current}
                refreshKey={refreshKey}
                refresh={refresh}
                data={data}
                act={act}
                notify={notify}
                close={closeThread}
                backLabel={
                  returnContext.current
                    ? returnContext.current.globalSearch
                      ? "Back to search"
                      : `Back to ${page === "work" ? (channel ? "#" + channel.name : "All work") : page}`
                    : "Back to channel"
                }
                copyLink={(replyId) => copyConversation(selectedId, replyId)}
                drafts={composerDrafts.current}
                edit={() => setModal({ type: "thread", thread: detail })}
              />
            ) : (
              <div className="conversation-unavailable">
                <button
                  className="button"
                  aria-label="Close thread"
                  onClick={closeThread}
                >
                  <ArrowLeft size={16} /> Back to workspace
                </button>
                <h1 tabIndex={-1} ref={(el) => el?.focus()}>
                  {detailError
                    ? "Conversation unavailable"
                    : "Opening conversation…"}
                </h1>
                {detailError ? (
                  <p role="alert">{detailError}</p>
                ) : (
                  <LoaderCircle className="spin" />
                )}
              </div>
            )}
          </section>
        )}
      </main>
      {searchOpen && (
        <GlobalSearch
          query={globalSearchQuery}
          setQuery={setGlobalSearchQuery}
          key={data.user.id}
          refreshKey={refreshKey}
          onClose={() => setSearchOpen(false)}
          onChoose={(result) => {
            setSearchOpen(false);
            setSearchTarget(null);
            setModal(null);
            if (result.kind === "repository" || result.kind === "branch") {
              go("repositories");
            } else if (result.kind === "agent-log") {
              go("team");
              setModal({
                type: "agent-detail",
                id: result.agent_id,
                initialTab: "logs",
                instanceKey: ++searchNavigation.current,
              });
            } else if (result.thread_id) {
              setDetailVersion((version) => version + 1);
              openThread(result.thread_id, "discussion", null, result.reply_id);
            } else if (result.kind === "channel") go("work", result.channel_id);
            else if (result.kind === "person") {
              go("team");
              setSearchTarget(`person-${result.id}`);
            } else {
              go("inbox");
              setSearchTarget(`${result.kind}-${result.id}`);
            }
          }}
        />
      )}
      {modal?.type === "copy-link" && (
        <Dialog title="Copy link" onClose={() => setModal(null)}>
          <label>
            Link
            <input
              aria-label="Link to copy"
              readOnly
              value={modal.link}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <p>Copy this link to share the conversation.</p>
        </Dialog>
      )}
      {modal && modal.type !== "copy-link" && (
        <ModalRouter
          modal={modal}
          close={() => setModal(null)}
          setModal={setModal}
          data={data}
          channelId={channelId}
          act={act}
          notify={notify}
          openThread={openThread}
        />
      )}
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
          <span>{toast.message}</span>
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function SettingsPage({ data, act, setModal, notify }) {
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">MAKE IT YOUR OWN</div>
          <h1>Workspace settings</h1>
          <p>A few good defaults, shaped around your team.</p>
        </div>
      </section>
      <div className="settings-content">
        <section className="settings-section">
          <div>
            <h2>Board statuses</h2>
            <p>Shared across every channel and both views.</p>
          </div>
          <div className="status-settings">
            {data.statuses.map((s) => (
              <form
                key={s.id}
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  try {
                    await act(`/admin/statuses/${s.id}`, "PATCH", {
                      name: f.get("name"),
                      color: f.get("color"),
                      position: Number(f.get("position")),
                    });
                    notify("Status updated");
                  } catch {}
                }}
              >
                <input
                  type="color"
                  name="color"
                  defaultValue={s.color}
                  aria-label={`${s.name} color`}
                />
                <input
                  name="name"
                  defaultValue={s.name}
                  aria-label="Status name"
                  required
                  maxLength={40}
                />
                <input
                  type="number"
                  name="position"
                  min="0"
                  defaultValue={s.position}
                  aria-label="Status order"
                />
                <button
                  className="icon-button"
                  title="Save status"
                  aria-label={`Save ${s.name}`}
                >
                  <Check size={17} />
                </button>
              </form>
            ))}
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = e.currentTarget;
                try {
                  await act(
                    "/admin/statuses",
                    "POST",
                    Object.fromEntries(new FormData(f)),
                  );
                  f.reset();
                  notify("Status added");
                } catch {}
              }}
            >
              <input
                type="color"
                name="color"
                defaultValue="#94a3b8"
                aria-label="New status color"
              />
              <input
                name="name"
                placeholder="Add a status…"
                aria-label="New status name"
                required
                maxLength={40}
              />
              <button className="button" type="submit">
                <Plus size={16} />
                Add
              </button>
            </form>
          </div>
        </section>
        <section className="settings-section">
          <div>
            <h2>Workspace access</h2>
            <p>
              Everyone can see and participate in every channel. Accounts are
              created by admins.
            </p>
          </div>
          <button className="button" onClick={() => setModal({ type: "user" })}>
            <Users size={16} />
            Add person
          </button>
        </section>
        <section className="settings-section">
          <div>
            <h2>Agent workspaces</h2>
            <p>
              Each agent runs in its own worker, with one persistent Codex
              session. Configure credentials and subscriptions in People &
              agents.
            </p>
          </div>
          <button
            className="button"
            onClick={() => setModal({ type: "agent" })}
          >
            <Bot size={16} />
            Create agent
          </button>
        </section>
        <section className="architecture-note">
          <Terminal size={22} />
          <div>
            <strong>Your infrastructure. Your conversations.</strong>
            <p>
              Data and attachments live on your server. Agent workspaces and
              Codex credentials stay with their worker containers.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
function ChannelStream({
  channel,
  threads,
  loading,
  data,
  act,
  notify,
  openThread,
  positions,
  drafts,
  afterPost,
}) {
  const items = [...threads]
    .filter((t) => t.channel_id === channel.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const history = useRef(null),
    content = useRef(null),
    initialized = useRef(false),
    pending = useRef(null);
  const record = useRef(
    positions.get(channel.id) || {
      top: 0,
      pinned: true,
      anchorId: null,
      offset: 0,
    },
  );
  const [away, setAway] = useState(false),
    [sentVersion, setSentVersion] = useState(0);
  const ready = useRef(false);
  ready.current = !loading || items.length > 0;
  function capture() {
    const el = history.current;
    if (
      !initialized.current ||
      !ready.current ||
      !el ||
      !el.getClientRects().length
    )
      return;
    const top = el.getBoundingClientRect().top;
    const anchor = [...el.querySelectorAll(".channel-entry")].find(
      (n) => n.getBoundingClientRect().bottom > top,
    );
    record.current = {
      top: el.scrollTop,
      pinned: el.scrollHeight - el.clientHeight - el.scrollTop <= 32,
      anchorId: anchor?.id || null,
      offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    };
    positions.set(channel.id, { ...record.current });
    setAway(!record.current.pinned);
  }
  function restore() {
    const el = history.current;
    if (
      !initialized.current ||
      !ready.current ||
      !el ||
      !el.getClientRects().length
    )
      return;
    const saved = record.current;
    if (saved.pinned) el.scrollTop = el.scrollHeight;
    else {
      const anchor = saved.anchorId && document.getElementById(saved.anchorId);
      if (anchor && el.contains(anchor))
        el.scrollTop +=
          anchor.getBoundingClientRect().top -
          el.getBoundingClientRect().top -
          saved.offset;
      else el.scrollTop = saved.top;
    }
    capture();
  }
  useLayoutEffect(() => {
    if (!ready.current) return;
    initialized.current = true;
    if (pending.current && items.some((t) => t.id === pending.current)) {
      record.current.pinned = true;
      pending.current = null;
    }
    restore();
  }, [items.map((t) => t.id).join(","), loading, sentVersion]);
  useLayoutEffect(() => {
    const el = history.current,
      inner = content.current;
    const observer = new ResizeObserver(restore);
    observer.observe(el);
    observer.observe(inner);
    el.addEventListener("scroll", capture, { passive: true });
    inner.addEventListener("load", restore, true);
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", capture);
      inner.removeEventListener("load", restore, true);
    };
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = history.current?.closest(".channel-workspace");
    const resize = () =>
      root?.style.setProperty(
        "--channel-viewport-height",
        `${viewport?.height || window.innerHeight}px`,
      );
    resize();
    viewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      window.removeEventListener("resize", resize);
      root?.style.removeProperty("--channel-viewport-height");
    };
  }, []);
  return (
    <section className="channel-stream" aria-label={`Channel ${channel.name}`}>
      <div className="channel-stream-meta">
        Oldest to newest ·{" "}
        {loading ? "Updating…" : `${items.length} conversations`}
      </div>
      <div
        className="channel-history"
        ref={history}
        tabIndex={0}
        role="region"
        aria-label={`History in ${channel.name}`}
      >
        <div ref={content}>
          {!items.length && (
            <div className="channel-empty">
              <MessageSquare size={24} />
              <h2>
                {loading
                  ? "Loading conversations…"
                  : "No conversations to show"}
              </h2>
              <p>
                {loading
                  ? "Your draft stays below while history loads."
                  : "Start a conversation below, or adjust your filters."}
              </p>
            </div>
          )}
          {items.map((t) => (
            <article
              className="channel-entry"
              id={`channel-thread-${t.id}`}
              key={t.id}
            >
              <Avatar user={data.users.find((u) => u.id === t.created_by)} />
              <div className="channel-entry-content">
                <button
                  className="thread-row channel-thread-link"
                  onClick={() => openThread(t.id)}
                >
                  <span className="channel-entry-meta">
                    <strong>{t.author_name}</strong>
                    <time
                      dateTime={t.created_at}
                      title={fullDate(t.created_at)}
                    >
                      {timeAgo(t.created_at)}
                    </time>
                    <span className="status-pill">
                      <i style={{ background: t.status_color }} />
                      {t.status_name}
                    </span>
                  </span>
                  <span className="thread-title">{t.title}</span>
                </button>
                <div className="channel-message">
                  <RichText>
                    {t.body ||
                      "Open this conversation to view its attachments."}
                  </RichText>
                </div>
                <button
                  className="channel-reply-link"
                  onClick={() => openThread(t.id)}
                >
                  {t.reply_count
                    ? `${t.reply_count} ${t.reply_count === 1 ? "reply" : "replies"}`
                    : "Reply in thread"}
                  <ChevronRight size={13} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
      {away && (
        <button
          className="channel-jump"
          onClick={() => {
            record.current.pinned = true;
            restore();
            history.current.focus({ preventScroll: true });
          }}
        >
          Jump to latest
        </button>
      )}
      <div className="channel-compose-dock">
        {channel.archived ? (
          <p className="channel-archived">
            This channel is archived. Reopen it to start a conversation.
          </p>
        ) : (
          <ReplyComposer
            creation
            data={data}
            channelId={channel.id}
            users={data.users}
            act={act}
            notify={notify}
            drafts={drafts}
            draftKey={`channel-${channel.id}`}
            textareaId="new-thread-message"
            afterPost={(saved) => {
              pending.current = saved.id;
              setSentVersion((v) => v + 1);
              afterPost();
            }}
          />
        )}
      </div>
    </section>
  );
}

function ThreadDetail({
  thread: t,
  data,
  act,
  notify,
  close,
  edit,
  copyLink,
  backLabel,
  drafts,
  initialTab = "discussion",
  initialBranchId,
  initialReplyId,
  readingPositions,
  refreshKey,
  refresh,
}) {
  const [tab, setTab] = useState(initialTab),
    [editing, setEditing] = useState(null),
    [editBody, setEditBody] = useState("");
  const reading = useConversationScroll({
    threadId: t.id,
    tab,
    replyIds: t.replies.map((r) => r.id),
    targetReplyId: initialReplyId,
    positions: readingPositions,
  });
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.querySelector(".conversation-main");
    const resize = () =>
      root?.style.setProperty(
        "--conversation-height",
        `${viewport?.height || innerHeight}px`,
      );
    resize();
    viewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      window.removeEventListener("resize", resize);
      root?.style.removeProperty("--conversation-height");
    };
  }, []);
  const heading = useRef(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <div className="detail-top">
        <button
          className="button conversation-back"
          aria-label="Close thread"
          onClick={close}
        >
          <ArrowLeft size={16} />
          {backLabel}
        </button>
        <span>
          <Hash size={15} />
          {t.channel_name}
          <ChevronRight size={13} />
          TW-{t.id}
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="Copy conversation link"
            onClick={() => copyLink()}
          >
            <Copy size={17} />
          </button>
          <button
            className={`icon-button ${t.subscribed ? "subscribed" : ""}`}
            aria-label={
              t.subscribed ? "Unsubscribe from thread" : "Subscribe to thread"
            }
            title={t.subscribed ? "Following thread" : "Follow thread"}
            onClick={() =>
              act(`/threads/${t.id}/subscription`, "PUT", {
                subscribed: !t.subscribed,
              }).catch(() => {})
            }
          >
            {t.subscribed ? <Eye size={18} /> : <EyeOff size={18} />}
          </button>
          <button
            className="icon-button"
            aria-label="Edit thread"
            onClick={edit}
          >
            <Pencil size={17} />
          </button>
        </div>
      </div>
      <div className="detail-title">
        <h1 tabIndex={-1} ref={heading}>
          {t.title}
        </h1>
        <div className="detail-origin">
          <Avatar
            user={data.users.find((u) => u.id === t.created_by)}
            size="small"
          />
          <span>
            <strong>{t.author_name}</strong> started this{" "}
            {timeAgo(t.created_at)}
          </span>
        </div>
      </div>
      <div className="thread-properties">
        <label>
          Status
          <select
            value={t.status_id}
            onChange={(e) =>
              act(`/threads/${t.id}`, "PATCH", {
                status_id: Number(e.target.value),
              }).catch(() => {})
            }
            style={{ borderLeftColor: t.status_color }}
          >
            {data.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assignee
          <select
            value={t.assignee_id || ""}
            onChange={(e) =>
              act(`/threads/${t.id}`, "PATCH", {
                assignee_id: e.target.value ? Number(e.target.value) : null,
              }).catch(() => {})
            }
          >
            <option value="">Unassigned</option>
            {data.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.kind === "agent" ? " · AI" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        className="thread-scroll"
        ref={reading.viewport}
        tabIndex={-1}
        role="region"
        aria-label="Conversation reading area"
      >
        <div className="thread-scroll-content" ref={reading.content}>
          {initialReplyId &&
            !t.replies.some((r) => r.id === initialReplyId) && (
              <p className="missing-message" role="alert">
                That message is unavailable. Showing its conversation instead.
              </p>
            )}
          <ThreadWorkControl
            key={t.id}
            api={api}
            thread={t}
            data={data}
            refreshKey={refreshKey}
            onDone={refresh}
          />
          <div className="thread-description">
            <RichText>{t.body}</RichText>
            <Attachments files={t.attachments} />
            {!t.body && !t.attachments?.length && (
              <p className="muted">No description yet.</p>
            )}
          </div>
          <div
            className="discussion-tabs"
            role="group"
            aria-label="Conversation view"
          >
            <button
              className={tab === "discussion" ? "selected" : ""}
              aria-pressed={tab === "discussion"}
              onClick={() => setTab("discussion")}
            >
              Discussion <span>{t.replies.length}</span>
            </button>
            <button
              className={tab === "activity" ? "selected" : ""}
              aria-pressed={tab === "activity"}
              onClick={() => setTab("activity")}
            >
              Activity
            </button>
            <button
              className={tab === "branches" ? "selected" : ""}
              aria-pressed={tab === "branches"}
              onClick={() => setTab("branches")}
            >
              Branches
            </button>
          </div>
          {tab === "branches" ? (
            <ThreadBranches
              key={t.id}
              api={api}
              data={data}
              threadId={t.id}
              initialBranchId={initialBranchId}
              refreshKey={t.events?.length}
            />
          ) : tab === "discussion" ? (
            <div className="replies">
              {t.replies.map((r) => (
                <article className="reply" id={`reply-${r.id}`} key={r.id}>
                  <Avatar user={data.users.find((u) => u.id === r.author_id)} />
                  <div className="reply-content">
                    <header>
                      <strong>{r.author_name}</strong>
                      {r.author_kind === "agent" && (
                        <span className="ai-label">AI</span>
                      )}
                      <time title={fullDate(r.created_at)}>
                        {timeAgo(r.created_at)}
                        {r.edited_at ? " · edited" : ""}
                      </time>
                      <button
                        className="icon-button"
                        aria-label={`Copy link to reply ${r.id}`}
                        onClick={() => copyLink(r.id)}
                      >
                        <Copy size={13} />
                      </button>
                      {(r.author_id === data.user.id || data.user.admin) && (
                        <button
                          className="icon-button"
                          aria-label={`Edit reply by ${r.author_name}`}
                          onClick={() => {
                            setEditing(r.id);
                            setEditBody(r.body);
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                    </header>
                    {editing === r.id ? (
                      <form
                        className="reply-edit"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          try {
                            await act(`/replies/${r.id}`, "PATCH", {
                              body: editBody,
                            });
                            setEditing(null);
                          } catch {}
                        }}
                      >
                        <textarea
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                        />
                        <div>
                          <button
                            type="button"
                            className="button"
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </button>
                          <button className="button primary">Save</button>
                        </div>
                      </form>
                    ) : (
                      <RichText>{r.body}</RichText>
                    )}
                    <Attachments files={r.attachments} />
                  </div>
                </article>
              ))}
              {!t.replies.length && (
                <div className="discussion-empty">
                  <MessageSquare size={20} />
                  <p>
                    There’s room for your perspective.
                    <br />
                    <span>Reply, or mention a teammate to bring them in.</span>
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="activity-list">
              {t.activity.map((e) => (
                <div className="activity-item" key={e.id}>
                  <span className="activity-dot" />
                  <div>
                    <strong>{e.actor_name}</strong>{" "}
                    {e.type === "thread.created"
                      ? "started this thread"
                      : e.type === "reply.created"
                        ? "posted a reply"
                        : e.type === "reply.edited"
                          ? "edited a reply"
                          : "updated " +
                            Object.keys(e.payload.changes || {})
                              .map((k) => k.replace("_id", ""))
                              .join(", ")}
                    <time>{fullDate(e.created_at)}</time>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {reading.away && (
        <button
          className="thread-jump"
          onClick={() => reading.jumpToLatest(true)}
        >
          {reading.newReplies > 0 && (
            <span aria-live="polite">
              {reading.newReplies} new{" "}
              {reading.newReplies === 1 ? "reply" : "replies"} ·{" "}
            </span>
          )}
          Jump to latest
        </button>
      )}
      <ReplyComposer
        key={t.id}
        drafts={drafts}
        draftKey={`reply-${t.id}`}
        thread={t}
        users={data.users}
        act={act}
        notify={notify}
        afterPost={(saved) => {
          reading.revealPosted(saved.id);
          setTab("discussion");
        }}
      />
    </>
  );
}
function Attachments({ files }) {
  return (
    !!files?.length && (
      <div className="attachments">
        {files.map((f) => (
          <div className="attachment" key={f.id}>
            {f.mime.startsWith("image/") && (
              <a
                href={`/api/attachments/${f.id}`}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={`/api/attachments/${f.id}`}
                  alt={f.name}
                  loading="lazy"
                />
              </a>
            )}
            <a
              className="attachment-file"
              href={`/api/attachments/${f.id}?download=1`}
              download={f.name}
            >
              <FileText size={17} />
              <span>
                <strong>{f.name}</strong>
                <small>{sizeLabel(f.size)}</small>
              </span>
              <Download size={15} />
            </a>
          </div>
        ))}
      </div>
    )
  );
}
function ReplyComposer({
  thread,
  users,
  act,
  notify,
  afterPost,
  creation = false,
  data,
  channelId,
  status,
  textareaId,
  drafts,
  draftKey,
}) {
  const draftState = useRef(drafts?.get(draftKey) || {});
  const savedDraft = draftState.current;
  const [body, setBody] = useState(savedDraft.body || ""),
    [files, setFiles] = useState(savedDraft.files || []),
    [busy, setBusy] = useState(!!savedDraft.sending),
    [uploading, setUploading] = useState(!!savedDraft.pending),
    [drag, setDrag] = useState(false),
    [mention, setMention] = useState(null),
    [error, setError] = useState(""),
    [destination, setDestination] = useState(
      savedDraft.destination ||
        channelId ||
        data?.channels.find((c) => !c.archived)?.id ||
        "",
    ),
    [title, setTitle] = useState(savedDraft.title || ""),
    [statusId, setStatusId] = useState(
      savedDraft.statusId || status || data?.statuses[0]?.id || "",
    ),
    [assigneeId, setAssigneeId] = useState(savedDraft.assigneeId || "");
  const input = useRef(),
    textarea = useRef(),
    uploadQueue = useRef(Promise.resolve()),
    uploadJobs = useRef(0),
    attachmentCount = useRef(savedDraft.files?.length || 0),
    sending = useRef(false),
    focusAfterSend = useRef(false);
  useEffect(() => {
    if (!busy && focusAfterSend.current) {
      focusAfterSend.current = false;
      textarea.current?.focus();
    }
  }, [busy]);
  useEffect(() => {
    Object.assign(savedDraft, {
      body,
      files,
      title,
      statusId,
      assigneeId,
      destination,
    });
    if (drafts) drafts.set(draftKey, savedDraft);
  }, [drafts, draftKey, body, files, title, statusId, assigneeId, destination]);
  useEffect(() => {
    const changed = () => {
      setBody(savedDraft.body || "");
      setTitle(savedDraft.title || "");
      setBusy(!!savedDraft.sending);
      setFiles(savedDraft.files || []);
      setUploading(!!savedDraft.pending);
      attachmentCount.current = savedDraft.files?.length || 0;
    };
    savedDraft.listeners ||= new Set();
    savedDraft.listeners.add(changed);
    return () => savedDraft.listeners.delete(changed);
  }, []);
  function uploadChanged() {
    savedDraft.listeners?.forEach((listener) => listener());
  }
  function upload(selected) {
    if (!selected?.length || sending.current) return;
    const selectedFiles = [...selected];
    uploadJobs.current += 1;
    savedDraft.pending = (savedDraft.pending || 0) + 1;
    uploadChanged();
    setError("");
    uploadQueue.current = (savedDraft.queue || uploadQueue.current).then(
      async () => {
        try {
          for (const f of selectedFiles) {
            if ((savedDraft.files?.length || 0) >= 10)
              throw new Error("Up to 10 attachments per message");
            const form = new FormData();
            form.set("file", f);
            const attachment = await api("/attachments", {
              method: "POST",
              body: form,
            });
            attachmentCount.current += 1;
            savedDraft.files = [...(savedDraft.files || []), attachment];
            uploadChanged();
          }
        } catch (e) {
          setError(e.message);
          notify(e.message, true);
        } finally {
          uploadJobs.current -= 1;
          savedDraft.pending -= 1;
          uploadChanged();
        }
      },
    );
    savedDraft.queue = uploadQueue.current;
  }
  async function send(e) {
    e?.preventDefault();
    if (
      sending.current ||
      savedDraft.sending ||
      savedDraft.pending ||
      uploadJobs.current ||
      (!body.trim() && !files.length && !(creation && title.trim()))
    )
      return;
    if (creation && !destination) return;
    sending.current = true;
    savedDraft.sending = true;
    uploadChanged();
    setBusy(true);
    setError("");
    try {
      const result = await act(
        creation ? "/threads" : `/threads/${thread.id}/replies`,
        "POST",
        {
          body,
          attachment_ids: files.map((f) => f.id),
          ...(creation
            ? {
                channel_id: Number(destination),
                ...(title.trim() ? { title: title.trim() } : {}),
                status_id: Number(statusId),
                assignee_id: assigneeId ? Number(assigneeId) : null,
              }
            : {}),
        },
      );
      Object.assign(savedDraft, { body: "", files: [], title: "" });
      uploadChanged();
      setBody("");
      setMention(null);
      setFiles([]);
      attachmentCount.current = 0;
      setTitle("");
      focusAfterSend.current = true;
      afterPost(result);
    } catch (e) {
      setError(e.message);
    } finally {
      sending.current = false;
      savedDraft.sending = false;
      uploadChanged();
      setBusy(false);
    }
  }
  const matches = mention
    ? users
        .filter((u) =>
          u.username.toLowerCase().startsWith(mention.query.toLowerCase()),
        )
        .slice(0, 6)
    : [];
  function chooseMention(user) {
    const value =
      body.slice(0, mention.start) +
      "@" +
      user.username +
      " " +
      body.slice(mention.end);
    setBody(value);
    setMention(null);
    textarea.current.focus();
  }
  return (
    <form
      className={`reply-composer ${creation ? "new-message-composer" : ""} ${drag ? "dragging" : ""}`}
      onSubmit={send}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        upload(e.dataTransfer.files);
      }}
    >
      {creation && (
        <div className="new-message-heading">
          <strong>Start a conversation</strong>
          {channelId ? (
            <span>#{data.channels.find((c) => c.id === channelId)?.name}</span>
          ) : (
            <label>
              Post in
              <select
                aria-label="Channel"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                disabled={busy}
              >
                {!destination && <option value="">Choose a channel</option>}
                {data.channels
                  .filter((c) => !c.archived)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={textarea}
          id={textareaId}
          aria-label={creation ? "Message" : "Reply"}
          placeholder={
            creation
              ? "Write a message… use @ to mention"
              : "Add to the conversation… use @ to mention"
          }
          maxLength={50000}
          disabled={busy}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            const before = e.target.value.slice(0, e.target.selectionStart);
            const m = before.match(/(?:^|\s)@([\w-]*)$/);
            setMention(
              m
                ? {
                    query: m[1],
                    start: e.target.selectionStart - m[1].length - 1,
                    end: e.target.selectionStart,
                  }
                : null,
            );
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
              return;
            if (e.key === "Escape") setMention(null);
            if (e.key !== "Enter") return;
            if (creation && !e.shiftKey && matches.length) {
              e.preventDefault();
              chooseMention(matches[0]);
              return;
            }
            if (e.metaKey || e.ctrlKey || (creation && !e.shiftKey)) send(e);
          }}
          onPaste={(e) => {
            const images = [...e.clipboardData.files];
            if (images.length) {
              e.preventDefault();
              upload(images);
            }
          }}
        />
        {matches.length > 0 && (
          <div className="mention-menu">
            {matches.map((u) => (
              <button key={u.id} type="button" onClick={() => chooseMention(u)}>
                <Avatar user={u} size="small" />
                <strong>{u.name}</strong>
                <span>@{u.username}</span>
              </button>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="pending-files">
            {files.map((f) => (
              <div key={f.id}>
                {f.mime?.startsWith("image/") ? (
                  <img
                    className="pending-preview"
                    src={`/api/attachments/${f.id}`}
                    alt={f.name}
                  />
                ) : (
                  <Paperclip size={13} />
                )}
                <span>{f.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  disabled={busy || uploading}
                  onClick={async () => {
                    try {
                      await api(`/attachments/${f.id}`, { method: "DELETE" });
                      attachmentCount.current -= 1;
                      setFiles((existing) =>
                        existing.filter((a) => a.id !== f.id),
                      );
                    } catch (e) {
                      notify(e.message, true);
                    }
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-toolbar">
          <div>
            <input
              ref={input}
              type="file"
              multiple
              aria-label={
                creation ? "Attach files to message" : "Attach files to reply"
              }
              hidden
              onChange={(e) => {
                upload(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Attach files"
              title="Attach files · up to 20 MB each"
              disabled={uploading || busy}
              onClick={() => input.current.click()}
            >
              {uploading ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Paperclip size={17} />
              )}
            </button>
            <span className="composer-note">Markdown supported</span>
          </div>
          <button
            className="button primary"
            disabled={
              busy ||
              uploading ||
              (creation && !destination) ||
              (!body.trim() && !files.length && !(creation && title.trim()))
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Send size={15} />
            )}
            {creation ? "Send" : "Reply"}
          </button>
        </div>
      </div>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {creation && (
        <details className="composer-options">
          <summary>Thread options</summary>
          <div className="composer-option-fields">
            <label>
              Title (optional)
              <input
                aria-label="Title (optional)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={240}
                placeholder="Generated from your message"
                disabled={busy}
              />
            </label>
            <label>
              Status
              <select
                aria-label="Status"
                value={statusId}
                onChange={(e) => setStatusId(e.target.value)}
                disabled={busy}
              >
                {data.statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Assignee
              <select
                aria-label="Assignee"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                disabled={busy}
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.kind === "agent" ? " · AI" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      )}
      <div className="composer-footer">
        <span>
          {drag
            ? "Drop files to attach"
            : "Everyone in the workspace can see this thread."}
        </span>
        <span>
          {creation
            ? "Enter to send · Shift + Enter for a new line"
            : "⌘ / Ctrl + Enter"}
        </span>
      </div>
    </form>
  );
}
function ModalRouter({
  modal,
  close,
  setModal,
  data,
  channelId,
  act,
  notify,
  openThread,
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e, fn) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await fn(new FormData(e.currentTarget));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const footer = (label = "Save") => (
    <>
      <div className="form-error" role="alert">
        {error}
      </div>
      <footer className="dialog-footer">
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button className="button primary" disabled={busy}>
          {busy ? <LoaderCircle size={16} className="spin" /> : label}
        </button>
      </footer>
    </>
  );
  if (modal.type === "agent-detail")
    return (
      <AgentDetail
        key={`${modal.id}:${modal.initialTab || "overview"}:${modal.instanceKey || 0}`}
        id={modal.id}
        initialTab={modal.initialTab}
        close={close}
        data={data}
        act={act}
        notify={notify}
      />
    );
  if (modal.type === "credential")
    return (
      <Dialog
        title="Your agent is ready to connect."
        subtitle="Copy this token now. It will not be shown again."
        onClose={close}
      >
        <div className="credential-content">
          <label>
            Agent server token
            <div className="secret-value">
              <code>{modal.token}</code>
              <button
                className="icon-button"
                aria-label="Copy token"
                onClick={() => copy(modal.token, notify)}
              >
                <Copy size={16} />
              </button>
            </div>
          </label>
          <p>
            Use this token with a separate persistent volume for this agent.
          </p>
          <pre>{`AGENT_TOKEN='<your-token>' AGENT_VOLUME=${modal.username} docker compose --profile manual up -d agent`}</pre>
          <p>
            For a remote worker, also set <code>THREADWORK_URL</code> to your
            server’s HTTPS address. See the README for the remote Compose file.
          </p>
        </div>
        <footer className="dialog-footer">
          <button className="button primary" onClick={close}>
            Done
          </button>
        </footer>
      </Dialog>
    );
  if (modal.type === "channel") {
    const c = modal.channel;
    return (
      <Dialog
        title={c ? "Edit channel" : "A place for shared work."}
        subtitle={
          c
            ? "Update this channel for everyone."
            : "Channels bring related conversations and work together."
        }
        onClose={close}
      >
        <form
          onSubmit={(e) =>
            submit(e, async (f) => {
              const body = {
                name: f.get("name"),
                description: f.get("description"),
                ...(c ? { archived: f.get("archived") === "on" } : {}),
              };
              await act(
                c ? `/channels/${c.id}` : "/channels",
                c ? "PATCH" : "POST",
                body,
              );
              close();
              notify(c ? "Channel updated" : "Channel created");
            })
          }
        >
          <div className="form-content">
            <label>
              Channel name
              <div className="input-with-icon">
                <Hash size={17} />
                <input
                  name="name"
                  aria-label="Channel name"
                  aria-describedby="channel-name-help"
                  defaultValue={c?.name}
                  placeholder="e.g. product-design"
                  pattern="[a-z][a-z0-9_-]{1,39}"
                  required
                  maxLength={40}
                />
              </div>
              <small id="channel-name-help">
                2–40 lowercase letters, numbers, hyphens, or underscores.
              </small>
            </label>
            <label>
              Description
              <textarea
                name="description"
                defaultValue={c?.description}
                placeholder="What belongs here?"
                maxLength={1000}
              />
            </label>
            {c && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="archived"
                  defaultChecked={!!c.archived}
                />
                Archive this channel
              </label>
            )}
          </div>
          {footer(c ? "Save changes" : "Create channel")}
        </form>
      </Dialog>
    );
  }
  if (modal.type === "thread") {
    const t = modal.thread;
    if (!t)
      return (
        <Dialog
          title="Start a conversation."
          subtitle="Write a message. Its title is generated automatically."
          onClose={close}
          wide
        >
          <ReplyComposer
            creation
            data={data}
            channelId={channelId}
            status={modal.status}
            users={data.users}
            act={act}
            notify={notify}
            afterPost={(r) => {
              close();
              openThread(r.id);
              notify("Message sent");
            }}
          />
        </Dialog>
      );
    return (
      <Dialog
        title={t ? "Edit thread" : "Start a conversation."}
        subtitle="A conversation here. A work item on the board."
        onClose={close}
        wide
      >
        <form
          onSubmit={(e) =>
            submit(e, async (f) => {
              const body = {
                title: f.get("title"),
                body: f.get("body"),
                status_id: Number(f.get("status_id")),
                assignee_id: f.get("assignee_id")
                  ? Number(f.get("assignee_id"))
                  : null,
                ...(!t ? { channel_id: Number(f.get("channel_id")) } : {}),
              };
              const r = await act(
                t ? `/threads/${t.id}` : "/threads",
                t ? "PATCH" : "POST",
                body,
              );
              close();
              openThread(r.id);
              notify(t ? "Thread updated" : "Thread created");
            })
          }
        >
          <div className="form-content">
            {!t && (
              <label>
                Channel
                <select
                  name="channel_id"
                  defaultValue={
                    channelId || data.channels.find((c) => !c.archived)?.id
                  }
                  required
                >
                  {data.channels
                    .filter((c) => !c.archived)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        # {c.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label>
              Title
              <input
                name="title"
                defaultValue={t?.title}
                placeholder="What would you like to work on?"
                required
                maxLength={240}
              />
            </label>
            <label>
              Description
              <textarea
                className="description-input"
                aria-label="Description"
                aria-describedby="thread-description-help"
                name="body"
                defaultValue={t?.body}
                placeholder="Share context, a question, or a first idea. Mention teammates with @username."
                maxLength={50000}
              />
              <small id="thread-description-help">
                Markdown supported. Use @username to mention a teammate.
              </small>
            </label>
            <div className="form-row">
              <label>
                Status
                <select
                  name="status_id"
                  aria-label="Status"
                  defaultValue={
                    t?.status_id || modal.status || data.statuses[0].id
                  }
                >
                  {data.statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Assignee
                <select
                  name="assignee_id"
                  aria-label="Assignee"
                  defaultValue={t?.assignee_id || ""}
                >
                  <option value="">Unassigned</option>
                  {data.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                      {u.kind === "agent" ? " · AI" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          {footer(t ? "Save changes" : "Create thread")}
        </form>
      </Dialog>
    );
  }
  if (modal.type === "user")
    return (
      <Dialog
        title="Bring someone into the loop."
        subtitle="Create an account for a teammate on your network."
        onClose={close}
      >
        <form
          onSubmit={(e) =>
            submit(e, async (f) => {
              await act("/admin/users", "POST", {
                username: f.get("username"),
                name: f.get("name"),
                password: f.get("password"),
                admin: f.get("admin") === "on",
              });
              close();
              notify("Account created");
            })
          }
        >
          <div className="form-content">
            <label>
              Display name
              <input
                name="name"
                required
                maxLength={80}
                placeholder="e.g. Alex Morgan"
              />
            </label>
            <label>
              Username
              <input
                name="username"
                aria-label="Username"
                aria-describedby="username-help"
                required
                pattern="[a-z][a-z0-9_-]{1,39}"
                placeholder="e.g. alex"
              />
              <small id="username-help">Used for sign-in and @mentions.</small>
            </label>
            <label>
              Initial password
              <input
                name="password"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                placeholder="At least 10 characters"
              />
            </label>
            <label className="checkbox-label">
              <input name="admin" type="checkbox" />
              Workspace admin
            </label>
          </div>
          {footer("Create account")}
        </form>
      </Dialog>
    );
  if (modal.type === "agent")
    return (
      <Dialog
        title="Meet your next teammate."
        subtitle="A name, a role, and an independent voice."
        onClose={close}
      >
        <form
          onSubmit={(e) =>
            submit(e, async (f) => {
              const r = await act(
                "/admin/agents",
                "POST",
                Object.fromEntries(f),
              );
              setModal({
                type: "credential",
                token: r.token,
                username: r.user.username,
              });
            })
          }
        >
          <div className="form-content">
            <div className="form-row">
              <label>
                Display name
                <input
                  name="name"
                  required
                  maxLength={80}
                  placeholder="e.g. Spark"
                />
              </label>
              <label>
                Username
                <input
                  name="username"
                  required
                  pattern="[a-z][a-z0-9_-]{1,39}"
                  placeholder="e.g. spark"
                />
              </label>
            </div>
            <label>
              Role & instructions
              <textarea
                name="role"
                required
                placeholder="What perspective should this agent bring? What can it help the team with?"
                maxLength={20000}
              />
            </label>
            <label>
              Codex model <span className="optional">optional</span>
              <input
                name="model"
                placeholder="Use the Codex default"
                maxLength={100}
              />
            </label>
            <div className="form-callout">
              <Bot size={19} />
              <p>
                This agent keeps one session across all channels. It decides
                when to participate. Connect a worker container after creating
                it.
              </p>
            </div>
          </div>
          {footer("Create agent")}
        </form>
      </Dialog>
    );
  return null;
}
async function copy(value, notify) {
  try {
    await navigator.clipboard.writeText(value);
    notify("Copied to clipboard");
  } catch {
    notify(
      "Select and copy the value manually; clipboard access requires HTTPS.",
      true,
    );
  }
}
function AgentDetail({
  id,
  initialTab = "overview",
  close,
  data,
  act,
  notify,
}) {
  const [agent, setAgent] = useState(null),
    [tab, setTab] = useState(initialTab),
    [busy, setBusy] = useState(false),
    [newToken, setNewToken] = useState(null);
  const load = useCallback(
    () =>
      api(`/admin/agents/${id}`)
        .then(setAgent)
        .catch((e) => notify(e.message, true)),
    [id],
  );
  useEffect(() => {
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [load]);
  async function command(command) {
    setBusy(true);
    try {
      const r = await act(`/admin/agents/${id}/command`, "POST", { command });
      if (r.token) setNewToken(r.token);
      load();
    } catch {
    } finally {
      setBusy(false);
    }
  }
  if (!agent)
    return (
      <Dialog title="Agent workspace" onClose={close}>
        <div className="empty">
          <LoaderCircle className="spin" />
        </div>
      </Dialog>
    );
  return (
    <Dialog
      title={agent.name}
      subtitle={`@${agent.username} · one session, across every channel`}
      onClose={close}
      wide
    >
      <div
        className="agent-detail-tabs"
        role="group"
        aria-label="Agent details view"
      >
        <button
          className={tab === "overview" ? "selected" : ""}
          aria-pressed={tab === "overview"}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          className={tab === "configuration" ? "selected" : ""}
          aria-pressed={tab === "configuration"}
          onClick={() => setTab("configuration")}
        >
          Configuration
        </button>
        <button
          className={tab === "logs" ? "selected" : ""}
          aria-pressed={tab === "logs"}
          onClick={() => setTab("logs")}
        >
          Runtime log
        </button>
      </div>
      <div className="agent-detail-body">
        {tab === "overview" && (
          <>
            <div className="agent-runtime">
              <span className={`state-badge ${agentState(agent)}`}>
                <i />
                {agentState(agent).replace("_", " ")}
              </span>
              <span className="muted">
                {agent.heartbeat_at
                  ? "Last seen " + timeAgo(agent.heartbeat_at)
                  : "No worker connected yet"}
              </span>
            </div>
            <p>{agent.role}</p>
            <div className="agent-controls">
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  await act(`/admin/agents/${id}`, "PATCH", {
                    desired: agent.desired === "running" ? "paused" : "running",
                  }).catch(() => {});
                  load();
                }}
              >
                {agent.desired === "running" ? (
                  <Pause size={15} />
                ) : (
                  <Play size={15} />
                )}{" "}
                {agent.desired === "running"
                  ? "Pause wake-ups"
                  : "Resume wake-ups"}
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => command("stop")}
              >
                <Square size={14} />
                Interrupt & pause
              </button>
            </div>
            <div className="agent-session">
              <span>CODEX SESSION</span>
              <code>
                {agent.session_id ||
                  "Created after sign-in and first connection"}
              </code>
            </div>
            <div className="auth-box">
              <div>
                <h3>Codex authentication</h3>
                <span className="muted">
                  {agent.auth_status.replaceAll("_", " ")}
                </span>
              </div>
              <button
                className="button"
                disabled={!online(agent) || busy || !!agent.login_code}
                onClick={() => command("login")}
              >
                <ExternalLink size={15} />
                Sign in with ChatGPT
              </button>
            </div>
            {agent.login_url && agent.login_code && (
              <div className="device-login">
                <p>
                  Open{" "}
                  <a href={agent.login_url} target="_blank" rel="noreferrer">
                    Codex device sign-in <ExternalLink size={13} />
                  </a>{" "}
                  and enter:
                </p>
                <div>
                  <code>{agent.login_code}</code>
                  <button
                    className="icon-button"
                    aria-label="Copy device code"
                    onClick={() => copy(agent.login_code, notify)}
                  >
                    <Copy size={16} />
                  </button>
                </div>
                <small>
                  You may need to enable device code login in ChatGPT security
                  settings.
                </small>
              </div>
            )}
            {agent.error && (
              <div className="error-inline">
                <AlertCircle size={16} />
                {agent.error}
              </div>
            )}
            {!online(agent) && (
              <div className="form-callout">
                <Terminal size={19} />
                <p>
                  Start this agent’s Docker Compose service. New agents need
                  their server token and a dedicated persistent volume. Setup
                  details are in the README.
                </p>
              </div>
            )}
          </>
        )}
        {tab === "configuration" && (
          <>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await act(
                    `/admin/agents/${id}`,
                    "PATCH",
                    Object.fromEntries(new FormData(e.currentTarget)),
                  );
                  notify("Agent configuration updated");
                  load();
                } catch {
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Display name
                <input
                  name="name"
                  defaultValue={agent.name}
                  required
                  maxLength={80}
                />
              </label>
              <label>
                Role & instructions
                <textarea
                  name="role"
                  defaultValue={agent.role}
                  required
                  maxLength={20000}
                />
              </label>
              <label>
                Codex model
                <input
                  name="model"
                  defaultValue={agent.model}
                  placeholder="Use the Codex default"
                />
              </label>
              <button className="button primary" disabled={busy}>
                Save configuration
              </button>
            </form>
            <WorkPreferences
              api={api}
              path={`/admin/agents/${id}/work-preferences`}
              initial={
                agent.work_preferences || {
                  notify_ready_work: false,
                  notify_ready_reviews: false,
                }
              }
              agent
              onDone={() => {
                load();
                notify("Work preferences updated");
              }}
            />
            <div className="agent-subscriptions">
              <h3>Channel subscriptions</h3>
              <p className="muted">
                New threads in these channels wake this agent.
              </p>
              {data.channels.map((c) => (
                <label className="checkbox-label" key={c.id}>
                  <input
                    type="checkbox"
                    checked={agent.subscriptions?.includes(c.id) || false}
                    onChange={async (e) => {
                      try {
                        await act(`/admin/agents/${id}/subscriptions`, "PUT", {
                          channel_id: c.id,
                          subscribed: e.target.checked,
                        });
                        load();
                      } catch {}
                    }}
                  />
                  # {c.name}
                </label>
              ))}
            </div>
            <div className="token-rotation">
              <h3>Server credential</h3>
              <p>
                Rotating the token disconnects the existing worker. Update its
                configuration with the replacement.
              </p>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => command("rotate-token")}
              >
                <RefreshCw size={15} />
                Rotate agent token
              </button>
              {newToken && (
                <div className="secret-value">
                  <code>{newToken}</code>
                  <button
                    className="icon-button"
                    aria-label="Copy replacement token"
                    onClick={() => copy(newToken, notify)}
                  >
                    <Copy size={16} />
                  </button>
                </div>
              )}
            </div>
          </>
        )}
        {tab === "logs" && (
          <div className="runtime-logs">
            {agent.logs.length ? (
              agent.logs.map((l) => (
                <div key={l.id} className={l.level}>
                  <time>{fullDate(l.created_at)}</time>
                  <span>{l.message}</span>
                </div>
              ))
            ) : (
              <p>No runtime activity yet.</p>
            )}
          </div>
        )}
      </div>
      <footer className="dialog-footer">
        <span className="muted">
          Runtime responses are never automatically posted.
        </span>
        <button className="button" onClick={close}>
          Close
        </button>
      </footer>
    </Dialog>
  );
}

createRoot(document.getElementById("root")).render(<App />);
