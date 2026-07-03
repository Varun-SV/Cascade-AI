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

  it('routes self-identity questions to Simple via heuristic, no classifier call', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn();
    (cascade as any).router = { generate };

    for (const q of ['who are you', 'who are you?', 'what can you do', 'who made you']) {
      const complexity = await (cascade as any).determineComplexity(q, '/dummy');
      expect(complexity, q).toBe('Simple');
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it('parses a verdict embedded in preamble/markdown instead of defaulting to Complex', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    // A chatty local model prepends text before the verdict — must still be Simple.
    const generate = vi.fn().mockResolvedValue({
      content: 'Sure! This is a **Simple** request — just a direct answer.',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });
    (cascade as any).router = { generate };

    // An artifact verb ("implement") avoids the read-only/conversational
    // short-circuits, so the classifier (and its parser) actually runs.
    const complexity = await (cascade as any).determineComplexity(
      'implement the new caching layer for the parser module with thorough coverage', '/dummy');
    expect(complexity).toBe('Simple');
    expect(generate).toHaveBeenCalled();
  });

  it('defaults an unparseable classifier reply for a mid-size task to Moderate (no strong signals → not Complex)', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn().mockResolvedValue({
      content: 'I think we should consider several factors here before deciding.',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });
    (cascade as any).router = { generate };

    // A single-target refactor with no scale-noun / multi-step signals: the
    // classifier reply is unparseable, so it defaults by length to Moderate —
    // the cost guardrail still holds for ambiguous prompts.
    const complexity = await (cascade as any).determineComplexity(
      'refactor the parser module so the error handling reads more clearly for future maintainers down the line',
      '/dummy');
    expect(complexity).toBe('Moderate');
    expect(generate).toHaveBeenCalled();
  });

  it('escalates a clearly-complex prompt to Complex when the classifier reply is unparseable (bug #5)', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn().mockResolvedValue({
      content: 'I think we should consider several factors here before deciding.',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });
    (cascade as any).router = { generate };

    // Explicit build+scale signals: a small classifier's garbled reply must not
    // strand genuinely complex build work at T2 — it reaches the full hierarchy.
    const complexity = await (cascade as any).determineComplexity(
      'refactor and migrate the build pipeline to a new system with full validation', '/dummy');
    expect(complexity).toBe('Complex');
    expect(generate).toHaveBeenCalled();
  });

  it('floors a clearly-complex prompt to Complex even when the classifier under-rates it as Moderate (bug #5)', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn().mockResolvedValue({
      // A small local model confidently under-rates a big build as Moderate.
      content: 'Moderate — a manager can coordinate this',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });
    (cascade as any).router = { generate };

    const complexity = await (cascade as any).determineComplexity(
      'build a full authentication system with a backend api, a database schema, and end-to-end tests',
      '/dummy');
    expect(complexity).toBe('Complex');
    expect(generate).toHaveBeenCalled();
    const log = cascade.getDecisionLog();
    expect(log[0]!.detail).toContain('heuristic floor');
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
