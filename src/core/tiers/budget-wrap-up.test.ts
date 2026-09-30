// ─────────────────────────────────────────────
//  Cascade AI — Tiers under a wrapping-up budget
// ─────────────────────────────────────────────
//
// Once a run's work has spent its share of the cap (router/run-budget.ts), no
// more work starts and the rest pays for the answer. These pin down what each
// tier does about it: T1 starts no more sections, skips review, and still
// answers; T2 starts no more workers; the answer's own call uses the reserve.

import { describe, expect, it, vi } from 'vitest';
import { T1Administrator, type TaskPlan } from './t1-administrator.js';
import { T2Manager } from './t2-manager.js';
import { T3Worker } from './t3-worker.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { CascadeConfig, GenerateResult, T1ToT2Assignment, T2Result, ToolDefinition } from '../../types.js';

const wrapUp = () => Object.assign(new Error('Most of this task\'s budget is spent.'), { name: 'BudgetWrapUpError' });

function reply(content: string): GenerateResult {
  return { content, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } };
}

function section(id: string, dependsOn: string[] = []): T1ToT2Assignment {
  return { sectionId: id, sectionTitle: `Section ${id}`, description: 'd', expectedOutput: 'o', constraints: [], dependsOn, t3Subtasks: [] };
}

function done(id: string, summary: string): T2Result {
  return { sectionId: id, sectionTitle: `Section ${id}`, status: 'COMPLETED', t3Results: [], sectionSummary: summary, issues: [] };
}

type T1Internals = {
  runT2sWithDependencies: (s: T1ToT2Assignment[], m: unknown[], t: string) => Promise<T2Result[]>;
  compileFinalOutput: (p: string, plan: TaskPlan, r: T2Result[]) => Promise<string>;
  decomposeTask: (p: string, c?: string) => Promise<TaskPlan>;
  dispatchT2Managers: (s: T1ToT2Assignment[]) => Promise<T2Result[]>;
  reviewT2Outputs: (p: string, plan: TaskPlan, r: T2Result[]) => Promise<{ approved: boolean; reason?: string; summary?: string; gaps: unknown[] }>;
};

