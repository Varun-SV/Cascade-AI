// ─────────────────────────────────────────────
//  Cascade AI — Planning within the budget
// ─────────────────────────────────────────────
//
// With a cost cap, T1 is told how many sections and workers what is left
// pays for, and a plan over that keeps its first ones; each section plans its
// workers within its share. Without a cap, nothing changes.

import { describe, expect, it, vi } from 'vitest';
import { T1Administrator, type TaskPlan } from './t1-administrator.js';
import { T2Manager } from './t2-manager.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { CascadeConfig, GenerateResult, ModelInfo, T1ToT2Assignment, ToolDefinition } from '../../types.js';

/** One planned call is $0.015; a section of 2 workers is $0.165. */
const PRICED = { id: 'sonnet', provider: 'anthropic', inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015 } as unknown as ModelInfo;

function reply(content: string): GenerateResult {
  return { content, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } };
}

function tools(): ToolRegistry {
  const definitions: ToolDefinition[] = [];
  return {
    getToolDefinitions: () => definitions, requiresApproval: () => false, isDangerous: () => false, hasTool: () => false, execute: vi.fn(),
  } as unknown as ToolRegistry;
}

/** A plan of `n` sections, each of 5 workers; each section after the first depends on the one before. */
function bigPlan(n: number): string {
  return JSON.stringify({
    complexity: 'Complex', reasoning: 'r',
    sections: Array.from({ length: n }, (_, i) => ({
      sectionId: `s${i + 1}`, sectionTitle: `Section ${i + 1}`, description: 'd', expectedOutput: 'o', constraints: [],
      dependsOn: i === 0 ? [] : [`s${i}`],
      t3Subtasks: Array.from({ length: 5 }, (_, j) => ({
        subtaskId: `s${i + 1}t${j + 1}`, subtaskTitle: `Worker ${j + 1}`, description: 'd', expectedOutput: 'o', constraints: [],
        dependsOn: j === 0 ? [] : [`s${i + 1}t${j}`],
      })),
    })),
  });
}

type Decompose = (p: string, c?: string) => Promise<TaskPlan>;

function planner(workRemainingUsd: number | undefined, plan: string) {
  const prompts: string[] = [];
  const noteWorkNotStarted = vi.fn();
  const router = {
    noteWorkNotStarted,
    runBudget: () => (workRemainingUsd == null ? { spentUsd: 0, usedTokens: 0, wrappingUp: false } : { capUsd: 1, spentUsd: 0, workRemainingUsd, usedTokens: 0, wrappingUp: false }),
    getModelForTier: () => PRICED,
    generate: vi.fn(async (_tier: string, options: { messages: Array<{ content: unknown }> }) => {
      prompts.push(String(options.messages[0]?.content ?? ''));
      return reply(plan);
    }),
  } as unknown as CascadeRouter;
  const admin = new T1Administrator(router, tools(), {} as CascadeConfig);
  return { decompose: (admin as unknown as { decomposeTask: Decompose }).decomposeTask.bind(admin), prompts, admin, noteWorkNotStarted };
}

