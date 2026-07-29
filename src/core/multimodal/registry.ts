// ─────────────────────────────────────────────
//  Cascade AI — Multimodal capability registry
// ─────────────────────────────────────────────
//
//  Cascade filters embedders, TTS, image and video models out of the CHAT pool
//  because routing a text turn to them fails. That was right, but it left the
//  system unable to draw a picture with an image model sitting in the very same
//  account whose key it already holds. This registry is where those models go
//  instead of the bin: they stop being chat candidates and become callable
//  capabilities.
//
//  Selection answers "which model should draw this?" the same way tier routing
//  answers "which model should think about this?" — quality first where quality
//  is actually known, price as the tiebreak, and never a model whose provider
//  the user has not configured.
//
//  On quality: image and video leaderboards move weekly and the public ones are
//  Elo over human preference, which does not transfer across modalities or even
//  across prompt styles. So `quality` is populated ONLY where there is a
//  defensible basis, and absent everywhere else. An unranked capability is
//  chosen on price, and `explain()` says so rather than implying a judgement
//  nobody made. Inventing a number here would be the image-generation version
//  of the $0-price bug: a confident-looking value with nothing behind it.

import type { ProviderType } from '../../types.js';
import { findPricing, tokenRatesPer1k } from '../router/pricing.js';

/** Modalities a capability can produce. Chat lives in the tier router, not here. */
export type GenerationModality = 'image' | 'video' | 'speech' | 'transcription';

/**
 * How the model is actually called. The registry stays declarative; the
 * executor (see generate.ts) switches on this.
 */
export type GenerationApi =
  | 'openai-images'          // POST /v1/images/generations
  | 'openai-speech'          // POST /v1/audio/speech
  | 'openai-transcriptions'  // POST /v1/audio/transcriptions
  | 'gemini-generate-content' // :generateContent with an IMAGE response modality
  | 'gemini-predict-lro';    // :predictLongRunning — Veo (submit → poll → fetch)

export interface GenerationCapability {
  modality: GenerationModality;
  /** The Cascade provider config that serves this model (and holds its key). */
  provider: ProviderType;
  modelId: string;
  api: GenerationApi;
  /**
   * 0–100 quality prior, present ONLY where there is a defensible basis.
   * Absent means unranked — selection falls back to price and says so.
   */
  quality?: number;
  /** Why `quality` holds the value it does. Required whenever quality is set. */
  qualityBasis?: string;
  /** Set when Cascade knows the model exists but cannot yet call it. */
  unsupported?: string;
}

/**
 * Generation models Cascade knows how to reach.
 *
 * Deliberately a curated table rather than live discovery: a provider's
 * /models list says an image model exists but not how to call it, what its
 * output options are, or whether it is reachable with this key. Every entry
 * here has a matching price row in core/router/pricing-data.json, so cost is
 * quoted from the same audited source the chat tiers use.
 */
const CAPABILITIES: readonly GenerationCapability[] = [
  // ── Image ──
  {
    modality: 'image', provider: 'openai', modelId: 'dall-e-3', api: 'openai-images',
  },
  {
    // Was `imagen-4.0-generate-001` on `:predict`, which now 404s for new keys
    // ("no longer available to new users") — Imagen's :predict API is deprecated
    // and shuts down 2026-08-17. Google's own migration path is this model on
    // the ordinary generateContent endpoint, so the fix was never another Imagen
    // id: the whole request/response SHAPE changes, which is why `api` moved to
    // 'gemini-generate-content' rather than just the modelId moving.
    // https://ai.google.dev/gemini-api/docs/imagen
    modality: 'image', provider: 'gemini', modelId: 'gemini-2.5-flash-image', api: 'gemini-generate-content',
  },

  // ── Speech (text → audio) ──
  {
    modality: 'speech', provider: 'openai', modelId: 'tts-1', api: 'openai-speech',
  },
  {
    // The only quality claim in this table that needs no leaderboard: OpenAI
    // ships these as the same voice at two fidelities and charges double for
    // this one. That is the vendor's own ordering, not an inference.
    modality: 'speech', provider: 'openai', modelId: 'tts-1-hd', api: 'openai-speech',
    quality: 70, qualityBasis: "OpenAI's own hd variant of tts-1, priced 2x",
  },

  // ── Transcription (audio → text) ──
  {
    modality: 'transcription', provider: 'openai', modelId: 'whisper-1', api: 'openai-transcriptions',
  },

  // ── Video ──
  {
    // Long-running: submit returns an operation name, the video lands minutes
    // later, and the bytes come from a short-lived signed URL. generate.ts owns
    // that polling loop; the registry only records the shape via `api`.
    modality: 'video', provider: 'gemini', modelId: 'veo-3.1-generate-001', api: 'gemini-predict-lro',
  },
];

