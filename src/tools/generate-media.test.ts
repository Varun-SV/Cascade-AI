// ─────────────────────────────────────────────
//  Cascade AI — Media tool registration
// ─────────────────────────────────────────────
//
//  The reported failure: asking a hosted run for a picture got "I cannot
//  directly create images. My capabilities are limited to generating text."
//  The model was telling the truth — `generate_image` had never been registered,
//  because the cloud run sets enabledTools: ['web_search','web_fetch'] and the
//  media tools were gated on that same allowlist.
//
//  These pin the registration rules so that cannot silently regress.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMediaTools } from './generate-media.js';
import { MultimodalRegistry } from '../core/multimodal/registry.js';
import type { GeneratedAsset } from '../core/multimodal/generate.js';
import { classifyProviderError, describeProviderError } from '../core/router/provider-errors.js';
import type { ProviderConfig, ToolExecuteOptions } from '../types.js';

const { generateImageMock } = vi.hoisted(() => ({ generateImageMock: vi.fn() }));
vi.mock('../core/multimodal/generate.js', () => ({
  generateImage: generateImageMock,
  generateSpeech: vi.fn(),
  generateVideo: vi.fn(),
  transcribeAudio: vi.fn(),
}));

const noopSink = async (_a: GeneratedAsset) => 'somewhere';
const noProviders = () => undefined;
const readFile = async () => Buffer.from('');

function toolNames(providers: Array<'openai' | 'gemini'>, withReader = true): string[] {
  return buildMediaTools(
    {
      registry: new MultimodalRegistry(providers),
      sink: noopSink,
      lookupProvider: noProviders,
    },
    withReader ? readFile : undefined,
  ).map((t) => t.name);
}

describe('media tool registration', () => {
  it('registers nothing when no provider can serve a modality', () => {
    expect(toolNames([])).toEqual([]);
  });

  it('registers image generation for a Gemini-only account', () => {
    // The exact configuration from the bug report: Gemini key, no OpenAI.
    // gemini-3-pro-image is in the catalogue, so the tool must exist.
    expect(toolNames(['gemini'])).toContain('generate_image');
  });

  it('registers video for Gemini, now that Veo polling exists', () => {
    expect(toolNames(['gemini'])).toContain('generate_video');
  });

  it('does not register speech or transcription without an OpenAI key', () => {
    // Both are OpenAI-only in the catalogue. Registering them anyway would
    // produce a tool that always fails — worse than an absent one.
    const names = toolNames(['gemini']);
    expect(names).not.toContain('generate_speech');
    expect(names).not.toContain('transcribe_audio');
  });

  it('registers the full OpenAI set, but not video', () => {
    const names = toolNames(['openai']);
    expect(names).toEqual(expect.arrayContaining(['generate_image', 'generate_speech', 'transcribe_audio']));
    // Veo is Gemini-only.
    expect(names).not.toContain('generate_video');
  });

  it('omits transcription on a host with no filesystem', () => {
    // Cloud has no disk for the user to point at, so a path-taking tool has
    // nothing to read even though the model exists.
    const names = toolNames(['openai'], false);
    expect(names).toContain('generate_image');
    expect(names).not.toContain('transcribe_audio');
  });
});

describe('media tools refuse cleanly rather than throwing', () => {
  it('explains which provider is missing instead of crashing the worker', async () => {
    // The registry says gemini can serve images, but no config carries the key.
    // A worker must get a sentence it can relay, not an exception.
    const [imageTool] = buildMediaTools({
      registry: new MultimodalRegistry(['gemini']),
      sink: noopSink,
      lookupProvider: noProviders,   // ← key lookup fails
    });
    const out = await imageTool!.execute(
      { prompt: 'a cat' },
      { tierId: 't', sessionId: 's', requireApproval: false },
    );
    expect(out).toContain('gemini');
    expect(out).toContain('not configured');
  });

  it('asks for a prompt rather than calling the API with an empty one', async () => {
    const [imageTool] = buildMediaTools({
      registry: new MultimodalRegistry(['gemini']),
      sink: noopSink,
      lookupProvider: noProviders,
    });
    const out = await imageTool!.execute(
      { prompt: '   ' },
      { tierId: 't', sessionId: 's', requireApproval: false },
    );
    expect(out).toContain('Provide a "prompt"');
  });
});

