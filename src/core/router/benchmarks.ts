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
//    - agentic  ← Terminal-Bench, SWE-bench, τ²-bench: how well a model holds a
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
  [/fable|mythos/i, 'claude-fable-5.1'],
  [/opus/i, 'claude-opus-5.5'],
  [/sonnet/i, 'claude-sonnet-5.5'],
  [/haiku/i, 'claude-haiku-5.5'],

  // OpenAI GPT-6.
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
  const profile = benchmarkProfile(model);
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
