import { describe, expect, it, vi } from 'vitest';
import { Cascade, buildContextualPrompt } from './cascade.js';
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

  it('uses a caller complexity hint and skips the classifier LLM call', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn();
    (cascade as any).router = { generate };

    const complexity = await (cascade as any).determineComplexity(
      'refactor the parser and add tests', '/dummy', [], 'Moderate',
    );

    expect(complexity).toBe('Moderate');
    expect(generate).not.toHaveBeenCalled();
    expect(cascade.getDecisionLog()[0]!.detail).toContain('Moderate — on-device hint');
  });

  it('floors a too-low hint to Complex when the prompt clearly needs the full hierarchy', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn();
    (cascade as any).router = { generate };

    // Multiple system-level deliverables — the same floor the classifier path uses.
    const complexity = await (cascade as any).determineComplexity(
      'Build a full-stack web application with an authentication system and a REST api',
      '/dummy', [], 'Simple',
    );

    expect(complexity).toBe('Complex');
    expect(generate).not.toHaveBeenCalled();
    expect(cascade.getDecisionLog()[0]!.detail).toContain('heuristic floor over on-device hint');
  });

  it('floors a "Simple" hint on a single-deliverable build up to Moderate', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn();
    (cascade as any).router = { generate };

    const complexity = await (cascade as any).determineComplexity(
      'Build a todo list application for me', '/dummy', [], 'Simple',
    );

    expect(complexity).toBe('Moderate');
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

  it('right-sizes a small single-deliverable build to Moderate, never the full hierarchy (token-bomb fix)', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn().mockResolvedValue({
      content: 'Simple — quick single-file build',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });
    (cascade as any).router = { generate };

    // "create ... app" used to floor straight to Complex (3-5 managers ×
    // workers for a one-worker task). One scale noun without multi-part
    // phrasing is a single manager's worth: Simple floors to Moderate only.
    const complexity = await (cascade as any).determineComplexity(
      'create a small todo app for my browser homepage with a clean look', '/dummy');
    expect(complexity).toBe('Moderate');
    const log = cascade.getDecisionLog();
    expect(log[0]!.detail).toContain('single manager');
  });

  it('leaves a Moderate verdict on a single-deliverable build alone (no Complex floor)', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn().mockResolvedValue({
      content: 'Moderate — one manager can handle this',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });
    (cascade as any).router = { generate };

    const complexity = await (cascade as any).determineComplexity(
      'create a small todo app for my browser homepage with a clean look', '/dummy');
    expect(complexity).toBe('Moderate');
    expect(cascade.getDecisionLog()[0]!.detail).not.toContain('heuristic floor');
  });
});

describe('buildContextualPrompt (multi-turn context into execution)', () => {
  it('returns the prompt unchanged when there is no history', () => {
    expect(buildContextualPrompt('hello')).toBe('hello');
    expect(buildContextualPrompt('hello', [])).toBe('hello');
  });

  it('prefixes recent turns and labels the latest message so a follow-up resolves in context', () => {
    const history: ConversationMessage[] = [
      { role: 'assistant', content: '1. Try the search again, or\n2. Summarize articles you paste.' },
      { role: 'user', content: 'go with the first one' },
      { role: 'assistant', content: 'Okay — retrying the web search now.' },
    ];
    const out = buildContextualPrompt('1', history);
    // The bare "1" is no longer standalone — the prior turns travel with it.
    expect(out).toContain('Recent conversation');
    expect(out).toContain('Assistant: 1. Try the search again');
    expect(out).toContain('User: go with the first one');
    expect(out).toContain('Latest user message:\n1');
    expect(out).not.toBe('1');
  });

  it('keeps only the last 6 turns', () => {
    const history: ConversationMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as ConversationMessage['role'],
      content: `msg-${i}`,
    }));
    const out = buildContextualPrompt('next', history);
    expect(out).not.toContain('msg-3'); // 7th-from-last, dropped
    expect(out).toContain('msg-4'); // first kept
    expect(out).toContain('msg-9'); // last kept
  });

  it('flattens non-string (block) message content without throwing', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'describe this' }, { type: 'image', image: { type: 'base64', data: 'x', mimeType: 'image/png' } }] },
    ];
    const out = buildContextualPrompt('and now?', history);
    expect(out).toContain('describe this');
    expect(out).toContain('[non-text]');
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

