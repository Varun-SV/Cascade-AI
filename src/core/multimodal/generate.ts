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

    if (cap.api === 'gemini-predict') {
      const base = baseUrlFor(cfg, 'https://generativelanguage.googleapis.com/v1beta');
      const url = `${base}/models/${encodeURIComponent(cap.modelId)}:predict`;
      const res = await postJson(url, {
        instances: [{ prompt: req.prompt }],
        parameters: { sampleCount: 1 },
      }, { 'x-goog-api-key': cfg.apiKey ?? '' }, signal);

      const body = await res.json() as {
        predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
      };
      const first = body.predictions?.[0];
      if (!first?.bytesBase64Encoded) throw new Error('Image response contained no image data.');
      const mimeType = first.mimeType ?? 'image/png';
      return {
        data: Buffer.from(first.bytesBase64Encoded, 'base64'),
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
