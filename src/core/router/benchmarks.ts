// ─────────────────────────────────────────────
//  Cascade AI — Public-benchmark model strengths
// ─────────────────────────────────────────────
//
//  Curated 0–100 scores per model family per task type, approximated from
//  public benchmarks so Cascade Auto can route each subtask to the model that
//  is actually strongest at it, rather than always defaulting to the
//  cheapest-or-first model:
//    - code     ← SWE-bench / Terminal-Bench / coding-agent evals
//    - analysis ← MMLU / GPQA / reasoning / intelligence suites
//    - creative ← writing evals / LMArena
//    - data     ← GSM8K / MATH / GPQA / data-wrangling
//
//  These are deliberately editable knobs, not gospel — they only set the
//  *relative* preference between available models for a given task type.
//
//  This bundled table is the OFFLINE fallback. The live/cached snapshot
//  (benchmark-data.json) is produced by the aggregator: each benchmark source
//  in scripts/benchmarks/sources/ is normalized to a common 0–100 quality scale,
//  then the conservative (lowest) value per family/task is taken across covering
//  sources. See docs/benchmark-aggregation.md.

import type { ModelInfo } from '../../types.js';
import type { TaskType } from './task-analyzer.js';
import type { LiveDataProvider } from './live-data.js';

export type BenchmarkProfile = Partial<Record<Exclude<TaskType, 'mixed'>, number>>;

// Optional live/cached data source. When set (Cascade Auto with benchmarks.live
// on), current public scores override the bundled table below; otherwise the
// bundled table is the offline baseline. Type-only import keeps this decoupled.
let liveProvider: LiveDataProvider | null = null;

/** Wire a live data source so benchmarkScore01 prefers current public scores. */
export function setBenchmarkLiveProvider(provider: LiveDataProvider | null): void {
  liveProvider = provider;
}

