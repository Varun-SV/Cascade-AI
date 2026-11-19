// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — Public-benchmark model strengths
// ─────────────────────────────────────────────────────────────────────────────
//
//  0–100 scores per model family, per task type, from public benchmarks, so
//  Cascade Auto routes each subtask to the model that is actually strongest at
//  it rather than the cheapest-or-first:
//    - code     ← Terminal-Bench 2.1 / 4.0, SWE-bench Verified (Vals AI)
//    - analysis ← Vals Index (multi-step finance, legal, tax, coding work)
//    - creative ← LMArena creative-writing arena
//    - data     ← Vals Index
//    - agentic  ← Terminal-Bench, SWE-bench: how well a model holds a
//                 tool loop together. Weighted for the tiers that orchestrate.
//
//  The numbers live in benchmark-data.json, produced by
//  scripts/refresh-benchmarks.mjs from the captures in
//  scripts/benchmarks/sources/ (see docs/benchmark-aggregation.md). This file
//  holds NO scores of its own. It used to carry a hand-typed copy as the
//  offline fallback, and that copy is exactly how invented numbers outlived
//  the data: the two drifted, and the fallback still rated GPT-4o above
//  models that beat it by thirty points on every agentic board. The bundled
//  fallback is now the committed snapshot itself.

import type { ModelInfo } from '../../types.js';
import type { TaskType } from './task-analyzer.js';
import type { LiveDataProvider } from './live-data.js';
import benchmarkData from './benchmark-data.json' with { type: 'json' };
import { MODELS } from '../../constants.js';

export type BenchmarkTask = Exclude<TaskType, 'mixed'>;
export type BenchmarkProfile = Partial<Record<BenchmarkTask | 'agentic', number>>;

const TASKS: readonly BenchmarkTask[] = ['code', 'analysis', 'creative', 'data'];

// Optional live/cached data source. When set (Cascade Auto with benchmarks.live
// on), current public scores override the bundled snapshot; otherwise the
// bundled snapshot is the offline baseline. Type-only import keeps this decoupled.
let liveProvider: LiveDataProvider | null = null;

/** Wire a live data source so benchmarkScore01 prefers current public scores. */
export function setBenchmarkLiveProvider(provider: LiveDataProvider | null): void {
  liveProvider = provider;
}

const BUNDLED: Record<string, BenchmarkProfile> =
  (benchmarkData as { families?: Record<string, BenchmarkProfile> }).families ?? {};

