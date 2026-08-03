// ─────────────────────────────────────────────
//  Cascade AI — Multimodal registry + modality classification
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  MultimodalRegistry,
  allCapabilities,
  capabilityCost,
  describeGenerationForPlanner,
} from './registry.js';
import { classifyModality, isChatModel } from '../../providers/model-filter.js';

describe('modality classification', () => {
  it.each([
    ['text-embedding-3-large', 'embedding'],
    ['whisper-1', 'transcription'],
    ['tts-1-hd', 'speech'],
    ['dall-e-3', 'image'],
    ['gpt-image-1', 'image'],
    ['imagen-4.0-generate-001', 'image'],
    // The generateContent-era Gemini image model. It has to classify as `image`
    // or it would land back in the CHAT pool, where a text turn routed to it
    // returns a picture.
    ['gemini-2.5-flash-image', 'image'],
    ['veo-3.1-generate-preview', 'video'],
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
    expect(geminiOnly.select('image')!.capability.modelId).toBe('gemini-2.5-flash-image');
    // No OpenAI key ⇒ no speech or transcription at all.
    expect(geminiOnly.select('speech')).toBeNull();
    expect(geminiOnly.select('transcription')).toBeNull();
  });

  it('offers video now that the polling path exists', () => {
    const r = new MultimodalRegistry(['gemini']);
    const pick = r.select('video')!;
    expect(pick.capability.modelId).toBe('veo-3.1-generate-preview');
    // The long-running shape is recorded on the capability so the executor can
    // switch on it rather than guessing from the model name.
    expect(pick.capability.api).toBe('gemini-predict-lro');
    expect(r.availableModalities()).toContain('video');
  });

  it('reaches Gemini image generation through generateContent, not Imagen :predict', () => {
    // Imagen's :predict API is deprecated (shuts down 2026-08-17) and already
    // 404s for new keys. The api discriminator is what routes the executor to
    // the right request/response shape, so it is asserted here rather than
    // inferred from the model name.
    const r = new MultimodalRegistry(['gemini']);
    const pick = r.select('image')!;
    expect(pick.capability.modelId).toBe('gemini-2.5-flash-image');
    expect(pick.capability.api).toBe('gemini-generate-content');
    // Nothing in the catalogue may still point at the dying endpoint.
    expect(allCapabilities().map((c) => c.api as string)).not.toContain('gemini-predict');
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
    // Cheapest of the two priced options. gemini-2.5-flash-image ($0.039/image)
    // undercuts dall-e-3 ($0.040), so the automatic pick moved to Gemini when
    // the Imagen entry was migrated — a price consequence of the migration, not
    // a quality judgement.
    expect(pick.capability.modelId).toBe('gemini-2.5-flash-image');
  });

  it('honours an explicit model request over the automatic choice', () => {
    const r = new MultimodalRegistry(['openai', 'gemini']);
    const pick = r.select('image', { preferModel: 'dall-e-3' })!;
    expect(pick.capability.modelId).toBe('dall-e-3');
    expect(pick.reason).toContain('Requested explicitly');
  });

  it('ignores an unusable explicit request rather than failing the call', () => {
    // Naming a model there is no key for should fall back, not dead-end.
    const r = new MultimodalRegistry(['openai']);
    const pick = r.select('image', { preferModel: 'gemini-2.5-flash-image' })!;
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

describe('describeGenerationForPlanner', () => {
  // Live-reported bug: "video — it just keeps on writing scripts, directing and
  // etc, but the video never gets generated, even after 30 minutes". The plan
  // never terminated in a generate_video call because nothing the planner read
  // said generation is an atomic, billed, terminating tool call — describe()
  // says so in its doc comment but was never wired into any prompt.
  const ALL = (name: string) => [
    'generate_image', 'generate_video', 'generate_speech', 'transcribe_audio',
  ].includes(name);

  it('names every registered generation tool and what one call actually returns', () => {
    const out = describeGenerationForPlanner(ALL);
    expect(out).toContain('"generate_image" (image)');
    expect(out).toContain('"generate_video" (video)');
    expect(out).toContain('"generate_speech" (speech)');
    expect(out).toContain('"transcribe_audio" (transcription)');
    expect(out).toContain('ATOMIC tool call');
  });

  it('states the plan-shape rule that makes a video run terminate, while keeping pre-production', () => {
    const out = describeGenerationForPlanner(ALL);
    expect(out).toContain('VIDEO PLANS MUST END IN THE TOOL CALL');
    // The user liked the script/direction work and asked to keep it — the rule
    // must not read as "stop doing pre-production".
    expect(out).toMatch(/pre-production[\s\S]*expected and worth planning/);
    expect(out).toContain('exactly ONE subtask whose deliverable is the "generate_video" call');
    // And it must forbid the two shapes that burn money without a clip:
    // ending on a script, and re-rendering after a critique.
    expect(out).toContain('Never end a video plan on a script');
    expect(out).toContain('re-render');
  });

  it('quotes video\'s real per-second price from the shared pricing dataset, never an invented one', () => {
    const out = describeGenerationForPlanner(ALL);
    const veo = allCapabilities().find((c) => c.modality === 'video')!;
    const cost = capabilityCost(veo)!;
    expect(cost.unit).toBe('per second of video');
    // The number has to come from the audited table, not from prose that can
    // drift away from it.
    expect(out).toContain(`Billed ${cost.label}.`);
  });

  it('quotes only the unit when a modality has two models at different prices', () => {
    // Image has dall-e-3 and gemini-2.5-flash-image at different rates; picking
    // one, or averaging them, would state a price nobody is charged.
    const out = describeGenerationForPlanner(ALL);
    const imageLine = out.split('\n').find((l) => l.startsWith('- "generate_image"'))!;
    expect(imageLine).toContain('Billed per image.');
    expect(imageLine).not.toMatch(/\$\d/);
  });

  it('says out loud that unlisted modalities have no tool, so the planner cannot invent one', () => {
    expect(describeGenerationForPlanner(ALL)).toContain('never plan a step that generates music');
  });

  it('describes only the tools THIS run can call, and drops the video rule with no video tool', () => {
    // An image-only account (no Gemini key → buildMediaTools registers no
    // generate_video) must not be told to plan around a tool it cannot call.
    const out = describeGenerationForPlanner((n) => n === 'generate_image');
    expect(out).toContain('"generate_image"');
    expect(out).not.toContain('generate_video');
    expect(out).not.toContain('VIDEO PLANS MUST END IN THE TOOL CALL');
  });

  it('renders nothing at all when no generation tool is registered', () => {
    // A text-only run's plan prompt must be byte-identical to before.
    expect(describeGenerationForPlanner(() => false)).toBe('');
  });
});
