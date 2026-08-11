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
/** The reason a signal carries, as an Error the caller can act on. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Aborted while waiting for a local inference slot');
}

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
   * cannot be acquired within `timeoutMs`, or as soon as `signal` fires.
   *
   * The signal matters as much as the timeout: with concurrency of 1 a caller
   * can sit here for half the inference timeout — 150 seconds by default —
   * and until it was wired up, neither cancelling the run nor spending its
   * budget got it out. It waited out the window for a slot it would drop the
   * moment it received one.
   */
  async acquire(timeoutMs?: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortReason(signal);
    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.makeRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const resolver = (release: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(release);
      };

      /** Leave the queue without taking a slot, so the next waiter still gets one. */
      const abandon = (): boolean => {
        if (settled) return false;
        settled = true;
        cleanup();
        const idx = this.queue.indexOf(resolver);
        if (idx !== -1) this.queue.splice(idx, 1);
        return true;
      };

      function onAbort(): void {
        if (abandon()) reject(abortReason(signal!));
      }

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!abandon()) return;
          reject(new Error(
            `Local model queue: timed out waiting for a free slot after ${timeoutMs}ms. ` +
            `Active: ${this.active}, Queued: ${this.queue.length}. ` +
            `Consider increasing localConcurrency or localInferenceTimeoutMs in your config.`,
          ));
        }, timeoutMs);
      }

      signal?.addEventListener('abort', onAbort, { once: true });
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