// ─────────────────────────────────────────────
//  Cross-provider fallback
// ─────────────────────────────────────────────
//
//  The bug: a systemic provider error (dead key, 404 model, exhausted quota) is
//  scoped to ONE provider+model, but `generate_image` let it escape untouched to
//  the T3 worker, which reads `classifyProviderError(err).systemic` as "this
//  capability is gone" and kills the whole worker with a CriticalToolError. On an
//  account with BOTH image providers configured, Gemini's endpoint 404ing killed
//  runs that dall-e-3 could have finished — no second provider was ever tried.
//
//  These pin the three decisions that fix is made of: retry a systemic failure on
//  a different provider, do NOT retry anything else, and only report the
//  capability dead once every configured provider has actually been asked.

const OPENAI_CFG: ProviderConfig = { type: 'openai', apiKey: 'sk-test' };
const GEMINI_CFG: ProviderConfig = { type: 'gemini', apiKey: 'gm-test' };

const RUN_OPTS: ToolExecuteOptions = { tierId: 't', sessionId: 's', requireApproval: false };

/**
 * Exactly what a caller sees out of generate.ts.
 *
 * Its `callProvider` classifies the raw failure and then throws a NEW Error
 * carrying only the prose — the HTTP status is gone by the time the tool catches
 * it. So the tool has to re-classify from text, and building the fixtures
 * through the real classifier is what proves that round-trip still lands on
 * `systemic` rather than testing against a message shape generate.ts never emits.
 */
function asGenerateThrows(raw: unknown, modelId: string): Error {
  return new Error(describeProviderError(classifyProviderError(raw), modelId));
}

/** A 404 from Gemini's image endpoint — the exact reported failure. */
const GEMINI_404 = asGenerateThrows(
  Object.assign(new Error('models/gemini-2.5-flash-image is not found for API version v1beta'), { status: 404 }),
  'gemini-2.5-flash-image',
);
/** OpenAI's key is dead too. */
const OPENAI_401 = asGenerateThrows(
  Object.assign(new Error('Incorrect API key provided'), { status: 401 }),
  'dall-e-3',
);
/** A safety refusal: per-task, and it would very plausibly refuse anywhere. */
const BLOCKED = asGenerateThrows(
  new Error('Image request was blocked by the provider (SAFETY).'),
  'gemini-2.5-flash-image',
);

function asset(modelId: string, provider: string): GeneratedAsset {
  return {
    data: Buffer.from('pixels'),
    mimeType: 'image/png',
    filename: `${modelId}.png`,
    modelId,
    provider,
  };
}

/** An account with BOTH image providers configured and keyed. */
function imageToolWith(providers: Array<'openai' | 'gemini'>) {
  const tools = buildMediaTools({
    registry: new MultimodalRegistry(providers),
    sink: async (a: GeneratedAsset) => `/w/${a.filename}`,
    lookupProvider: (p) => (p === 'openai' ? OPENAI_CFG : p === 'gemini' ? GEMINI_CFG : undefined),
  });
  return tools.find((t) => t.name === 'generate_image')!;
}

/** Which capability each generateImage call was aimed at. */
function attemptedProviders(): string[] {
  return generateImageMock.mock.calls.map((c) => (c[0] as { provider: string }).provider);
}

