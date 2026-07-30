// ─────────────────────────────────────────────
//  Cascade AI — Multimodal generation execution
// ─────────────────────────────────────────────
//
//  The registry decides WHICH model. This calls it.
//
//  Every generator returns bytes plus the mime type, never a provider URL.
//  OpenAI's image URLs expire in about an hour and Google's are signed and
//  short-lived, so handing one to a caller produces an artifact that works in
//  testing and is dead by the time anyone opens it. Fetching the bytes here
//  means a generated asset behaves like every other file Cascade produces.

import type { ProviderConfig } from '../../types.js';
import { classifyProviderError, describeProviderError } from '../router/provider-errors.js';
import type { GenerationCapability } from './registry.js';

export interface GeneratedAsset {
  /** Raw bytes of the asset. */
  data: Buffer;
  mimeType: string;
  /** Suggested filename, extension included. */
  filename: string;
  modelId: string;
  provider: string;
  /** Provider-side revision of the prompt, when it reports one (DALL·E does). */
  revisedPrompt?: string;
}

export interface ImageRequest {
  prompt: string;
  /** e.g. "1024x1024". Passed through; the provider validates it. */
  size?: string;
}

export interface SpeechRequest {
  text: string;
  /** OpenAI voice id (alloy, echo, fable, onyx, nova, shimmer). */
  voice?: string;
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav';
}

export interface VideoRequest {
  prompt: string;
  /** Clip length in seconds. Billed per second — an 8s clip is 8x a 1s one. */
  seconds?: number;
  /** "16:9" (default) or "9:16". */
  aspectRatio?: string;
}

export interface TranscriptionRequest {
  audio: Buffer;
  filename: string;
  /** ISO-639-1 hint; improves accuracy when known. */
  language?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Wrap a provider call so a failure carries the same classified, actionable
 * message the chat tiers produce. A generation failure used to surface as a raw
 * SDK stack; there is no reason a dead key should read differently here than it
 * does in a T3 worker.
 */
async function callProvider<T>(fn: () => Promise<T>, modelId: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const classified = classifyProviderError(err);
    throw new Error(describeProviderError(classified, modelId));
  }
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      // Carry the provider's own words through, and the status, so
      // classifyProviderError can tell a 429 from a 401.
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(text || res.statusText), { status: res.status });
    }
    return res;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function baseUrlFor(cfg: ProviderConfig, fallback: string): string {
  return (cfg.baseUrl ?? fallback).replace(/\/+$/, '');
}

function stamp(ext: string): string {
  return `cascade-${Date.now()}.${ext}`;
}

/**
 * Gemini's image models take a named aspect ratio (`generationConfig.
 * imageConfig.aspectRatio`), not a free-form pixel WxH like OpenAI's — there
 * is no arbitrary-size control at all.
 * https://ai.google.dev/gemini-api/docs/image-generation
 *
 * `req.size` arrives as an OpenAI-shaped "WxH" string (the tool's own schema
 * mirrors dall-e-3's accepted sizes: "1024x1024", "1792x1024", "1024x1792").
 * Map it onto whichever of Gemini's ratios its numeric ratio is closest to,
 * so a landscape/portrait request still lands roughly right instead of
 * silently defaulting to square — which is what happened before this existed:
 * the size was parsed by the tool schema and then simply never read here.
 */
const GEMINI_ASPECT_RATIOS: ReadonlyArray<readonly [string, number]> = [
  ['1:1', 1 / 1], ['3:2', 3 / 2], ['2:3', 2 / 3], ['3:4', 3 / 4], ['4:3', 4 / 3],
  ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9],
];

function closestGeminiAspectRatio(size: string): string | undefined {
  const m = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return undefined;
  const ratio = w / h;
  return GEMINI_ASPECT_RATIOS.reduce((best, cand) =>
    Math.abs(cand[1] - ratio) < Math.abs(best[1] - ratio) ? cand : best,
  )[0];
}

// ── Image ─────────────────────────────────────

