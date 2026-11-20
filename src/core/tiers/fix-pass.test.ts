// ─────────────────────────────────────────────
//  Cascade AI — T1's fix pass, as the person sees it and as it plans
// ─────────────────────────────────────────────
//
// A review that rejects the first pass sends a fix pass. Its sections are named
// as fixes (a re-run of a section that failed read as the same section twice),
// and it is told what the earlier pass left on disk, so it finishes those files
// instead of writing them again from scratch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { T1Administrator, fixTitle, type TaskPlan } from './t1-administrator.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { CascadeConfig, T1ToT2Assignment, T2Result } from '../../types.js';

type T1Internals = {
  compileFinalOutput: (p: string, plan: TaskPlan, r: T2Result[]) => Promise<string>;
  decomposeTask: (p: string, c?: string) => Promise<TaskPlan>;
  dispatchT2Managers: (s: T1ToT2Assignment[]) => Promise<T2Result[]>;
  reviewT2Outputs: (p: string, plan: TaskPlan, r: T2Result[]) => Promise<{ approved: boolean; reason?: string; summary?: string; gaps: unknown[] }>;
};

const story = (title: string): T1ToT2Assignment => ({
  sectionId: 's1', sectionTitle: title, description: 'd', expectedOutput: 'o', constraints: [],
  t3Subtasks: [
    { subtaskId: 'write', subtaskTitle: 'Write Story Content', description: 'd', expectedOutput: 'o', constraints: [], peerT3Ids: [], files: ['story.md'] },
    { subtaskId: 'pdf', subtaskTitle: 'Generate PDF', description: 'd', expectedOutput: 'o', constraints: [], peerT3Ids: [], files: ['story.pdf', '../outside.txt'] },
  ],
});

const result = (title: string, status: T2Result['status']): T2Result =>
  ({ sectionId: 's1', sectionTitle: title, status, t3Results: [], sectionSummary: 'summary', issues: [] });

let dir = '';
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = '';
  fs.rmSync(path.join(os.tmpdir(), 'outside.txt'), { force: true });
});

describe('the fix pass', () => {
  it('is named as a fix, and told which of the planned files are already there', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-fix-pass-'));
    fs.writeFileSync(path.join(dir, 'story.md'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(os.tmpdir(), 'outside.txt'), 'not the workspace');

    const router = { isWrappingUp: () => false, getModelForTier: () => undefined } as unknown as CascadeRouter;
    const registry = { getWorkspaceRoot: () => dir } as unknown as ToolRegistry;
    const admin = new T1Administrator(router, registry, {} as CascadeConfig);
    const t1 = admin as unknown as T1Internals;
    let plans = 0;
    t1.decomposeTask = vi.fn(async () => {
      plans++;
      return { complexity: 'Simple', reasoning: '', sections: [story('Story Generation and PDF Export')] } as TaskPlan;
    });
    t1.dispatchT2Managers = vi.fn(async (sections: T1ToT2Assignment[]) => sections.map((s) => result(s.sectionTitle, plans === 1 ? 'PARTIAL' : 'COMPLETED')));
    let reviews = 0;
    t1.reviewT2Outputs = vi.fn(async () => (++reviews === 1
      ? { approved: false, reason: 'The story was not finished', summary: 'unfinished', gaps: [] }
      : { approved: true, gaps: [] }));
    t1.compileFinalOutput = vi.fn(async () => 'the answer');

    await admin.execute('write a story in a novel format, and save it as pdf', 'task');

    // Named as a fix on every screen, not the same title twice.
    const dispatched = vi.mocked(t1.dispatchT2Managers).mock.calls.map(([s]) => s.map((x) => x.sectionTitle));
    expect(dispatched).toEqual([['Story Generation and PDF Export'], ['Fix 1 · Story Generation and PDF Export']]);

    // Told what is on disk: the story it wrote, by name and size, and nothing
    // that isn't there or lies outside the workspace.
    const [prompt, context] = vi.mocked(t1.decomposeTask).mock.calls[1]!;
    expect(context).toContain('FILES ALREADY IN THE WORKSPACE');
    expect(context).toContain('- story.md (2.0 KB)');
    expect(context).not.toContain('story.pdf');
    expect(context).not.toContain('outside.txt');
    expect(prompt).toMatch(/check, fix or finish them where they are/);
    // Names and sizes only.
    expect(context).not.toContain('xxxx');
  });

  it('says nothing about files when the earlier pass left none', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-fix-pass-'));
    const router = { isWrappingUp: () => false, getModelForTier: () => undefined } as unknown as CascadeRouter;
    const admin = new T1Administrator(router, { getWorkspaceRoot: () => dir } as unknown as ToolRegistry, {} as CascadeConfig);
    const t1 = admin as unknown as T1Internals;
    t1.decomposeTask = vi.fn(async () => ({ complexity: 'Simple', reasoning: '', sections: [story('Story')] }) as TaskPlan);
    let n = 0;
    t1.dispatchT2Managers = vi.fn(async (s: T1ToT2Assignment[]) => s.map((x) => result(x.sectionTitle, ++n === 1 ? 'FAILED' : 'COMPLETED')));
    let reviews = 0;
    t1.reviewT2Outputs = vi.fn(async () => (++reviews === 1 ? { approved: false, reason: 'failed', summary: 'failed', gaps: [] } : { approved: true, gaps: [] }));
    t1.compileFinalOutput = vi.fn(async () => 'the answer');

    await admin.execute('goal', 'task');

    const [prompt, context] = vi.mocked(t1.decomposeTask).mock.calls[1]!;
    expect(context ?? '').not.toContain('FILES ALREADY IN THE WORKSPACE');
    expect(prompt).not.toMatch(/check, fix or finish/);
  });
});

describe('fixTitle', () => {
  it('names a section by its fix pass, never twice', () => {
    expect(fixTitle(1, 'Story Generation')).toBe('Fix 1 · Story Generation');
    expect(fixTitle(2, 'Fix 1 · Story Generation')).toBe('Fix 2 · Story Generation');
  });
});
