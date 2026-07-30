// ─────────────────────────────────────────────
//  Cascade AI — GitHub Models LIVE integration smoke test  (OPT-IN)
// ─────────────────────────────────────────────
//
//  HOW TO RUN
//
//    GITHUB_MODELS_TEST_TOKEN=<your PAT> npx vitest run src/providers/github-models.live.test.ts
//
//  The PAT must be a fine-grained personal access token with the `models: read`
//  permission. Nothing else is needed — the endpoint is fixed.
//
//  This suite makes REAL network calls and spends REAL quota (a handful of
//  requests against a budget that is only ~10 RPM on the Free tier), so it is
//  opt-in and never part of the default suite. With no GITHUB_MODELS_TEST_TOKEN
//  in the environment every case is SKIPPED, and that is the expected,
//  non-failing outcome for CI and for a normal local `npm test`. A skip here is
//  not a pass — it means the assertions below simply were not evaluated.
//
//  WHY IT EXISTS
//
//  Everything else about this provider is pinned by github-models.test.ts
//  against mocks. One thing cannot be: whether a PERSONAL PAT is served by the
//  plain `/inference/chat/completions` path this provider is built against, or
//  whether some account types require an `/orgs/{org}/inference/...` variant
//  instead. Rather than speculatively "handle both" and carry dead code
//  forever, the uncertainty is parked here where a real credential settles it
//  empirically — see the explicit 404 assertion in the chat-completion case.

import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../types.js';
import { GitHubModelsProvider } from './github-models.js';
import {
  GITHUB_MODELS_API_VERSION,
  GITHUB_MODELS_CATALOG_URL,
  GITHUB_MODELS_INFERENCE_URL,
} from '../constants.js';

const TOKEN = process.env['GITHUB_MODELS_TEST_TOKEN'];

/** Small, widely-available catalog model — keep the spend trivial. */
const PROBE_MODEL_ID = 'openai/gpt-4o-mini';

function liveModel(id: string): ModelInfo {
  return {
    id, name: id, provider: 'github-models',
    contextWindow: 128_000, isVisionCapable: false,
    inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
    maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
  };
}