const FAMILY_BENCHMARKS: Record<string, BenchmarkProfile> = {
  // Anthropic. Fable 5 is its own tier above the generic Opus family; newer
  // Opus/Sonnet revisions still inherit the conservative family baselines when
  // no directly comparable cross-vendor source covers all four task columns.
  'claude-fable-5':    { code: 92, analysis: 100, creative: 97, data: 97 },
  'claude-opus':       { code: 95, analysis: 92, creative: 90, data: 88 },
  'claude-sonnet':     { code: 93, analysis: 88, creative: 87, data: 85 },
  'claude-haiku':      { code: 80, analysis: 75, creative: 76, data: 72 },

  // OpenAI GPT-5 family. GPT-5.6 uses durable capability tiers rather than the
  // old base/mini/nano names, so Sol/Terra/Luna must stay distinct: collapsing
  // them to generic gpt-5 destroys the quality-to-cost signal Cascade routes on.
  'gpt-5.6-sol':       { code: 99, analysis: 98, creative: 96, data: 100 },
  'gpt-5.6-terra':     { code: 97, analysis: 92, creative: 94, data: 98 },
  'gpt-5.6-luna':      { code: 94, analysis: 85, creative: 91, data: 97 },
  'gpt-5.5':           { code: 97, analysis: 96, creative: 94, data: 95 },
  'gpt-5.4':           { code: 94, analysis: 94, creative: 92, data: 92 },
  'gpt-5.4-mini':      { code: 86, analysis: 85, creative: 85, data: 83 },
  'gpt-5.4-nano':      { code: 82, analysis: 84, creative: 82, data: 84 },
  'gpt-5':             { code: 96, analysis: 95, creative: 93, data: 93 },
  'gpt-5-mini':        { code: 88, analysis: 86, creative: 86, data: 84 },
  'gpt-5-nano':        { code: 78, analysis: 75, creative: 78, data: 73 },
  'openai-o3':         { code: 89, analysis: 92, creative: 88, data: 91 },

  // OpenAI — strong all-round, particularly creative/writing.
  'gpt-4.1':           { code: 90, analysis: 89, creative: 91, data: 87 },
  'gpt-4.1-mini':      { code: 82, analysis: 80, creative: 83, data: 79 },
  'gpt-4.1-nano':      { code: 70, analysis: 68, creative: 72, data: 66 },
  'gpt-4o':            { code: 86, analysis: 85, creative: 90, data: 84 },
  'gpt-4o-mini':       { code: 76, analysis: 74, creative: 80, data: 72 },

  // Google Gemini. Current 3.x releases get explicit rows instead of inheriting
  // the 2.5 fallback; that inheritance was making a newly-discovered 3.x model
  // look no better than a year-old model until the static table was updated.
  'gemini-3.7-flash':      { code: 95, analysis: 93, creative: 92, data: 93 },
  'gemini-3.6-flash':      { code: 87, analysis: 87, creative: 89, data: 89 },
  'gemini-3.5-flash':      { code: 85, analysis: 84, creative: 88, data: 88 },
  'gemini-3.5-flash-lite': { code: 78, analysis: 78, creative: 80, data: 78 },
  'gemini-3.1-pro':        { code: 79, analysis: 78, creative: 88, data: 99 },
  'gemini-3.1-flash-lite': { code: 74, analysis: 75, creative: 77, data: 74 },
  'gemini-3-flash':        { code: 84, analysis: 84, creative: 87, data: 86 },
  'gemini-2.5-pro':        { code: 90, analysis: 93, creative: 86, data: 92 },
  'gemini-2.5-flash':      { code: 82, analysis: 83, creative: 80, data: 82 },
  // The 2.5-lite tier scores below full 2.5-flash but above the older 2.0
  // lite tier — it exists because a naive `gemini-?2\.5-flash` regex swallows
  // "gemini-2.5-flash-lite" as a substring match (no lite variant of its own
  // to fall into), so the weaker lite model got credited with the full
  // flash's benchmark score and kept winning Cascade Auto's "best value" pick.
  'gemini-2.5-flash-lite': { code: 72, analysis: 72, creative: 74, data: 72 },
  'gemini-1.5-pro':        { code: 82, analysis: 84, creative: 82, data: 85 },
  'gemini-2.0-flash':      { code: 79, analysis: 80, creative: 79, data: 80 },
  'gemini-flash-lite':     { code: 68, analysis: 68, creative: 70, data: 68 },

  // Local (Ollama) — lower absolute scores; the ordering is what matters when a
  // tier is restricted to local-only models.
  'deepseek':          { code: 80, analysis: 72, creative: 68, data: 74 },
  'qwen':              { code: 78, analysis: 73, creative: 72, data: 74 },
  'codellama':         { code: 76, analysis: 60, creative: 55, data: 60 },
  'llama-70b':         { code: 74, analysis: 72, creative: 73, data: 70 },
  'mistral':           { code: 62, analysis: 64, creative: 66, data: 60 },
  'gemma':             { code: 58, analysis: 60, creative: 62, data: 57 },
  'llama-small':       { code: 55, analysis: 56, creative: 60, data: 54 },
};