export interface CapabilityCost {
  /** Human-readable unit price, e.g. "$0.0400 per image". */
  label: string;
  amount: number;
  unit: string;
}

/** Unit price for a capability, read from the shared pricing dataset. */
export function capabilityCost(cap: GenerationCapability): CapabilityCost | null {
  const match = findPricing(cap.modelId, cap.provider, {
    fallbackProviders: cap.provider === 'gemini' ? ['vertex'] : [],
  });
  const rate = match?.entry.rates?.[0];
  if (!rate) return null;
  const unitLabel: Record<string, string> = {
    per_image: 'per image',
    per_second: 'per second of video',
    per_character: 'per character',
    per_audio_minute: 'per audio minute',
  };
  const unit = unitLabel[rate.unit] ?? rate.unit;
  // Sub-cent rates need more places than a currency format would give.
  const amount = rate.amount;
  const shown = amount < 0.001 ? amount.toExponential(2) : amount.toFixed(4);
  return { label: `$${shown} ${unit}`, amount, unit };
}

export interface SelectionResult {
  capability: GenerationCapability;
  cost: CapabilityCost | null;
  /** Why this one — shown in /why and in the tool's own result. */
  reason: string;
}

/**
 * Say why a capability sits where it does. `isBest` is passed rather than
 * inferred because the same capability is the automatic choice in one list and
 * a runner-up in another, and claiming "ranked highest" for a runner-up would
 * be the same kind of confident-but-baseless statement the quality field itself
 * is careful to avoid.
 */
function explainChoice(
  c: GenerationCapability,
  cost: CapabilityCost | null,
  modality: GenerationModality,
  isBest: boolean,
): string {
  const priced = cost ? ` ${cost.label}.` : '';
  if (c.quality !== undefined) {
    return isBest
      ? `${c.modelId} (${c.provider}) — ranked highest for ${modality}: ${c.qualityBasis}.${priced}`
      : `${c.modelId} (${c.provider}) — ranked alternative for ${modality}: ${c.qualityBasis}.${priced}`;
  }
  const noRanking =
    '. No published quality ranking is applied for this modality, so this is a cost choice, not a quality one.';
  return isBest
    ? `${c.modelId} (${c.provider}) — cheapest usable ${modality} model` +
      (cost ? ` at ${cost.label}` : '') + noRanking
    : `${c.modelId} (${c.provider}) — alternative usable ${modality} model` +
      (cost ? ` at ${cost.label}` : '') + noRanking;
}

export class MultimodalRegistry {
  /** Provider types the user has actually configured a key for. */
  private readonly available: ReadonlySet<ProviderType>;

  constructor(availableProviders: Iterable<ProviderType>) {
    this.available = new Set(availableProviders);
  }

  /** Every capability whose provider is configured AND which Cascade can call. */
  usable(modality?: GenerationModality): GenerationCapability[] {
    return CAPABILITIES.filter(
      (c) => !c.unsupported && this.available.has(c.provider) && (!modality || c.modality === modality),
    );
  }

