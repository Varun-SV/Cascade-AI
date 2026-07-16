import { describe, expect, it, vi } from 'vitest';
import type {
  GenerateResult,
  PermissionDecision,
  PermissionRequest,
  T2ToT3Assignment,
  ToolCall,
  ToolDefinition,
} from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { PeerBus } from '../peer/bus.js';
import { PermissionEscalator } from '../permissions/escalator.js';
import { T3Worker, buildWorkerRules, shouldRequireArtifact } from './t3-worker.js';

function makeResult(
  content: string,
  toolCalls?: ToolCall[],
  finishReason: GenerateResult['finishReason'] = 'stop',
): GenerateResult {
  return {
    content,
    toolCalls,
    finishReason,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimatedCostUsd: 0,
    },
  };
}

function makeAssignment(overrides: Partial<T2ToT3Assignment> = {}): T2ToT3Assignment {
  return {
    subtaskId: 'subtask-1',
    subtaskTitle: 'Write summary',
    description: 'Write a concise summary',
    expectedOutput: 'A complete summary',
    constraints: [],
    peerT3Ids: [],
    parentT2: 't2-1',
    ...overrides,
  };
}

function makeRouter(generateImpl: CascadeRouter['generate']): CascadeRouter {
  // runAgentLoop calls getModelForTier to decide native vs text tool-call mode
  return {
    generate: generateImpl,
    getModelForTier: () => undefined,
  } as unknown as CascadeRouter;
}

function makeToolRegistry(overrides: Partial<ToolRegistry> = {}): ToolRegistry {
  const toolDefinitions: ToolDefinition[] = [{
    name: 'file_write',
    description: 'Write a file',
    inputSchema: {},
  }];

  return {
    getToolDefinitions: () => toolDefinitions,
    requiresApproval: () => false,
    isDangerous: () => false,
    execute: vi.fn().mockResolvedValue('ok'),
    ...overrides,
  } as unknown as ToolRegistry;
}

describe('T3Worker', () => {
  it('executes a real approval + tool loop through the escalator', async () => {
    let loopCalls = 0;
    const router = makeRouter(vi.fn(async (_tier, options) => {
      const latest = options.messages[options.messages.length - 1];
      const content = typeof latest?.content === 'string' ? latest.content : '';

      if (content.startsWith('Self-test this output')) {
        return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
      }

      loopCalls += 1;
      if (loopCalls === 1) {
        return makeResult('', [{
          id: 'tool-1',
          name: 'file_write',
          input: { path: 'summary.md', content: '# Summary' },
        }], 'tool_use');
      }

      return makeResult('Final summary');
    }));

    const execute = vi.fn().mockResolvedValue('wrote summary.md');
    const toolRegistry = makeToolRegistry({
      requiresApproval: () => true,
      isDangerous: () => true,
      execute,
    });

    const escalator = new PermissionEscalator();
    const requestPermission = vi
      .spyOn(escalator, 'requestPermission')
      .mockResolvedValue({
        requestId: 'req-1',
        approved: true,
        decidedBy: 'T2',
        always: true,
      } satisfies PermissionDecision);

    const worker = new T3Worker(router, toolRegistry, 't2-parent');
    worker.setPermissionEscalator(escalator);

    const result = await worker.execute(makeAssignment(), 'task-1');

    expect(result.status).toBe('COMPLETED');
    expect(result.output).toBe('Final summary');
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(requestPermission.mock.calls[0]?.[0]).toEqual(expect.objectContaining<Partial<PermissionRequest>>({
      parentT2Id: 't2-parent',
      toolName: 'file_write',
      subtaskContext: 'Write summary',
    }));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('runs one independent T2-critic round: rejected output is revised, then accepted', async () => {
    const criticTiers: string[] = [];
    let verdicts = 0;

    const generate = vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }> }) => {
      const latest = options.messages[options.messages.length - 1];
      const content = typeof latest?.content === 'string' ? latest.content : '';

      if (content.startsWith('Self-test this output')) {
        return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
      }
      if (content.includes('independent critic')) {
        criticTiers.push(tier);
        verdicts += 1;
        // First (and only, maxRounds=1) verdict: reject so the revision path runs.
        return makeResult('{"sufficient": false, "notes": "misses the conclusion"}');
      }
      if (content.startsWith('Improve the following')) {
        return makeResult('Improved output');
      }
      return makeResult('Draft output');
    });

    const router = {
      generate,
      getModelForTier: () => undefined,
      getReflectionConfig: () => ({ enabled: true, maxRounds: 1 }),
    } as unknown as CascadeRouter;

    const worker = new T3Worker(router, makeToolRegistry(), 't2-parent');
    const result = await worker.execute(makeAssignment(), 'task-critic');

    expect(result.status).toBe('COMPLETED');
    expect(result.output).toBe('Improved output');
    expect(verdicts).toBe(1);
    // The critic must run on the T2 tier — a different model than the T3 that
    // produced the output — and must NOT spawn a manager hierarchy.
    expect(criticTiers).toEqual(['T2']);
  });

  it('delivers peer sync messages through the shared PeerBus', async () => {
    const router = makeRouter(vi.fn());
    const toolRegistry = makeToolRegistry();
    const bus = new PeerBus();

    const sender = new T3Worker(router, toolRegistry, 't2-parent');
    const receiver = new T3Worker(router, toolRegistry, 't2-parent');
    sender.setPeerBus(bus);
    receiver.setPeerBus(bus);

    const received = new Promise<{ fromId: string; content: unknown }>((resolve) => {
      receiver.once('peer-sync-received', resolve);
    });

    sender.sendToPeer(receiver.id, { ready: true });

    await expect(received).resolves.toEqual({
      fromId: sender.id,
      content: { ready: true },
    });
  });
});

