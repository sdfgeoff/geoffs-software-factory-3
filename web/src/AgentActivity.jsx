import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pause, Play, RefreshCw, ArrowDown } from "lucide-react";

function safePayload(value) {
  if (Array.isArray(value)) return value.map(safePayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "rawContent",
            "raw_content",
            "encryptedContent",
            "encrypted_content",
            "raw_reasoning",
          ].includes(key),
      )
      .map(([key, child]) => [key, safePayload(child)]),
  );
}
function eventTitle(event) {
  const item = event.payload?.item;
  if (event.type === "worker/wake") return "Wake notification";
  if (event.type === "worker/disconnected") return "Worker disconnected";
  if (event.type === "worker/activity_gap") return "Activity capture gap";
  if (event.type === "turn/started") return "Turn started";
  if (event.type === "turn/completed") return "Turn completed";
  if (event.type.includes("reasoning") || item?.type === "reasoning")
    return "Reasoning summary";
  if (item?.type === "mcpToolCall")
    return `MCP tool · ${[item.server, item.tool].filter(Boolean).join(".") || "tool call"}`;
  if (item?.type === "commandExecution") return "Command execution";
  if (item?.type === "agentMessage" || event.type.includes("agentMessage"))
    return "Agent message";
  if (item?.type === "fileChange") return "File changes";
  if (event.type.includes("outputDelta")) return "Command output";
  return event.type.replaceAll("/", " · ");
}
function preview(event) {
  const item = event.payload?.item;
  const value =
    item?.command ||
    item?.text ||
    event.payload?.delta ||
    event.payload?.message ||
    item?.status ||
    event.payload?.turn?.status ||
    "";
  return (typeof value === "string" ? value : JSON.stringify(value)).slice(
    0,
    180,
  );
}
const MAX_VISIBLE_EVENTS = 2000;
const mergeEvents = (previous, next) =>
  [
    ...new Map(
      [...previous, ...next].map((event) => [event.id, event]),
    ).values(),
  ].sort((a, b) => a.id - b.id);

