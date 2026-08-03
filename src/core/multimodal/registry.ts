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
    //
    // `veo-3.1-generate-001` (no "-preview") is VERTEX AI's id for this model,
    // not the Gemini Developer API's — this file calls
    // generativelanguage.googleapis.com (see generate.ts), which 404s on it:
    // "models/veo-3.1-generate-001 is not found for API version v1beta". On the
    // Gemini API specifically, Veo 3.1 is still preview-only, so the correct id
    // there is `veo-3.1-generate-preview`.
    // https://ai.google.dev/gemini-api/docs/veo
    modality: 'video', provider: 'gemini', modelId: 'veo-3.1-generate-preview', api: 'gemini-predict-lro',
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
   * including the things it cannot, and why.
   *
   * This is the USER-facing inventory (model ids and unit prices), keyed on
   * which providers are configured. It is deliberately NOT what the planner
   * reads: see `describeGenerationForPlanner()` below for that, and the note
   * there for why the two cannot be the same string.
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

// ── Planner-facing capability awareness ───────
//
//  Live-reported bug: asked for a video, Cascade wrote a script, wrote
//  direction notes, and then kept planning — thirty minutes of paid planning
//  calls and no clip, because nothing in the plan prompt said that video is one
//  tool call the plan has to END on. The creative pre-production was fine and
//  wanted; what was missing was the terminating step.

/**
 * The tool each generation modality is reached through, plus the one
 * operational fact about it a model cannot infer from the tool name.
 *
 * Keyed on TOOL NAME rather than on a registry instance because the planner's
 * question is "what can this run call?", and the honest answer to that is the
 * tool registry — media tools are registered only for modalities the account
 * can actually serve (see tools/generate-media.ts buildMediaTools), and a
 * restricted host can drop them anyway.
 */
const PLANNER_FACTS: ReadonlyArray<{
  tool: string;
  modality: GenerationModality;
  shape: string;
}> = [
  { tool: 'generate_image', modality: 'image', shape: 'one call returns one finished image' },
  { tool: 'generate_speech', modality: 'speech', shape: 'one call returns one finished audio file' },
  {
    tool: 'generate_video',
    modality: 'video',
    shape: 'one call returns one finished clip, after rendering for 1-3 minutes (Cascade stops waiting at 8)',
  },
  {
    tool: 'transcribe_audio',
    modality: 'transcription',
    shape: 'one call returns the transcript of one audio file',
  },
];

/**
 * The catalogue's price for a modality, stated only where it can be stated
 * exactly: every priced entry for the modality has to agree before a number is
 * quoted. With two priced models in play the real cost depends on which one
 * selection lands on, and averaging them would invent a number nobody charges —
 * the same mistake the `quality` field above refuses to make. When they
 * disagree the UNIT is still worth saying: "billed per second of video" is what
 * stops a planner treating a 30-second clip as free.
 */
function plannerPriceNote(modality: GenerationModality): string {
  const costs = CAPABILITIES
    .filter((c) => c.modality === modality && !c.unsupported)
    .map((c) => capabilityCost(c))
    .filter((c): c is CapabilityCost => c !== null);
  if (!costs.length) return '';
  const labels = new Set(costs.map((c) => c.label));
  if (labels.size === 1) return ` Billed ${costs[0]!.label}.`;
  const units = new Set(costs.map((c) => c.unit));
  return units.size === 1 ? ` Billed ${[...units][0]}.` : '';
}

/**
 * What the PLANNER (T1 and T2) needs to know about generation, keyed on the
 * tools this run can actually call. Empty string when there are none, so a
 * text-only run's prompt is unchanged.
 *
 * Deliberately not `describe()`. That method is a user-facing inventory of
 * model ids and prices keyed on configured PROVIDERS, and two things make it
 * the wrong string to paste into a plan prompt:
 *
 *   • it answers "what could this account generate", not "what can THIS RUN
 *     call". A restricted host still has the provider configured, so it would
 *     advertise a capability no worker can reach — precisely the situation
 *     buildMediaTools exists to prevent;
 *   • a list of model ids says nothing about plan SHAPE. The planner does not
 *     mis-plan video because it is unaware of Veo's price; it mis-plans video by
 *     emitting a script subtask, a direction subtask and a review subtask, and
 *     no subtask that ever calls the tool. That is the fact that has to reach
 *     the prompt, and an inventory has nowhere to put it.
 */
export function describeGenerationForPlanner(has: (toolName: string) => boolean): string {
  const present = PLANNER_FACTS.filter((f) => has(f.tool));
  if (!present.length) return '';

  const lines = ['MEDIA GENERATION — the only generation tools this run can call:'];
  for (const f of present) {
    lines.push(`- "${f.tool}" (${f.modality}): ${f.shape}.${plannerPriceNote(f.modality)}`);
  }
  lines.push(
    'Each one is a single ATOMIC tool call, made by ONE T3 worker, that produces the finished file. '
    + 'It is never a multi-step pipeline, and no worker can satisfy it by describing the result in words.',
    'No other modality has a tool here — never plan a step that generates music, 3D or anything not listed above.',
  );
  if (has('generate_video')) {
    lines.push(
      'VIDEO PLANS MUST END IN THE TOOL CALL. Creative pre-production — a script, a shot list, direction '
      + 'notes — is expected and worth planning, but it is NOT the video. Any plan that involves video MUST '
      + 'contain exactly ONE subtask whose deliverable is the "generate_video" call itself; it MUST be the '
      + 'last subtask on that path (dependsOn the pre-production ones), and nothing after it may be required '
      + 'to produce the clip. Never end a video plan on a script, a storyboard or a review step. Never split '
      + 'one clip across several "generate_video" subtasks, and never plan a render → critique → re-render '
      + 'loop: every render is billed again and takes minutes.',
    );
  }
  return lines.join('\n');
}

// Re-exported so callers pricing a text model and a capability use one import.
export { tokenRatesPer1k };
