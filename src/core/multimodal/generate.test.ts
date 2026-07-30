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
import { generateImage } from './generate.js';
import { allCapabilities } from './registry.js';

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