export default function AgentActivity({ api, agentId, threadId }) {
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [olderBusy, setOlderBusy] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [turnInput, setTurnInput] = useState("");
  const [turnFilter, setTurnFilter] = useState("");
  const [includeWakes, setIncludeWakes] = useState(false);
  const [polling, setPolling] = useState(true);
  const [version, setVersion] = useState(0);
  const [newCount, setNewCount] = useState(0);
  const [fullTurn, setFullTurn] = useState(null);
  const [windowNotice, setWindowNotice] = useState("");
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const viewport = useRef();
  const generation = useRef(0);
  const pollingRef = useRef(polling);
  const prepend = useRef(null);
  const initialScroll = useRef(false);
  pollingRef.current = polling;
  const scopedAgent = fullTurn?.agentId || agentId;
  const base = scopedAgent
    ? `/admin/agents/${scopedAgent}/activity`
    : `/admin/threads/${threadId}/activity`;
  const selectedTurn = fullTurn?.turnId || turnFilter;
  const query = (extra = {}) => {
    const params = new URLSearchParams({
      limit: "100",
      ...(selectedTurn ? { turn_id: selectedTurn } : {}),
      ...(threadId && !fullTurn && includeWakes
        ? { include_wakes: "true" }
        : {}),
      ...extra,
    });
    return base + "?" + params;
  };
  useEffect(() => {
    const current = ++generation.current;
    let busy = false;
    let newest = 0;
    let initialized = false;
    eventsRef.current = [];
    setEvents([]);
    setWindowNotice("");
    setError("");
    setLoading(true);
    setHasOlder(false);
    setNewCount(0);
    initialScroll.current = true;
    prepend.current = null;
    const fetchEvents = async (initial = false) => {
      if (
        generation.current !== current ||
        busy ||
        (!initial && !pollingRef.current)
      )
        return;
      initial = initial || !initialized;
      busy = true;
      try {
        const result = await api(
          query(initial ? {} : { after: String(newest), limit: "200" }),
        );
        if (generation.current !== current || (!initial && !pollingRef.current))
          return;
        const incoming = result.events || [];
        newest = Math.max(newest, ...incoming.map((event) => event.id), 0);
        const merged = mergeEvents(eventsRef.current, incoming);
        const visible = merged.slice(0, MAX_VISIBLE_EVENTS);
        eventsRef.current = visible;
        setEvents(visible);
        if (merged.length >= MAX_VISIBLE_EVENTS) {
          setPolling(false);
          pollingRef.current = false;
          setWindowNotice(
            "This reading window reached 2,000 events. Live updates are paused. Refresh for the latest activity, or load an earlier history window.",
          );
        }
        if (initial) {
          setHasOlder(!!result.has_more);
          initialized = true;
        } else if (incoming.length)
          setNewCount((count) => count + incoming.length);
        setError("");
        if (!initial && result.has_more && pollingRef.current)
          setTimeout(() => fetchEvents(false), 0);
      } catch (e) {
        if (generation.current === current) setError(e.message);
      } finally {
        busy = false;
        if (generation.current === current) setLoading(false);
      }
    };
    fetchEvents(true);
    const interval = setInterval(() => fetchEvents(false), 1000);
    return () => {
      generation.current++;
      clearInterval(interval);
    };
  }, [api, base, selectedTurn, includeWakes, version]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (prepend.current) {
      element.scrollTop = prepend.current.replace
        ? 0
        : prepend.current.top + element.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (initialScroll.current && events.length) {
      element.scrollTop = element.scrollHeight;
      initialScroll.current = false;
    }
  }, [events]);
  const loadOlder = async () => {
    if (olderBusy || !events.length) return;
    const current = generation.current;
    setOlderBusy(true);
    try {
      const result = await api(query({ before: String(events[0].id) }));
      if (current !== generation.current) return;
      const incoming = result.events || [];
      if (eventsRef.current.length + incoming.length > MAX_VISIBLE_EVENTS) {
        const earlier = mergeEvents([], incoming);
        eventsRef.current = earlier;
        prepend.current = { top: 0, height: 0, replace: true };
        setEvents(earlier);
        setPolling(false);
        pollingRef.current = false;
        setWindowNotice(
          "Showing an earlier history window. Live updates are paused; refresh to return to the latest activity.",
        );
      } else {
        prepend.current = {
          top: viewport.current.scrollTop,
          height: viewport.current.scrollHeight,
        };
        const merged = mergeEvents(eventsRef.current, incoming);
        eventsRef.current = merged;
        setEvents(merged);
      }
      setHasOlder(!!result.has_more);
      setError("");
    } catch (e) {
      if (current === generation.current) setError(e.message);
    } finally {
      setOlderBusy(false);
    }
  };
  return (
    <section
      className="agent-activity"
      aria-label={
        threadId && !fullTurn ? "Ticket agent activity" : "Agent activity"
      }
    >
      <header className="agent-activity-heading">
        <h3>
          {fullTurn
            ? "Full turn context"
            : threadId
              ? "Direct agent tool activity"
              : "Agent activity"}
        </h3>
        <div className="agent-activity-actions">
          <button
            className="icon-button"
            aria-label="Refresh agent activity"
            onClick={() => {
              setPolling(true);
              setVersion((v) => v + 1);
            }}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="button subtle"
            disabled={!!windowNotice}
            onClick={() => setPolling((value) => !value)}
          >
            {polling ? <Pause size={14} /> : <Play size={14} />}{" "}
            {polling ? "Pause live updates" : "Resume live updates"}
          </button>
        </div>
      </header>
      <p className="muted">
        {fullTurn
          ? "This complete turn may include work on other tickets. Only directly linked tool events belong to the ticket activity view."
          : threadId
            ? "Only tool events directly associated with this ticket are shown. Wake notifications are separate; they do not establish what the agent worked on."
            : "Commands, tool arguments and results, messages, and available reasoning summaries. Private reasoning is not recorded."}
      </p>
      {fullTurn ? (
        <button className="button subtle" onClick={() => setFullTurn(null)}>
          Return to ticket activity
        </button>
      ) : (
        <form
          className="activity-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setTurnFilter(turnInput.trim());
          }}
        >
          <label>
            Filter by turn ID
            <input
              value={turnInput}
              onChange={(event) => setTurnInput(event.target.value)}
              placeholder="All turns"
            />
          </label>
          <button className="button subtle">Apply turn filter</button>
          {turnFilter && (
            <button
              className="button subtle"
              type="button"
              onClick={() => {
                setTurnInput("");
                setTurnFilter("");
              }}
            >
              Clear turn filter
            </button>
          )}
        </form>
      )}
      {threadId && !fullTurn && (
        <label className="checkbox-label activity-wake-option">
          <input
            type="checkbox"
            checked={includeWakes}
            onChange={(event) => setIncludeWakes(event.target.checked)}
          />
          Include wake notifications (separately labelled)
        </label>
      )}
      <div className="activity-status" role="status">
        {loading
          ? "Loading activity…"
          : `${polling ? "Live" : "Updates paused"} · ${events.length} events`}
        {newCount > 0 && (
          <button
            className="button subtle"
            onClick={() => {
              viewport.current.scrollTop = viewport.current.scrollHeight;
              setNewCount(0);
            }}
          >
            <ArrowDown size={14} />
            Show latest ({newCount})
          </button>
        )}
      </div>
      {windowNotice && (
        <p className="activity-window-notice" role="status">
          {windowNotice}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="agent-activity-stream"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="Activity event timeline"
      >
        {hasOlder && (
          <button
            className="button subtle activity-older"
            onClick={loadOlder}
            disabled={olderBusy}
          >
            {olderBusy
              ? "Loading older activity…"
              : events.length >= MAX_VISIBLE_EVENTS
                ? "Load earlier history window"
                : "Load older activity"}
          </button>
        )}
        {!loading && !events.length && (
          <p className="muted">
            No recorded activity for this view. New events will appear here
            while live updates are enabled.
          </p>
        )}
        {events.map((event) => (
          <ActivityEvent
            key={event.id}
            event={event}
            onFullTurn={
              threadId && !fullTurn
                ? (selected) =>
                    setFullTurn({
                      agentId: selected.agent_id,
                      turnId: selected.turn_id,
                    })
                : null
            }
          />
        ))}
      </div>
    </section>
  );
}