describe.skipIf(!TOKEN)('GitHub Models — LIVE (opt-in, needs GITHUB_MODELS_TEST_TOKEN)', () => {
  it('serves the real catalog under the headers the provider sends', async () => {
    const res = await fetch(GITHUB_MODELS_CATALOG_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${TOKEN}`,
        'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
      },
    });
    expect(
      res.ok,
      `Catalog GET ${GITHUB_MODELS_CATALOG_URL} returned HTTP ${res.status}. ` +
      `401/403 usually means the PAT is missing the \`models: read\` permission; ` +
      `404 means the catalog path or the X-GitHub-Api-Version (${GITHUB_MODELS_API_VERSION}) has moved.`,
    ).toBe(true);

    const body = (await res.json()) as unknown;
    const raw = Array.isArray(body) ? body
      : (body as { models?: unknown[] })?.models ?? (body as { data?: unknown[] })?.data;
    expect(
      Array.isArray(raw) && raw.length > 0,
      `Catalog body was not a non-empty array under any of the shapes listModels() ` +
      `parses (top-level array / .models / .data). Got: ${JSON.stringify(body).slice(0, 400)}`,
    ).toBe(true);

    // Surface the true field names so a shape change is diagnosable from the
    // failure output alone rather than needing a separate manual curl.
    const first = (raw as unknown[])[0] as Record<string, unknown>;
    expect(
      typeof first['id'] === 'string' || typeof first['name'] === 'string',
      `No 'id' or 'name' string on the first catalog entry — listModels() would ` +
      `parse zero models and silently degrade to the seed model. Entry keys: ` +
      `${Object.keys(first).join(', ')}`,
    ).toBe(true);

    // The owner-prefixed id shape is what the whole prefix-stripping logic in
    // github-models.ts assumes; if GitHub ever drops it, that code is dead
    // weight and this is where it shows up.
    const ids = (raw as Record<string, unknown>[])
      .map((m) => m['id'])
      .filter((v): v is string => typeof v === 'string');
    expect(
      ids.some((id) => id.includes('/')),
      `No catalog id contained an owner prefix ('owner/model'). Sample: ${ids.slice(0, 5).join(', ')}`,
    ).toBe(true);
  }, 30_000);

  it('listModels() parses that live catalog into usable ModelInfo', async () => {
    // The end-to-end version of the case above: real bytes through the real
    // parser, so a shape we did not anticipate shows up as an empty/degraded
    // list rather than a green mock.
    const provider = new GitHubModelsProvider(
      { type: 'github-models', apiKey: TOKEN },
      liveModel(PROBE_MODEL_ID),
    );
    const models = await provider.listModels();
    expect(
      models.length > 1,
      `listModels() returned ${models.length} model(s) — 1 means it fell back to the ` +
      `seed because nothing parsed out of a successfully fetched catalog.`,
    ).toBe(true);
    for (const m of models) {
      expect(m.provider).toBe('github-models');
      expect(m.isLocal).toBe(false);
      expect(m.pricingUnknown).toBe(false);
      expect(m.maxOutputTokens).toBe(4_000);
    }
  }, 30_000);

  it('answers a NON-STREAMING chat completion on the plain personal /inference path', async () => {
    // THE open question this file exists to settle. The provider is built
    // against the plain personal path; if a personal PAT actually needs
    // `/orgs/{org}/inference/chat/completions`, this is the assertion that says
    // so out loud instead of the provider failing mysteriously in the field.
    const url = `${GITHUB_MODELS_INFERENCE_URL}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        // Also proves the API-version header the client sets on EVERY request
        // is at worst ignored by the inference endpoint, never rejected.
        'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
      },
      body: JSON.stringify({
        model: PROBE_MODEL_ID,
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        max_tokens: 16,
        temperature: 0,
      }),
    });

    expect(
      res.status,
      `POST ${url} returned 404. THIS IS THE UNRESOLVED CASE: a personal PAT may ` +
      `require the '/orgs/{org}/inference/chat/completions' variant instead of the ` +
      `plain personal path this provider is built against. If this fires, ` +
      `GITHUB_MODELS_INFERENCE_URL in src/constants.ts (and the fixed baseURL in ` +
      `src/providers/github-models.ts) need the org-scoped form.`,
    ).not.toBe(404);
    expect(
      res.ok,
      `POST ${url} returned HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`,
    ).toBe(true);

    // Genuinely OpenAI-compatible response shape — this is the assumption that
    // lets the provider inherit OpenAIProvider's request path wholesale.
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    expect(typeof body.choices?.[0]?.message?.content).toBe('string');
    expect(typeof body.usage?.prompt_tokens).toBe('number');
    expect(typeof body.usage?.completion_tokens).toBe('number');
  }, 60_000);

  it('streams a chat completion through the inherited OpenAI path', async () => {
    const provider = new GitHubModelsProvider(
      { type: 'github-models', apiKey: TOKEN },
      liveModel(PROBE_MODEL_ID),
    );
    const chunks: string[] = [];
    const result = await provider.generateStream(
      { messages: [{ role: 'user', content: 'Reply with the single word: pong' }], maxTokens: 16, temperature: 0 },
      (c) => { if (c.text) chunks.push(c.text); },
    );
    expect(result.content.length).toBeGreaterThan(0);
    expect(chunks.join('')).toBe(result.content);
    // stream_options.include_usage is part of the inherited request — if GitHub
    // ignored it, cost/TPM accounting would silently read zero.
    expect(
      result.usage.inputTokens + result.usage.outputTokens,
      'No usage reported on the stream — the endpoint may not honour stream_options.include_usage.',
    ).toBeGreaterThan(0);
  }, 60_000);

  it('isAvailable() is true with a real PAT', async () => {
    const provider = new GitHubModelsProvider(
      { type: 'github-models', apiKey: TOKEN },
      liveModel(PROBE_MODEL_ID),
    );
    await expect(provider.isAvailable()).resolves.toBe(true);
  }, 30_000);
});