describe('buildWorkerRules — tool-scoped guidance', () => {
  // The complete built-in tool set (registry.ts registerDefaults).
  const FULL = new Set([
    'shell', 'file_read', 'file_write', 'file_edit', 'file_delete', 'file_list',
    'git', 'github', 'image_analyze', 'pdf_create', 'run_code', 'peer_message',
    'web_search', 'glob', 'grep', 'web_fetch',
  ]);

  it('with the full tool set, renders the original prompt verbatim (no behavior change for desktop)', () => {
    const out = buildWorkerRules((name) => FULL.has(name));
    expect(out).toBe(`You are a T3 Worker agent in the Cascade AI system. Your job is to execute a specific subtask completely and accurately.

Rules:
- Execute the subtask completely — do not stop partway through.
- Use tools when needed. Ask for approval only when the tool registry requires it.
- If the task asks for a file or artifact, you must actually create it in the workspace, verify that it exists, and inspect it before claiming success.
- Use the "web_search" tool to find current information, documentation, news, or general web data.
- Use the "pdf_create" tool for PDF requests.
- Use the "run_code" tool for any file types (Excel, Zip, csv, etc.) or complex processing not covered by other tools. Always cleanup after code execution.
- If you are not making meaningful progress, stop and escalate rather than looping or padding the response.
- Use the "peer_message" tool to communicate with other T3 workers if your tasks have dependencies or shared state. You can send updates or wait for signals.
- Return structured output that directly addresses the expected output specification.`);
  });

  it('with a web-only cloud tool set, omits guidance for tools that do not exist', () => {
    const out = buildWorkerRules((name) => new Set(['web_search', 'web_fetch']).has(name));
    // The one enabled tool is still described…
    expect(out).toContain('- Use the "web_search" tool');
    // …and the absent tools are NOT mentioned, so the model never wastes a
    // turn calling a tool that isn't registered.
    expect(out).not.toContain('run_code');
    expect(out).not.toContain('pdf_create');
    expect(out).not.toContain('peer_message');
    expect(out).not.toContain('If the task asks for a file or artifact');
    // A web tool exists, so the generic "use tools" line is still present.
    expect(out).toContain('- Use tools when needed.');
  });

  it('with NO tools registered (hosted pure-chat), drops all tool guidance', () => {
    const out = buildWorkerRules(() => false);
    // The model has zero tools — never tell it to reach for one, so it can't
    // waste turns hallucinating tool calls against an empty registry.
    expect(out).not.toContain('- Use tools when needed.');
    expect(out).not.toContain('web_search');
    expect(out).not.toContain('run_code');
    expect(out).not.toContain('pdf_create');
    expect(out).not.toContain('peer_message');
    expect(out).not.toContain('If the task asks for a file or artifact');
    // Non-tool execution guidance still renders.
    expect(out).toContain('- Execute the subtask completely');
    expect(out).toContain('- Return structured output');
  });
});

