import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchPool } from "../server/search-pool.mjs";

test("search readers enforce deadlines, queue bounds and cancellation without blocking normal work", async () => {
  const pool = new SearchPool("unused", {
    size: 1,
    queueLimit: 1,
    timeoutMs: 250,
    workerUrl: new URL("./fixtures/search-reader.mjs", import.meta.url),
  });
  try {
    const controller = new AbortController();
    const running = pool.run(
      "global",
      { block: true },
      { id: 1 },
      controller.signal,
    );
    const cancelled = assert.rejects(running, /cancelled/);
    const waiting = pool.run("global", {}, {});
    await assert.rejects(pool.run("global", {}, {}), /busy/);
    const start = performance.now();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      performance.now() - start < 200,
      "main event loop continues while SQLite-style work blocks the reader",
    );
    controller.abort();
    await cancelled;
    assert.deepEqual(await waiting, { ok: true });
    const slow = pool.run("global", { block: true }, {});
    await assert.rejects(slow, /too long/);
    assert.deepEqual(await pool.run("global", {}, {}), { ok: true });
    assert.ok(pool.slots.size <= 1);
  } finally {
    pool.close();
  }
  await assert.rejects(pool.run("global", {}, {}), /unavailable/);
});
