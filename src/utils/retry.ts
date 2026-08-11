// ─────────────────────────────────────────────
//  Cascade AI — Retry Utility
// ─────────────────────────────────────────────

/**
 * Thrown when a Cascade run is aborted via `AbortSignal`.
 * Caught at the `Cascade.run()` boundary — does NOT propagate as an
 * unhandled rejection. Callers receive a partial result instead.
 */
export class CascadeCancelledError extends Error {
  constructor(reason?: string) {
    super(reason ?? 'Run was cancelled via AbortSignal');
    this.name = 'CascadeCancelledError';
  }
}

/**
 * A retryable error that carries a `.userMessage` for display.
 */
export class CascadeToolError extends Error {
  /** A friendly message to show the user / T3 */
  public readonly userMessage: string;
  /** Whether this error class is retryable by default */
  public readonly retryable: boolean;

  constructor(userMessage: string, cause?: unknown, retryable = false) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`${userMessage}: ${causeMsg}`);
    this.name = 'CascadeToolError';
    this.userMessage = userMessage;
    this.retryable = retryable;
  }
}

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms (doubled each retry). Default: 300 */
  baseDelayMs?: number;
  /**
   * Maximum delay cap in ms to prevent excessive waits. Default: 30_000 (30s).
   * Useful when `baseDelayMs` is large and `maxAttempts` is high.
   */
  maxDelayMs?: number;
  /**
   * When true (default), adds ±25% random jitter to each delay to prevent
   * thundering-herd issues when many callers retry simultaneously.
   */
  jitter?: boolean;
  /** Custom predicate: return true if the error warrants a retry. */
  isRetryable?: (err: Error) => boolean;
  /** Optional callback fired before each retry with the attempt number and error. */
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
}

/**
 * Executes `fn`, retrying on transient errors up to `maxAttempts` times.
 * Uses exponential back-off with optional jitter to spread load across retrying clients.
 *
 * @example
 * const result = await withRetry(() => fetchRemoteData(), {
 *   maxAttempts: 3,
 *   isRetryable: (e) => e.message.includes('ECONNRESET'),
 * });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const useJitter = opts.jitter !== false; // default: true
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let lastErr: Error = new Error('No attempts made');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));

      // Check CascadeToolError.retryable if applicable
      if (lastErr instanceof CascadeToolError && !lastErr.retryable) {
        throw lastErr;
      }

      if (attempt === maxAttempts || !isRetryable(lastErr)) {
        throw lastErr;
      }

      const rawDelay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      // Add ±25% jitter to reduce thundering-herd on simultaneous retries
      const delay = useJitter
        ? rawDelay * (0.75 + Math.random() * 0.5)
        : rawDelay;

      opts.onRetry?.(attempt, lastErr, delay);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * Wraps a promise with a timeout. Clears the internal timer whether the
 * promise resolves, rejects, or times out to avoid lingering handles.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(errorMessage)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Time-box an operation and actually CANCEL it when the clock runs out.
 *
 * `withTimeout` above races a promise it did not create, so it cannot stop the
 * work: on timeout the caller gets an error while the original request keeps
 * running — and for a model call that means it keeps generating and keeps
 * billing, invisibly, with its usage never reported anywhere. Everything built
 * to compensate for that (charging an estimate for the abandoned attempt,
 * re-checking the budget before the retry, holding a second reservation) exists
 * only because the request was never cancelled.
 *
 * This takes a FACTORY instead of a promise so it can hand in a signal. On
 * timeout the signal aborts first and the rejection follows, so the provider
 * sees the cancellation before the caller sees the error. A caller's own signal
 * is chained in, so a cancelled run still aborts everything beneath it.
 *
 * Aborting is a request, not a refund: a provider that has already begun a
 * completion may still charge for it. What changes is that we stop paying for
 * output nobody will ever read, and stop doing it for the full length of a
 * second request that was racing the first.
 */
export async function withTimeoutAbort<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out',
  outer?: AbortSignal | ReadonlyArray<AbortSignal | undefined>,
): Promise<T> {
  // Several signals can want this call stopped — the caller's own cancellation
  // and the router's per-run kill switch — and any of them firing should end
  // it. Taking a list rather than one avoids AbortSignal.any(), which is not
  // available on every runtime this ships to.
  const outers = (Array.isArray(outer) ? outer : [outer])
    .filter((sig): sig is AbortSignal => sig !== undefined);
  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectRace: ((err: unknown) => void) | undefined;

  // Aborting the inner controller is a request to the operation; it is not a
  // guarantee the operation settles, and some do not honour a signal at all.
  // Racing an explicit rejection is what actually returns control to the
  // caller — without it, cancelling a run left the router waiting out the full
  // inference timeout (two minutes by default) for a call nobody wanted any
  // more, which is the opposite of the instant cancel this is here to provide.
  // Reject FIRST, then abort. The operation's own abort handler usually
  // rejects too, and Promise.race reports whichever settles first — so
  // aborting first meant the caller saw the provider's generic "aborted"
  // instead of the real reason (a run cancellation, or a budget ceiling that
  // needs to keep saying so on the way up). Rejecting first claims the race;
  // the abort on the next line is still synchronous, so it reaches the
  // operation before any continuation of ours runs.
  const settle = (reason: Error): void => {
    rejectRace?.(reason);
    controller.abort(reason);
  };

  const abortOuter = (): void => {
    const fired = outers.find((sig) => sig.aborted);
    settle(fired?.reason instanceof Error ? fired.reason : new CascadeCancelledError('Run cancelled'));
  };

  const failPromise = new Promise<never>((_, reject) => {
    rejectRace = reject;
    timer = setTimeout(() => settle(new Error(errorMessage)), timeoutMs);
  });

  if (outers.some((sig) => sig.aborted)) abortOuter();
  else for (const sig of outers) sig.addEventListener('abort', abortOuter, { once: true });

  try {
    return await Promise.race([run(controller.signal), failPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const sig of outers) sig.removeEventListener('abort', abortOuter);
  }
}

// ── Helpers ────────────────────────────────────

function defaultIsRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||       // DNS resolution failure (transient)
    msg.includes('econnaborted') ||    // Connection aborted mid-stream
    msg.includes('socket hang up') ||
    msg.includes('socket timeout') ||
    msg.includes('network error') ||
    msg.includes('failed to fetch') || // fetch() in browser/node environments
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||  // 429
    msg.includes('overloaded') ||         // Anthropic 529 body text
    msg.includes('529') ||                // Anthropic overload status code
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504') ||               // Gateway timeout
    msg.includes('internal server error') // 500 — may be transient
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
