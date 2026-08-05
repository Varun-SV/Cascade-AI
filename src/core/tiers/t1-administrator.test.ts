import { describe, it, expect, vi } from 'vitest';
import { T1Administrator, type TaskPlan } from './t1-administrator.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { CascadeConfig, T1ToT2Assignment, T2Result } from '../../types.js';

function makeSection(id: string): T1ToT2Assignment {
  return {
    sectionId: id,
    sectionTitle: `Section ${id}`,
    description: 'd',
    expectedOutput: 'o',
    constraints: [],
    dependsOn: [],
    t3Subtasks: [],
  };
}

function makeTrackingManagers(count: number, active: { n: number; max: number }) {
  return Array.from({ length: count }, () => ({
    execute: vi.fn(async () => {
      active.n++;
      active.max = Math.max(active.max, active.n);
      await new Promise((r) => setTimeout(r, 15));
      active.n--;
      return {
        sectionId: 's', sectionTitle: 't', status: 'COMPLETED',
        t3Results: [], sectionSummary: 'ok', issues: [],
      } as T2Result;
    }),
    shareCompletedOutput: vi.fn(),
  }));
}

describe('T1Administrator cross-section concurrency (t3Execution bug fix)', () => {
  // Bug: t3Execution only serialized T3 workers WITHIN one T2 section
  // (t2-manager.ts) — independent SECTIONS still ran fully in parallel via
  // t1-administrator.ts's executeWave, regardless of the setting.

  it('runs independent sections SEQUENTIALLY when t3Execution is sequential', async () => {
    const router = { getT3ExecutionMode: () => 'sequential' } as unknown as CascadeRouter;
    const admin = new T1Administrator(router, {} as ToolRegistry, {} as CascadeConfig);

    const sections = [makeSection('s1'), makeSection('s2'), makeSection('s3')];
    const active = { n: 0, max: 0 };
    const managers = makeTrackingManagers(sections.length, active);

    await (admin as unknown as { runT2sWithDependencies: (s: unknown, m: unknown, t: string) => Promise<T2Result[]> })
      .runT2sWithDependencies(sections, managers, 'task-seq');

    expect(active.max).toBe(1); // never more than one section in flight at once
    for (const m of managers) expect(m.execute).toHaveBeenCalledOnce();
  });

  it('still runs independent sections in PARALLEL when t3Execution is auto/parallel (unchanged behavior)', async () => {
    const router = { getT3ExecutionMode: () => 'parallel' } as unknown as CascadeRouter;
    const admin = new T1Administrator(router, {} as ToolRegistry, {} as CascadeConfig);

    const sections = [makeSection('s1'), makeSection('s2'), makeSection('s3')];
    const active = { n: 0, max: 0 };
    const managers = makeTrackingManagers(sections.length, active);

    await (admin as unknown as { runT2sWithDependencies: (s: unknown, m: unknown, t: string) => Promise<T2Result[]> })
      .runT2sWithDependencies(sections, managers, 'task-par');

    expect(active.max).toBe(3); // all three ran concurrently
  });
});

describe('T1Administrator.validatePlan (LLM plan JSON missing `constraints` bug fix)', () => {
  // `constraints` is a required string[] in T1ToT2Assignment/T3SubtaskSpec,
  // but that's a compile-time contract only — the LLM's plan JSON doesn't
  // honor it. A section or subtask with no `constraints` field crashed
  // T2Manager/T3Worker with "Cannot read properties of undefined (reading
  // 'join')" the moment anything called `.join`/`.map` on it, taking down
  // every section of the run at once.
  function validate(plan: TaskPlan): void {
    (new T1Administrator({} as CascadeRouter, {} as ToolRegistry, {} as CascadeConfig) as unknown as {
      validatePlan: (p: TaskPlan) => void;
    }).validatePlan(plan);
  }

  it('fills in a missing section-level `constraints` instead of leaving it undefined', () => {
    const plan = {
      complexity: 'Moderate',
      reasoning: 'r',
      sections: [{
        sectionId: 's1', sectionTitle: 'Baseline Research', description: 'd', expectedOutput: 'o',
        t3Subtasks: [],
      } as unknown as T1ToT2Assignment],
    } as TaskPlan;

    expect(() => validate(plan)).not.toThrow();
    expect(plan.sections[0]!.constraints).toEqual([]);
  });

  it('fills in a missing subtask-level `constraints` instead of leaving it undefined', () => {
    const plan = {
      complexity: 'Complex',
      reasoning: 'r',
      sections: [{
        sectionId: 's1', sectionTitle: 'Intervention Point 1', description: 'd', expectedOutput: 'o',
        constraints: [],
        t3Subtasks: [{ subtaskId: 't1', subtaskTitle: 'sub', description: 'd', expectedOutput: 'o', peerT3Ids: [] }],
      } as unknown as T1ToT2Assignment],
    } as TaskPlan;

    expect(() => validate(plan)).not.toThrow();
    expect(plan.sections[0]!.t3Subtasks[0]!.constraints).toEqual([]);
  });

  it('leaves an already-populated `constraints` array untouched', () => {
    const plan: TaskPlan = {
      complexity: 'Simple',
      reasoning: 'r',
      sections: [{
        sectionId: 's1', sectionTitle: 'Section', description: 'd', expectedOutput: 'o',
        constraints: ['must cite sources'],
        t3Subtasks: [],
      }],
    };

    validate(plan);
    expect(plan.sections[0]!.constraints).toEqual(['must cite sources']);
  });
});