// Ordered most-specific → least so e.g. "gpt-4.1-mini" doesn't match "gpt-4.1".
const FAMILY_MATCHERS: Array<[RegExp, string]> = [
  [/fable-?5/i, 'claude-fable-5'],
  [/opus/i, 'claude-opus'],
  [/sonnet/i, 'claude-sonnet'],
  [/haiku/i, 'claude-haiku'],

  // GPT-5 family — most-specific first. GPT-5.1/5.2 intentionally fold into
  // the stable gpt-5 baseline until a comparable source justifies distinct
  // four-axis profiles; current 5.6/5.5/5.4 variants have direct coverage.
  [/gpt-?5\.6.*sol/i, 'gpt-5.6-sol'],
  [/gpt-?5\.6.*terra/i, 'gpt-5.6-terra'],
  [/gpt-?5\.6.*luna/i, 'gpt-5.6-luna'],
  [/gpt-?5\.5/i, 'gpt-5.5'],
  [/gpt-?5\.4.*nano/i, 'gpt-5.4-nano'],
  [/gpt-?5\.4.*mini/i, 'gpt-5.4-mini'],
  [/gpt-?5\.4/i, 'gpt-5.4'],
  [/gpt-?5.*nano/i, 'gpt-5-nano'],
  [/gpt-?5.*mini/i, 'gpt-5-mini'],
  [/gpt-?5/i, 'gpt-5'],
  [/^\s*o3(?:-|\s|$)/i, 'openai-o3'],

  [/gpt-?4\.1-nano/i, 'gpt-4.1-nano'],
  [/gpt-?4\.1-mini/i, 'gpt-4.1-mini'],
  [/gpt-?4\.1/i, 'gpt-4.1'],
  [/gpt-?4o-mini/i, 'gpt-4o-mini'],
  [/gpt-?4o/i, 'gpt-4o'],

  // Current Gemini 3.x identities. Preview suffixes and `models/` prefixes are
  // harmless because the patterns match the canonical stem.
  [/gemini-?3\.7-flash/i, 'gemini-3.7-flash'],
  [/gemini-?3\.6-flash/i, 'gemini-3.6-flash'],
  [/gemini-?3\.5-flash-lite/i, 'gemini-3.5-flash-lite'],
  [/gemini-?3\.5-flash/i, 'gemini-3.5-flash'],
  [/gemini-?3\.1-pro/i, 'gemini-3.1-pro'],
  [/gemini-?3\.1-flash-lite/i, 'gemini-3.1-flash-lite'],
  [/gemini-?3-flash/i, 'gemini-3-flash'],
  [/gemini-?2\.5-pro/i, 'gemini-2.5-pro'],
  // Must precede the bare `2\.5-flash` rule below: that pattern has no word
  // boundary after "flash" and matches "gemini-2.5-flash-lite" as a plain
  // substring, so the lite variant would otherwise be scored as the full
  // flash model (see the FAMILY_BENCHMARKS comment above).
  [/gemini-?2\.5-flash-lite/i, 'gemini-2.5-flash-lite'],
  [/gemini-?2\.5-flash/i, 'gemini-2.5-flash'],
  [/gemini-?1\.5-pro/i, 'gemini-1.5-pro'],
  [/gemini-?2\.0-flash-lite/i, 'gemini-flash-lite'],
  [/gemini-?2\.0-flash/i, 'gemini-2.0-flash'],
  // Generic Gemini fallbacks — a model released after this table was written
  // still gets a sensible class score instead of neutral 0.5. Most-specific
  // first so a future Flash-Lite cannot inherit full Flash scores.
  [/gemini.*flash.?lite/i, 'gemini-3.5-flash-lite'],
  [/gemini.*pro/i, 'gemini-3.1-pro'],
  [/gemini.*flash/i, 'gemini-3.7-flash'],
  [/gemini/i, 'gemini-3.7-flash'],

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

/**
 * Benchmark strength of a model for a task type, normalised to 0–1. Returns a
 * neutral 0.5 for models with no benchmark profile so they neither win nor lose
 * on this factor alone.
 */
export function benchmarkScore01(model: ModelInfo, taskType: TaskType): number {
  const fam = resolveFamily(model);
  if (!fam) return 0.5;
  // Prefer current live/cached scores; fall back to the bundled table.
  const profile = liveProvider?.getQualityProfile(fam) ?? FAMILY_BENCHMARKS[fam];
  if (!profile) return 0.5;

  let score: number;
  if (taskType === 'mixed') {
    const vals = Object.values(profile).filter((v): v is number => typeof v === 'number');
    score = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 50;
  } else {
    score = profile[taskType] ?? 50;
  }
  return Math.max(0, Math.min(1, score / 100));
}
