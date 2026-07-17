// ─────────────────────────────────────────────
//  Cascade AI — Public-benchmark model strengths
// ─────────────────────────────────────────────
//
//  Curated 0–100 scores per model family per task type, approximated from
//  public benchmarks so Cascade Auto can route each subtask to the model that
//  is actually strongest at it, rather than always defaulting to the
//  cheapest-or-first model:
//    - code     ← SWE-bench / HumanEval
//    - analysis ← MMLU / GPQA / reasoning suites
//    - creative ← writing evals / LMArena
//    - data     ← GSM8K / MATH / data-wrangling
//
//  These are deliberately editable knobs, not gospel — they only set the
//  *relative* preference between available models for a given task type.

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
  // Anthropic — strongest at coding and agentic tool-use.
  'claude-opus':       { code: 95, analysis: 92, creative: 90, data: 88 },
  'claude-sonnet':     { code: 93, analysis: 88, creative: 87, data: 85 },
  'claude-haiku':      { code: 80, analysis: 75, creative: 76, data: 72 },
  // OpenAI GPT-5 family — current flagship; strongest all-round. Offline
  // baseline (the live fetch refreshes these); point releases (gpt-5.x) fold in.
  'gpt-5':             { code: 96, analysis: 95, creative: 93, data: 93 },
  'gpt-5-mini':        { code: 88, analysis: 86, creative: 86, data: 84 },
  'gpt-5-nano':        { code: 78, analysis: 75, creative: 78, data: 73 },
  // OpenAI — strong all-round, particularly creative/writing.
  'gpt-4.1':           { code: 90, analysis: 89, creative: 91, data: 87 },
  'gpt-4.1-mini':      { code: 82, analysis: 80, creative: 83, data: 79 },
  'gpt-4.1-nano':      { code: 70, analysis: 68, creative: 72, data: 66 },
  'gpt-4o':            { code: 86, analysis: 85, creative: 90, data: 84 },
  'gpt-4o-mini':       { code: 76, analysis: 74, creative: 80, data: 72 },
  // Google — strongest at analysis/data and long-context.
  'gemini-2.5-pro':    { code: 90, analysis: 93, creative: 86, data: 92 },
  'gemini-2.5-flash':  { code: 82, analysis: 83, creative: 80, data: 82 },
  'gemini-1.5-pro':    { code: 82, analysis: 84, creative: 82, data: 85 },
  'gemini-2.0-flash':  { code: 79, analysis: 80, creative: 79, data: 80 },
  'gemini-flash-lite': { code: 68, analysis: 68, creative: 70, data: 68 },
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
  [/opus/i, 'claude-opus'],
  [/sonnet/i, 'claude-sonnet'],
  [/haiku/i, 'claude-haiku'],
  // GPT-5 family — ordered most-specific first (nano/mini before the base, and
  // point releases like gpt-5.4 fold into the gpt-5 base).
  [/gpt-?5.*nano/i, 'gpt-5-nano'],
  [/gpt-?5.*mini/i, 'gpt-5-mini'],
  [/gpt-?5/i, 'gpt-5'],
  [/gpt-?4\.1-nano/i, 'gpt-4.1-nano'],
  [/gpt-?4\.1-mini/i, 'gpt-4.1-mini'],
  [/gpt-?4\.1/i, 'gpt-4.1'],
  [/gpt-?4o-mini/i, 'gpt-4o-mini'],
  [/gpt-?4o/i, 'gpt-4o'],
  [/gemini-?2\.5-pro/i, 'gemini-2.5-pro'],
  [/gemini-?2\.5-flash/i, 'gemini-2.5-flash'],
  [/gemini-?1\.5-pro/i, 'gemini-1.5-pro'],
  [/gemini-?2\.0-flash-lite/i, 'gemini-flash-lite'],
  [/gemini-?2\.0-flash/i, 'gemini-2.0-flash'],
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
