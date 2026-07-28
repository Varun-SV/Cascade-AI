// ─────────────────────────────────────────────
//  Cascade AI — Provider error classification
// ─────────────────────────────────────────────
//
//  When a model call fails, two questions decide what the orchestrator should
//  do next, and neither was being asked:
//
//    1. Is this failure specific to THIS subtask, or will it hit every worker?
//       A malformed prompt fails once; an expired API key fails every time. The
//       orchestrator used to retry both identically, so one dead key cost a
//       worker call per subtask plus a retry each — the whole run's budget spent
//       discovering the same fact over and over.
//
//    2. What should the USER be told? "A series of system-level errors" is not
//       something anyone can act on. "Gemini rejected the request: rate limit
//       exceeded (HTTP 429)" tells them to slow down or raise a quota.
//
//  Classification is deliberately conservative: anything not recognised is
//  `unknown`, which is treated as per-task and therefore still retried. Being
//  wrong in that direction costs one extra call; being wrong the other way
//  would abort a run over a transient blip.

/**
 * What kind of failure this is, and — crucially — whether retrying a DIFFERENT
 * subtask against the same model could plausibly succeed.
 */
export type ProviderErrorKind =
  | 'rate_limit'         // 429 — systemic, but eases with time
  | 'quota_exhausted'    // billing/quota is gone — systemic, does NOT ease
  | 'auth'               // bad/expired key — systemic
  | 'model_unavailable'  // model id wrong, or not enabled for this key — systemic
  | 'context_length'     // prompt too big — per-task (a smaller subtask may fit)
  | 'content_filter'     // safety refusal — per-task
  | 'network'            // transport blip — transient, per-task
  | 'unknown';

/** Kinds that will hit every worker on this model, not just the one that failed. */
const SYSTEMIC: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'rate_limit',
  'quota_exhausted',
  'auth',
  'model_unavailable',
]);

export function isSystemicKind(kind: ProviderErrorKind): boolean {
  return SYSTEMIC.has(kind);
}

export interface ClassifiedError {
  kind: ProviderErrorKind;
  /** True when every other worker on this model is expected to fail the same way. */
  systemic: boolean;
  /** HTTP status, when the provider gave us one. */
  status?: number;
  /** The provider's own message, trimmed — never invented or paraphrased. */
  raw: string;
}

/** Pull an HTTP status off whatever shape the SDK threw. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code']) {
    const v = e[key];
    if (typeof v === 'number' && v >= 100 && v < 600) return v;
  }
  // Nested: OpenAI puts it on .response.status, Google on .error.code
  const resp = e['response'] as Record<string, unknown> | undefined;
  if (resp && typeof resp['status'] === 'number') return resp['status'] as number;
  const inner = e['error'] as Record<string, unknown> | undefined;
  if (inner && typeof inner['code'] === 'number') return inner['code'] as number;
  return undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e['message'] === 'string') return e['message'];
    const inner = e['error'] as Record<string, unknown> | undefined;
    if (inner && typeof inner['message'] === 'string') return inner['message'] as string;
    try { return JSON.stringify(err); } catch { /* fall through */ }
  }
  return String(err);
}

/**
 * Classify a thrown provider error.
 *
 * Status codes are checked before message text: a 429 is a rate limit whatever
 * words the vendor wraps it in, and every vendor words it differently. Text
 * matching is the fallback for SDKs that flatten the status away.
 */
export function classifyProviderError(err: unknown): ClassifiedError {
  const raw = messageOf(err).trim();
  const status = statusOf(err);
  const m = raw.toLowerCase();

  const kind = ((): ProviderErrorKind => {
    // ── By status ──
    if (status === 429) {
      // 429 covers both "too fast" and "you have no credit left". They need
      // opposite responses from the user, so split them on the message.
      return /quota|billing|credit|exceeded your current quota|insufficient/.test(m)
        ? 'quota_exhausted'
        : 'rate_limit';
    }
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'model_unavailable';

    // ── By message ──
    if (/rate limit|too many requests|resource_exhausted/.test(m)) {
      return /quota|billing|credit|insufficient/.test(m) ? 'quota_exhausted' : 'rate_limit';
    }
    if (/quota|billing|insufficient_quota|insufficient credit|payment required/.test(m)) return 'quota_exhausted';
    if (/api key|unauthorized|authentication|permission denied|invalid[_ ]api/.test(m)) return 'auth';
    if (/model .*(not found|does not exist|unavailable)|no such model|unknown model|not supported for/.test(m)) {
      return 'model_unavailable';
    }
    if (/context length|too many tokens|maximum context|prompt is too long|input too long/.test(m)) return 'context_length';
    if (/safety|content filter|blocked|recitation|prohibited/.test(m)) return 'content_filter';
    if (/econnreset|etimedout|enotfound|socket hang up|network|fetch failed|aborted/.test(m)) return 'network';

    return 'unknown';
  })();

  return { kind, systemic: isSystemicKind(kind), status, raw };
}

/**
 * Turn a classified failure into something the user can act on.
 *
 * The provider's own words are always included verbatim: a paraphrase can be
 * wrong, and when someone is debugging a dead key they need the literal text to
 * search for. The added sentence says what to DO about it.
 */
export function describeProviderError(c: ClassifiedError, modelId?: string): string {
  const on = modelId ? ` on ${modelId}` : '';
  const detail = c.raw ? ` Provider said: ${c.raw}` : '';

  switch (c.kind) {
    case 'rate_limit':
      return `Rate limit hit${on}. The provider is throttling requests — lower the number of parallel workers, ` +
        `or use a model with a higher requests-per-minute allowance.${detail}`;
    case 'quota_exhausted':
      return `Quota or billing limit reached${on}. This will not recover on its own — check the provider's ` +
        `billing page, or switch this tier to a different provider.${detail}`;
    case 'auth':
      return `Authentication failed${on}. The API key is missing, expired, or lacks access to this model — ` +
        `re-check the key in Settings > Providers.${detail}`;
    case 'model_unavailable':
      return `Model unavailable${on}. The id may be wrong, retired, or not enabled for this API key — ` +
        `pick a different model for this tier.${detail}`;
    case 'context_length':
      return `The prompt was too long${on}. Reduce the attached context, or use a model with a larger ` +
        `context window for this tier.${detail}`;
    case 'content_filter':
      return `The provider's safety filter refused this request${on}.${detail}`;
    case 'network':
      return `Network error reaching the provider${on}. This is usually transient.${detail}`;
    default:
      return `The model call failed${on}.${detail}`;
  }
}
