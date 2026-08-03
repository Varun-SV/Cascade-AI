// ─────────────────────────────────────────────
//  Cascade AI — Multimodal execution: Gemini image generation
// ─────────────────────────────────────────────
//
//  These cover the migration off Imagen's `:predict` API, which Google is
//  shutting down on 2026-08-17 and which already 404s for new keys ("This model
//  models/imagen-4.0-generate-001 is no longer available to new users"). The
//  replacement is not another Imagen id — it is `gemini-2.5-flash-image` on the
//  ordinary generateContent endpoint, whose request AND response shapes are
//  completely different. So the endpoint, the request body and the response
//  parse are all asserted: swapping only one of the three is exactly how a 404
//  becomes a silent "no image data" instead of a working picture.
//
//  Response shape mirrors Google's own raw-REST clients (google-gemini/glanceboard
//  reads `part["inlineData"]["data"]`; cookbook's Batch_mode reads
//  `part['inlineData']['mimeType']`): candidates[].content.parts[], where the
//  image is an `inlineData` part carrying base64 `data` + `mimeType`, sitting
//  alongside any commentary text parts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../types.js';
import { generateImage, generateVideo } from './generate.js';
import { allCapabilities } from './registry.js';
import { classifyProviderError } from '../router/provider-errors.js';

const CFG: ProviderConfig = { type: 'gemini', apiKey: 'test-key' };

/** The real catalogue entry — so a registry regression fails these too. */
const GEMINI_IMAGE = allCapabilities().find(
  (c) => c.modality === 'image' && c.provider === 'gemini',
)!;

const PNG_BYTES = Buffer.from('\x89PNG\r\n\x1a\n-pretend-pixels-', 'binary');

interface Call { url: string; body: any; headers: Record<string, string> }

/** Stub fetch with a canned JSON body; returns the calls it received. */
function stubFetch(json: unknown, ok = true, status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return {
      ok,
      status,
      statusText: 'Error',
      json: async () => json,
      text: async () => (typeof json === 'string' ? json : JSON.stringify(json)),
    } as unknown as Response;
  }));
  return calls;
}

