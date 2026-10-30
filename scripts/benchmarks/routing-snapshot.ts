// Prints Cascade Auto's pick per provider set × tier × task type × bias, as
// JSON, so a benchmark refresh can be reviewed as a routing diff:
//   npx tsx scripts/benchmarks/routing-snapshot.ts > before.json
// No tracker and no feedback: this is what the benchmark data alone decides.
import { ModelSelector } from '../../src/core/router/selector.js';
import { TaskAnalyzer, type AutoBias, type TaskProfile } from '../../src/core/router/task-analyzer.js';
import type { ProviderType, TierRole } from '../../src/types.js';

const PROVIDER_SETS: Record<string, ProviderType[]> = {
  all: ['anthropic', 'openai', 'gemini'],
  anthropic: ['anthropic'],
  openai: ['openai'],
  gemini: ['gemini'],
};
const TIERS: TierRole[] = ['T1', 'T2', 'T3'];
const TYPES = ['code', 'analysis', 'creative', 'data', 'mixed'] as const;
const BIASES: AutoBias[] = ['balanced', 'quality', 'cost'];
// T1 plans and T2 manages: both run tool loops, so they select with tool use.
const COMPLEXITY: Record<TierRole, TaskProfile['complexity']> = { T1: 4, T2: 3, T3: 2 };

const out: Record<string, string> = {};
for (const [setName, providers] of Object.entries(PROVIDER_SETS)) {
  for (const bias of BIASES) {
    for (const tier of TIERS) {
      for (const type of TYPES) {
        const selector = new ModelSelector(new Set(providers));
        const analyzer = new TaskAnalyzer(undefined, bias);
        const profile: TaskProfile = {
          type, complexity: COMPLEXITY[tier], requiresReasoning: tier !== 'T3',
          requiresVision: false, estimatedTokens: 2000, confidence: 0.9,
        };
        (analyzer as unknown as { analyze: () => Promise<TaskProfile> }).analyze = async () => profile;
        const sel = await analyzer.select('x', tier, selector, { requiresToolUse: true });
        out[`${setName}|${bias}|${tier}|${type}`] = sel.model?.id ?? '(none)';
      }
    }
  }
}
console.log(JSON.stringify(out, null, 1));