describe('T1Administrator.summarizeCompletedSections (corrective replan grounding fix)', () => {
  it('includes completed and partial sections, with their summary text', () => {
    const admin = new T1Administrator({} as CascadeRouter, {} as ToolRegistry, {} as CascadeConfig);
    const results: T2Result[] = [
      { sectionId: 's1', sectionTitle: 'Auth module refactor', status: 'COMPLETED', t3Results: [], sectionSummary: 'JWT auth implemented and tested.', issues: [] },
      { sectionId: 's2', sectionTitle: 'Partial docs', status: 'PARTIAL', t3Results: [], sectionSummary: 'Half the docs written.', issues: [] },
      { sectionId: 's3', sectionTitle: 'Broken section', status: 'FAILED', t3Results: [], sectionSummary: '', issues: ['boom'] },
    ];

    const summary = (admin as unknown as { summarizeCompletedSections: (r: T2Result[]) => string })
      .summarizeCompletedSections(results);

    expect(summary).toContain('Auth module refactor');
    expect(summary).toContain('JWT auth implemented and tested.');
    expect(summary).toContain('Partial docs');
    expect(summary).toContain('Half the docs written.');
    expect(summary).not.toContain('Broken section'); // FAILED sections aren't "already done"
  });

  it('returns an empty string when nothing has completed yet', () => {
    const admin = new T1Administrator({} as CascadeRouter, {} as ToolRegistry, {} as CascadeConfig);
    const summary = (admin as unknown as { summarizeCompletedSections: (r: T2Result[]) => string })
      .summarizeCompletedSections([]);
    expect(summary).toBe('');
  });

  it('never claims a BLOCKED section is already done', () => {
    // A blocked section produced nothing, so telling a corrective replan "do
    // not redo this" would strand the work permanently — the one thing the
    // replan exists to pick up.
    const admin = new T1Administrator({} as CascadeRouter, {} as ToolRegistry, {} as CascadeConfig);
    const summary = (admin as unknown as { summarizeCompletedSections: (r: T2Result[]) => string })
      .summarizeCompletedSections([
        { sectionId: 's1', sectionTitle: 'Implement API', status: 'FAILED', t3Results: [], sectionSummary: '', issues: ['boom'] },
        { sectionId: 's2', sectionTitle: 'Integration tests', status: 'BLOCKED', t3Results: [], sectionSummary: '', issues: ['skipped'] },
      ]);
    expect(summary).toBe('');
  });
});

describe('T1Administrator.compileFinalOutput — blocked sections are not content', () => {
  /**
   * The regression this pins: `completedSections` was `status !== 'FAILED'`,
   * which was only accidentally correct while FAILED was the sole unproductive
   * state. Introducing BLOCKED made every skipped section read as finished
   * work — so an empty summary was fed to the compile step as though a manager
   * had written it, and a run whose first section failed stopped reporting
   * failure at all, because the sections blocked behind it looked like output.
   */
  const compile = (admin: T1Administrator, results: T2Result[]) =>
    (admin as unknown as { compileFinalOutput: (p: string, plan: unknown, r: T2Result[]) => Promise<string> })
      .compileFinalOutput('build the thing', { sections: [] }, results);

  it('reports failure when every section either failed or was blocked behind it', async () => {
    const admin = new T1Administrator({} as CascadeRouter, {} as ToolRegistry, {} as CascadeConfig);
    const out = await compile(admin, [
      { sectionId: 's1', sectionTitle: 'Implement API', status: 'FAILED', t3Results: [], sectionSummary: '', issues: ['provider 500'] },
      { sectionId: 's2', sectionTitle: 'Integration tests', status: 'BLOCKED', t3Results: [], sectionSummary: '', issues: ['Required upstream work "Implement API" failed. This section was not attempted, so no tokens were spent on it.'] },
    ]);

    expect(out).toContain('Task failed');
    expect(out).toContain('provider 500');
  });
});