describe('T1 while the budget wraps up', () => {
  it('starts no section once the run is wrapping up, and says why it was left', async () => {
    let wrapping = false;
    const noteWorkNotStarted = vi.fn();
    const router = { getT3ExecutionMode: () => 'sequential', isWrappingUp: () => wrapping, noteWorkNotStarted } as unknown as CascadeRouter;
    const admin = new T1Administrator(router, {} as ToolRegistry, {} as CascadeConfig);
    const managers = ['a', 'b'].map((id) => ({
      execute: vi.fn(async () => { wrapping = true; return done(id, `${id} done`); }),
      shareCompletedOutput: vi.fn(),
      setGraphPosition: vi.fn(),
    }));

    const results = await (admin as unknown as T1Internals)
      .runT2sWithDependencies([section('a'), section('b')], managers, 'task');

    expect(managers[0]!.execute).toHaveBeenCalledOnce();
    expect(managers[1]!.execute).not.toHaveBeenCalled();
    expect(results[1]).toMatchObject({ sectionId: 'b', status: 'BLOCKED' });
    expect(results[1]!.issues.join(' ')).toMatch(/kept for writing the answer/);
    expect(noteWorkNotStarted).toHaveBeenCalledOnce();
  });

  it('skips review and correction while wrapping up, and goes straight to the answer', async () => {
    const router = { isWrappingUp: () => true, getModelForTier: () => undefined } as unknown as CascadeRouter;
    const admin = new T1Administrator(router, {} as ToolRegistry, {} as CascadeConfig);
    const t1 = admin as unknown as T1Internals;
    t1.decomposeTask = vi.fn(async () => ({ complexity: 'Complex', reasoning: '', sections: [section('a')] }) as TaskPlan);
    t1.dispatchT2Managers = vi.fn(async () => [done('a', 'a done')]);
    t1.reviewT2Outputs = vi.fn(async () => ({ approved: false, reason: 'more', summary: 'more', gaps: [] }));
    t1.compileFinalOutput = vi.fn(async () => 'the answer');

    const result = await admin.execute('goal', 'task');

    expect(result.output).toBe('the answer');
    expect(t1.reviewT2Outputs).not.toHaveBeenCalled();
    expect(t1.decomposeTask).toHaveBeenCalledOnce();
  });

  it('still answers when the budget runs down during a correction pass', async () => {
    const router = { isWrappingUp: () => false, getModelForTier: () => undefined } as unknown as CascadeRouter;
    const admin = new T1Administrator(router, {} as ToolRegistry, {} as CascadeConfig);
    const t1 = admin as unknown as T1Internals;
    let plans = 0;
    t1.decomposeTask = vi.fn(async () => {
      plans++;
      if (plans > 1) throw wrapUp();
      return { complexity: 'Complex', reasoning: '', sections: [section('a')] } as TaskPlan;
    });
    t1.dispatchT2Managers = vi.fn(async () => [done('a', 'a done')]);
    t1.reviewT2Outputs = vi.fn(async () => ({ approved: false, reason: 'more', summary: 'more', gaps: [] }));
    t1.compileFinalOutput = vi.fn(async () => 'the answer');

    await expect(admin.execute('goal', 'task')).resolves.toMatchObject({ output: 'the answer' });
  });

  it('writes the answer with the budget kept back for it', async () => {
    const generate = vi.fn(async () => reply('compiled'));
    const admin = new T1Administrator({ generate } as unknown as CascadeRouter, {} as ToolRegistry, {} as CascadeConfig);
    await (admin as unknown as T1Internals).compileFinalOutput('goal', { sections: [] } as unknown as TaskPlan, [done('a', 'a done')]);
    expect(generate.mock.calls[0]![1]).toMatchObject({ budgetClass: 'final' });
  });

  it('returns the finished sections as they are when not even the answer can be paid for', async () => {
    const generate = vi.fn(async () => { throw wrapUp(); });
    const admin = new T1Administrator({ generate } as unknown as CascadeRouter, {} as ToolRegistry, {} as CascadeConfig);
    const blocked: T2Result = { ...done('b', ''), status: 'BLOCKED', issues: ['Not started'] };

    const out = await (admin as unknown as T1Internals)
      .compileFinalOutput('goal', { sections: [] } as unknown as TaskPlan, [done('a', 'Findings for a.'), blocked]);

    expect(out).toContain('## Section a');
    expect(out).toContain('Findings for a.');
    expect(out).toMatch(/Not finished:.*Section b/);
    expect(out).toContain('budget is spent');
  });

  it('does not swallow an ordinary failure as if it were the budget', async () => {
    const generate = vi.fn(async () => { throw new Error('provider down'); });
    const admin = new T1Administrator({ generate } as unknown as CascadeRouter, {} as ToolRegistry, {} as CascadeConfig);
    await expect((admin as unknown as T1Internals)
      .compileFinalOutput('goal', { sections: [] } as unknown as TaskPlan, [done('a', 'a')])).rejects.toThrow('provider down');
  });
});

function tools(): ToolRegistry {
  const definitions: ToolDefinition[] = [];
  return {
    getToolDefinitions: () => definitions, requiresApproval: () => false, isDangerous: () => false, hasTool: () => false, execute: vi.fn(),
  } as unknown as ToolRegistry;
}

function twoStepSection(): T1ToT2Assignment {
  const step = (id: string, title: string, dependsOn: string[]) => ({
    subtaskId: id, subtaskTitle: title, description: title, expectedOutput: title, constraints: [], peerT3Ids: [], dependsOn,
  });
  return {
    sectionId: 'section-1', sectionTitle: 'Release notes', description: 'd', expectedOutput: 'o', constraints: [],
    executionMode: 'parallel',
    t3Subtasks: [step('draft', 'Draft notes', []), step('finalize', 'Finalize notes', ['draft'])],
  };
}

