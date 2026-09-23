// ─────────────────────────────────────────────
//  Cascade AI — Never pass off work that did not happen
// ─────────────────────────────────────────────
//
//  One rule, every prompt that can hand the user an answer. Each door is
//  tested here rather than beside its tier, so a new door that forgets the
//  rule has an obvious place to be missed from.

import { describe, expect, it, vi } from 'vitest';
import type { CascadeConfig, GenerateResult, T2ToT3Assignment, T2Result, ToolCall, ToolDefinition } from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { ACTING_INTEGRITY_RULE, REPORTING_INTEGRITY_RULE, describeArgs, describeToolRecord, recordToolCall } from './integrity.js';
import { T3Worker, buildWorkerRules } from './t3-worker.js';
import { T2Manager } from './t2-manager.js';
import { T1Administrator, type TaskPlan } from './t1-administrator.js';

function makeResult(content: string, toolCalls?: ToolCall[]): GenerateResult {
  return {
    content,
    toolCalls,
    finishReason: toolCalls?.length ? 'tool_use' : 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
  };
}

function assignment(overrides: Partial<T2ToT3Assignment> = {}): T2ToT3Assignment {
  return {
    subtaskId: 'probe',
    subtaskTitle: 'Probe the chatbot',
    description: 'Open the site with browser control, ask the chatbot the three questions, and return its answers verbatim',
    expectedOutput: 'The chatbot’s three answers, unchanged',
    constraints: [],
    peerT3Ids: [],
    parentT2: 't2-1',
    ...overrides,
  };
}

/** The refusal the browser controller throws when every session is taken. */
const REFUSAL = 'All 1 browser session are in use by other runs. Try again when one finishes, or raise the session limit in settings.';

function browserRegistry(execute = vi.fn().mockRejectedValue(new Error(REFUSAL))): ToolRegistry {
  const defs: ToolDefinition[] = [{ name: 'browser_control', description: 'Drive a browser', inputSchema: {} }];
  return {
    getToolDefinitions: () => defs,
    requiresApproval: () => false,
    isDangerous: () => false,
    hasTool: (n: string) => n === 'browser_control',
    execute,
  } as unknown as ToolRegistry;
}

type Call = { tier: string; systemPrompt: string; content: string };

const PASS = '{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}';

/** Records every model call; the self-test passes and everything else answers `text`. */
function recordingRouter(text: string, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const router = {
    generate: vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }>; systemPrompt?: string }) => {
      const latest = options.messages[options.messages.length - 1];
      const content = typeof latest?.content === 'string' ? latest.content : '';
      calls.push({ tier, systemPrompt: options.systemPrompt ?? '', content });
      return makeResult(content.startsWith('Self-test this output') ? PASS : text);
    }),
    getModelForTier: () => undefined,
    ...extra,
  } as unknown as CascadeRouter;
  return { router, calls };
}

const noTools = () => ({ ...browserRegistry(), getToolDefinitions: () => [] }) as unknown as ToolRegistry;

/**
 * A worker that reaches for the browser once, is refused, and then reports
 * exactly what the reported run did: answers it never obtained.
 */
function fabricatingRouter(opts: {
  selfTest?: (prompt: string) => string;
  reflection?: boolean;
} = {}) {
  const calls: Call[] = [];
  let loop = 0;
  const generate = vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }>; systemPrompt?: string }) => {
    const latest = options.messages[options.messages.length - 1];
    const content = typeof latest?.content === 'string' ? latest.content : '';
    calls.push({ tier, systemPrompt: options.systemPrompt ?? '', content });
    if (content.startsWith('Self-test this output')) {
      return makeResult(opts.selfTest?.(content) ?? PASS);
    }
    if (content.includes('independent critic')) return makeResult('{"sufficient": false, "notes": "the answers are missing"}');
    if (content.startsWith('Improve the following')) return makeResult('Improved output');
    loop += 1;
    if (loop === 1) return makeResult('', [{ id: 'b1', name: 'browser_control', input: { action: 'navigate', url: 'https://example.test' } }]);
    return makeResult('I logged in and asked the chatbot. It answered: "Yes", "No", "Maybe".');
  });
  const router = {
    generate,
    getModelForTier: () => undefined,
    ...(opts.reflection ? { getReflectionConfig: () => ({ enabled: true, maxRounds: 1 }) } : {}),
  } as unknown as CascadeRouter;
  return { router, calls };
}