describe('Fast answer (direct single-model path)', () => {
  const midModel = { id: 'gpt-4o-mini', provider: 'openai', inputCostPer1kTokens: 0, outputCostPer1kTokens: 0 };

  function mockRouter(generate: ReturnType<typeof vi.fn>) {
    const selector = {
      getCandidatesForTier: () => [midModel],
      selectForTier: () => midModel,
    };
    return {
      getSelector: () => selector,
      generate,
      getStats: () => ({ totalTokens: 8, totalCostUsd: 0.0001, costByTier: {}, tokensByTier: { T2: 8 }, costByFeature: {} }),
      getTierCostPercentages: () => ({}),
      setRunSignal: () => {},
    };
  }

  it('answers with one generate call — no tiers, no tools — and streams the reply', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn(async (_tier: string, opts: any, onChunk?: (c: { text: string }) => void) => {
      onChunk?.({ text: 'Fast ' });
      onChunk?.({ text: 'reply.' });
      // The fast path must pin the mid model and pass NO tools.
      expect(opts.model?.id).toBe('gpt-4o-mini');
      expect(opts.tools).toBeUndefined();
      return { content: 'Fast reply.', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, estimatedCostUsd: 0.0001 }, finishReason: 'stop' };
    });
    (cascade as any).router = mockRouter(generate);

    const tokens: string[] = [];
    cascade.on('stream:token', (e: { text: string; primary?: boolean }) => { if (e.primary) tokens.push(e.text); });

    const result = await (cascade as any).runFastAnswer({ prompt: 'hi there' }, Date.now(), 'task-fast');

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('Fast reply.');
    expect(result.t2Results).toEqual([]);
    expect(tokens.join('')).toBe('Fast reply.');
    expect((cascade as any).decisionLog?.some((d: { detail: string }) => /Fast answer/.test(d.detail))).toBe(true);
  });

  it('passes recent conversation history into the single call', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    let seenMessages: any[] = [];
    const generate = vi.fn(async (_t: string, opts: any) => { seenMessages = opts.messages; return { content: 'ok', usage: {}, finishReason: 'stop' }; });
    (cascade as any).router = mockRouter(generate);

    await (cascade as any).runFastAnswer(
      { prompt: 'and the second one', conversationHistory: [{ role: 'assistant', content: '1) A  2) B' }] },
      Date.now(), 'task-fast-2',
    );

    expect(seenMessages[0]).toEqual({ role: 'assistant', content: '1) A  2) B' });
    expect(seenMessages[seenMessages.length - 1]).toEqual({ role: 'user', content: 'and the second one' });
  });
});

describe('Small-talk gate (auto fast answer) + terse option replies', () => {
  const cascade = new Cascade(baseConfig, process.cwd()) as any;

  it('treats greetings and self-identity questions as small talk', () => {
    expect(cascade.looksLikeSmallTalk('hi')).toBe(true);
    expect(cascade.looksLikeSmallTalk('Hello!')).toBe(true);
    expect(cascade.looksLikeSmallTalk('thanks')).toBe(true);
    expect(cascade.looksLikeSmallTalk('who are you?')).toBe(true);
    expect(cascade.looksLikeSmallTalk('what can you do')).toBe(true);
    expect(cascade.looksLikeSmallTalk('hey there')).toBe(true);
  });

  it('does NOT treat lookups, tasks, or terse confirmations as small talk', () => {
    // These need tools or real context — they stay on the worker path.
    expect(cascade.looksLikeSmallTalk('what is a monad')).toBe(false);
    expect(cascade.looksLikeSmallTalk('show me the config file')).toBe(false);
    expect(cascade.looksLikeSmallTalk('list the failing tests')).toBe(false);
    expect(cascade.looksLikeSmallTalk('tell me the latest on the launch')).toBe(false);
    expect(cascade.looksLikeSmallTalk('fix the typo in README')).toBe(false);
    // Bare confirmations in an ongoing conversation are task input.
    const history = [{ role: 'assistant', content: 'Shall I proceed with the refactor?' }];
    expect(cascade.looksLikeSmallTalk('yes', history)).toBe(false);
    expect(cascade.looksLikeSmallTalk('ok', history)).toBe(false);
  });

  it('recognises terse option replies', () => {
    expect(cascade.looksLikeTerseOptionReply('3')).toBe(true);
    expect(cascade.looksLikeTerseOptionReply('b)')).toBe(true);
    expect(cascade.looksLikeTerseOptionReply('(2)')).toBe(true);
    expect(cascade.looksLikeTerseOptionReply('option 2')).toBe(true);
    expect(cascade.looksLikeTerseOptionReply('3 please, and make it a chart')).toBe(false);
    expect(cascade.looksLikeTerseOptionReply('proceed')).toBe(false);
  });

  it('ignores a context-free on-device hint for a terse option reply and classifies with history', async () => {
    const c = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn().mockResolvedValue({
      content: 'Simple',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });
    (c as any).router = { generate };
    const history: ConversationMessage[] = [
      { role: 'assistant', content: 'Which would you like? 1) a table 2) prose 3) a recommendation chart' },
    ];
    // The tiny on-device model said Complex for "3" — that hint must be ignored
    // in favour of the LLM classifier, which sees the conversation.
    const complexity = await (c as any).determineComplexity('3', '/dummy', history, 'Complex');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(complexity).toBe('Simple');
  });

  it('still honours an on-device hint for a normal prompt', async () => {
    const c = new Cascade(baseConfig, process.cwd());
    const generate = vi.fn();
    (c as any).router = { generate };
    const complexity = await (c as any).determineComplexity(
      'refactor the auth flow to use sessions', '/dummy', [], 'Moderate',
    );
    expect(generate).not.toHaveBeenCalled(); // hint used, no classifier round-trip
    expect(complexity).toBe('Moderate');
  });
});

