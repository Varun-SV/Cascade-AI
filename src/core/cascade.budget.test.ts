// ─────────────────────────────────────────────
//  Cascade AI — A budget-limited run still answers
// ─────────────────────────────────────────────
//
// The run-level half of router/run-budget.ts: the calls that ARE the answer
// may use the budget kept back for it, a run that wrapped up says so under
// its answer, and a wrap-up before any work is done ends the run gracefully.

import { describe, expect, it, vi } from 'vitest';
import { Cascade } from './cascade.js';
import type { CascadeConfig, GenerateOptions, ModelInfo } from '../types.js';

const config = {
  version: '1.0', defaultIdentityId: 'default', providers: [], models: {},
  tools: { shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false },
  hooks: {}, dashboard: { port: 4891, auth: false, teamMode: 'single' }, telemetry: { enabled: false },
  memory: { maxSessionMessages: 1000, autoSummarizeAt: 150000, retentionDays: 90 },
  theme: 'cascade',
  workspace: { cascadeMdPath: 'CASCADE.md', configPath: '.cascade/config.json', keystorePath: '.cascade/keystore.enc', auditLogPath: '.cascade/audit.log' },
} as unknown as CascadeConfig;

const MODEL = {
  id: 'stub', name: 'Stub', provider: 'openai', contextWindow: 128_000, maxOutputTokens: 4_000,
  inputCostPer1kTokens: 0.001, outputCostPer1kTokens: 0.002, isVisionCapable: false, supportsStreaming: false, isLocal: false,
} as unknown as ModelInfo;

type Generate = (tier: string, options: GenerateOptions) => Promise<unknown>;

async function cascadeAnswering(generate: Generate, extra: Partial<CascadeConfig> = {}) {
  const cascade = new Cascade({ ...config, ...extra } as CascadeConfig, process.cwd());
  await cascade.init();
  const router = (cascade as unknown as { router: Record<string, unknown> }).router;
  router['getSelector'] = () => ({ selectForTier: () => MODEL, getCandidatesForTier: () => [MODEL] });
  router['getTierModel'] = () => MODEL;
  router['getModelForTier'] = () => MODEL;
  router['generate'] = vi.fn(generate);
  return { cascade, router };
}

const answer = (content: string) => async () => ({
  content, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
});

describe('a budget-limited run', () => {
  it('writes a fast answer with the budget kept back for the answer', async () => {
    const { cascade, router } = await cascadeAnswering(answer('Quick answer.'));
    await cascade.run({ prompt: 'what is 2+2', fastAnswer: true });
    const calls = (router['generate'] as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]![1]).toMatchObject({ budgetClass: 'final' });
  });

  it('lets every call of a Simple run use it, since each one is the answer', async () => {
    const { cascade, router } = await cascadeAnswering(answer('The answer.'), { routing: { forceTier: 'T3' } } as Partial<CascadeConfig>);
    await cascade.run({ prompt: 'summarise the plan in one line' });
    const calls = (router['generate'] as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, options] of calls) expect(options).toMatchObject({ budgetClass: 'final' });
  });

  it('says under the answer that work stopped at the budget', async () => {
    const { cascade, router } = await cascadeAnswering(answer('The answer.'), { routing: { forceTier: 'T3' } } as Partial<CascadeConfig>);
    router['isWrappingUp'] = () => true;
    router['runBudget'] = () => ({ capUsd: 1, spentUsd: 0.8, usedTokens: 1_000, wrappingUp: true, workNotStarted: 2 });
    const result = await cascade.run({ prompt: 'summarise the plan in one line' });
    expect(result.output).toMatch(/Budget: not all the planned work fitted in this task's \$1\.00 budget \(\$0\.80 spent\)/);
  });

  it('says nothing when it wrapped up with nothing left to hold back', async () => {
    // Its last worker crossed the line: everything planned was done.
    const { cascade, router } = await cascadeAnswering(answer('The answer.'), { routing: { forceTier: 'T3' } } as Partial<CascadeConfig>);
    router['isWrappingUp'] = () => true;
    router['runBudget'] = () => ({ capUsd: 1, spentUsd: 0.85, usedTokens: 1_000, wrappingUp: true, workNotStarted: 0 });
    const result = await cascade.run({ prompt: 'summarise the plan in one line' });
    expect(result.output).not.toMatch(/Budget:/);
  });

  it('adds nothing when the run never wrapped up', async () => {
    const { cascade } = await cascadeAnswering(answer('The answer.'), { routing: { forceTier: 'T3' } } as Partial<CascadeConfig>);
    const result = await cascade.run({ prompt: 'summarise the plan in one line' });
    expect(result.output).not.toMatch(/Budget:/);
  });

  it('ends gracefully when the budget is spent before any work is done', async () => {
    const refused = Object.assign(new Error('Most of this task\'s budget is spent.'), { name: 'BudgetWrapUpError' });
    const { cascade } = await cascadeAnswering(async () => { throw refused; }, { routing: { forceTier: 'T1' } } as Partial<CascadeConfig>);
    const stopped = vi.fn();
    cascade.on('run:budget-exceeded', stopped);
    const result = await cascade.run({ prompt: 'research and compare three databases' });
    expect(result.output).toMatch(/budget/i);
    expect(stopped).toHaveBeenCalled();
  });

  it('records the wrap-up for /why and passes it on', async () => {
    const { cascade, router } = await cascadeAnswering(answer('x'));
    const heard = vi.fn();
    cascade.on('budget:wrap-up', heard);
    (router as unknown as { emit: (e: string, p: unknown) => void }).emit('budget:wrap-up', { reason: 'Used $0.80 of this task\'s $1.00 budget.', spentUsd: 0.8, capUsd: 1 });
    expect(heard).toHaveBeenCalled();
    expect(cascade.getDecisionLog()).toContainEqual(expect.objectContaining({ kind: 'budget', detail: expect.stringContaining('$0.80') }));
  });
});
