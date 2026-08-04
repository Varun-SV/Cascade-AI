/**
 * The property that makes durable resume worth building: finished work must
 * reach the resumed run as concrete facts, not as a vague instruction.
 *
 * These exercise the store + summary pair the way Cascade.buildResumePrompt
 * uses them, without standing up a whole Cascade (which needs providers, a
 * router and a workspace). The wiring itself is covered by tsc; what needs
 * pinning is the behaviour that a re-plan can actually act on.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResumeStore, summarizeCompleted, type CompletedNode } from './resume-store.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-resume-flow-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Mirrors Cascade.buildResumePrompt so the assembled text is under test. */
function buildResumePrompt(prompt: string, partialOutput: string, completed: readonly CompletedNode[]): string {
  const done = summarizeCompleted(completed);
  return [
    'Continue and FINISH this task. A previous attempt was interrupted before completion; '
    + 'any files already created are on disk — build on them, do NOT recreate them. '
    + 'Plan ONLY the remaining work.',
    '',
    `Original task: ${prompt}`,
    done ? `\n${done}` : '',
    partialOutput ? `\nPartial result so far:\n${partialOutput}` : '',
  ].filter(Boolean).join('\n');
}

describe('durable resume flow', () => {
  it('carries finished sections across a simulated process restart', async () => {
    // Run 1 gets two sections done, then the process dies.
    const dying = new ResumeStore({ dir });
    await dying.save({
      taskId: 'task-1',
      prompt: 'Write a market report',
      reason: 'error',
      detail: 'boom',
      partialOutput: 'Draft intro',
      completed: [
        { id: 's1', title: 'Research competitors', status: 'COMPLETED', output: 'Found 4 competitors' },
        { id: 's2', title: 'Gather pricing', status: 'COMPLETED', output: 'Prices range $10-$90' },
      ],
    });

    // Run 2 is a brand-new store over the same directory — a different process.
    const restarted = new ResumeStore({ dir });
    const recovered = await restarted.consume();
    expect(recovered).not.toBeNull();

    const resumePrompt = buildResumePrompt(
      recovered!.prompt, recovered!.partialOutput, recovered!.completed,
    );

    // The finished sections are named, so the planner can skip them rather than
    // infer from prose that something unspecified was already done.
    expect(resumePrompt).toContain('Research competitors');
    expect(resumePrompt).toContain('Gather pricing');
    expect(resumePrompt).toContain('do NOT redo');
    expect(resumePrompt).toContain('Plan ONLY the remaining work');
    expect(resumePrompt).toContain('Write a market report');
  });

  it('cannot restore the same finished work into two runs', async () => {
    const store = new ResumeStore({ dir });
    await store.save({
      taskId: 'task-1', prompt: 'p', reason: 'cancelled', partialOutput: 'x',
      completed: [{ id: 's1', title: 'Done thing', status: 'COMPLETED', output: 'o' }],
    });

    expect(await store.consume()).not.toBeNull();
    // A second resume must not re-inject sections the first one already took.
    expect(await store.consume()).toBeNull();
  });

  it('produces a prompt without a completed block when nothing finished', async () => {
    // A run that died during planning has no sections. The prompt should not
    // claim work was done, or the planner will look for output that isn't there.
    const resumePrompt = buildResumePrompt('Do the thing', '', []);
    expect(resumePrompt).not.toContain('ALREADY COMPLETED');
    expect(resumePrompt).toContain('Do the thing');
  });

  it('records every interruption kind the run loop can hit', async () => {
    const store = new ResumeStore({ dir });
    for (const reason of ['budget', 'cancelled', 'error', 'breaker'] as const) {
      await store.save({
        taskId: `task-${reason}`, prompt: 'p', reason, partialOutput: 'x', completed: [],
      });
    }
    const reasons = (await store.list()).map((c) => c.reason);
    expect(new Set(reasons)).toEqual(new Set(['budget', 'cancelled', 'error', 'breaker']));
  });
});

describe('a resumed run must not lose the work it inherited', () => {
  const node = (id: string, title = id): CompletedNode => ({
    id, title, status: 'COMPLETED', output: `output of ${id}`,
  });

  /** Mirrors Cascade.checkpointRun's merge: inherited nodes + this attempt's. */
  function cumulative(
    inherited: readonly CompletedNode[],
    thisAttempt: readonly CompletedNode[],
  ): CompletedNode[] {
    const merged = new Map<string, CompletedNode>();
    for (const node of inherited) merged.set(node.id, node);
    for (const node of thisAttempt) merged.set(node.id, node);
    return [...merged.values()];
  }

  it('carries earlier sections through resume -> partial -> interruption -> resume', async () => {
    const store = new ResumeStore({ dir });

    // Attempt 1 finishes two sections, then stops.
    await store.save({
      taskId: 'task-1', prompt: 'Write a market report', reason: 'budget', partialOutput: 'draft',
      completed: [node('s1', 'Research'), node('s2', 'Pricing')],
    });

    // Attempt 2 claims it, finishes ONE more section, and is interrupted again.
    const claimed = await store.claim();
    expect(claimed).not.toBeNull();
    const inherited = claimed!.checkpoint.completed;

    await store.save({
      taskId: 'task-2',
      // The ORIGINAL prompt travels forward rather than the continuation text,
      // so repeated resumes don't nest prompts inside prompts.
      prompt: claimed!.checkpoint.prompt,
      reason: 'cancelled',
      partialOutput: 'draft 2',
      completed: cumulative(inherited, [node('s3', 'Draft')]),
    });
    await store.settle(claimed!.claimId);

    // Attempt 3 must see ALL THREE sections. Before the merge it saw only s3,
    // and re-did (and re-paid for) the two that were already finished.
    const third = await store.claim();
    expect(third!.checkpoint.completed.map((c) => c.id).sort()).toEqual(['s1', 's2', 's3']);
    expect(third!.checkpoint.prompt).toBe('Write a market report');
  });

  it('a re-run section supersedes its inherited copy rather than duplicating', async () => {
    const older: CompletedNode = { id: 's1', title: 'Research', status: 'PARTIAL', output: 'thin' };
    const newer: CompletedNode = { id: 's1', title: 'Research', status: 'COMPLETED', output: 'full' };
    const merged = cumulative([older], [newer]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.output).toBe('full');
  });
});
