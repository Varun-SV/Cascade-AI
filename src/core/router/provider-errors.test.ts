// ─────────────────────────────────────────────
//  Cascade AI — provider error classification tests
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { classifyProviderError, describeProviderError, enrichProviderError } from './provider-errors.js';

describe('classifyProviderError — 429 is two different problems', () => {
  it('reads a plain 429 as a rate limit that will ease', () => {
    const c = classifyProviderError(Object.assign(new Error('Too Many Requests'), { status: 429 }));
    expect(c.kind).toBe('rate_limit');
    expect(c.systemic).toBe(true);
  });

  it('reads a 429 about billing as an exhausted quota', () => {
    const c = classifyProviderError(
      Object.assign(new Error('You exceeded your current quota, please check your plan and billing details'), { status: 429 }),
    );
    expect(c.kind).toBe('quota_exhausted');
  });

  it('finds an exhausted quota with no status at all', () => {
    // Several SDKs flatten the status away by the time the error reaches us.
    const c = classifyProviderError(new Error('insufficient_quota: your credit balance is too low'));
    expect(c.kind).toBe('quota_exhausted');
  });
});

describe('classifyProviderError — a quota that refills is not a quota that is gone', () => {
  // The finding that mattered most in review: Google words an ordinary
  // per-minute throttle in the vocabulary of a spent account, so keying on the
  // word "quota" would write off a provider that is fine in sixty seconds.
  it('reads a Gemini per-minute limit as a rate limit, not an exhausted account', () => {
    const c = classifyProviderError(Object.assign(new Error(
      "429 RESOURCE_EXHAUSTED. Quota exceeded for quota metric 'Generate Content API requests per minute' "
      + "and limit 'GenerateContent request limit per minute for a region' of service "
      + "'generativelanguage.googleapis.com'."), { status: 429 }));
    expect(c.kind).toBe('rate_limit');
  });

  it('reads a Gemini per-day limit as a rate limit too', () => {
    // Longer to clear than a minute, but it still clears, and being wrong
    // toward transient costs a retry rather than a provider.
    const c = classifyProviderError(Object.assign(new Error(
      "Quota exceeded for quota metric 'Generate Content API requests per day'"), { status: 429 }));
    expect(c.kind).toBe('rate_limit');
  });

  it('still reads OpenAI billing exhaustion as exhausted', () => {
    const c = classifyProviderError(Object.assign(new Error(
      'You exceeded your current quota, please check your plan and billing details.'), { status: 429 }));
    expect(c.kind).toBe('quota_exhausted');
  });

  it("catches Anthropic's wording, which said 'credit balance' and matched nothing", () => {
    // Previously classified 'unknown' — non-systemic, so retried per task. The
    // one message that genuinely means "this account cannot pay" was the one
    // the classifier did not recognise.
    const c = classifyProviderError(new Error('Your credit balance is too low to access the Anthropic API'));
    expect(c.kind).toBe('quota_exhausted');
  });

  it('treats a bare unexplained "quota" as transient, not as a dead account', () => {
    const c = classifyProviderError(new Error('Quota exceeded.'));
    expect(c.kind).toBe('rate_limit');
    expect(c.systemic).toBe(true);
  });
});

describe('classifyProviderError — retry metadata outranks billing wording', () => {
  it('reads a Gemini quota message carrying retryDelay as transient', () => {
    // Google returns OpenAI's billing phrasing for ordinary RPM/TPM and
    // rolling-spend limits, and attaches a retry interval when it does.
    // Nothing genuinely out of money tells you when to come back.
    const c = classifyProviderError(Object.assign(new Error(
      '[429] You exceeded your current quota, please check your plan and billing details. '
      + '[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"41s"}]'), { status: 429 }));
    expect(c.kind).toBe('rate_limit');
  });

  it('reads a retry hint carried as a FIELD, not in the text', () => {
    // Some SDKs hang retryDelay off the error rather than flattening it in.
    const c = classifyProviderError(Object.assign(
      new Error('You exceeded your current quota, please check your plan and billing details'),
      { status: 429, retryDelay: '41s' },
    ));
    expect(c.kind).toBe('rate_limit');
  });

  it('reads a Retry-After header the same way', () => {
    const c = classifyProviderError(Object.assign(
      new Error('You exceeded your current quota'),
      { status: 429, headers: { 'Retry-After': '30' } },
    ));
    expect(c.kind).toBe('rate_limit');
  });

  it('still calls it exhausted when no retry interval is offered', () => {
    // The contrast case: identical wording, no retry metadata anywhere.
    const c = classifyProviderError(Object.assign(new Error(
      'You exceeded your current quota, please check your plan and billing details'), { status: 429 }));
    expect(c.kind).toBe('quota_exhausted');
  });
});

