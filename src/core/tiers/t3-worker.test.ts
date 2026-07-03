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
import { T3Worker } from './t3-worker.js';

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
