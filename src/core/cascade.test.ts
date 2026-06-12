import { describe, expect, it, vi } from 'vitest';
import { Cascade } from './cascade.js';
import type { CascadeConfig, ConversationMessage } from '../types.js';

const baseConfig: CascadeConfig = {
  version: '1.0',
  defaultIdentityId: 'default',
  providers: [],
  models: {},
  tools: {
    shellAllowlist: [],
    shellBlocklist: [],
    requireApprovalFor: [],
    browserEnabled: false,
  },
  hooks: {},
  dashboard: {
    port: 4891,
    auth: false,
    teamMode: 'single',
  },
  telemetry: {
    enabled: false,
  },
  memory: {
    maxSessionMessages: 1000,
    autoSummarizeAt: 150000,
    retentionDays: 90,
  },
  theme: 'cascade',
  workspace: {
    cascadeMdPath: 'CASCADE.md',
    configPath: '.cascade/config.json',
    keystorePath: '.cascade/keystore.enc',
    auditLogPath: '.cascade/audit.log',
  },
};

describe('Cascade routing complexity', () => {
  it('passes recent conversation context into complexity routing', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn().mockResolvedValue({
      content: 'Complex',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });

    (cascade as any).router = { generate };

    const history: ConversationMessage[] = [
      { role: 'assistant', content: 'I can do a deep multi-agent research pass and generate a verified PDF report.' },
      { role: 'user', content: 'Sounds good.' },
    ];

    const complexity = await (cascade as any).determineComplexity('proceed', '/dummy', history);
    const routedPrompt = generate.mock.calls[0]?.[1]?.messages?.[0]?.content as string;

    expect(complexity).toBe('Complex');
    expect(routedPrompt).toContain('Recent conversation:');
    expect(routedPrompt).toContain('I can do a deep multi-agent research pass');
    expect(routedPrompt).toContain('Latest user message:\nproceed');
  });

  it('takes the verdict from the first word and records the reason in the decision log', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn().mockResolvedValue({
      // Reason mentions "complex" — must not override the Moderate verdict.
      content: 'Moderate — a few steps, not complex enough for multiple managers',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });
    (cascade as any).router = { generate };

    const complexity = await (cascade as any).determineComplexity('refactor the parser and add tests', '/dummy');

    expect(complexity).toBe('Moderate');
    const log = cascade.getDecisionLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe('complexity');
    expect(log[0]!.detail).toContain('Moderate — classifier:');
    expect(log[0]!.detail).toContain('a few steps');
  });

  it('records the heuristic short-circuit for casual greetings without a classifier call', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn();
    (cascade as any).router = { generate };

    const complexity = await (cascade as any).determineComplexity('hello!', '/dummy');

    expect(complexity).toBe('Simple');
    expect(generate).not.toHaveBeenCalled();
    expect(cascade.getDecisionLog()[0]!.detail).toContain('heuristic: casual greeting');
  });
});

describe('Boardroom plan approval gate', () => {
  const plan = {
    complexity: 'Complex' as const,
    reasoning: 'test',
    sections: [
      { sectionId: 's1', sectionTitle: 'Build', description: '', expectedOutput: '', constraints: [], t3Subtasks: [{}, {}] },
      { sectionId: 's2', sectionTitle: 'Verify', description: '', expectedOutput: '', constraints: [], t3Subtasks: [{}] },
    ],
  };

  it('default-approves when nobody is listening (SDK/headless unchanged)', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const decision = await (cascade as any).requestPlanApproval(plan, 'task-1');
    expect(decision).toEqual({ approved: true });
  });

  it('emits the org-chart summary and resolves with the listener decision', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    (cascade as any).router = { getTierModel: () => null };

    let payload: any;
    cascade.on('plan:approval-required', (p) => {
      payload = p;
      cascade.resolvePlanApproval(false);
    });

    const decision = await (cascade as any).requestPlanApproval(plan, 'task-2');
    expect(decision.approved).toBe(false);
    expect(payload.t2Count).toBe(2);
    expect(payload.t3Count).toBe(3);
    expect(payload.estCostUsd).toBe(0); // no models resolved → no estimate
  });

  it('estimates plan cost from the resolved T2/T3 model pricing', () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const model = { inputCostPer1kTokens: 1, outputCostPer1kTokens: 1, isLocal: false };
    (cascade as any).router = { getTierModel: () => model };
    const est = (cascade as any).estimatePlanCost(plan);
    expect(est).toBeGreaterThan(0);
  });
});
