import React, { useState, useEffect, useRef, useCallback } from "react";
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
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./style.css";

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
function Dialog({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    const previous = document.activeElement;
    const el = ref.current;
    el.querySelector("input,textarea,select,button")?.focus();
    const key = (e) => {
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
      className="modal-backdrop"
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
function App() {
  const [data, setData] = useState(null),
    [auth, setAuth] = useState("loading"),
    [page, setPage] = useState("work"),
    [channelId, setChannelId] = useState(null),
    [view, setView] = useState(localStorage.getItem("tw_view") || "threads"),
    [threads, setThreads] = useState([]),
    [loading, setLoading] = useState(false),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [assignee, setAssignee] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [selectedId, setSelectedId] = useState(null),
    [detail, setDetail] = useState(null),
    [modal, setModal] = useState(null),
    [toast, setToast] = useState(null),
    [mobile, setMobile] = useState(false),
    [connected, setConnected] = useState(true),
    [inbox, setInbox] = useState([]),
    [refreshKey, setRefreshKey] = useState(0);
  const toastTimer = useRef();
  const notify = useCallback((message, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({ message, error });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const load = useCallback(async () => {
    try {
      const b = await api("/bootstrap");
      setData(b);
      setAuth("signedIn");
    } catch (e) {
      if (e.status === 401) {
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
        if (!stale) setThreads(t);
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
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let stale = false;
    api(`/threads/${selectedId}`)
      .then((d) => {
        if (!stale) setDetail(d);
      })
      .catch((e) => notify(e.message, true));
    return () => {
      stale = true;
    };
  }, [selectedId, refreshKey]);
  useEffect(() => {
    if (page === "inbox" && auth === "signedIn")
      api("/inbox")
        .then(setInbox)
        .catch((e) => notify(e.message, true));
  }, [page, auth, refreshKey]);
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
    const key = (e) => {
      if (e.key === "Escape") {
        setSelectedId(null);
        setMobile(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        document.querySelector("#global-search")?.focus();
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
    setPage(p);
    setChannelId(id);
    setSelectedId(null);
    setQuery("");
    setStatusFilter("");
    setMobile(false);
  }
  function startThread() {
    if (view === "board") setModal({ type: "thread" });
    else document.getElementById("new-thread-message")?.focus();
  }
  function openThread(id) {
    setSelectedId(id);
    setDetail(null);
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
                await api("/logout", { method: "POST" });
                setSelectedId(null);
                setAuth("signedOut");
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
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
                    : "Settings"}
            </strong>
          </div>
          <div className="topbar-right">
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
              <div className="view-switch" aria-label="Work view">
                <button
                  className={view === "threads" ? "selected" : ""}
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
                    id="global-search"
                    placeholder="Search conversations…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <kbd>⌘ K</kbd>
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
            {view === "threads" && !channel?.archived && (
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
              />
            )}
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
                            {t.body?.replace(/[#*`>]/g, "").slice(0, 90) ||
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
                          {shown.filter((t) => t.status_id === s.id).length}
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
                              e.dataTransfer.setData("text/thread-id", t.id)
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
                                  {t.body.replace(/[#*`>]/g, "").slice(0, 110)}
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
                        <div className="column-empty">Drop a thread here</div>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}
            <footer className="page-footer">
              <span>
                <MessageSquare size={13} /> A thread in conversation. A ticket
                on the board.
              </span>
              <span>
                Shared by people & agents{" "}
                <span className="footer-spark">✳</span>
              </span>
            </footer>
          </>
        )}
        {page === "inbox" && (
          <>
            <section className="page-heading">
              <div>
                <div className="eyebrow">STAY IN THE LOOP</div>
                <h1>
                  Your inbox<span className="heading-count">{data.unread}</span>
                </h1>
                <p>Replies, mentions, and changes to the work you follow.</p>
              </div>
              <button
                className="button"
                onClick={() => act("/inbox/read", "POST", {}).catch(() => {})}
              >
                <CheckCheck size={16} />
                Mark all read
              </button>
            </section>
            <div className="inbox-list">
              {inbox.length ? (
                inbox.map((n) => (
                  <button
                    className={`inbox-item ${!n.read_at ? "unread" : ""}`}
                    key={n.id}
                    onClick={async () => {
                      await act("/inbox/read", "POST", { ids: [n.id] }).catch(
                        () => {},
                      );
                      if (n.thread_id) openThread(n.thread_id);
                    }}
                  >
                    <Avatar
                      user={data.users.find((u) => u.id === n.actor_id)}
                    />
                    <div>
                      <div className="inbox-title">
                        <strong>{n.actor_name}</strong>{" "}
                        {n.type === "reply.created"
                          ? "replied to"
                          : n.type === "thread.created"
                            ? "started"
                            : n.type === "reply.edited"
                              ? "edited a reply in"
                              : "updated"}{" "}
                        <strong>{n.payload.title || "a thread"}</strong>
                      </div>
                      <p>
                        {n.payload.body?.slice(0, 160) ||
                          Object.keys(n.payload.changes || {})
                            .map((k) => k.replace("_id", ""))
                            .join(", ") + " changed"}
                      </p>
                      <span>
                        #{n.channel_name} <span className="meta-dot">·</span>{" "}
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
                  <article className="agent-card" key={a.user_id}>
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
                  {data.users.filter((u) => u.kind === "human").length} members
                </span>
              </div>
              <div className="people-list">
                {data.users
                  .filter((u) => u.kind === "human")
                  .map((u) => (
                    <div className="person-row" key={u.id}>
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
        {page === "settings" && data.user.admin && (
          <SettingsPage
            data={data}
            act={act}
            setModal={setModal}
            notify={notify}
          />
        )}
      </main>
      {selectedId && (
        <div
          className="detail-shade"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelectedId(null);
          }}
        >
          <aside
            className="thread-detail"
            role="dialog"
            aria-modal="true"
            aria-label="Thread details"
          >
            {detail ? (
              <ThreadDetail
                thread={detail}
                data={data}
                act={act}
                notify={notify}
                close={() => setSelectedId(null)}
                edit={() => setModal({ type: "thread", thread: detail })}
              />
            ) : (
              <div className="detail-loading">
                <LoaderCircle className="spin" />
                <button
                  className="icon-button"
                  onClick={() => setSelectedId(null)}
                  aria-label="Close thread"
                >
                  <X />
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
      {modal && (
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
function ThreadDetail({ thread: t, data, act, notify, close, edit }) {
  const [tab, setTab] = useState("discussion"),
    [editing, setEditing] = useState(null),
    [editBody, setEditBody] = useState("");
  const end = useRef();
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Tab") {
        const root = document.querySelector(".thread-detail");
        const nodes = [
          ...root.querySelectorAll("button,input,textarea,select,a[href]"),
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
    return () => document.removeEventListener("keydown", key);
  }, []);
  return (
    <>
      <div className="detail-top">
        <span>
          <Hash size={15} />
          {t.channel_name}
          <ChevronRight size={13} />
          TW-{t.id}
        </span>
        <div>
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
          <button
            className="icon-button"
            aria-label="Close thread"
            onClick={close}
          >
            <X size={21} />
          </button>
        </div>
      </div>
      <div className="detail-title">
        <h1>{t.title}</h1>
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
      <div className="thread-scroll">
        <div className="thread-description">
          <RichText>{t.body}</RichText>
          <Attachments files={t.attachments} />
          {!t.body && !t.attachments?.length && (
            <p className="muted">No description yet.</p>
          )}
        </div>
        <div className="discussion-tabs">
          <button
            className={tab === "discussion" ? "selected" : ""}
            onClick={() => setTab("discussion")}
          >
            Discussion <span>{t.replies.length}</span>
          </button>
          <button
            className={tab === "activity" ? "selected" : ""}
            onClick={() => setTab("activity")}
          >
            Activity
          </button>
        </div>
        {tab === "discussion" ? (
          <div className="replies">
            {t.replies.map((r) => (
              <article className="reply" key={r.id}>
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
            <div ref={end} />
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
      <ReplyComposer
        key={t.id}
        thread={t}
        users={data.users}
        act={act}
        notify={notify}
        afterPost={() => {
          setTab("discussion");
          setTimeout(
            () => end.current?.scrollIntoView({ behavior: "smooth" }),
            200,
          );
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
}) {
  const [body, setBody] = useState(""),
    [files, setFiles] = useState([]),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [drag, setDrag] = useState(false),
    [mention, setMention] = useState(null),
    [error, setError] = useState(""),
    [destination, setDestination] = useState(
      channelId || data?.channels.find((c) => !c.archived)?.id || "",
    ),
    [title, setTitle] = useState(""),
    [statusId, setStatusId] = useState(status || data?.statuses[0]?.id || ""),
    [assigneeId, setAssigneeId] = useState("");
  const input = useRef(),
    textarea = useRef(),
    uploadQueue = useRef(Promise.resolve()),
    uploadJobs = useRef(0),
    attachmentCount = useRef(0),
    sending = useRef(false),
    focusAfterSend = useRef(false);
  useEffect(() => {
    if (!busy && focusAfterSend.current) {
      focusAfterSend.current = false;
      textarea.current?.focus();
    }
  }, [busy]);
  function upload(selected) {
    if (!selected?.length || sending.current) return;
    const selectedFiles = [...selected];
    uploadJobs.current += 1;
    setUploading(true);
    setError("");
    uploadQueue.current = uploadQueue.current.then(async () => {
      try {
        for (const f of selectedFiles) {
          if (attachmentCount.current >= 10)
            throw new Error("Up to 10 attachments per message");
          const form = new FormData();
          form.set("file", f);
          const attachment = await api("/attachments", {
            method: "POST",
            body: form,
          });
          attachmentCount.current += 1;
          setFiles((existing) => [...existing, attachment]);
        }
      } catch (e) {
        setError(e.message);
        notify(e.message, true);
      } finally {
        uploadJobs.current -= 1;
        setUploading(uploadJobs.current > 0);
      }
    });
  }
  async function send(e) {
    e?.preventDefault();
    if (
      sending.current ||
      uploadJobs.current ||
      (!body.trim() && !files.length && !(creation && title.trim()))
    )
      return;
    if (creation && !destination) return;
    sending.current = true;
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
        id={modal.id}
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
function AgentDetail({ id, close, data, act, notify }) {
  const [agent, setAgent] = useState(null),
    [tab, setTab] = useState("overview"),
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
      <div className="agent-detail-tabs">
        <button
          className={tab === "overview" ? "selected" : ""}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          className={tab === "configuration" ? "selected" : ""}
          onClick={() => setTab("configuration")}
        >
          Configuration
        </button>
        <button
          className={tab === "logs" ? "selected" : ""}
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