describe('generate_image falls back across providers before declaring the capability dead', () => {
  beforeEach(() => { generateImageMock.mockReset(); });

  it('retries a systemic failure on the other configured provider and reports the model that actually drew', async () => {
    // Gemini is the automatic pick (cheaper) and it 404s. dall-e-3 is right
    // there with a working key.
    generateImageMock
      .mockRejectedValueOnce(GEMINI_404)
      .mockResolvedValueOnce(asset('dall-e-3', 'openai'));

    const signal = new AbortController().signal;
    const out = await imageToolWith(['openai', 'gemini']).execute(
      { prompt: 'a cat' },
      { ...RUN_OPTS, signal },
    );

    expect(attemptedProviders()).toEqual(['gemini', 'openai']);
    // The retry must carry the OTHER provider's config, not the failed one's —
    // retrying dall-e-3 with the Gemini key would just fail differently.
    expect(generateImageMock.mock.calls[1]![1]).toBe(OPENAI_CFG);
    // Cancellation still has to reach the retry; a run killed mid-fallback
    // must not keep paying for an image nobody will see.
    expect(generateImageMock.mock.calls[1]![3]).toBe(signal);

    // Same result shape as an un-fallen-back call…
    expect(out).toContain('Image generated and saved to /w/dall-e-3.png.');
    expect(out).toContain('reference it as: ![description](/w/dall-e-3.png)');
    // …but the reported model is the one that produced the bytes.
    expect(out).toContain('Model: dall-e-3');
    expect(out).not.toContain('Model: gemini-2.5-flash-image');
    // And the broken provider is still surfaced — the run succeeded, so nothing
    // else will ever mention that a configured key is dead.
    expect(out).toContain('gemini failed first');
  });

  it('honours an explicit model request and still falls back off it when it fails systemically', async () => {
    generateImageMock
      .mockRejectedValueOnce(OPENAI_401)
      .mockResolvedValueOnce(asset('gemini-2.5-flash-image', 'gemini'));

    const out = await imageToolWith(['openai', 'gemini']).execute(
      { prompt: 'a cat', model: 'dall-e-3' },
      RUN_OPTS,
    );

    expect(attemptedProviders()).toEqual(['openai', 'gemini']);
    expect(out).toContain('Model: gemini-2.5-flash-image');
  });

  it('propagates an error naming every provider tried when they all fail systemically', async () => {
    // This is the case where the worker SHOULD escalate: nothing on this
    // account can draw. t3-worker's CriticalToolError fast-fail is correct
    // here, so the tool's job is only to make sure it fires with the full story.
    generateImageMock
      .mockRejectedValueOnce(GEMINI_404)
      .mockRejectedValueOnce(OPENAI_401);

    const err = await imageToolWith(['openai', 'gemini'])
      .execute({ prompt: 'a cat' }, RUN_OPTS)
      .then(() => null, (e: unknown) => e as Error & { systemic?: boolean });

    expect(err).toBeInstanceOf(Error);
    expect(attemptedProviders()).toEqual(['gemini', 'openai']);
    // Both providers named, with each one's own words kept.
    expect(err!.message).toContain('gemini-2.5-flash-image');
    expect(err!.message).toContain('dall-e-3');
    expect(err!.message).toContain('every configured provider');
    // Tagged, so the worker escalates deterministically instead of re-deriving
    // "systemic" from prose — and the classifier agrees either way.
    expect(err!.systemic).toBe(true);
    expect(classifyProviderError(err).systemic).toBe(true);
  });

  it('does not spend a second provider call on a non-systemic failure', async () => {
    // A safety refusal is about the PROMPT, not the provider. Retrying it
    // elsewhere burns latency and money to get refused again.
    generateImageMock.mockRejectedValueOnce(BLOCKED);

    await expect(
      imageToolWith(['openai', 'gemini']).execute({ prompt: 'something refused' }, RUN_OPTS),
    ).rejects.toThrow(/safety filter/);

    expect(generateImageMock).toHaveBeenCalledTimes(1);
    expect(attemptedProviders()).toEqual(['gemini']);
  });

  it('does not retry after the run is cancelled', async () => {
    // An in-flight call rejecting as the user cancels can carry any message at
    // all; "the user said stop" outranks whatever it classifies as.
    const ac = new AbortController();
    generateImageMock.mockImplementationOnce(async () => { ac.abort(); throw GEMINI_404; });

    await expect(
      imageToolWith(['openai', 'gemini']).execute({ prompt: 'a cat' }, { ...RUN_OPTS, signal: ac.signal }),
    ).rejects.toThrow();

    expect(generateImageMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a single-provider account exactly as it was: the original error, unwrapped', async () => {
    // Gemini alone has nothing to fall back TO, so the fix must be a no-op —
    // same error object the worker used to fast-fail on.
    generateImageMock.mockRejectedValueOnce(GEMINI_404);

    await expect(
      imageToolWith(['gemini']).execute({ prompt: 'a cat' }, RUN_OPTS),
    ).rejects.toBe(GEMINI_404);

    expect(generateImageMock).toHaveBeenCalledTimes(1);
  });

  it('skips a provider whose config does not resolve rather than counting it as tried', async () => {
    // The registry says a capability is usable; the key lookup is what decides
    // whether it can actually be called. A capability with no config is not a
    // fallback, it is a second way to fail.
    const tools = buildMediaTools({
      registry: new MultimodalRegistry(['openai', 'gemini']),
      sink: async (a: GeneratedAsset) => `/w/${a.filename}`,
      lookupProvider: (p) => (p === 'gemini' ? GEMINI_CFG : undefined), // no OpenAI key
    });
    generateImageMock.mockRejectedValueOnce(GEMINI_404);

    await expect(
      tools.find((t) => t.name === 'generate_image')!.execute({ prompt: 'a cat' }, RUN_OPTS),
    ).rejects.toBe(GEMINI_404);

    expect(generateImageMock).toHaveBeenCalledTimes(1);
  });
});