function ActivityEvent({ event, onFullTurn }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={`activity-event ${event.type.includes("error") || event.type.includes("gap") ? "activity-event-warning" : ""}`}
      data-activity-id={event.id}
      onToggle={(change) => setOpen(change.currentTarget.open)}
    >
      <summary>
        <span className="activity-event-heading">
          <strong>{eventTitle(event)}</strong>
          <time dateTime={event.occurred_at} title={event.occurred_at}>
            {new Date(event.occurred_at).toLocaleTimeString()}
          </time>
        </span>
        <span className="activity-event-type">
          {event.agent_name} · {event.type}
        </span>
        {preview(event) && (
          <span className="activity-event-preview">{preview(event)}</span>
        )}
        <span className="activity-associations">
          {event.links?.map((link, index) => (
            <span
              className={`activity-association ${link.kind}`}
              key={`${link.thread_id}:${link.kind}:${index}`}
            >
              {link.kind === "wake"
                ? "Wake notification"
                : "Direct tool activity"}{" "}
              · TW-{link.thread_id}
            </span>
          ))}
        </span>
      </summary>
      {open && (
        <>
          <dl className="activity-identifiers">
            <dt>Session</dt>
            <dd>{event.session_id || "—"}</dd>
            <dt>Turn</dt>
            <dd>{event.turn_id || "—"}</dd>
            <dt>Item</dt>
            <dd>{event.item_id || "—"}</dd>
            <dt>Event</dt>
            <dd>{event.event_id}</dd>
          </dl>
          <pre
            className="activity-event-payload"
            tabIndex={0}
            aria-label="Event details"
          >
            {JSON.stringify(safePayload(event.payload), null, 2)}
          </pre>
          {onFullTurn && event.turn_id && (
            <button className="button subtle" onClick={() => onFullTurn(event)}>
              Inspect full turn context
            </button>
          )}
        </>
      )}
    </details>
  );
}
