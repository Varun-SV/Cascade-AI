// ─────────────────────────────────────────────
//  Cascade AI — PermissionEscalator Tests
// ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionEscalator } from './escalator.js';
import type { PermissionRequest, PermissionDecision } from '../../types.js';

/** Drain the microtask queue enough for async evaluators to resolve */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'req-001',
    requestedBy: 't3-worker-1',
    parentT2Id: 't2-manager-1',
    toolName: 'file_write',
    input: { path: '/workspace/output.md' },
    isDangerous: false,
    subtaskContext: 'Write summary report',
    sectionContext: 'Generate documentation',
    ...overrides,
  };
}

function makeDecision(approved: boolean, decidedBy: 'T2' | 'T1' | 'USER' = 'T2'): PermissionDecision {
  return { requestId: 'req-001', approved, always: true, decidedBy };
}

describe('PermissionEscalator', () => {
  let escalator: PermissionEscalator;

  beforeEach(() => {
    escalator = new PermissionEscalator();
  });

  // ── Safe tool auto-approve ─────────────────

  it('auto-approves file_read without calling T2 or T1', async () => {
    const t2 = vi.fn().mockResolvedValue(makeDecision(true));
    const t1 = vi.fn().mockResolvedValue(makeDecision(true));
    escalator.setT2Evaluator(t2 as any);
    escalator.setT1Evaluator(t1 as any);

    const req = makeRequest({ toolName: 'file_read', isDangerous: false });
    const decision = await escalator.requestPermission(req);

    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toBe('T2');
    expect(t2).not.toHaveBeenCalled();
    expect(t1).not.toHaveBeenCalled();
  });

  it('auto-approves git_status without calling T2 or T1', async () => {
    const t2 = vi.fn().mockResolvedValue(makeDecision(true));
    escalator.setT2Evaluator(t2 as any);

    const req = makeRequest({ toolName: 'git_status', isDangerous: false });
    const decision = await escalator.requestPermission(req);

    expect(decision.approved).toBe(true);
    expect(t2).not.toHaveBeenCalled();
  });

  // ── Session cache ──────────────────────────

  it('returns cached decision on second identical request', async () => {
    const t2 = vi.fn().mockResolvedValue(makeDecision(true, 'T2'));
    escalator.setT2Evaluator(t2 as any);

    const req = makeRequest({ toolName: 'shell_run', isDangerous: true });
    await escalator.requestPermission(req);
    expect(t2).toHaveBeenCalledTimes(1);

    // Second request for same T2 + toolName should hit cache
    const second = await escalator.requestPermission({ ...req, id: 'req-002' });
    expect(t2).toHaveBeenCalledTimes(1);
    expect(second.approved).toBe(true);
    expect(second.reasoning).toContain('Cached');
  });

  // ── T2 approves ────────────────────────────

  it('T2 approves dangerous tool without escalating to T1', async () => {
    const t2 = vi.fn().mockResolvedValue(makeDecision(true, 'T2'));
    const t1 = vi.fn();
    escalator.setT2Evaluator(t2 as any);
    escalator.setT1Evaluator(t1 as any);

    const req = makeRequest({ toolName: 'shell_run', isDangerous: true });
    const decision = await escalator.requestPermission(req);

    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toBe('T2');
    expect(t1).not.toHaveBeenCalled();
  });

  // ── T2 uncertain → T1 approves ────────────

  it('escalates to T1 when T2 returns null', async () => {
    const t2 = vi.fn().mockResolvedValue(null);
    const t1 = vi.fn().mockResolvedValue({
      requestId: 'req-001',
      approved: true,
      always: true,
      decidedBy: 'T1' as const,
      reasoning: 'Consistent with task goal',
    });
    escalator.setT2Evaluator(t2 as any);
    escalator.setT1Evaluator(t1 as any);

    const req = makeRequest({ toolName: 'shell_run', isDangerous: true });
    const decision = await escalator.requestPermission(req);

    expect(t2).toHaveBeenCalledOnce();
    expect(t1).toHaveBeenCalledOnce();
    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toBe('T1');
  });

  // ── T2 + T1 uncertain → user event fires ──

  it('emits permission:user-required when both T2 and T1 return null', async () => {
    const t2 = vi.fn().mockResolvedValue(null);
    const t1 = vi.fn().mockResolvedValue(null);
    escalator.setT2Evaluator(t2 as any);
    escalator.setT1Evaluator(t1 as any);

    const userEventFired = vi.fn();
    escalator.on('permission:user-required', userEventFired);

    const req = makeRequest({ toolName: 'shell_run', isDangerous: true });

    // Start the request — it will pause waiting for user
    const promise = escalator.requestPermission(req);
    // Flush all async evaluator calls so the event fires
    await flushPromises();

    expect(userEventFired).toHaveBeenCalledOnce();

    // Now the user resolves it
    escalator.resolveUserDecision(req.id, true, false);
    const decision = await promise;

    expect(decision.decidedBy).toBe('USER');
    expect(decision.approved).toBe(true);
  });

  // ── User denies ────────────────────────────

  it('returns denied decision when user resolves with false', async () => {
    escalator.setT2Evaluator(vi.fn().mockResolvedValue(null) as any);
    escalator.setT1Evaluator(vi.fn().mockResolvedValue(null) as any);

    const req = makeRequest({ toolName: 'shell_run', isDangerous: true });
    const promise = escalator.requestPermission(req);
    await flushPromises();
    escalator.resolveUserDecision(req.id, false, true);

    const decision = await promise;
    expect(decision.approved).toBe(false);
    expect(decision.always).toBe(true);
  });

  // ── cancelAllPending ───────────────────────

  it('cancelAllPending denies all waiting decisions', async () => {
    escalator.setT2Evaluator(vi.fn().mockResolvedValue(null) as any);
    escalator.setT1Evaluator(vi.fn().mockResolvedValue(null) as any);

    const req = makeRequest({ toolName: 'shell_run', isDangerous: true });
    const promise = escalator.requestPermission(req);
    // Drain microtasks so the user-required event fires and decision is registered
    await flushPromises();

    expect(escalator.hasPendingUserDecisions()).toBe(true);
    escalator.cancelAllPending();
    expect(escalator.hasPendingUserDecisions()).toBe(false);

    const decision = await promise;
    expect(decision.approved).toBe(false);
    expect(decision.reasoning).toContain('cancelled');
  });

  // ── T2 evaluator throws ────────────────────

  it('escalates to T1 if T2 evaluator throws', async () => {
    const t2 = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    const t1 = vi.fn().mockResolvedValue({
      requestId: 'req-001',
      approved: false,
      decidedBy: 'T1' as const,
    });
    escalator.setT2Evaluator(t2 as any);
    escalator.setT1Evaluator(t1 as any);

    const req = makeRequest({ toolName: 'shell_run', isDangerous: true });
    const decision = await escalator.requestPermission(req);

    expect(decision.decidedBy).toBe('T1');
    expect(t1).toHaveBeenCalledOnce();
  });
});
