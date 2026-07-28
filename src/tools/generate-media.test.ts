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

import { describe, expect, it } from 'vitest';
import { buildMediaTools } from './generate-media.js';
import { MultimodalRegistry } from '../core/multimodal/registry.js';
import type { GeneratedAsset } from '../core/multimodal/generate.js';

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
