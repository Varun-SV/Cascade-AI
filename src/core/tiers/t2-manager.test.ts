import { describe, expect, it, vi } from 'vitest';
import type { GenerateResult, T1ToT2Assignment, ToolDefinition } from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { T2Manager } from './t2-manager.js';

function makeResult(content: string, finishReason: GenerateResult['finishReason'] = 'stop'): GenerateResult {
  return {
    content,
    finishReason,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimatedCostUsd: 0,
    },
  };
}

function makeAssignment(): T1ToT2Assignment {
  return {
    sectionId: 'section-1',
    sectionTitle: 'Build release notes',
    description: 'Generate release notes from the completed work',
    expectedOutput: 'A final release-notes summary',
    constraints: [],
    executionMode: 'parallel',
    t3Subtasks: [
      {
        subtaskId: 'draft',
        subtaskTitle: 'Draft notes',
        description: 'Draft the initial notes',
        expectedOutput: 'Drafted notes',
        constraints: [],
        peerT3Ids: [],
        dependsOn: [],
      },
      {
        subtaskId: 'finalize',
        subtaskTitle: 'Finalize notes',
        description: 'Finalize after the draft is complete',
        expectedOutput: 'Finalized notes',
        constraints: [],
        peerT3Ids: [],
        dependsOn: ['draft'],
      },
    ],
  };
}

function makeToolRegistry(): ToolRegistry {
  const definitions: ToolDefinition[] = [];
  return {
    getToolDefinitions: () => definitions,
    requiresApproval: () => false,
    isDangerous: () => false,
    execute: vi.fn(),
  } as unknown as ToolRegistry;
}

describe('T2Manager', () => {
  it('executes dependent subtasks in dependency order and aggregates the result', async () => {
    const executionOrder: string[] = [];

    const router = {
      generate: vi.fn(async (tier, options) => {
        const latest = options.messages[options.messages.length - 1];
        const content = typeof latest?.content === 'string' ? latest.content : '';

        if (content.startsWith('Execute the following subtask completely:')) {
          const title = /\*\*(.+?)\*\*/.exec(content)?.[1] ?? 'unknown';
          executionOrder.push(title);
          return makeResult(`${title} complete`);
        }

        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }

        if (tier === 'T2') {
          return makeResult('Merged release notes');
        }

        return makeResult('ok');
      }),
    } as unknown as CascadeRouter;

    const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
    const result = await manager.execute(makeAssignment(), 'task-1');

    expect(result.status).toBe('COMPLETED');
    expect(result.sectionSummary).toBe('Merged release notes');
    expect(executionOrder).toEqual(['Draft notes', 'Finalize notes']);
  });

  it('breaks cyclic dependencies instead of deadlocking the section', async () => {
    const router = {
      generate: vi.fn(async (_tier, options) => {
        const latest = options.messages[options.messages.length - 1];
        const content = typeof latest?.content === 'string' ? latest.content : '';
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        if (content.startsWith('Summarize these T3 worker outputs')) {
          return makeResult('Cyclic section merged');
        }
        return makeResult('completed');
      }),
    } as unknown as CascadeRouter;

    const assignment = makeAssignment();
    assignment.t3Subtasks[0]!.dependsOn = ['finalize'];

    const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
    const result = await manager.execute(assignment, 'task-2');

    expect(result.status).toBe('COMPLETED');
    expect(result.t3Results).toHaveLength(2);
    expect(result.t3Results.every((t3) => t3.status === 'COMPLETED')).toBe(true);
  });
});