// One family per model VERSION. A single `claude-opus` row used to score Opus
// 4.5 and Opus 5.5 the same, though Terminal-Bench 2.1 puts them 23 points
// apart — so Auto could not tell the model a provider recommends from the one
// it is about to retire.
//
// Ordered most-specific → least: "claude-opus-4-5" must not fall into an
// "opus-4" rule, "gpt-5.4-nano" must not fall into "gpt-5.4". Separators are
// `[-.]` (plus a space after the line name) because the same version is spelled `opus-4-5` by Anthropic,
// `opus-4.5` by most gateways and `Opus 4.5` in a display name.
const FAMILY_MATCHERS: Array<[RegExp, string]> = [
  // Anthropic. Mythos is the same model as Fable without Fable's extra
  // safeguards, so it scores as Fable.
  [/(?:fable|mythos)[\s.-]?5[-.]2/i, 'claude-fable-5.2'],
  [/(?:fable|mythos)[\s.-]?5[-.]1/i, 'claude-fable-5.1'],
  [/(?:fable|mythos)[\s.-]?5(?![-.]?\d)/i, 'claude-fable-5'],
  [/opus[\s.-]?5[-.]5/i, 'claude-opus-5.5'],
  [/opus[\s.-]?5(?![-.]?\d)/i, 'claude-opus-5'],
  [/opus[\s.-]?4[-.]8/i, 'claude-opus-4.8'],
  [/opus[\s.-]?4[-.]7/i, 'claude-opus-4.7'],
  [/opus[\s.-]?4[-.]6/i, 'claude-opus-4.6'],
  [/opus[\s.-]?4[-.]5/i, 'claude-opus-4.5'],
  [/sonnet[\s.-]?5[-.]5/i, 'claude-sonnet-5.5'],
  [/sonnet[\s.-]?5(?![-.]?\d)/i, 'claude-sonnet-5'],
  [/sonnet[\s.-]?4[-.]6/i, 'claude-sonnet-4.6'],
  [/sonnet[\s.-]?4[-.]5/i, 'claude-sonnet-4.5'],
  [/haiku[\s.-]?5[-.]5/i, 'claude-haiku-5.5'],
  [/haiku[\s.-]?4[-.]5/i, 'claude-haiku-4.5'],
  // Anything older that got this far (Claude 3.x, Opus/Sonnet 4.0–4.1) is
  // retired. It must not fall into the "newer than this table" rules below and
  // be scored as the newest model; a family with no data reads as 0.5.
  [/claude-(?:[1-3]|instant)|(?:opus|sonnet|haiku)[\s.-]?[1-4](?!\d)/i, 'claude-legacy'],
  // A Claude version newer than this table scores as the newest one we have
  // measured in its line — newer releases have not scored lower on these
  // boards — instead of a neutral 0.5 that would lose to everything measured.
  [/fable|mythos/i, 'claude-fable-5.2'],
  [/opus/i, 'claude-opus-5.5'],
  [/sonnet/i, 'claude-sonnet-5.5'],
  [/haiku/i, 'claude-haiku-5.5'],

  // OpenAI GPT-6. Point releases first: "gpt-6.2-astra" must not fall into
  // the bare "gpt-6 astra" rule.
  [/gpt-?6[-.]2.*astra/i, 'gpt-6.2-astra'],
  [/gpt-?6[-.]2.*sol/i, 'gpt-6.2-sol'],
  [/gpt-?6[-.]1.*sol/i, 'gpt-6.1-sol'],
  [/gpt-?6[-.]1.*terra/i, 'gpt-6.1-terra'],
  [/gpt-?6.*astra/i, 'gpt-6-astra'],
  [/gpt-?6.*sol/i, 'gpt-6-sol'],
  [/gpt-?6.*luna/i, 'gpt-6-luna'],
  // GPT-5.6 durable tiers; bare "gpt-5.6" is OpenAI's alias for Sol.
  [/gpt-?5\.6.*sol/i, 'gpt-5.6-sol'],
  [/gpt-?5\.6.*terra/i, 'gpt-5.6-terra'],
  [/gpt-?5\.6.*luna/i, 'gpt-5.6-luna'],
  [/gpt-?5\.6(?![\w.-])/i, 'gpt-5.6-sol'],
  [/gpt-?5\.5/i, 'gpt-5.5'],
  [/gpt-?5\.4.*nano/i, 'gpt-5.4-nano'],
  [/gpt-?5\.4.*mini/i, 'gpt-5.4-mini'],
  [/gpt-?5\.4/i, 'gpt-5.4'],
  [/gpt-?5\.2/i, 'gpt-5.2'],
  [/gpt-?5(?![.\d]).*nano/i, 'gpt-5-nano'],
  [/gpt-?5(?![.\d]).*mini/i, 'gpt-5-mini'],
  [/gpt-?5(?![.\d])/i, 'gpt-5'],
  [/gpt-?4\.1-nano/i, 'gpt-4.1-nano'],
  [/gpt-?4\.1-mini/i, 'gpt-4.1-mini'],
  [/gpt-?4\.1/i, 'gpt-4.1'],
  [/gpt-?4o(?![\s-]?mini)/i, 'gpt-4o'],

  // Google Gemini.
  [/gemini-?4.*argon/i, 'gemini-4-argon'],
  [/gemini-?4.*carbon/i, 'gemini-4-carbon'],
  [/gemini-?4.*neon/i, 'gemini-4-neon'],
  [/gemini-?4.*hydrogen/i, 'gemini-4-hydrogen'],
  [/gemini-?3\.8-flash(?!-lite)/i, 'gemini-3.8-flash'],
  [/gemini-?3\.7-flash(?!-lite)/i, 'gemini-3.7-flash'],
  [/gemini-?3\.6-flash(?!-lite)/i, 'gemini-3.6-flash'],
  [/gemini-?3\.5-flash-lite/i, 'gemini-3.5-flash-lite'],
  [/gemini-?3\.5-flash/i, 'gemini-3.5-flash'],
  [/gemini-?3\.1-pro/i, 'gemini-3.1-pro'],
  [/gemini-?3\.1-flash-lite/i, 'gemini-3.1-flash-lite'],
  [/gemini-?3-pro/i, 'gemini-3-pro'],
  [/gemini-?3-flash/i, 'gemini-3-flash'],
  // 2.5 flash-lite must precede 2.5 flash: the bare flash rule would match it
  // as a substring and credit the lite model with the full model's score.
  [/gemini-?2\.5-flash-lite/i, 'gemini-2.5-flash-lite'],
  [/gemini-?2\.5-flash/i, 'gemini-2.5-flash'],
  [/gemini-?2\.5-pro/i, 'gemini-2.5-pro'],
  [/gemini-?2\.0-flash(?!-lite)/i, 'gemini-2.0-flash'],
  [/gemini-?(?:1\.\d|2\.0)/i, 'gemini-legacy'], // shut down; see claude-legacy
  // A Gemini released after this table (discovered live from the provider)
  // scores as the newest measured model of its class.
  [/gemini.*flash.?lite/i, 'gemini-3.5-flash-lite'],
  [/gemini.*(?:pro|argon|ultra)/i, 'gemini-4-argon'],
  [/gemini.*flash/i, 'gemini-3.8-flash'],

  // Other providers' current models, as served by their own APIs or through an
  // OpenAI-compatible gateway ("moonshotai/kimi-k3.1-pro", "z-ai/glm-5.3",
  // "x-ai/grok-4.7"). Exact versions only: an older or newer release of one
  // of these lines is not scored as the version measured here, since these
  // lines have moved a long way between releases.
  [/kimi[\s.-]?k3[-.]1/i, 'kimi-k3.1'],
  [/kimi[\s.-]?k3(?![-.]?\d)/i, 'kimi-k3'],
  [/glm[\s.-]?5[-.]3[\s.-]?flash/i, 'glm-5.3-flash'],
  [/glm[\s.-]?5[-.]3(?![-.]?\d)/i, 'glm-5.3'],
  [/grok[\s.-]?4[-.]7(?!\d)/i, 'grok-4.7'],
  [/grok[\s.-]?4[-.]6(?!\d)/i, 'grok-4.6'],
  [/deepseek[\s.-]?v4[-.]1[\s.-]?flash/i, 'deepseek-v4.1-flash'],
  [/deepseek[\s.-]?v4[\s.-]?pro/i, 'deepseek-v4-pro'],
  [/qwen[\s.-]?4[\s.-]?max/i, 'qwen-4-max'],
  [/qwen[\s.-]?3[-.]8[\s.-]?max/i, 'qwen-3.8-max'],
  [/minimax[\s.-]?m3[-.]1[\s.-]?flash/i, 'minimax-m3.1-flash'],
  [/minimax[\s.-]?m3(?![-.]?\d)/i, 'minimax-m3'],
  [/mistral[\s.-]?large[\s.-]?4(?!\d)/i, 'mistral-large-4'],
  [/mimo[\s.-]?v2[-.]6[\s.-]?pro/i, 'mimo-v2.6-pro'],
  [/mimo[\s.-]?v2[-.]6[\s.-]?flash/i, 'mimo-v2.6-flash'],

  // Local (Ollama) tags. No current board measures these builds; their
  // scores are carried seeds that only rank local models against each other
  // when a tier is restricted to local-only.
  [/codellama|code-llama|starcoder|stable-code/i, 'codellama'],
  [/deepseek/i, 'deepseek'],
  [/qwen/i, 'qwen'],
  [/llama.?3.*70b|llama3:70b|llama-3-70b/i, 'llama-70b'],
  [/llama/i, 'llama-small'],
  [/mistral|mixtral/i, 'mistral'],
  [/gemma/i, 'gemma'],
];