describe('T1Administrator.reviewT2Outputs (preserve a user-chosen skip)', () => {
  // "Skip this section" converts an escalated section to PARTIAL and keeps its
  // output — but the reviewer only ever sees the summary text below, and
  // without a note explaining WHY it's incomplete, a strict QA reviewer has
  // every reason to reject it and trigger a correction plan that redoes
  // exactly the work the user just chose to stop.
  type ReviewFn = (p: string, plan: unknown, r: T2Result[]) => Promise<{ approved: boolean; reason?: string }>;

  function makeReviewer(captured: { prompt?: string }) {
    const router = {
      generate: vi.fn(async (_tier: string, options: { messages: Array<{ content: unknown }> }) => {
        captured.prompt = String(options.messages[0]?.content ?? '');
        return { content: 'APPROVED', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 } };
      }),
    } as unknown as CascadeRouter;
    return new T1Administrator(router, {} as ToolRegistry, {} as CascadeConfig);
  }

  it('annotates a userSkipped section in the reviewer prompt', async () => {
    const captured: { prompt?: string } = {};
    const admin = makeReviewer(captured);
    const results: T2Result[] = [{
      sectionId: 's1', sectionTitle: 'Legacy migration', status: 'PARTIAL',
      t3Results: [], sectionSummary: 'Escalated worker output kept as-is.', issues: [],
      userSkipped: true,
    }];

    await (admin as unknown as { reviewT2Outputs: ReviewFn }).reviewT2Outputs('goal', {} as never, results);

    expect(captured.prompt).toContain('SKIP');
    expect(captured.prompt).toMatch(/user.*explicitly chose to SKIP|intentional decision, not a failure/i);
  });

  it('adds no such note for an ordinary section', async () => {
    const captured: { prompt?: string } = {};
    const admin = makeReviewer(captured);
    const results: T2Result[] = [{
      sectionId: 's1', sectionTitle: 'Auth module', status: 'COMPLETED',
      t3Results: [], sectionSummary: 'Done.', issues: [],
    }];

    await (admin as unknown as { reviewT2Outputs: ReviewFn }).reviewT2Outputs('goal', {} as never, results);

    expect(captured.prompt).not.toMatch(/explicitly chose to SKIP/i);
  });
});

describe('T1 planner prompt — media generation capability awareness', () => {
  // Live-reported bug: a video request produced script and direction sections
  // forever and never a section that called generate_video. T1 planned around a
  // capability whose shape it was never told — MultimodalRegistry.describe()
  // claimed "the planner sees this" while being wired into no prompt at all.
  type Decompose = (prompt: string, systemContext?: string) => Promise<TaskPlan>;

  function makeAdmin(captured: { systemPrompt?: string }, toolNames: string[]) {
    const router = {
      generate: vi.fn(async (_tier: string, options: { systemPrompt?: string }) => {
        captured.systemPrompt = options.systemPrompt;
        return {
          content: '{"complexity":"Simple","reasoning":"r","sections":[]}',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
        };
      }),
    } as unknown as CascadeRouter;
    const toolRegistry = {
      getToolDefinitions: () => toolNames.map((name) => ({ name, description: '', inputSchema: {} })),
    } as unknown as ToolRegistry;
    return new T1Administrator(router, toolRegistry, {} as CascadeConfig);
  }

  it('tells the planner that video is one atomic billed call the plan must END on', async () => {
    const captured: { systemPrompt?: string } = {};
    const admin = makeAdmin(captured, ['file_write', 'generate_image', 'generate_video']);

    await (admin as unknown as { decomposeTask: Decompose }).decomposeTask('make me a 5-second video of a cat');

    expect(captured.systemPrompt).toContain('MEDIA GENERATION');
    expect(captured.systemPrompt).toContain('"generate_video" (video)');
    expect(captured.systemPrompt).toContain('ATOMIC tool call');
    expect(captured.systemPrompt).toContain('VIDEO PLANS MUST END IN THE TOOL CALL');
    // The pre-production the user explicitly asked to KEEP has to be sanctioned
    // by the same paragraph that demands the terminating call.
    expect(captured.systemPrompt).toMatch(/script, a shot list, direction/);
  });

  it('says nothing about generation when no generation tool is registered', async () => {
    const captured: { systemPrompt?: string } = {};
    const admin = makeAdmin(captured, ['file_write', 'web_search']);

    await (admin as unknown as { decomposeTask: Decompose }).decomposeTask('write a haiku');

    expect(captured.systemPrompt).not.toContain('MEDIA GENERATION');
    expect(captured.systemPrompt).not.toContain('generate_video');
  });
});
