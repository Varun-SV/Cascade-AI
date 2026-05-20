// ─────────────────────────────────────────────
//  Cascade AI — Local Model Request Queue
// ─────────────────────────────────────────────

/**
 * A simple FIFO concurrency limiter for local (e.g. Ollama) inference calls.
 *
 * When a slot frees up, the next waiter receives a `release` function; calling
 * it frees the slot for the next caller. Setting maxConcurrent > 1 is useful
 * for multi-GPU or CPU setups; the default of 1 serializes all calls to protect
 * GPU VRAM on single-GPU machines.
 */
export class LocalRequestQueue {
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly queue: Array<(release: () => void) => void> = [];

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  /**
   * Acquire a queue slot. Returns a `release` function that MUST be called
   * when the inference call is done (even on error). Rejects if the slot
   * cannot be acquired within `timeoutMs`.
   */
  async acquire(timeoutMs?: number): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.makeRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const resolver = (release: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(release);
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = this.queue.indexOf(resolver);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(new Error(
            `Local model queue: timed out waiting for a free slot after ${timeoutMs}ms. ` +
            `Active: ${this.active}, Queued: ${this.queue.length}. ` +
            `Consider increasing localConcurrency or localInferenceTimeoutMs in your config.`,
          ));
        }, timeoutMs);
      }

      this.queue.push(resolver);
    });
  }

  /** Number of in-flight requests. */
  get activeCount(): number {
    return this.active;
  }

  /** Number of requests waiting for a slot. */
  get queueDepth(): number {
    return this.queue.length;
  }

  private makeRelease(): () => void {
    let called = false;
    return () => {
      if (called) return;
      called = true;
      this.active--;
      const next = this.queue.shift();
      if (next) {
        this.active++;
        next(this.makeRelease());
      }
    };
  }
}