export function resolveFamily(model: ModelInfo): string | null {
  // Prefer the canonical base-model id (e.g. an Azure deployment's real model)
  // so a deployment named "prod-fast" still resolves via its baseModelId.
  const hay = `${model.baseModelId ?? ''} ${model.id} ${model.name}`;
  for (const [re, fam] of FAMILY_MATCHERS) {
    if (re.test(hay)) return fam;
  }
  return null;
}

/** The family's scores: live/cached snapshot first, the bundled snapshot otherwise. */
export function benchmarkProfile(model: ModelInfo): BenchmarkProfile | null {
  const fam = resolveFamily(model);
  if (!fam) return null;
  return liveProvider?.getQualityProfile(fam) ?? BUNDLED[fam] ?? null;
}

/**
 * Benchmark strength of a model for a task type, normalised to 0–1. Returns a
 * neutral 0.5 for models with no benchmark profile so they neither win nor lose
 * on this factor alone.
 *
 * `agenticWeight` (0–1) blends in the agentic score: how reliably the model
 * runs a multi-step tool loop. The tiers that orchestrate (T1 plans, T2
 * manages) fail differently from a worker writing one answer — a planner that
 * drops a tool call strands a whole wave — so they pass a high weight. A model
 * no agentic board has measured is scored on the task alone.
 */