/** A generateContent response carrying an image part. */
function imageResponse(parts: unknown[]) {
  return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('generateImage — Gemini generateContent', () => {
  it('calls :generateContent with a Gemini-shaped body, never Imagen :predict', async () => {
    const calls = stubFetch(imageResponse([
      { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
    ]));

    await generateImage(GEMINI_IMAGE, CFG, { prompt: 'a cat wearing a hat' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    // The endpoint is the whole point of the migration.
    expect(call!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    );
    expect(call!.url).not.toContain(':predict');
    // Gemini's contents/parts request, not Imagen's instances/parameters one.
    expect(call!.body).toMatchObject({ contents: [{ parts: [{ text: 'a cat wearing a hat' }] }] });
    expect(call!.body.instances).toBeUndefined();
    // These models can answer in text; ask for an image explicitly.
    expect(call!.body.generationConfig.responseModalities).toContain('IMAGE');
    expect(call!.headers['x-goog-api-key']).toBe('test-key');
  });

  it('decodes the inlineData part into bytes', async () => {
    stubFetch(imageResponse([
      { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
    ]));

    const asset = await generateImage(GEMINI_IMAGE, CFG, { prompt: 'a cat' });

    expect(asset.data.equals(PNG_BYTES)).toBe(true);
    expect(asset.mimeType).toBe('image/png');
    expect(asset.filename).toMatch(/^cascade-\d+\.png$/);
    expect(asset.modelId).toBe('gemini-2.5-flash-image');
    expect(asset.provider).toBe('gemini');
  });

  it('finds the image part even when the model talks first', async () => {
    // Real responses interleave commentary with the picture, so parts[0] is not
    // reliably the image — the same reason providers/gemini.ts walks parts by
    // hand rather than trusting an index.
    stubFetch(imageResponse([
      { text: "Here's the cat you asked for!" },
      { inlineData: { mimeType: 'image/jpeg', data: PNG_BYTES.toString('base64') } },
    ]));

    const asset = await generateImage(GEMINI_IMAGE, CFG, { prompt: 'a cat' });

    expect(asset.data.equals(PNG_BYTES)).toBe(true);
    expect(asset.mimeType).toBe('image/jpeg');
    expect(asset.filename).toMatch(/\.jpg$/);
  });

  it('reports what the model said when it answers with text and no image', async () => {
    // A well-formed response with no picture in it. Saying only "no image data"
    // sends the user hunting a parse bug that is not there.
    stubFetch(imageResponse([{ text: 'I cannot create that image.' }]));

    await expect(generateImage(GEMINI_IMAGE, CFG, { prompt: 'a cat' }))
      .rejects.toThrow(/replied with text instead: I cannot create that image\./);
  });

  it('surfaces a safety block as a block, not as an empty response', async () => {
    stubFetch({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } });

    await expect(generateImage(GEMINI_IMAGE, CFG, { prompt: 'something disallowed' }))
      .rejects.toThrow(/blocked by the provider \(SAFETY\)/);
  });

  it('surfaces a CANDIDATE-level safety stop as a block too, not a generic empty response', async () => {
    // Regression: promptFeedback.blockReason is reserved for a block BEFORE
    // generation starts — a prompt that was accepted but whose OUTPUT tripped
    // an image safety filter reports the refusal on candidates[0].finishReason
    // instead, with no promptFeedback at all. Falling through to the generic
    // "no image data" error hid the refusal and left it classified 'unknown'
    // (non-systemic by accident) rather than the correct 'content_filter'.
    stubFetch({
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'IMAGE_SAFETY' }],
    });

    await expect(generateImage(GEMINI_IMAGE, CFG, { prompt: 'something borderline' }))
      .rejects.toThrow(/blocked by the provider \(IMAGE_SAFETY\)/);
  });

  it('does not treat an ordinary STOP finish as a block', async () => {
    // The existing "answers with text and no image" case already carries
    // finishReason: 'STOP' via imageResponse() — this pins that a normal STOP
    // must never be misread as a refusal.
    stubFetch(imageResponse([{ text: 'no picture, just words' }]));

    await expect(generateImage(GEMINI_IMAGE, CFG, { prompt: 'a cat' }))
      .rejects.toThrow(/no image data/);
  });

  it('classifies a provider HTTP failure instead of leaking a raw response', async () => {
    // The live symptom that started this: a 404 from the retired Imagen id.
    stubFetch('This model is no longer available to new users.', false, 404);

    await expect(generateImage(GEMINI_IMAGE, CFG, { prompt: 'a cat' }))
      .rejects.toThrow(/Model unavailable on gemini-2\.5-flash-image/);
  });

  it('maps an OpenAI-shaped size onto the closest Gemini aspect ratio', async () => {
    // Regression: Gemini has no free-form pixel size, only named ratios — the
    // tool's requested "size" was parsed and then simply never forwarded, so
    // an explicit landscape/portrait request silently rendered square.
    const calls = stubFetch(imageResponse([
      { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
    ]));

    await generateImage(GEMINI_IMAGE, CFG, { prompt: 'a banner', size: '1792x1024' });

    expect(calls[0]!.body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' });
  });

  it('maps a portrait size onto 9:16', async () => {
    const calls = stubFetch(imageResponse([
      { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
    ]));

    await generateImage(GEMINI_IMAGE, CFG, { prompt: 'a poster', size: '1024x1792' });

    expect(calls[0]!.body.generationConfig.imageConfig).toEqual({ aspectRatio: '9:16' });
  });

  it('omits imageConfig entirely when no size is requested', async () => {
    const calls = stubFetch(imageResponse([
      { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
    ]));

    await generateImage(GEMINI_IMAGE, CFG, { prompt: 'a cat' });

    expect(calls[0]!.body.generationConfig.imageConfig).toBeUndefined();
  });

  it('honours a configured baseUrl override', async () => {
    const calls = stubFetch(imageResponse([
      { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
    ]));

    await generateImage(
      GEMINI_IMAGE,
      { ...CFG, baseUrl: 'https://proxy.example/v1beta/' },
      { prompt: 'a cat' },
    );

    expect(calls[0]!.url).toBe(
      'https://proxy.example/v1beta/models/gemini-2.5-flash-image:generateContent',
    );
  });
});

// Live-reported bug: generate_video failed unrecoverably with a 404 on
// `veo-3.1-generate-001`. That id is Vertex AI's — the Gemini DEVELOPER API
// (generativelanguage.googleapis.com, what this file actually calls) uses
// `veo-3.1-generate-preview` instead, and Veo 3.1 has no non-preview id there
// yet. generateVideo() had zero real test coverage before this (every other
// test file only mocks it), which is exactly how the wrong id shipped unnoticed.
describe('generateVideo — Gemini predictLongRunning', () => {
  const GEMINI_VIDEO = allCapabilities().find(
    (c) => c.modality === 'video' && c.provider === 'gemini',
  )!;

  /** Stub fetch with one response per call, in order; the last one repeats if exhausted. */
  function stubFetchSequence(
    responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string; bytes?: Buffer }>,
  ): Call[] {
    const calls: Call[] = [];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers });
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        statusText: 'Error',
        json: async () => r.json,
        text: async () => r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : ''),
        arrayBuffer: async () => {
          const b = r.bytes ?? Buffer.alloc(0);
          // `Buffer.buffer` is the underlying pooled ArrayBuffer, not
          // necessarily sized to this Buffer alone — slice by byteOffset/
          // byteLength or a short test buffer can pick up neighboring bytes.
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
      } as unknown as Response;
    }));
    return calls;
  }

  const operation = (done: boolean, extra: Record<string, unknown> = {}) => ({
    ok: true,
    json: { name: 'operations/abc123', done, ...extra },
  });
  const finished = (uri: string) => operation(true, {
    response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } },
  });

  it('submits to :predictLongRunning with the FIXED model id, never the retired Vertex one', async () => {
    const calls = stubFetchSequence([
      { ok: true, json: { name: 'operations/abc123' } },
      finished('https://example.com/signed/video.mp4'),
      { ok: true, bytes: Buffer.from('fake-mp4-bytes') },
    ]);

    vi.useFakeTimers();
    try {
      const promise = generateVideo(GEMINI_VIDEO, CFG, { prompt: 'a cat skateboarding' });
      await vi.advanceTimersByTimeAsync(10_000); // the one poll interval before the "done" poll
      await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning',
    );
    expect(calls[0]!.url).not.toContain('veo-3.1-generate-001');
    expect(calls[0]!.body).toMatchObject({ instances: [{ prompt: 'a cat skateboarding' }] });
    // Default aspect ratio when none is requested.
    expect(calls[0]!.body.parameters).toMatchObject({ aspectRatio: '16:9' });
    expect(calls[0]!.headers['x-goog-api-key']).toBe('test-key');
  });

  it('reproduces the exact reported failure and classifies it as a systemic model-unavailable error', async () => {
    // Verbatim from the live bug report.
    stubFetchSequence([{
      ok: false,
      status: 404,
      json: {
        error: {
          code: 404,
          message: 'models/veo-3.1-generate-001 is not found for API version v1beta, or is not '
            + 'supported for predictLongRunning. Call ModelService.ListModels to see the list of '
            + 'available models and their supported methods.',
          status: 'NOT_FOUND',
        },
      },
    }]);

    await expect(generateVideo(GEMINI_VIDEO, CFG, { prompt: 'a cat' }))
      .rejects.toThrow(/Model unavailable on veo-3\.1-generate-preview/);
  });

  it('passes through an explicit aspect ratio and duration', async () => {
    const calls = stubFetchSequence([
      { ok: true, json: { name: 'operations/abc123' } },
      finished('https://example.com/signed/video.mp4'),
      { ok: true, bytes: Buffer.from('bytes') },
    ]);

    vi.useFakeTimers();
    try {
      const promise = generateVideo(GEMINI_VIDEO, CFG, { prompt: 'a banner clip', aspectRatio: '9:16', seconds: 8 });
      await vi.advanceTimersByTimeAsync(10_000);
      await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(calls[0]!.body.parameters).toEqual({ aspectRatio: '9:16', durationSeconds: 8 });
  });

  it('polls until the operation reports done, then downloads the bytes', async () => {
    vi.useFakeTimers();
    try {
      const calls = stubFetchSequence([
        { ok: true, json: { name: 'operations/abc123' } },
        operation(false), // first poll: still rendering
        finished('https://example.com/signed/video.mp4'), // second poll: done
        { ok: true, bytes: Buffer.from('the-real-video-bytes') },
      ]);

      const promise = generateVideo(GEMINI_VIDEO, CFG, { prompt: 'a cat' });
      await vi.advanceTimersByTimeAsync(10_000); // first poll interval
      await vi.advanceTimersByTimeAsync(10_000); // second poll interval
      const asset = await promise;

      expect(calls).toHaveLength(4);
      expect(calls[1]!.url).toContain('operations/abc123');
      expect(calls[2]!.url).toContain('operations/abc123');
      expect(calls[3]!.url).toBe('https://example.com/signed/video.mp4');
      expect(asset.data.toString()).toBe('the-real-video-bytes');
      expect(asset.mimeType).toBe('video/mp4');
      expect(asset.modelId).toBe('veo-3.1-generate-preview');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up at the deadline with the OUTCOME, not a "Provider said:" wrapper', async () => {
    // The provider said nothing — it is still rendering; Cascade is the one
    // that stopped waiting. Running that through describeProviderError turned
    // the only fact the user needs ("no video exists") into "The model call
    // failed on veo-…. Provider said: …", which reads as a generic swallowed
    // failure and hides that nothing was produced.
    stubFetchSequence([
      { ok: true, json: { name: 'operations/abc123' } },
      operation(false), // never finishes
    ]);

    vi.useFakeTimers();
    let caught: unknown;
    try {
      const promise = generateVideo(GEMINI_VIDEO, CFG, { prompt: 'a cat' }).catch((e: unknown) => { caught = e; });
      await vi.advanceTimersByTimeAsync(8 * 60_000 + 10_000);
      await promise;
    } finally {
      vi.useRealTimers();
    }

    const message = (caught as Error).message;
    expect(message).toMatch(/veo-3\.1-generate-preview timed out after 8 minutes — no video was produced/);
    // The give-up must reach the user as itself, NOT wrapped in the classifier's
    // generic prose — nothing here came from the provider.
    expect(message).not.toContain('Provider said');
    expect(message).not.toContain('The model call failed');
    expect(message.startsWith('veo-3.1-generate-preview timed out')).toBe(true);
  });

  it('classifies that give-up as non-systemic, so no layer retries the 8-minute render', async () => {
    // The T3 worker fast-fails a SYSTEMIC provider error and (since this fix)
    // any provider-backed failure at all — but generate-media.ts's
    // runWithProviderFallback keys on `systemic` to decide whether to pay for a
    // second provider. A timeout must not read as systemic there, or a second
    // video model landing in the catalogue would buy a second 8-minute wait.
    stubFetchSequence([
      { ok: true, json: { name: 'operations/abc123' } },
      operation(false),
    ]);

    vi.useFakeTimers();
    let caught: unknown;
    try {
      const promise = generateVideo(GEMINI_VIDEO, CFG, { prompt: 'a cat' }).catch((e: unknown) => { caught = e; });
      await vi.advanceTimersByTimeAsync(8 * 60_000 + 10_000);
      await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(classifyProviderError(caught).systemic).toBe(false);
  });

  it('surfaces an operation-level failure even though the operation finished ("done" is not "succeeded")', async () => {
    stubFetchSequence([
      { ok: true, json: { name: 'operations/abc123' } },
      operation(true, { error: { message: 'Video generation failed: unsafe content detected.' } }),
    ]);

    vi.useFakeTimers();
    try {
      const promise = generateVideo(GEMINI_VIDEO, CFG, { prompt: 'a cat' });
      // Attach the rejection handler BEFORE advancing the clock — the operation
      // rejects during the timer flush below, and a handler attached only
      // afterward leaves a window where Node reports it as unhandled.
      const assertion = expect(promise).rejects.toThrow(/unsafe content detected/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