describe('Extended context (compaction integration)', () => {
  const enabledConfig: CascadeConfig = { ...baseConfig, extendedContext: { enabled: true, maxMultiplier: 2 } };

  function mockRouter(window: number | undefined, generate = vi.fn(async () => ({ content: 'CONDENSED', usage: {}, finishReason: 'stop' }))) {
    return { getReferenceContextWindow: () => window, generate };
  }

  it('is a no-op when extended context is disabled', async () => {
    const cascade = new Cascade(baseConfig, process.cwd());
    (cascade as any).router = mockRouter(1000);
    const opts = { prompt: 'x'.repeat(100_000), conversationHistory: [] };
    expect(await (cascade as any).applyExtendedContext(opts)).toBe(opts);
  });

  it('is a no-op when the model window is unknown', async () => {
    const cascade = new Cascade(enabledConfig, process.cwd());
    (cascade as any).router = mockRouter(undefined);
    const opts = { prompt: 'x'.repeat(100_000), conversationHistory: [] };
    expect(await (cascade as any).applyExtendedContext(opts)).toBe(opts);
  });

  it('folds an over-budget history into a leading summary (automatic)', async () => {
    const cascade = new Cascade(enabledConfig, process.cwd());
    const generate = vi.fn(async () => ({ content: 'CONDENSED', usage: {}, finishReason: 'stop' }));
    (cascade as any).router = mockRouter(1000, generate); // budget 800 tokens
    const history: ConversationMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(400), // ~100 tokens each → ~2000 total
    }));
    const out = await (cascade as any).applyExtendedContext({ prompt: 'hi', conversationHistory: history });
    expect(generate).toHaveBeenCalled();
    expect(out.conversationHistory[0].role).toBe('system');
    expect(out.conversationHistory.length).toBeLessThan(history.length);
  });

  // Window 1000 → budget 800, cap 2× = 2000 tokens (~8000 chars). An input well
  // past the window still spans several chunks after the cap, so map-reduce runs.
  const bigInput = 'word here and there. '.repeat(1500); // ~31500 chars ≫ 1000-token window

  it('compacts a single oversized input when there is no confirm listener (proceeds)', async () => {
    const cascade = new Cascade(enabledConfig, process.cwd());
    const generate = vi.fn(async () => ({ content: 'S', usage: {}, finishReason: 'stop' }));
    (cascade as any).router = mockRouter(1000, generate);
    const out = await (cascade as any).applyExtendedContext({ prompt: bigInput, conversationHistory: [] });
    expect(generate).toHaveBeenCalled();
    expect(out.prompt).not.toBe(bigInput);
  });

  it('leaves the oversized input untouched when the confirm is rejected', async () => {
    const cascade = new Cascade(enabledConfig, process.cwd());
    const generate = vi.fn(async () => ({ content: 'S', usage: {}, finishReason: 'stop' }));
    (cascade as any).router = mockRouter(1000, generate);
    cascade.on('context:approval-required', () => cascade.resolveContextApproval(false));
    const out = await (cascade as any).applyExtendedContext({ prompt: bigInput, conversationHistory: [] });
    expect(out.prompt).toBe(bigInput);
    expect(generate).not.toHaveBeenCalled();
  });
});