describe('T2 while the budget wraps up', () => {
  function routerFor(state: { wrapping: boolean; started: string[]; summaryOptions?: Record<string, unknown>; notStarted?: number }) {
    return {
      isWrappingUp: () => state.wrapping,
      noteWorkNotStarted: (n = 1) => { state.notStarted = (state.notStarted ?? 0) + n; },
      getModelForTier: () => undefined,
      generate: vi.fn(async (_tier: string, options: { messages: Array<{ content: unknown }> } & Record<string, unknown>) => {
        const content = String(options.messages[options.messages.length - 1]?.content ?? '');
        if (content.startsWith('Execute the following subtask completely:')) {
          const title = /\*\*(.+?)\*\*/.exec(content)?.[1] ?? '?';
          state.started.push(title);
          // The run crosses into its reserve while the first worker runs.
          state.wrapping = true;
          return reply(`${title} complete`);
        }
        if (content.startsWith('Self-test this output')) {
          return reply('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        if (content.startsWith('Summarize these T3 worker outputs')) {
          state.summaryOptions = options;
          return reply('Summary');
        }
        return reply('ok');
      }),
    } as unknown as CascadeRouter;
  }

  it('starts no more workers once the run is wrapping up, and says why they were left', async () => {
    const state = { wrapping: false, started: [] as string[], notStarted: 0 };
    const manager = new T2Manager(routerFor(state), tools(), 't1-root');
    const result = await manager.execute(twoStepSection(), 'task');

    expect(state.started).toEqual(['Draft notes']);
    expect(state.notStarted).toBe(1);
    const finalize = result.t3Results.find((r) => r.subtaskId === 'finalize');
    expect(finalize).toMatchObject({ status: 'FAILED', output: '' });
    expect(finalize!.issues.join(' ')).toMatch(/kept for writing the answer/);
  });

  it('writes a Moderate run\'s answer with the budget kept back for it', async () => {
    const state = { wrapping: false, started: [] as string[], summaryOptions: undefined as Record<string, unknown> | undefined };
    const manager = new T2Manager(routerFor(state), tools(), 'root');
    manager.setPresenter(true);
    await manager.execute(twoStepSection(), 'task');
    expect(state.summaryOptions).toMatchObject({ budgetClass: 'final' });
  });

  it('keeps an ordinary section summary as work', async () => {
    const state = { wrapping: false, started: [] as string[], summaryOptions: undefined as Record<string, unknown> | undefined };
    const manager = new T2Manager(routerFor(state), tools(), 't1-root');
    await manager.execute(twoStepSection(), 'task');
    expect(state.summaryOptions?.budgetClass).toBe('work');
  });
});

describe('T3 while the budget wraps up', () => {
  const assignment = {
    subtaskId: 'w1', subtaskTitle: 'Research', description: 'Research the topic', expectedOutput: 'notes',
    constraints: [], peerT3Ids: [], parentT2: 't2',
  };

  function workerRefusing(refuse: (content: string) => boolean) {
    const router = {
      getModelForTier: () => undefined,
      generate: vi.fn(async (_tier: string, options: { messages: Array<{ content: unknown }> }) => {
        const content = String(options.messages[options.messages.length - 1]?.content ?? '');
        if (refuse(content)) throw wrapUp();
        return reply('The finished notes.');
      }),
    } as unknown as CascadeRouter;
    return new T3Worker(router, tools(), 't2');
  }

  it('keeps a draft it finished when its self-check is not paid for, and says so', async () => {
    const worker = workerRefusing((c) => c.startsWith('Self-test this output'));
    const result = await worker.execute(assignment, 'task');
    expect(result.status).toBe('COMPLETED');
    expect(result.output).toBe('The finished notes.');
    expect(result.issues.join(' ')).toMatch(/Not self-checked/);
  });

  it('reports a worker stopped before it wrote anything as not finished, not as a question for the user', async () => {
    const worker = workerRefusing(() => true);
    const result = await worker.execute(assignment, 'task');
    expect(result.status).toBe('FAILED');
    expect(result.output).toBe('');
    expect(result.issues.join(' ')).toMatch(/Not finished/);
  });
});
