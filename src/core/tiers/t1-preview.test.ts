// ─────────────────────────────────────────────
//  Cascade AI — T1 previewPlan (/plan command)
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { T1Administrator } from './t1-administrator.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { CascadeConfig, GenerateResult } from '../../types.js';

function makeResult(content: string): GenerateResult {
  return { content, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } };
}

const PLAN_JSON = JSON.stringify({
  complexity: 'Moderate',
  reasoning: 'two independent sections',
  sections: [
    { sectionId: 's1', sectionTitle: 'Build core', description: 'core', expectedOutput: 'done', constraints: [], dependsOn: [], t3Subtasks: [{ subtaskId: 't1', subtaskTitle: 'impl', description: 'd', expectedOutput: 'o', constraints: [], dependsOn: [] }] },
    { sectionId: 's2', sectionTitle: 'Write docs', description: 'docs', expectedOutput: 'done', constraints: [], dependsOn: [], t3Subtasks: [{ subtaskId: 't2', subtaskTitle: 'doc', description: 'd', expectedOutput: 'o', constraints: [], dependsOn: [] }] },
  ],
});

function makeToolRegistry(): ToolRegistry {
  return { getToolDefinitions: () => [], requiresApproval: () => false, isDangerous: () => false } as unknown as ToolRegistry;
}

describe('T1 previewPlan', () => {
  it('returns a decomposition WITHOUT executing it (single decompose call, no dispatch)', async () => {
    const generate = vi.fn(async () => makeResult(PLAN_JSON));
    const router = { generate, getModelForTier: () => undefined } as unknown as CascadeRouter;
    const t1 = new T1Administrator(router, makeToolRegistry(), {} as unknown as CascadeConfig);

    const plan = await t1.previewPlan('build a thing with docs');

    expect(plan.sections).toHaveLength(2);
    expect(plan.sections[0]!.sectionTitle).toBe('Build core');
    // Only the decomposition call ran — no section/worker execution.
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