describe('T3Worker — text-tool lean prompts (v0.15.0)', () => {
  it('sends the FULL text-tool contract once, then only a terse reminder', async () => {
    const sysPrompts: string[] = [];
    let calls = 0;
    const router = {
      generate: vi.fn(async (_tier: string, options: { messages: Array<{ content?: unknown }>; systemPrompt?: string }) => {
        const latest = options.messages[options.messages.length - 1];
        const content = typeof latest?.content === 'string' ? latest.content : '';
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        sysPrompts.push(String(options.systemPrompt ?? ''));
        calls += 1;
        if (calls === 1) {
          // Text-format tool call — no native toolCalls field.
          return makeResult('<tool_call>{"name":"file_write","input":{"path":"a.md","content":"x"}}</tool_call>');
        }
        return makeResult('Final answer');
      }),
      // A model WITHOUT native tool support triggers the text-tool path.
      getModelForTier: () => ({ id: 'local-x', provider: 'ollama', supportsToolUse: false }),
    } as unknown as CascadeRouter;

    const worker = new T3Worker(router, makeToolRegistry(), 't2-parent');
    const result = await worker.execute(makeAssignment(), 'task-lean');

    expect(result.status).toBe('COMPLETED');
    expect(sysPrompts.length).toBeGreaterThanOrEqual(2);
    expect(sysPrompts[0]).toContain('TOOL USE INSTRUCTIONS');   // full contract, turn 1
    expect(sysPrompts[1]).toContain('TOOL USE REMINDER');       // terse afterwards
    expect(sysPrompts[1]).not.toContain('TOOL USE INSTRUCTIONS');
    expect(sysPrompts[1]).toContain('file_write');              // tool names still listed
  });
});

describe('shouldRequireArtifact', () => {
  const fileTask = { description: 'Write a spec to specs/pump.md', expectedOutput: 'A saved file specs/pump.md' };

  it('does NOT require an artifact when the worker has no file-writing tool', () => {
    // The hosted chat run enables only web tools — requiring a file it cannot
    // create is what produced the "stalled waiting for artifact creation" bug.
    expect(shouldRequireArtifact(fileTask, ['web_search', 'web_fetch'])).toBe(false);
    expect(shouldRequireArtifact({ files: ['out.pdf'] }, ['web_search'])).toBe(false);
  });

  it('requires an artifact when a file-writing tool is available and a file is asked for', () => {
    expect(shouldRequireArtifact(fileTask, ['file_write', 'file_read'])).toBe(true);
    expect(shouldRequireArtifact({ files: ['out.pdf'] }, ['file_write'])).toBe(true);
    expect(shouldRequireArtifact({ description: 'create a file called notes.txt' }, ['file_edit'])).toBe(true);
    expect(shouldRequireArtifact(fileTask, ['shell'])).toBe(true); // shell can write files too
  });

  it('does not require an artifact for a pure question, even with file tools', () => {
    expect(shouldRequireArtifact(
      { description: 'Determine the Flare KOD pump specifications', expectedOutput: 'A concise answer' },
      ['file_write', 'shell'],
    )).toBe(false);
  });

  it('tolerates an undefined assignment', () => {
    expect(shouldRequireArtifact(undefined, ['file_write'])).toBe(false);
  });
});