describe('classifyProviderError — 403 is two different problems', () => {
  it('reads an Azure deployment-scoped 403 as a model problem, not a dead key', () => {
    // The key works; it just cannot use THIS deployment. Condemning the whole
    // provider would exclude every other deployment on the same resource.
    const c = classifyProviderError(Object.assign(new Error(
      'The API deployment for this resource does not exist or you do not have access to it'), { status: 403 }));
    expect(c.kind).toBe('model_unavailable');
  });

  it('reads a model-access 403 the same way', () => {
    const c = classifyProviderError(Object.assign(new Error(
      'Project does not have access to model gpt-5'), { status: 403 }));
    expect(c.kind).toBe('model_unavailable');
  });

  it('still reads a genuinely rejected credential as auth', () => {
    expect(classifyProviderError(Object.assign(new Error('Incorrect API key provided'), { status: 401 })).kind)
      .toBe('auth');
    expect(classifyProviderError(Object.assign(new Error('Permission denied'), { status: 403 })).kind)
      .toBe('auth');
  });
});

describe('enrichProviderError', () => {
  it('keeps the failure classifiable as the SAME kind after wrapping', () => {
    // Load-bearing: RunBreaker re-classifies whatever it is handed. A wrapper
    // that lost the evidence would be re-read as `unknown` — which is treated
    // as per-task and therefore RETRIED, undoing the stop this path exists to
    // perform.
    const original = Object.assign(new Error('429 You exceeded your current quota'), { status: 429 });
    const c = classifyProviderError(original);

    const wrapped = enrichProviderError(original, c, 'gemini-2.5-flash');

    const reclassified = classifyProviderError(wrapped);
    expect(reclassified.kind).toBe('quota_exhausted');
    expect(reclassified.systemic).toBe(true);
    expect(reclassified.status).toBe(429);
  });

  it('carries the status across, which the description text alone cannot always replace', () => {
    // Worth being precise about what the preserved status is actually FOR,
    // because for most kinds it is redundant: describeProviderError's own
    // wording happens to contain the keywords that re-trigger the same
    // classification, so 'auth', 'quota_exhausted' and 'rate_limit' all
    // survive a wrap with the status thrown away.
    //
    // 'model_unavailable' does not. Its description says "not enabled for this
    // API key", the auth branch matches /api key/ and is tested FIRST, so on
    // the message alone a 404 comes back as 'auth' — a systemic-but-different
    // verdict that would send the user to re-check a key that is fine.
    //
    // The router only wraps quota/auth today, so this is defence for whoever
    // widens that next; the trap is real and silent, hence a test on it.
    const original = Object.assign(new Error('Request failed'), { status: 404 });
    const c = classifyProviderError(original);
    expect(c.kind).toBe('model_unavailable');

    // The failure mode, demonstrated: strip the status and the kind changes.
    expect(classifyProviderError(new Error(describeProviderError(c, 'gpt-4o'))).kind).toBe('auth');

    // With the wrapper, it does not.
    expect(classifyProviderError(enrichProviderError(original, c, 'gpt-4o')).kind).toBe('model_unavailable');
  });

  it('preserves an auth failure whose raw text says nothing matchable', () => {
    const original = Object.assign(new Error('Request failed'), { status: 401 });
    const c = classifyProviderError(original);
    expect(c.kind).toBe('auth');

    expect(classifyProviderError(enrichProviderError(original, c, 'gpt-4o')).kind).toBe('auth');
  });

  it("keeps the provider's verbatim text, so upstream matching still works", () => {
    const original = new Error('429 You exceeded your current quota');
    const wrapped = enrichProviderError(original, classifyProviderError(original), 'gemini-2.5-flash');

    expect(wrapped.message).toContain('You exceeded your current quota');
  });

  it('adds the actionable sentence and names the model', () => {
    const original = new Error('insufficient_quota');
    const wrapped = enrichProviderError(original, classifyProviderError(original), 'gemini-2.5-flash');

    expect(wrapped.message).toContain('gemini-2.5-flash');
    expect(wrapped.message).toMatch(/will not recover on its own/);
  });

  it('keeps the original reachable as `cause`', () => {
    const original = new Error('insufficient_quota');
    const wrapped = enrichProviderError(original, classifyProviderError(original), 'x');
    expect(wrapped.cause).toBe(original);
  });

  it('agrees with describeProviderError', () => {
    const original = new Error('insufficient_quota');
    const c = classifyProviderError(original);
    expect(enrichProviderError(original, c, 'x').message).toBe(describeProviderError(c, 'x'));
  });
});
