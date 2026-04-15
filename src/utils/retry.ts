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
  /** Custom predicate: return true if the error warrants a retry. */
  isRetryable?: (err: Error) => boolean;
}

/**
 * Executes `fn`, retrying on transient errors up to `maxAttempts` times.
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

      const delay = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * Wraps a promise with a timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out',
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    // @ts-ignore
    if (timer) clearTimeout(timer);
  }
}

// ── Helpers ────────────────────────────────────

function defaultIsRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('rate limit') ||
    msg.includes('529') ||   // Anthropic overload
    msg.includes('503') ||
    msg.includes('502')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