export function benchmarkScore01(model: ModelInfo, taskType: TaskType, agenticWeight = 0): number {
  const profile = benchmarkProfile(model) ?? estimatedProfile(model);
  if (!profile) return 0.5;

  let score: number;
  if (taskType === 'mixed') {
    // The four task types only — an `agentic` key must not leak into "general".
    const vals = TASKS.map((t) => profile[t]).filter((v): v is number => typeof v === 'number');
    score = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 50;
  } else {
    score = profile[taskType] ?? 50;
  }
  const w = Math.max(0, Math.min(1, agenticWeight));
  if (w > 0 && typeof profile.agentic === 'number') {
    score = (1 - w) * score + w * profile.agentic;
  }
  return Math.max(0, Math.min(1, score / 100));
}

// ── Models no benchmark has measured ─────────────────────────────────────────
//
// Cascade is meant to run on whatever model it is given: a fine-tune on a
// llama.cpp server, a new open model behind an OpenAI-compatible gateway, a
// preview id no board has scored yet. A flat 0.5 for all of them put a 1B
// model and a 400B one on the same footing, so routing could not place either.
//
// What is known about such a model still says something. Its size, when the
// id or the local server gives one, and its price, when it has one, both track
// public scores closely across the models that ARE measured. The estimate is
// read off those, then pulled toward the middle and capped below the measured
// leaders, so a guess can place a model but never outrank one the boards have
// actually tested.

/** How a model's benchmark score was arrived at. */
export type ScoreBasis = 'measured' | 'estimated-from-size' | 'estimated-from-price' | 'unknown';

/** How far an estimate is pulled toward the neutral 50: it is a guess. */
const ESTIMATE_SHRINK = 0.7;