  /** Modalities this account can actually generate right now. */
  availableModalities(): GenerationModality[] {
    return [...new Set(this.usable().map((c) => c.modality))];
  }

  /**
   * Every usable capability for a modality, best first.
   *
   * Ranked models beat unranked ones, then higher quality, then lower unit
   * price. An explicit `preferModel` is moved to the head when it is usable —
   * the user naming a model is a stronger signal than any prior.
   *
   * `select()` is just the head of this list. The TAIL is the point: a systemic
   * provider failure (dead key, 404, exhausted quota) is scoped to one
   * provider+model, so "this model cannot draw" is not the same fact as "this
   * account cannot draw". A caller holding the ordered alternatives can try the
   * next provider instead of aborting the whole run — see generate-media.ts.
   */
  rank(modality: GenerationModality, opts: { preferModel?: string } = {}): SelectionResult[] {
    const scored = this.usable(modality)
      .map((c) => ({ c, cost: capabilityCost(c) }))
      .sort((a, b) => {
        const qa = a.c.quality ?? -1;
        const qb = b.c.quality ?? -1;
        if (qa !== qb) return qb - qa;
        // Unpriced sorts last: same principle as the chat tiers — a missing
        // price is not a cheap one.
        const pa = a.cost?.amount ?? Number.POSITIVE_INFINITY;
        const pb = b.cost?.amount ?? Number.POSITIVE_INFINITY;
        return pa - pb;
      });

    const results: SelectionResult[] = scored.map(({ c, cost }, i) => ({
      capability: c,
      cost,
      reason: explainChoice(c, cost, modality, i === 0),
    }));

    if (opts.preferModel) {
      const i = results.findIndex((r) => r.capability.modelId === opts.preferModel);
      if (i > -1) {
        const [wanted] = results.splice(i, 1);
        results.unshift({ ...wanted!, reason: `Requested explicitly: ${wanted!.capability.modelId}.` });
      }
    }
    return results;
  }

  /**
   * Pick a model for a modality — the best usable one, or null if there is none.
   */
  select(modality: GenerationModality, opts: { preferModel?: string } = {}): SelectionResult | null {
    return this.rank(modality, opts)[0] ?? null;
  }

  /**
   * A plain-language account of what this account can and cannot generate —
   * including the things it cannot, and why. The planner sees this, so being
   * candid here is what stops it inventing a `generate_music` call.
   */
  describe(): string {
    const lines: string[] = [];
    const usable = this.usable();
    if (usable.length) {
      lines.push('Generation models available on your configured providers:');
      for (const modality of ['image', 'speech', 'transcription', 'video'] as GenerationModality[]) {
        const forModality = usable.filter((c) => c.modality === modality);
        if (!forModality.length) continue;
        const shown = forModality.map((c) => {
          const cost = capabilityCost(c);
          return `${c.modelId}${cost ? ` (${cost.label})` : ''}`;
        });
        lines.push(`  ${modality}: ${shown.join(', ')}`);
      }
    } else {
      lines.push('No generation models are available — none of your configured providers offers one.');
    }

    const blocked = CAPABILITIES.filter((c) => c.unsupported && this.available.has(c.provider));
    for (const c of blocked) {
      lines.push(`  ${c.modality}: ${c.modelId} exists on your account but is not callable. ${c.unsupported}`);
    }
    // Said out loud because it is the most commonly assumed-present capability,
    // and a planner that assumes it will write a step that can never run.
    lines.push(
      '  music: no supported provider exposes a music-generation API, so Cascade cannot generate music.',
    );
    return lines.join('\n');
  }
}

/** The catalogue itself, for tests and `cascade models`. */
export function allCapabilities(): readonly GenerationCapability[] {
  return CAPABILITIES;
}

// Re-exported so callers pricing a text model and a capability use one import.
export { tokenRatesPer1k };
