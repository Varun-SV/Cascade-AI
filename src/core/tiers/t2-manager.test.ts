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
      getModelForTier: () => undefined,
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
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;

    const assignment = makeAssignment();
    assignment.t3Subtasks[0]!.dependsOn = ['finalize'];

    const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
    const result = await manager.execute(assignment, 'task-2');

    expect(result.status).toBe('COMPLETED');
    expect(result.t3Results).toHaveLength(2);
    expect(result.t3Results.every((t3) => t3.status === 'COMPLETED')).toBe(true);
  });

  // ── Boardroom gate (Moderate / planApproval: 'all') ──

  it('gate reject stops the section before any worker runs', async () => {
    const router = {
      generate: vi.fn(async () => makeResult('should not run')),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;

    const manager = new T2Manager(router, makeToolRegistry(), 'root');
    manager.setPlanApprovalCallback(async () => ({ approved: false }));
    const result = await manager.execute(makeAssignment(), 'task-reject');

    expect(result.t3Results).toHaveLength(0);
    expect(result.sectionSummary).toContain('rejected');
    expect(router.generate).not.toHaveBeenCalled();
  });

  it('gate keepSubtaskIds drops the other subtasks before dispatch', async () => {
    const executed: string[] = [];
    const router = {
      generate: vi.fn(async (tier, options) => {
        const latest = options.messages[options.messages.length - 1];
        const content = typeof latest?.content === 'string' ? latest.content : '';
        if (content.startsWith('Execute the following subtask completely:')) {
          executed.push(/\*\*(.+?)\*\*/.exec(content)?.[1] ?? 'unknown');
          return makeResult('done');
        }
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        if (tier === 'T2') return makeResult('merged');
        return makeResult('ok');
      }),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;

    const manager = new T2Manager(router, makeToolRegistry(), 'root');
    manager.setPlanApprovalCallback(async () => ({ approved: true, keepSubtaskIds: ['draft'] }));
    await manager.execute(makeAssignment(), 'task-keep');

    expect(executed).toEqual(['Draft notes']); // 'Finalize notes' was dropped
  });

  // ── T3→T2 reinforcement request ──

  it('spawns reinforcement sibling workers when a T3 calls request_workers', async () => {
    const executed: string[] = [];
    const router = {
      generate: vi.fn(async (_tier, options) => {
        const msgs = options.messages as Array<{ role: string; content: unknown }>;
        const last = msgs[msgs.length - 1];
        const content = typeof last?.content === 'string' ? last.content : '';
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        if (content.startsWith('Summarize')) return makeResult('merged');
        // Once the request_workers tool result is in the conversation, finish.
        if (msgs.some((m) => m.role === 'tool')) return makeResult('done');
        if (content.startsWith('Execute the following subtask completely:')) {
          const title = /\*\*(.+?)\*\*/.exec(content)?.[1] ?? '?';
          executed.push(title);
          if (content.includes('FANOUT')) {
            return {
              content: 'requesting help',
              finishReason: 'tool_use' as const,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
              toolCalls: [{ id: 'tc1', name: 'request_workers', input: { subtasks: [
                { title: 'Helper A', description: 'do A' },
                { title: 'Helper B', description: 'do B' },
              ] } }],
            };
          }
          return makeResult(`${title} done`);
        }
        return makeResult('ok');
      }),
      getModelForTier: () => undefined,
      getReinforcementsConfig: () => ({ enabled: true, maxPerSection: 4 }),
    } as unknown as CascadeRouter;

    const assignment: T1ToT2Assignment = {
      sectionId: 'sec', sectionTitle: 'Section', description: 'd', expectedOutput: 'o', constraints: [],
      executionMode: 'parallel',
      t3Subtasks: [{ subtaskId: 'main', subtaskTitle: 'Main', description: 'FANOUT this big task', expectedOutput: 'o', constraints: [], peerT3Ids: [], dependsOn: [] }],
    };

    const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
    await manager.execute(assignment, 'task-reinf');

    // The worker requested two helpers; T2 spawned and ran both as siblings.
    expect(executed).toContain('Main');
    expect(executed).toContain('Helper A');
    expect(executed).toContain('Helper B');
  });

  // ── Permission evaluation (dangerous tools advise, never final-approve) ──

  it('auto-approves a non-dangerous tool at T2 without escalating', async () => {
    const router = {
      generate: vi.fn(async () => makeResult('YES')),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;
    const manager = new T2Manager(router, makeToolRegistry(), 'root');

    const req = {
      id: 'p1', requestedBy: 't3-a', parentT2Id: (manager as any).id,
      toolName: 'diff_view', input: {}, isDangerous: false,
      subtaskContext: 's', sectionContext: 'sec',
    };
    const decision = await (manager as any).evaluatePermissionAtT2(req);

    expect(decision).not.toBeNull();
    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toBe('T2');
    expect(router.generate).not.toHaveBeenCalled(); // no LLM call for safe path
  });

  it('never final-approves a DANGEROUS tool — records advice on the trail and returns null so it reaches the user', async () => {
    const router = {
      generate: vi.fn(async () => makeResult('YES')), // even a confident YES must not auto-approve
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;
    const manager = new T2Manager(router, makeToolRegistry(), 'root');

    const req: any = {
      id: 'p2', requestedBy: 't3-a', parentT2Id: (manager as any).id,
      toolName: 'shell_run', input: { command: 'rm -rf build' }, isDangerous: true,
      subtaskContext: 's', sectionContext: 'sec',
    };
    const decision = await (manager as any).evaluatePermissionAtT2(req);

    expect(decision).toBeNull(); // escalates past T2
    expect(router.generate).toHaveBeenCalledOnce();
    expect(req.trail).toHaveLength(1);
    expect(req.trail[0]).toMatchObject({ tier: 'T2', verdict: 'approve' });
  });
});