/** Billions of parameters, from the local server's report or the model's name ("qwen2.5-32b", "8x7b"). */
export function parameterCountB(model: ModelInfo): number | null {
  if (typeof model.minSizeB === 'number' && model.minSizeB > 0) return model.minSizeB;
  const hay = `${model.id} ${model.name}`;
  // A preceding letter is not allowed, so Qwen's active-parameter "a3b" isn't read as the size.
  const m = /(?:^|[^a-z0-9.])(?:(\d+)x)?(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(hay);
  if (!m) return null;
  const n = Number(m[2]) * (m[1] ? Number(m[1]) : 1);
  return Number.isFinite(n) && n > 0 && n < 10_000 ? n : null;
}

/** Blended USD per million tokens (three input to one output), or null when there is no real price. */
function blendedPricePerM(model: ModelInfo): number | null {
  if (model.isLocal || model.pricingUnknown) return null;
  const blended = ((model.inputCostPer1kTokens * 3 + model.outputCostPer1kTokens) / 4) * 1000;
  return blended > 0 ? blended : null;
}

function mixed(profile: BenchmarkProfile): number | null {
  const vals = TASKS.map((t) => profile[t]).filter((v): v is number => typeof v === 'number');
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

interface PriceFit { slope: number; intercept: number; cap: number }
let priceFit: PriceFit | null | undefined;

/**
 * Score against log price across the catalog's measured models, by Theil–Sen
 * (median of pairwise slopes), the same robust line the aggregation uses, so
 * one oddly priced model doesn't tilt it. The cap is the measured models'
 * 75th percentile. Null when the catalog gives too little to fit.
 */
function fitPrice(): PriceFit | null {
  if (priceFit !== undefined) return priceFit;
  const pts: Array<[number, number]> = [];
  for (const m of Object.values(MODELS)) {
    const price = blendedPricePerM(m);
    const fam = resolveFamily(m);
    const profile = fam ? BUNDLED[fam] : undefined;
    const score = profile ? mixed(profile) : null;
    if (price !== null && score !== null) pts.push([Math.log10(price), score]);
  }
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j]![0] - pts[i]![0];
      if (Math.abs(dx) > 1e-6) slopes.push((pts[j]![1] - pts[i]![1]) / dx);
    }
  }
  if (pts.length < 5 || slopes.length === 0) return (priceFit = null);
  const slope = median(slopes);
  if (!(slope > 0)) return (priceFit = null);
  const intercept = median(pts.map(([x, y]) => y - slope * x));
  const sorted = pts.map(([, y]) => y).sort((a, b) => a - b);
  const cap = sorted[Math.floor(sorted.length * 0.75)]!;
  return (priceFit = { slope, intercept, cap });
}

/**
 * Size to score, anchored on the measured open families of known size: the
 * small Llama and Gemma builds (about 8B) score in the mid-50s, the 70B Llama
 * about 72. So 1B ≈ 41, 8B ≈ 56, 32B ≈ 66, 70B ≈ 72, before the pull toward
 * the middle.
 */
function scoreFromSize(b: number): number {
  return 40.6 + 17 * Math.log10(b);
}

/**
 * An estimated profile for a model no benchmark has measured, and how it was
 * estimated; null when nothing is known to estimate from. The same score
 * stands for every task type, and there is no agentic score: nothing about a
 * model's size or price says how well it holds a tool loop together.
 */
export function estimateBenchmark(model: ModelInfo): { profile: BenchmarkProfile; basis: Exclude<ScoreBasis, 'measured' | 'unknown'> } | null {
  const fit = fitPrice();
  const cap = fit?.cap ?? 70;
  const size = parameterCountB(model);
  const price = blendedPricePerM(model);
  let raw: number | null = null;
  let basis: 'estimated-from-size' | 'estimated-from-price' | null = null;
  if (size !== null) {
    raw = scoreFromSize(size);
    basis = 'estimated-from-size';
  } else if (price !== null && fit) {
    raw = fit.intercept + fit.slope * Math.log10(price);
    basis = 'estimated-from-price';
  }
  if (raw === null || basis === null) return null;
  const score = Math.max(15, Math.min(cap, 50 + ESTIMATE_SHRINK * (raw - 50)));
  const rounded = Math.round(score * 10) / 10;
  return { profile: { code: rounded, analysis: rounded, creative: rounded, data: rounded }, basis };
}

function estimatedProfile(model: ModelInfo): BenchmarkProfile | null {
  return estimateBenchmark(model)?.profile ?? null;
}

/** Where a model's benchmark score comes from, for explaining a routing choice. */
export function benchmarkBasis(model: ModelInfo): ScoreBasis {
  if (benchmarkProfile(model)) return 'measured';
  return estimateBenchmark(model)?.basis ?? 'unknown';
}

/** For tests: forget the fitted price line so a changed catalog is refitted. */
export function resetBenchmarkEstimateForTest(): void {
  priceFit = undefined;
}
