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
/**
 * Wording for a quota that refills on a clock rather than from a card.
 *
 * "Quota" alone cannot separate the two, and reading it as billing is the
 * expensive mistake. Google words an ordinary per-minute throttle as
 * `Quota exceeded for quota metric 'Generate Content API requests per minute'`
 * — a limit that clears within sixty seconds, described entirely in the
 * vocabulary of a spent account.
 */
const RATE_SHAPED = /per[\s-]+(?:second|minute|hour|day)|requests?[\s-]+per|tokens?[\s-]+per|quota metric|rate[\s-]?limit|too many requests/;

/**
 * Wording that means money, not time: the account cannot pay, and waiting
 * changes nothing. Anthropic says "credit balance is too low", OpenAI
 * "exceeded your current quota, please check your plan and billing details",
 * and neither of those was previously matched by `insufficient credit`.
 */
const BILLING_SHAPED = /billing|\bcredits?\b|balance is too low|insufficient[_\s]?quota|insufficient funds|payment required|out of credits?|exceeded your current quota/;

/**
 * A 403 that is about THIS model rather than the credential.
 *
 * Azure returns `The API deployment for this resource does not exist or you do
 * not have access to it` for a deployment name the key cannot use — the key
 * itself is fine, and other deployments on the same resource still work.
 * Reading that as a dead credential condemns a whole working provider.
 */
const MODEL_SCOPED = /deployment|does not exist|do(?:es)? not have access to|access to (?:the )?(?:model|deployment)|model .*not (?:enabled|available|supported)/;

/**
 * Split a 429 (or a rate-limit-shaped message) into "too fast" and "cannot
 * pay". Ties break toward `rate_limit`, which is this module's stated bias:
 * being wrong that way costs a retry, being wrong the other way strands a
 * provider that was about to start working again.
 */
function splitRateFromBilling(m: string): ProviderErrorKind {
  if (RATE_SHAPED.test(m)) return 'rate_limit';
  return BILLING_SHAPED.test(m) ? 'quota_exhausted' : 'rate_limit';
}

export function classifyProviderError(err: unknown): ClassifiedError {
  const raw = messageOf(err).trim();
  const status = statusOf(err);
  const m = raw.toLowerCase();

  const kind = ((): ProviderErrorKind => {
    // ── By status ──
    // 429 covers both "too fast" and "you have no credit left". They need
    // opposite responses from the user, so split them on the message — and
    // the word "quota" is not the thing that splits them (see RATE_SHAPED).
    if (status === 429) return splitRateFromBilling(m);
    if (status === 401) return 'auth';
    // 403 is the ambiguous one: a rejected credential and a credential that
    // simply lacks this one model arrive identically.
    if (status === 403) return MODEL_SCOPED.test(m) ? 'model_unavailable' : 'auth';
    if (status === 404) return 'model_unavailable';

    // ── By message ──
    if (/rate limit|too many requests|resource_exhausted/.test(m)) return splitRateFromBilling(m);
    if (BILLING_SHAPED.test(m)) return 'quota_exhausted';
    // A bare "quota" with no billing wording and no status. Still systemic —
    // every worker on this model will meet it — but transient, so the run
    // backs off rather than writing the provider off.
    if (/\bquota\b/.test(m)) return 'rate_limit';
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
 * Re-throwable form of `describeProviderError`, for the point where a failure
 * leaves the router for good and the raw vendor string would be all the user
 * ever sees.
 *
 * Two things are carried over deliberately, because the error is classified
 * again downstream (RunBreaker does exactly that) and a wrapper that destroyed
 * its own evidence would be reclassified as `unknown` — turning a systemic
 * failure back into a per-task one that gets retried, which is the behaviour
 * this whole path exists to stop:
 *
 *   · the HTTP status, so status-based classification still fires. For most
 *     kinds this is belt-and-braces — describeProviderError's own wording
 *     carries the keywords that re-trigger the same verdict. Not for
 *     'model_unavailable': its text says "not enabled for this API key", the
 *     auth branch matches /api key/ and is tested first, so on the message
 *     alone a 404 comes back as 'auth' and points the user at a key that is
 *     perfectly fine. The status is what stops that.
 *   · the provider's verbatim text, which `describeProviderError` appends —
 *     so message-based classification still fires too, and anything upstream
 *     matching on the original wording (isModelNotFoundError) still matches.
 *
 * The original is kept as `cause` for anyone who wants the untouched object.
 */
export function enrichProviderError(err: unknown, c: ClassifiedError, modelId?: string): Error {
  const enriched = new Error(describeProviderError(c, modelId), { cause: err });
  if (typeof c.status === 'number') {
    (enriched as Error & { status?: number }).status = c.status;
  }
  return enriched;
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
