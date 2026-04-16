// ─────────────────────────────────────────────
//  Cascade AI — Retry Utility
// ─────────────────────────────────────────────

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