export async function generateImage(
  cap: GenerationCapability,
  cfg: ProviderConfig,
  req: ImageRequest,
  signal?: AbortSignal,
): Promise<GeneratedAsset> {
  return callProvider(async () => {
    if (cap.api === 'openai-images') {
      const url = `${baseUrlFor(cfg, 'https://api.openai.com/v1')}/images/generations`;
      const res = await postJson(url, {
        model: cap.modelId,
        prompt: req.prompt,
        size: req.size ?? '1024x1024',
        n: 1,
        // b64 rather than a URL: see the file header — provider URLs expire.
        response_format: 'b64_json',
      }, { Authorization: `Bearer ${cfg.apiKey ?? ''}` }, signal);

      const body = await res.json() as {
        data?: Array<{ b64_json?: string; revised_prompt?: string }>;
      };
      const first = body.data?.[0];
      if (!first?.b64_json) throw new Error('Image response contained no image data.');
      return {
        data: Buffer.from(first.b64_json, 'base64'),
        mimeType: 'image/png',
        filename: stamp('png'),
        modelId: cap.modelId,
        provider: cap.provider,
        ...(first.revised_prompt ? { revisedPrompt: first.revised_prompt } : {}),
      };
    }

    if (cap.api === 'gemini-generate-content') {
      // Gemini's image models are ordinary generateContent calls, not Imagen's
      // `:predict`. The image comes back as an inlineData PART alongside any
      // commentary text, rather than in a `predictions[]` array — so this reads
      // nothing like the Imagen shape it replaced.
      const base = baseUrlFor(cfg, 'https://generativelanguage.googleapis.com/v1beta');
      const url = `${base}/models/${encodeURIComponent(cap.modelId)}:generateContent`;
      const aspectRatio = req.size ? closestGeminiAspectRatio(req.size) : undefined;
      const res = await postJson(url, {
        contents: [{ parts: [{ text: req.prompt }] }],
        generationConfig: {
          // Asked for explicitly: these models can answer with text only, and a
          // text-only reply to "draw me a cat" is a failed image generation.
          responseModalities: ['IMAGE', 'TEXT'],
          // Gemini has no free-form pixel size — only a named aspect ratio (see
          // closestGeminiAspectRatio). Omitted entirely when there's no
          // requested size, or no supported ratio close enough to bother with.
          ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
        },
      }, { 'x-goog-api-key': cfg.apiKey ?? '' }, signal);

      const body = await res.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> };
          finishReason?: string;
        }>;
        promptFeedback?: { blockReason?: string };
      };

      // Walk the parts for the first one carrying bytes. Same reason the chat
      // provider walks parts by hand (see providers/gemini.ts): a response can
      // mix text, thinking and inline data, and index 0 is not reliably the
      // image.
      const candidate = body.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const image = parts.find((p) => p.inlineData?.data)?.inlineData;
      if (!image?.data) {
        // Distinguish "refused" from "empty" — a safety block returns a
        // perfectly well-formed response with no image in it, and reporting
        // that as a generic parse failure sends the user hunting a bug that
        // isn't there. Two different places can carry the refusal: a
        // PROMPT-level block on `promptFeedback` (checked before generation
        // even starts), or a CANDIDATE-level stop on `finishReason` — Gemini's
        // image safety filters commonly stop generation with a reason like
        // `SAFETY`/`PROHIBITED_CONTENT`/`IMAGE_SAFETY` and no `blockReason` on
        // `promptFeedback` at all, since the prompt itself was accepted; it's
        // what came back that was refused. `STOP` is the only non-refusal
        // value, so anything else present is treated as a block.
        const blocked = body.promptFeedback?.blockReason
          ?? (candidate?.finishReason && candidate.finishReason !== 'STOP' ? candidate.finishReason : undefined);
        if (blocked) throw new Error(`Image request was blocked by the provider (${blocked}).`);
        const said = parts.find((p) => p.text)?.text?.trim();
        throw new Error(
          'Image response contained no image data.' + (said ? ` The model replied with text instead: ${said}` : ''),
        );
      }
      const mimeType = image.mimeType ?? 'image/png';
      return {
        data: Buffer.from(image.data, 'base64'),
        mimeType,
        filename: stamp(mimeType.includes('jpeg') ? 'jpg' : 'png'),
        modelId: cap.modelId,
        provider: cap.provider,
      };
    }

    throw new Error(`${cap.modelId} is not an image generator.`);
  }, cap.modelId);
}

// ── Speech (text → audio) ─────────────────────

export async function generateSpeech(
  cap: GenerationCapability,
  cfg: ProviderConfig,
  req: SpeechRequest,
  signal?: AbortSignal,
): Promise<GeneratedAsset> {
  return callProvider(async () => {
    if (cap.api !== 'openai-speech') throw new Error(`${cap.modelId} is not a speech model.`);
    const format = req.format ?? 'mp3';
    const url = `${baseUrlFor(cfg, 'https://api.openai.com/v1')}/audio/speech`;
    const res = await postJson(url, {
      model: cap.modelId,
      input: req.text,
      voice: req.voice ?? 'alloy',
      response_format: format,
    }, { Authorization: `Bearer ${cfg.apiKey ?? ''}` }, signal);

    const mime: Record<string, string> = {
      mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac',
      flac: 'audio/flac', wav: 'audio/wav',
    };
    return {
      data: Buffer.from(await res.arrayBuffer()),
      mimeType: mime[format] ?? 'application/octet-stream',
      filename: stamp(format),
      modelId: cap.modelId,
      provider: cap.provider,
    };
  }, cap.modelId);
}

// ── Video (long-running) ──────────────────────

