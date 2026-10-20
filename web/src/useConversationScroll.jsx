import { useLayoutEffect, useRef, useState } from "react";

const nearBottom = (el) =>
  el.scrollHeight - el.clientHeight - el.scrollTop <= 32;

// Positions belong to the signed-in App session, not to the DOM or the backend.
// A future main-area conversation can reuse this hook and pass its permalink target.
export default function useConversationScroll({
  threadId,
  tab,
  replyIds,
  targetReplyId,
  positions,
}) {
  const viewport = useRef(null),
    content = useRef(null);
  const current = useRef(null),
    pendingPost = useRef(null);
  const [away, setAway] = useState(false),
    [newReplies, setNewReplies] = useState(0);
  const [postVersion, setPostVersion] = useState(0);
  const ids = useRef(replyIds);
  ids.current = replyIds;
  const key = `${threadId}:${tab}`;
  const latestId = () => ids.current.at(-1) || 0;
  function capture() {
    const el = viewport.current,
      record = current.current;
    if (!el || !record) return;
    record.top = el.scrollTop;
    record.pinned = nearBottom(el);
    const top = el.getBoundingClientRect().top;
    const anchor = [...el.querySelectorAll(".reply[id]")].find(
      (node) => node.getBoundingClientRect().bottom > top,
    );
    record.anchorId = anchor?.id || null;
    record.offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    if (record.pinned) record.seenId = latestId();
    positions.set(record.key, { ...record });
    setAway(!record.pinned);
    setNewReplies(
      record.pinned ? 0 : ids.current.filter((id) => id > record.seenId).length,
    );
  }
  function restore() {
    const el = viewport.current,
      record = current.current;
    if (!el || !record) return;
    if (record.pinned) el.scrollTop = el.scrollHeight;
    else {
      const anchor =
        record.anchorId && document.getElementById(record.anchorId);
      if (anchor && el.contains(anchor))
        el.scrollTop +=
          anchor.getBoundingClientRect().top -
          el.getBoundingClientRect().top -
          record.offset;
      else el.scrollTop = record.top;
    }
    capture();
  }
  function jumpToLatest(focus = false) {
    if (!viewport.current || !current.current) return;
    current.current.pinned = true;
    restore();
    if (focus) viewport.current.focus({ preventScroll: true });
  }
  function revealPosted(id) {
    pendingPost.current = { threadId, id };
    setPostVersion((v) => v + 1);
  }
  useLayoutEffect(() => {
    const el = viewport.current;
    const saved = positions.get(key);
    current.current = saved
      ? { ...saved }
      : {
          key,
          top: 0,
          pinned: tab === "discussion",
          anchorId: null,
          offset: 0,
          seenId: latestId(),
        };
    let highlighted, timer;
    const target =
      tab === "discussion" &&
      targetReplyId &&
      document.getElementById(`reply-${targetReplyId}`);
    if (target && el.contains(target)) {
      el.scrollTop +=
        target.getBoundingClientRect().top -
        el.getBoundingClientRect().top -
        Math.max(0, (el.clientHeight - target.offsetHeight) / 2);
      target.classList.add("search-target");
      highlighted = target;
      timer = setTimeout(() => target.classList.remove("search-target"), 3000);
      capture();
    } else restore();
    return () => {
      // Saved continuously on scroll/resize; do not recapture after DOM teardown.
      clearTimeout(timer);
      highlighted?.classList.remove("search-target");
    };
  }, [key, targetReplyId]);
  useLayoutEffect(() => {
    const posted = pendingPost.current;
    if (
      tab === "discussion" &&
      posted?.threadId === threadId &&
      viewport.current?.querySelector(`#reply-${posted.id}`)
    ) {
      pendingPost.current = null;
      jumpToLatest();
    } else restore();
  }, [key, replyIds.join(","), postVersion]);
  useLayoutEffect(() => {
    const el = viewport.current,
      inner = content.current;
    const observer = new ResizeObserver(restore);
    observer.observe(el);
    observer.observe(inner);
    // Load events cover image dimensions becoming available after an initial restore.
    inner.addEventListener("load", restore, true);
    el.addEventListener("scroll", capture, { passive: true });
    return () => {
      observer.disconnect();
      inner.removeEventListener("load", restore, true);
      el.removeEventListener("scroll", capture);
    };
  }, [key]);
  return {
    viewport,
    content,
    away: tab === "discussion" && away,
    newReplies,
    jumpToLatest,
    revealPosted,
  };
}