describe('describeToolRecord — what the worker actually did', () => {
  it('says plainly when no tool ran, so a claimed action has nothing behind it', () => {
    expect(describeToolRecord([])).toBe('none — no tool was called');
  });

  it('lists each call with the start of what it returned, on one line', () => {
    const text = describeToolRecord([
      { name: 'web_search', result: 'Top result:\n  Example   Domain' },
      { name: 'browser_control', result: `Tool error: ${REFUSAL}` },
    ]);
    expect(text).toBe(`- web_search → Top result: Example Domain\n- browser_control → Tool error: ${REFUSAL}`);
  });

  it('clips a long result to its start, where the outcome and any error are', () => {
    const text = describeToolRecord([{ name: 'web_fetch', result: `OK ${'x'.repeat(500)}` }]);
    expect(text.startsWith('- web_fetch → OK xxx')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(200);
  });

  it('accounts for every call: the latest in full, the earlier ones by tool and outcome', () => {
    // A bare "(3 earlier calls not shown)" left the grader told to fail an
    // action no LISTED call performed, while the call that performed it was
    // one of the three. A correct output citing call 1 of 15 read as invented.
    const record = [
      { name: 'browser_control', result: 'navigated to https://example.test' },
      { name: 'browser_control', result: `Tool error: ${REFUSAL}` },
      { name: 'web_fetch', result: 'OK' },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, result: 'ok' })),
    ];
    const text = describeToolRecord(record);
    expect(text.split('\n').slice(0, 4)).toEqual([
      'Earlier calls, by tool (3):',
      '- browser_control ×2 (1 returned a result, 1 an error or refusal)',
      '- web_fetch ×1 (1 returned a result)',
      'Most recent 12:',
    ]);
    expect(text).toContain('- t0 → ok');
    expect(text).toContain('- t11 → ok');
  });

  it('counts a browser action the tool refused as a failure, in the words the tool really uses', async () => {
    // browser_control does not throw on a refused action: it returns
    // "Failed: …". That is how the session cap actually reaches the record,
    // and the summary counted it as a result.
    const { BrowserControlTool } = await import('../../tools/browser-control.js');
    const tool = new BrowserControlTool(async () => ({ ok: false, detail: REFUSAL }));
    const refused = await tool.execute({ action: 'navigate', url: 'https://example.test' }, { sessionId: 'run-1', tierId: 'w1' } as never);
    expect(refused.startsWith('Failed: '), 'the format this depends on').toBe(true);

    const record = [
      recordToolCall('browser_control', refused),
      recordToolCall('web_fetch', 'Failed to fetch https://example.test: ECONNREFUSED'),
      recordToolCall('grep', 'No matches found for: needle'),
      ...Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, result: 'ok' })),
    ];
    expect(describeToolRecord(record).split('\n').slice(1, 4)).toEqual([
      '- browser_control ×1 (1 an error or refusal)',
      '- web_fetch ×1 (1 an error or refusal)',
      '- grep ×1 (1 returned a result)',
    ]);
  });

  it('stays bounded however many calls there were', () => {
    const record = Array.from({ length: 500 }, (_, i) => ({ name: i % 2 ? 'web_fetch' : 'web_search', result: 'x'.repeat(1000) }));
    expect(describeToolRecord(record).length).toBeLessThan(12 * 200 + 300);
  });

  it('keeps only the start of a result when the call is recorded, not the whole of it', () => {
    // Held for the life of the worker: a few file_reads of large files was
    // hundreds of megabytes kept to show the grader 160 characters of each.
    const entry = recordToolCall('file_read', `START ${'x'.repeat(1_000_000)}`);
    expect(entry.result.startsWith('START xxx')).toBe(true);
    expect(entry.result.length).toBeLessThanOrEqual(161);
  });

  it('says what each call was asked to do, so a claim can be checked against more than the tool\u2019s name', () => {
    // "Filled #q" never says what was typed, and a successful shell command
    // may print nothing: an output claiming other text or another command
    // looked supported by the name and result alone.
    const entry = recordToolCall('browser_control', 'Filled #q', { action: 'fill', selector: '#q', value: 'what is dark matter?' });
    expect(describeToolRecord([entry])).toBe('- browser_control(action=fill, selector=#q, value=what is dark matter?) → Filled #q');
  });

  it('keeps secrets out of the record: secret-named arguments, and anything typed into a password field', () => {
    expect(describeArgs({ url: 'https://x.test', apiKey: 'sk-live-123', authorization: 'Bearer abc' }))
      .toBe('url=https://x.test, apiKey=[redacted], authorization=[redacted]');
    // The password arrives under a plain `value`; the selector gives it away.
    expect(describeArgs({ action: 'fill', selector: 'input[type=password]', value: 'hunter2' }))
      .toBe('action=fill, selector=input[type=password], value=[redacted]');
    expect(describeArgs({ action: 'fill', selector: '#password', value: 'hunter2' })).not.toContain('hunter2');
  });

  it('keeps the argument summary bounded', () => {
    const args = describeArgs({ command: 'x'.repeat(10_000), cwd: '/tmp', env: { A: 'y'.repeat(500) } });
    expect(args.length).toBeLessThanOrEqual(161);
    expect(args.startsWith('command=xxx')).toBe(true);
  });

  it('marks an empty result rather than printing nothing after the arrow', () => {
    expect(describeToolRecord([{ name: 'shell', result: '  ' }])).toBe('- shell → (empty result)');
  });
});

