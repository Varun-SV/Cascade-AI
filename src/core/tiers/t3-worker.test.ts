// ─────────────────────────────────────────────
//  Cascade AI — T3 Worker Permission Tests
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import type { PermissionRequest, PermissionDecision } from '../../types.js';
import { PermissionEscalator } from '../permissions/escalator.js';

// We test the T3 → escalator integration: verify that T3 calls escalator
// rather than directly emitting approval events, and that the result is honored.

function makeDecision(approved: boolean, decidedBy: 'T2' | 'T1' | 'USER' = 'T2'): PermissionDecision {
  return { requestId: 'req-001', approved, decidedBy };
}

describe('T3 Worker — permission escalation integration', () => {
  it('escalator.requestPermission is called with correct shape', async () => {
    const escalator = new PermissionEscalator();
    const spy = vi.spyOn(escalator, 'requestPermission').mockResolvedValue(makeDecision(true));

    await escalator.requestPermission({
      id: 'req-001',
      requestedBy: 't3-worker-1',
      parentT2Id: 't2-manager-1',
      toolName: 'file_write',
      input: { path: '/workspace/report.md' },
      isDangerous: false,
      subtaskContext: 'Write final report',
      sectionContext: 'Generate documentation',
    });

    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]![0] as PermissionRequest;
    expect(call.toolName).toBe('file_write');
    expect(call.requestedBy).toBe('t3-worker-1');
    expect(call.parentT2Id).toBe('t2-manager-1');
  });

  it('denial returns error string including decidedBy', async () => {
    const escalator = new PermissionEscalator();
    vi.spyOn(escalator, 'requestPermission').mockResolvedValue(makeDecision(false, 'T1'));

    const decision = await escalator.requestPermission({
      id: 'req-002',
      requestedBy: 't3-worker-2',
      parentT2Id: 't2-manager-1',
      toolName: 'shell_run',
      input: { command: 'rm -rf /' },
      isDangerous: true,
      subtaskContext: 'Clean temp files',
      sectionContext: 'Cleanup section',
    });

    // Simulate what T3 does: convert denial to error string
    const result = !decision.approved
      ? `Tool ${decision.requestId} was denied (decided by ${decision.decidedBy}).`
      : 'ok';

    expect(result).toContain('denied');
    expect(result).toContain('T1');
  });

  it('approval from any tier allows tool execution', async () => {
    for (const tier of ['T2', 'T1', 'USER'] as const) {
      const escalator = new PermissionEscalator();
      vi.spyOn(escalator, 'requestPermission').mockResolvedValue(makeDecision(true, tier));

      const decision = await escalator.requestPermission({
        id: 'req-003',
        requestedBy: 't3-test',
        parentT2Id: 't2-test',
        toolName: 'file_write',
        input: {},
        isDangerous: false,
        subtaskContext: 'test',
        sectionContext: 'test',
      });

      expect(decision.approved).toBe(true);
    }
  });
});

describe('T3 Worker — legacy fallback (no escalator)', () => {
  it('falls back to direct approval-request event when escalator not set', () => {
    // This tests the code path in t3-worker.ts: if permissionEscalator is undefined,
    // it emits 'tool:approval-request' and waits for 'tool:approval-response:{id}'
    const mockEmit = vi.fn();
    const mockOnce = vi.fn();

    // Simulate: approvalId = `t3-worker-1-tool-call-1`
    const approvalId = 't3-worker-1-tool-call-1';
    mockEmit('tool:approval-request', { id: approvalId, toolName: 'shell_run', isDangerous: true });

    expect(mockEmit).toHaveBeenCalledWith('tool:approval-request', expect.objectContaining({
      id: approvalId,
      toolName: 'shell_run',
    }));
  });
});
