import { Worker } from "node:worker_threads";
const failure = (message, status = 503) =>
  Object.assign(new Error(message), { status });
// Lazy, bounded readers. Cancellation/timeouts terminate only that reader's
// SQLite execution; stale queries cannot accumulate behind synchronous work.
export class SearchPool {
  constructor(
    path,
    {
      size = 2,
      queueLimit = 8,
      timeoutMs = 5000,
      workerUrl = new URL("./search-worker.mjs", import.meta.url),
    } = {},
  ) {
    Object.assign(this, { path, size, queueLimit, timeoutMs, workerUrl });
    this.slots = new Set();
    this.queue = [];
    this.closed = false;
  }
  run(kind, input, user, signal) {
    if (this.closed) return Promise.reject(failure("Search is unavailable"));
    if (signal?.aborted)
      return Promise.reject(failure("Search cancelled", 499));
    if (this.queue.length >= this.queueLimit)
      return Promise.reject(failure("Search is busy. Please retry."));
    return new Promise((resolve, reject) => {
      const job = { kind, input, user, resolve, reject, signal };
      job.cancel = () => {
        const slot = [...this.slots].find((s) => s.job === job);
        if (slot)
          this.finish(slot, failure("Search cancelled", 499), null, true);
        else {
          this.queue = this.queue.filter((j) => j !== job);
          this.settle(job, failure("Search cancelled", 499));
        }
      };
      signal?.addEventListener("abort", job.cancel, { once: true });
      // Includes queue wait, so overload has a fixed wall-clock deadline.
      job.timer = setTimeout(() => {
        const slot = [...this.slots].find((s) => s.job === job);
        if (slot)
          this.finish(
            slot,
            failure("Search took too long. Refine the query and retry."),
            null,
            true,
          );
        else {
          this.queue = this.queue.filter((j) => j !== job);
          this.settle(job, failure("Search is busy. Please retry."));
        }
      }, this.timeoutMs);
      this.queue.push(job);
      this.drain();
    });
  }
  settle(job, error, result) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.cancel);
    error ? job.reject(error) : job.resolve(result);
  }
  finish(slot, error, result, terminate = false) {
    if (!this.slots.has(slot) || slot.retiring) return;
    const job = slot.job;
    slot.job = null;
    if (terminate) {
      slot.retiring = true;
      slot.worker.terminate().finally(() => {
        this.slots.delete(slot);
        this.drain();
      });
    }
    if (job) this.settle(job, error, result);
    this.drain();
  }
  drain() {
    if (this.closed) return;
    while (this.queue.length) {
      let slot = [...this.slots].find((s) => !s.job && !s.retiring);
      if (!slot) {
        if (this.slots.size >= this.size) return;
        const worker = new Worker(this.workerUrl, {
          workerData: { path: this.path },
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        });
        slot = { worker, job: null };
        this.slots.add(slot);
        worker.on("message", ({ result, error }) =>
          this.finish(
            slot,
            error ? failure(error.message, error.status) : null,
            result,
          ),
        );
        worker.on("error", () =>
          this.finish(
            slot,
            failure("Search reader unavailable. Please retry."),
            null,
            true,
          ),
        );
        worker.on("exit", () => {
          if (this.slots.has(slot) && !slot.retiring)
            this.finish(
              slot,
              failure("Search reader stopped. Please retry."),
              null,
              true,
            );
        });
      }
      const job = this.queue.shift();
      slot.job = job;
      slot.worker.postMessage({
        kind: job.kind,
        input: job.input,
        user: job.user,
      });
    }
  }
  close() {
    this.closed = true;
    for (const job of this.queue)
      this.settle(job, failure("Search is shutting down"));
    this.queue = [];
    for (const slot of [...this.slots])
      this.finish(slot, failure("Search is shutting down"), null, true);
  }
}