describe('what the acting rule asks for', () => {
  it('lets a worker fix a call the tool told it how to fix, instead of stopping at the first error', () => {
    // executeTool's own validation says "supply them and call the tool
    // again", and a busy browser says to try again. A rule that stopped at
    // any error contradicted both.
    expect(ACTING_INTEGRITY_RULE).toContain('A tool error you can act on');
    expect(ACTING_INTEGRITY_RULE).toContain('correct the call and retry');
    expect(ACTING_INTEGRITY_RULE, 'stopping is for when there is no way forward').toMatch(/If you still cannot do what was asked .* keeps failing or refusing .* and stop\./);
  });

  it('still forbids inventing what could not be obtained', () => {
    expect(ACTING_INTEGRITY_RULE).toMatch(/^- Never present simulated, hypothetical or invented results as real\./);
    expect(ACTING_INTEGRITY_RULE).toContain('do not fill in plausible-looking results');
  });
});

describe('the rule reaches every prompt that can answer the user', () => {
  describe('T3 — the worker that does the work', () => {
    it('carries it whatever tools are registered, including none', () => {
      // Not tool-gated like the image and video rules: a capability with no
      // rule of its own is exactly the one that went unguarded.
      expect(buildWorkerRules(() => false)).toContain(ACTING_INTEGRITY_RULE);
      expect(buildWorkerRules(() => true)).toContain(ACTING_INTEGRITY_RULE);
    });

    it('shows the self-test what each tool returned, so a refused browser cannot pass as a visited one', async () => {
      const { router, calls } = fabricatingRouter();
      await new T3Worker(router, browserRegistry(), 't2-1').execute(assignment(), 'task-refused');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'));
      expect(graded?.content, 'the refusal is in front of the grader').toContain(`browser_control(action=navigate, url=https://example.test) → Tool error: ${REFUSAL}`);
      expect(graded?.content, 'and it is told what to do with it').toMatch(/"correctness" MUST be "fail" if the output presents simulated/);
    });

    it('does not fail an output whose first call errored and whose retry worked', async () => {
      // The grader was told to fail any claimed action whose call "returned an
      // error", which also caught the retry that went on to succeed.
      const execute = vi.fn()
        .mockRejectedValueOnce(new Error(REFUSAL))
        .mockResolvedValueOnce('navigated to https://example.test');
      let loop = 0;
      const calls: Call[] = [];
      const router = {
        generate: vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }>; systemPrompt?: string }) => {
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          calls.push({ tier, systemPrompt: options.systemPrompt ?? '', content });
          if (content.startsWith('Self-test this output')) return makeResult(PASS);
          loop += 1;
          if (loop <= 2) return makeResult('', [{ id: `b${loop}`, name: 'browser_control', input: { action: 'navigate', url: 'https://example.test' } }]);
          return makeResult('Opened https://example.test.');
        }),
        getModelForTier: () => undefined,
      } as unknown as CascadeRouter;
      await new T3Worker(router, browserRegistry(execute), 't2-1').execute(assignment(), 'task-retried');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'))?.content ?? '';
      expect(graded, 'both attempts are in the record').toContain(`browser_control(action=navigate, url=https://example.test) → Tool error: ${REFUSAL}`);
      expect(graded).toContain('browser_control(action=navigate, url=https://example.test) → navigated to https://example.test');
      expect(graded, 'and a retry that succeeded is said to count').toContain('a later retry that succeeded did');
      expect(graded).not.toContain('did not perform or that returned an error');
    });

    it('does not hold a tool\u2019s whole result for the life of the worker', async () => {
      const execute = vi.fn().mockResolvedValue(`PAGE ${'x'.repeat(500_000)}`);
      const worker = new T3Worker(fabricatingRouter().router, browserRegistry(execute), 't2-1');
      await worker.execute(assignment(), 'task-big');
      const record = (worker as unknown as { toolRecord: Array<{ result: string }> }).toolRecord;
      expect(record).toHaveLength(1);
      expect(record[0]!.result.length).toBeLessThanOrEqual(161);
    });

    it('tells the self-test when nothing was called at all', async () => {
      // The reported shape: no browser to reach, and a login claimed anyway.
      const { router, calls } = recordingRouter('I logged in and asked the chatbot.');
      await new T3Worker(router, noTools(), 't2-1').execute(assignment(), 'task-none');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'));
      expect(graded?.content).toContain('none — no tool was called');
    });

    it('keeps the record for one subtask only — a reused worker does not inherit the last one’s calls', async () => {
      const execute = vi.fn()
        .mockRejectedValueOnce(new Error(REFUSAL))
        .mockResolvedValueOnce('navigated to https://example.test');
      const worker = new T3Worker(fabricatingRouter().router, browserRegistry(execute), 't2-1');
      await worker.execute(assignment(), 'task-1');

      const second = fabricatingRouter();
      (worker as unknown as { router: CascadeRouter }).router = second.router;
      await worker.execute(assignment({ subtaskId: 'probe-2' }), 'task-2');

      const graded = second.calls.find((c) => c.content.startsWith('Self-test this output'));
      expect(graded?.content).toContain('browser_control(action=navigate, url=https://example.test) → navigated to https://example.test');
      expect(graded?.content, 'the first subtask’s refusal is not this one’s').not.toContain(REFUSAL);
    });

    it('carries it into the correction round, which replaces the worker’s own system prompt', async () => {
      // The round that exists to make a failed check pass is where covering a
      // gap is most tempting — and it ran with none of the worker's rules.
      const { router, calls } = fabricatingRouter({
        selfTest: () => '{"completeness":"pass","correctness":"fail","compliance":"pass","notes":"claims a login no tool performed"}',
      });
      await new T3Worker(router, browserRegistry(), 't2-1').execute(assignment(), 'task-correct');

      const correction = calls.find((c) => c.content.startsWith('The following output failed these checks'));
      expect(correction, 'a correction round ran').toBeDefined();
      expect(correction?.systemPrompt).toContain(ACTING_INTEGRITY_RULE);
      expect(correction?.content, 'and the ask itself allows "I could not"').toContain('never invent the missing result');
      expect(correction?.content, 'once the tool keeps failing, not at its first error').toContain('keeps failing or refusing');
    });

    it('carries it into the tool-less rewrite, which can only close a gap in real work by inventing it', async () => {
      const { router, calls } = fabricatingRouter({ reflection: true });
      await new T3Worker(router, browserRegistry(), 't2-1').execute(assignment(), 'task-reflect');

      const rewrite = calls.find((c) => c.content.startsWith('Improve the following'));
      expect(rewrite, 'the rewrite ran').toBeDefined();
      expect(rewrite?.systemPrompt).toContain(ACTING_INTEGRITY_RULE);
      expect(rewrite?.content).toContain('You have no tools in this step');
    });
  });

  it('T2 — the section summary, which on a Moderate run is the answer', async () => {
    const { router, calls } = recordingRouter('worker output');
    await new T2Manager(router, noTools(), 't1-root').execute({
      sectionId: 's1', sectionTitle: 'Probe', description: 'Probe the chatbot', expectedOutput: 'answers',
      constraints: [], t3Subtasks: [{
        subtaskId: 'a', subtaskTitle: 'Ask', description: 'Ask', expectedOutput: 'answers', constraints: [], peerT3Ids: [], dependsOn: [],
      }],
    }, 'task-t2');

    const summary = calls.find((c) => c.content.startsWith('Summarize these T3 worker outputs'));
    expect(summary, 'the section was summarised').toBeDefined();
    expect(summary?.systemPrompt).toContain(REPORTING_INTEGRITY_RULE);
  });

  it('T1 — the final compile, which on a Complex run is the answer', async () => {
    const { router, calls } = recordingRouter('compiled');
    const admin = new T1Administrator(router, {} as ToolRegistry, {} as CascadeConfig);
    await (admin as unknown as { compileFinalOutput: (p: string, plan: TaskPlan, r: T2Result[]) => Promise<string> })
      .compileFinalOutput('probe the chatbot', { complexity: 'Complex', sections: [], reasoning: '' }, [{
        sectionId: 's1', sectionTitle: 'Probe', status: 'COMPLETED', sectionSummary: 'done',
        t3Results: [], issues: [],
      } as T2Result]);

    const compile = calls.find((c) => c.content.startsWith('Compile a final, coherent response'));
    expect(compile, 'the compile ran').toBeDefined();
    expect(compile?.systemPrompt).toContain(REPORTING_INTEGRITY_RULE);
  });
});
