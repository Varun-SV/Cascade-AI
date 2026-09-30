// ─────────────────────────────────────────────
//  Cascade AI — A whole run under a small budget
// ─────────────────────────────────────────────
//
// The reported problem, end to end: with a $0.10 cap, a Complex run used to
// reply only "stopped to avoid runaway cost" once the cap was crossed. Here the
// real router counts real (fake-provider) usage through T1, T2 and T3.

import { describe, expect, it, vi } from 'vitest';
import { Cascade } from './cascade.js';
import type { CascadeConfig, ModelInfo } from '../types.js';

/** $0.01 per 1,000 tokens in and out. */
const PRICED = {
  id: 'priced-model', name: 'Priced', provider: 'anthropic', contextWindow: 200_000, maxOutputTokens: 8_000,
  inputCostPer1kTokens: 0.01, outputCostPer1kTokens: 0.01, isVisionCapable: false, supportsStreaming: false, isLocal: false,
} as unknown as ModelInfo;

const config = {
  version: '1.0', defaultIdentityId: 'default', providers: [], models: {},
  tools: { shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false },
  hooks: {}, dashboard: { port: 4891, auth: false, teamMode: 'single' }, telemetry: { enabled: false },
  memory: { maxSessionMessages: 1000, autoSummarizeAt: 150000, retentionDays: 90 },
  theme: 'cascade',
  workspace: { cascadeMdPath: 'CASCADE.md', configPath: '.cascade/config.json', keystorePath: '.cascade/keystore.enc', auditLogPath: '.cascade/audit.log' },
  routing: { forceTier: 'T1' },
  budget: { maxCostPerRunUsd: 0.1 },
} as unknown as CascadeConfig;

/** Six independent research sections of one worker each: more than $0.10 buys. */
const PLAN = JSON.stringify({
  complexity: 'Complex', reasoning: 'r',
  sections: Array.from({ length: 6 }, (_, i) => ({
    sectionId: `s${i + 1}`, sectionTitle: `Topic ${i + 1}`, description: `Research topic ${i + 1}`, expectedOutput: 'notes',
    constraints: [], dependsOn: [],
    t3Subtasks: [{ subtaskId: `w${i + 1}`, subtaskTitle: `Research ${i + 1}`, description: `Research topic ${i + 1}`, expectedOutput: 'notes', constraints: [], dependsOn: [] }],
  })),
});

function respond(content: string): string {
  if (content.startsWith('Analyze this task and create an execution plan')) return PLAN;
  if (content.startsWith('Execute the following subtask completely:')) return `Findings: ${/\*\*(.+?)\*\*/.exec(content)?.[1] ?? 'topic'} is covered.`;
  if (content.startsWith('Self-test this output')) return '{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}';
  if (content.startsWith('Summarize these T3 worker outputs')) return 'Section summary.';
  if (content.includes('strict QA Reviewer')) return 'APPROVED';
  if (content.startsWith('Compile a final, coherent response')) return 'COMPILED ANSWER from the finished sections.';
  if (content.startsWith('Answer this request directly')) return 'DIRECT ANSWER within the budget.';
  return 'ok';
}

/**
 * A Cascade on the real router, whose provider bills what it reads (a token
 * per 4 characters) and writes (up to `writes` tokens, within the limit it is
 * sent), at $0.01 per 1,000 either way.
 */
async function cascadeBilling(writes: number, capUsd = 0.1) {
  const cascade = new Cascade({ ...config, budget: { maxCostPerRunUsd: capUsd } } as CascadeConfig, process.cwd());
  await cascade.init();
  const router = (cascade as unknown as { router: Record<string, unknown> }).router;
  for (const tier of ['T1', 'T2', 'T3']) (router['tierModels'] as Map<string, ModelInfo>).set(tier, PRICED);
  router['getModelForTier'] = () => PRICED;
  router['getTierModel'] = () => PRICED;
  const workers: string[] = [];
  router['getProvider'] = () => ({
    generate: async (opts: { messages: Array<{ content: unknown }>; maxTokens?: number }) => {
      const content = String(opts.messages[opts.messages.length - 1]?.content ?? '');
      if (content.startsWith('Execute the following subtask completely:')) workers.push(content);
      const inputTokens = Math.ceil(opts.messages.reduce((n, m) => n + String(m.content ?? '').length, 0) / 4);
      const outputTokens = Math.min(opts.maxTokens ?? writes, writes);
      return { content: respond(content), finishReason: 'stop', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
    },
  });
  const stopped = vi.fn();
  cascade.on('run:budget-exceeded', stopped);
  const spent = () => (router as unknown as { runBudget: () => { spentUsd: number } }).runBudget().spentUsd;
  return { cascade, workers, stopped, spent };
}

describe('a Complex run with a $0.10 budget', () => {
  it('plans only what the budget pays for, and finishes within it', async () => {
    const { cascade, workers, stopped, spent } = await cascadeBilling(700);
    const result = await cascade.run({ prompt: 'Research six topics and compare them.' });

    // Six sections planned; $0.08 of work pays for one at this price, and the
    // answer says it covers only that.
    expect(workers).toHaveLength(1);
    expect(result.output).toContain('COMPILED ANSWER');
    expect(result.output).toMatch(/Budget: not all the planned work fitted in this task's \$0\.10 budget/);
    expect(result.output).not.toMatch(/Stopped to avoid runaway cost/);
    expect(spent()).toBeLessThanOrEqual(0.1);
    expect(stopped).not.toHaveBeenCalled();
  }, 30_000);

  it('answers directly when planning alone spends the work budget, and stays within the cap', async () => {
    // The model writes 3,000 tokens a call where the plan assumed 700: the
    // plan itself leaves too little for a worker.
    const { cascade, workers, stopped, spent } = await cascadeBilling(3_000);
    const result = await cascade.run({ prompt: 'Research six topics and compare them.' });

    expect(workers).toHaveLength(0);
    expect(result.output).toContain('DIRECT ANSWER');
    expect(result.output).toMatch(/Budget: not all the planned work fitted in this task's \$0\.10 budget/);
    expect(result.output).not.toMatch(/Stopped to avoid runaway cost/);
    expect(spent()).toBeLessThanOrEqual(0.1);
    expect(stopped).not.toHaveBeenCalled();
  }, 30_000);

  it('wraps up part-way and writes the answer from the work that finished', async () => {
    // $0.20: the plan and one worker fit before work reaches its $0.16.
    const { cascade, workers, stopped, spent } = await cascadeBilling(6_000, 0.2);
    const result = await cascade.run({ prompt: 'Research six topics and compare them.' });

    expect(workers.length).toBeGreaterThan(0);
    expect(result.output).toContain('COMPILED ANSWER');
    expect(result.output).toMatch(/Budget: not all the planned work fitted in this task's \$0\.20 budget/);
    expect(spent()).toBeLessThanOrEqual(0.2);
    expect(stopped).not.toHaveBeenCalled();
  }, 30_000);
});