describe('T1 plans within the budget', () => {
  it('tells the planner what the budget pays for', async () => {
    const { decompose, prompts } = planner(0.8, bigPlan(1));
    await decompose('research three databases');
    expect(prompts[0]).toMatch(/BUDGET: .*pays for about 4 sections of two workers each/);
  });

  it('keeps the first sections and workers of a plan over it, and drops links to what was cut', async () => {
    const { decompose, noteWorkNotStarted } = planner(0.8, bigPlan(6));
    const plan = await decompose('research three databases');
    expect(plan.sections.map((s) => s.sectionId)).toEqual(['s1', 's2', 's3', 's4']);
    // Counted as work the budget held back: 2 sections, and 3 workers from each of 4.
    expect(noteWorkNotStarted).toHaveBeenCalledWith(14);
    expect(plan.sections.every((s) => s.t3Subtasks.length === 2)).toBe(true);
    expect(plan.sections[1]!.dependsOn).toEqual(['s1']);
    expect(plan.sections[0]!.t3Subtasks[1]!.dependsOn).toEqual(['s1t1']);
  });

  it('lets a smaller plan keep more workers in each section', async () => {
    // Two sections split $0.80: $0.40 each pays for five workers.
    const { decompose } = planner(0.8, bigPlan(2));
    const plan = await decompose('research three databases');
    expect(plan.sections.map((s) => s.t3Subtasks.length)).toEqual([5, 5]);
  });

  it('changes nothing without a cost cap', async () => {
    const { decompose, prompts } = planner(undefined, bigPlan(6));
    const plan = await decompose('research three databases');
    expect(prompts[0]).not.toMatch(/BUDGET/);
    expect(plan.sections).toHaveLength(6);
    expect(plan.sections[0]!.t3Subtasks).toHaveLength(5);
  });

  it('says nothing about a budget too large to bind', async () => {
    const { decompose, prompts } = planner(50, bigPlan(2));
    await decompose('research three databases');
    expect(prompts[0]).not.toMatch(/BUDGET/);
  });

  it('gives each section an equal share of what is left for work', async () => {
    const { admin } = planner(0.9, bigPlan(1));
    const seen: T1ToT2Assignment[] = [];
    (admin as unknown as { runT2sWithDependencies: (s: T1ToT2Assignment[]) => Promise<unknown[]> })
      .runT2sWithDependencies = async (sections) => { seen.push(...sections); return []; };
    const section = (id: string): T1ToT2Assignment => ({ sectionId: id, sectionTitle: id, description: 'd', expectedOutput: 'o', constraints: [], t3Subtasks: [] });
    await (admin as unknown as { dispatchT2Managers: (s: T1ToT2Assignment[]) => Promise<unknown> })
      .dispatchT2Managers([section('a'), section('b'), section('c')]);
    expect(seen.map((s) => s.budgetUsd)).toEqual([0.3, 0.3, 0.3].map((v) => expect.closeTo(v, 6)));
  });
});

describe('T2 plans its workers within its share', () => {
  function sectionWith(workers: number, budgetUsd?: number): T1ToT2Assignment {
    return {
      sectionId: 's', sectionTitle: 'Research', description: 'd', expectedOutput: 'o', constraints: [], executionMode: 'parallel',
      ...(budgetUsd != null ? { budgetUsd } : {}),
      t3Subtasks: Array.from({ length: workers }, (_, j) => ({
        subtaskId: `t${j + 1}`, subtaskTitle: `Worker ${j + 1}`, description: 'd', expectedOutput: 'o', constraints: [], peerT3Ids: [],
        dependsOn: j === 0 ? [] : [`t${j}`],
      })),
    };
  }

  function managerRouter(started: string[], workRemainingUsd?: number, notStarted?: (n: number) => void) {
    return {
      noteWorkNotStarted: notStarted ?? (() => {}),
      runBudget: () => (workRemainingUsd == null ? { spentUsd: 0, usedTokens: 0, wrappingUp: false } : { capUsd: 1, spentUsd: 0, workRemainingUsd, usedTokens: 0, wrappingUp: false }),
      isWrappingUp: () => false,
      getModelForTier: () => PRICED,
      generate: vi.fn(async (_tier: string, options: { messages: Array<{ content: unknown }> }) => {
        const content = String(options.messages[options.messages.length - 1]?.content ?? '');
        const title = /\*\*(.+?)\*\*/.exec(content)?.[1];
        if (content.startsWith('Execute the following subtask completely:') && title) started.push(title);
        if (content.startsWith('Self-test this output')) return reply('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        return reply('done');
      }),
    } as unknown as CascadeRouter;
  }

  it('runs no more workers than the section\'s share pays for', async () => {
    const started: string[] = [];
    // $0.18 - $0.045 for the manager = $0.135: two workers at $0.06.
    const notStarted = vi.fn();
    const manager = new T2Manager(managerRouter(started, undefined, notStarted), tools(), 't1-root');
    const result = await manager.execute(sectionWith(5, 0.18), 'task');
    expect(started).toEqual(['Worker 1', 'Worker 2']);
    expect(notStarted).toHaveBeenCalledWith(3);
    expect(result.t3Results).toHaveLength(2);
  });

  it('uses what is left for the whole run when it has no share of its own', async () => {
    const started: string[] = [];
    const manager = new T2Manager(managerRouter(started, 0.18), tools(), 'root');
    await manager.execute(sectionWith(5), 'task');
    expect(started).toHaveLength(2);
  });

  it('runs every planned worker without a cost cap', async () => {
    const started: string[] = [];
    const manager = new T2Manager(managerRouter(started), tools(), 't1-root');
    await manager.execute(sectionWith(5), 'task');
    expect(started).toHaveLength(5);
  });
});
