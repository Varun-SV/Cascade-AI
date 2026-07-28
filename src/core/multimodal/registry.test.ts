// ─────────────────────────────────────────────
//  Cascade AI — Multimodal registry + modality classification
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { MultimodalRegistry, allCapabilities, capabilityCost } from './registry.js';
import { classifyModality, isChatModel } from '../../providers/model-filter.js';

describe('modality classification', () => {
  it.each([
    ['text-embedding-3-large', 'embedding'],
    ['whisper-1', 'transcription'],
    ['tts-1-hd', 'speech'],
    ['dall-e-3', 'image'],
    ['gpt-image-1', 'image'],
    ['imagen-4.0-generate-001', 'image'],
    ['veo-3.1-generate-001', 'video'],
    ['sora-2', 'video'],
    ['omni-moderation-latest', 'moderation'],
    ['gpt-4o-realtime-preview', 'realtime'],
    ['davinci-002', 'legacy-completion'],
  ])('%s -> %s', (id, expected) => {
    expect(classifyModality(id)).toBe(expected);
  });

  it('leaves ordinary chat models alone, including vision-capable ones', () => {
    // A vision chat model READS images and writes text — it belongs in the chat
    // pool. Filing it as an image generator would delete it from routing.
    for (const id of ['gpt-4o', 'claude-opus-4-5', 'gemini-3.1-pro', 'gpt-4-vision-preview']) {
      expect(classifyModality(id)).toBe('chat');
      expect(isChatModel(id)).toBe(true);
    }
  });

  it('defaults an unrecognised id to chat rather than guessing a modality', () => {
    // Safe direction: a misfiled chat model still works; a chat model filed as
    // an image generator disappears from the router entirely.
    expect(classifyModality('some-brand-new-model-v9')).toBe('chat');
  });

  it('prefers the provider-reported methods over the id', () => {
    // Gemini says what a model can be called with; that beats any name guess.
    expect(classifyModality('some-opaque-id', ['embedContent'])).toBe('embedding');
    expect(classifyModality('some-opaque-id', ['predict'])).toBe('image');
    expect(classifyModality('some-opaque-id', ['predictLongRunning'])).toBe('video');
  });

  it('agrees with isChatModel on every non-chat family', () => {
    // The two must not drift: anything classified non-chat has to be excluded
    // from the chat pool, or it becomes both a tool and a routing candidate.
    for (const cap of allCapabilities()) {
      expect(isChatModel(cap.modelId)).toBe(false);
      expect(classifyModality(cap.modelId)).not.toBe('chat');
    }
  });
});

describe('capability pricing', () => {
  it('quotes every usable capability from the shared pricing dataset', () => {
    // Same audited source as the chat tiers — a generation model must not be
    // the one place a price gets invented.
    for (const cap of allCapabilities()) {
      expect(capabilityCost(cap), `${cap.modelId} has no price row`).not.toBeNull();
    }
  });

  it('labels the unit, not just the number', () => {
    const dalle = allCapabilities().find((c) => c.modelId === 'dall-e-3')!;
    expect(capabilityCost(dalle)!.label).toMatch(/per image/);
    const tts = allCapabilities().find((c) => c.modelId === 'tts-1')!;
    expect(capabilityCost(tts)!.label).toMatch(/per character/);
  });
});

describe('MultimodalRegistry', () => {
  it('offers nothing when no provider is configured', () => {
    const r = new MultimodalRegistry([]);
    expect(r.availableModalities()).toEqual([]);
    expect(r.select('image')).toBeNull();
    expect(r.describe()).toContain('No generation models are available');
  });

  it('only offers capabilities whose provider is configured', () => {
    const openaiOnly = new MultimodalRegistry(['openai']);
    expect(openaiOnly.select('image')!.capability.provider).toBe('openai');
    // Gemini's image model exists in the catalogue but there is no key for it.
    expect(openaiOnly.usable('image').map((c) => c.modelId)).toEqual(['dall-e-3']);

    const geminiOnly = new MultimodalRegistry(['gemini']);
    expect(geminiOnly.select('image')!.capability.modelId).toBe('imagen-4.0-generate-001');
    // No OpenAI key ⇒ no speech or transcription at all.
    expect(geminiOnly.select('speech')).toBeNull();
    expect(geminiOnly.select('transcription')).toBeNull();
  });

  it('offers video now that the polling path exists', () => {
    const r = new MultimodalRegistry(['gemini']);
    const pick = r.select('video')!;
    expect(pick.capability.modelId).toBe('veo-3.1-generate-001');
    // The long-running shape is recorded on the capability so the executor can
    // switch on it rather than guessing from the model name.
    expect(pick.capability.api).toBe('gemini-predict-lro');
    expect(r.availableModalities()).toContain('video');
  });

  it('still never offers a capability marked unsupported', () => {
    // The guard stays even with the catalogue currently empty of them — it is
    // what keeps a future not-yet-wired entry from becoming a failing tool.
    const r = new MultimodalRegistry(['openai', 'gemini']);
    expect(r.usable().every((c) => !c.unsupported)).toBe(true);
  });

  it('prices video per second, so the caller can multiply by duration', () => {
    const r = new MultimodalRegistry(['gemini']);
    const cost = r.select('video')!.cost!;
    expect(cost.unit).toBe('per second of video');
    // An 8-second clip is 8x this — the reason the tool clamps duration.
    expect(cost.amount).toBeGreaterThan(0);
  });

  it('prefers a ranked model over an unranked one', () => {
    // tts-1-hd carries the only defensible quality claim in the table.
    const r = new MultimodalRegistry(['openai']);
    const pick = r.select('speech')!;
    expect(pick.capability.modelId).toBe('tts-1-hd');
    expect(pick.reason).toContain('ranked highest');
  });

  it('says plainly when a choice was made on price, not quality', () => {
    // Image models carry no quality prior, so the reason must not imply one.
    const r = new MultimodalRegistry(['openai', 'gemini']);
    const pick = r.select('image')!;
    expect(pick.reason).toContain('cost choice, not a quality one');
    // Cheapest of the two priced options.
    expect(pick.capability.modelId).toBe('dall-e-3');
  });

  it('honours an explicit model request over the automatic choice', () => {
    const r = new MultimodalRegistry(['openai', 'gemini']);
    const pick = r.select('image', { preferModel: 'imagen-4.0-generate-001' })!;
    expect(pick.capability.modelId).toBe('imagen-4.0-generate-001');
    expect(pick.reason).toContain('Requested explicitly');
  });

  it('ignores an unusable explicit request rather than failing the call', () => {
    // Naming a model there is no key for should fall back, not dead-end.
    const r = new MultimodalRegistry(['openai']);
    const pick = r.select('image', { preferModel: 'imagen-4.0-generate-001' })!;
    expect(pick.capability.modelId).toBe('dall-e-3');
  });

  it('tells the planner what it cannot do, not just what it can', () => {
    const r = new MultimodalRegistry(['openai', 'gemini']);
    const described = r.describe();
    expect(described).toContain('dall-e-3');
    // The two most commonly assumed-present capabilities. A planner that
    // assumes either writes a step that can never run.
    expect(described).toContain('music: no supported provider');
  });
});