/** How often to ask whether the video is done. */
const VIDEO_POLL_INTERVAL_MS = 10_000;
/** Give up after this long. Veo typically lands in 1–3 minutes. */
const VIDEO_TIMEOUT_MS = 8 * 60_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled.'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('Cancelled.'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Generate a video.
 *
 * Unlike every other generator here, this is a long-running operation: the
 * submit call returns an operation name, not a result, and the video appears
 * minutes later. So the shape is submit → poll → fetch bytes, and the caller is
 * kept informed via `onProgress` because a silent two-minute wait is
 * indistinguishable from a hang.
 *
 * The final asset arrives as a short-lived signed URL that needs the API key to
 * download, so the bytes are fetched here for the same reason as everywhere
 * else in this file: a URL-based artifact is dead by the time anyone opens it.
 */
export async function generateVideo(
  cap: GenerationCapability,
  cfg: ProviderConfig,
  req: VideoRequest,
  signal?: AbortSignal,
  onProgress?: (note: string) => void,
): Promise<GeneratedAsset> {
  return callProvider(async () => {
    if (cap.api !== 'gemini-predict-lro') throw new Error(`${cap.modelId} is not a video generator.`);
    const base = baseUrlFor(cfg, 'https://generativelanguage.googleapis.com/v1beta');
    const key = cfg.apiKey ?? '';
    const headers = { 'x-goog-api-key': key };

    // ── Submit ──
    const submit = await postJson(
      `${base}/models/${encodeURIComponent(cap.modelId)}:predictLongRunning`,
      {
        instances: [{ prompt: req.prompt }],
        parameters: {
          aspectRatio: req.aspectRatio ?? '16:9',
          ...(req.seconds ? { durationSeconds: req.seconds } : {}),
        },
      },
      headers,
      signal,
    );
    const started = await submit.json() as { name?: string };
    if (!started.name) throw new Error('Video request was accepted but returned no operation to poll.');
    onProgress?.(`Video generation started (${cap.modelId}). This usually takes 1-3 minutes.`);

    // ── Poll ──
    const deadline = Date.now() + VIDEO_TIMEOUT_MS;
    let operation: {
      done?: boolean;
      error?: { message?: string };
      response?: {
        generateVideoResponse?: {
          generatedSamples?: Array<{ video?: { uri?: string } }>;
        };
      };
    } = {};

    while (Date.now() < deadline) {
      await sleep(VIDEO_POLL_INTERVAL_MS, signal);
      const poll = await fetch(`${base}/${started.name}`, { headers, signal });
      if (!poll.ok) {
        const text = await poll.text().catch(() => '');
        throw Object.assign(new Error(text || poll.statusText), { status: poll.status });
      }
      operation = await poll.json() as typeof operation;
      if (operation.done) break;
      onProgress?.('Still rendering…');
    }

    if (!operation.done) {
      throw new Error(
        `Video was still rendering after ${Math.round(VIDEO_TIMEOUT_MS / 60_000)} minutes. ` +
        'It may still complete on the provider side, but Cascade stopped waiting.',
      );
    }
    // A finished operation can still carry a failure; `done` means "no longer
    // running", not "succeeded".
    if (operation.error?.message) throw new Error(operation.error.message);

    const uri = operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) throw new Error('Video finished but the response contained no video.');

    // ── Fetch the bytes ──
    // The signed URI still requires the key, and expires — download now.
    const media = await fetch(uri, { headers, signal });
    if (!media.ok) throw new Error(`Video finished but could not be downloaded (HTTP ${media.status}).`);

    return {
      data: Buffer.from(await media.arrayBuffer()),
      mimeType: 'video/mp4',
      filename: stamp('mp4'),
      modelId: cap.modelId,
      provider: cap.provider,
    };
  }, cap.modelId);
}

// ── Transcription (audio → text) ──────────────

export async function transcribeAudio(
  cap: GenerationCapability,
  cfg: ProviderConfig,
  req: TranscriptionRequest,
  signal?: AbortSignal,
): Promise<{ text: string; modelId: string }> {
  return callProvider(async () => {
    if (cap.api !== 'openai-transcriptions') throw new Error(`${cap.modelId} is not a transcription model.`);
    const url = `${baseUrlFor(cfg, 'https://api.openai.com/v1')}/audio/transcriptions`;

    // multipart/form-data — the one endpoint here that isn't JSON.
    const form = new FormData();
    form.append('model', cap.modelId);
    if (req.language) form.append('language', req.language);
    form.append('file', new Blob([new Uint8Array(req.audio)]), req.filename);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey ?? ''}` },
        body: form,
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(text || res.statusText), { status: res.status });
      }
      const body = await res.json() as { text?: string };
      return { text: body.text ?? '', modelId: cap.modelId };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }, cap.modelId);
}
