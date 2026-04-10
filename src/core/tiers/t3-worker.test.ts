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
  return { generate: generateImpl } as unknown as CascadeRouter;
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
