import { describe, it, expect, vi } from 'vitest';
import { T1Administrator } from './t1-administrator.js';
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
});
