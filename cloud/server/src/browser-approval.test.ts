// ─────────────────────────────────────────────
//  Cascade Cloud — who may approve a browser action
// ─────────────────────────────────────────────
//
//  Two properties, both of which were absent and neither of which is visible
//  from the code that has them.
//
//  `browser_control` is dangerous. T2 and T1 only append advisory verdicts and
//  pass a dangerous request on, so it reaches the user's turn, which
//  `Cascade.run()` resolves from `approvalCallback`. With no callback that
//  resolves `approved = false` — so the capability shipped unusable rather than
//  ungated, which is a harder failure to notice.
//
//  And a caller with no human on the other end must not receive it at all. The
//  whole safety story is "you can watch it and stop it"; the SSE path has no
//  socket to render a live view and no way to press Stop, so auto-approving
//  there would hand the capability to exactly the runs that cannot supervise it.

import { describe, it, expect, vi } from 'vitest';
import { applyPermissionDecision, type PermissionDecision } from './runs.js';

/**
 * The approval shape runs.ts builds.
 *
 * The DECISION half is imported rather than restated. It used to be copied in
 * here, which meant the conversation check was tested in effigy: tightening the
 * real one changed nothing this file could see, and loosening it would have
 * broken nothing either.
 */
function makeApprovalCallback(opts: {
  interactive: boolean;
  conversationId: string;
  emit: (event: string, payload: Record<string, unknown>) => void;
}) {
  const pending = new Map<string, (d: { approved: boolean; always: boolean }) => void>();

  const onDecision = (d: PermissionDecision) =>
    applyPermissionDecision(pending, opts.conversationId, d);

  const callback = async (request: { id: string }) => {
    if (!opts.interactive) return { approved: false, always: false };
    return await new Promise<{ approved: boolean; always: boolean }>((resolve) => {
      pending.set(request.id, resolve);
      opts.emit('permission:user-required', { conversationId: opts.conversationId, ...request });
    });
  };

  return { callback, onDecision, pending };
}

describe('a run nobody is watching', () => {
  it('is refused rather than auto-approved', async () => {
    // Refusing is the safe direction: the alternative gives a dangerous
    // capability to the one caller that cannot see or stop it.
    const emit = vi.fn();
    const { callback } = makeApprovalCallback({ interactive: false, conversationId: 'c1', emit });

    const decision = await callback({ id: 'req-1' });

    expect(decision.approved).toBe(false);
    expect(emit, 'and nobody is asked, because nobody is there').not.toHaveBeenCalled();
  });
});

describe('a run with someone watching', () => {
  it('asks, and waits for the answer', async () => {
    const emit = vi.fn();
    const { callback, onDecision } = makeApprovalCallback({ interactive: true, conversationId: 'c1', emit });

    let settled = false;
    const decision = callback({ id: 'req-1' }).then((d) => { settled = true; return d; });
    await new Promise((r) => setTimeout(r, 10));

    expect(emit).toHaveBeenCalledWith('permission:user-required', expect.objectContaining({ id: 'req-1', conversationId: 'c1' }));
    expect(settled, 'it must not proceed on its own').toBe(false);

    onDecision({ conversationId: 'c1', requestId: 'req-1', approved: true });
    expect((await decision).approved).toBe(true);
  });

  it('carries "always" through, which is what makes a multi-step sequence usable', async () => {
    const { callback, onDecision } = makeApprovalCallback({ interactive: true, conversationId: 'c1', emit: vi.fn() });
    const decision = callback({ id: 'req-1' });
    await new Promise((r) => setTimeout(r, 10));
    onDecision({ conversationId: 'c1', requestId: 'req-1', approved: true, always: true });
    expect((await decision).always).toBe(true);
  });

  it('treats a denial as a denial', async () => {
    const { callback, onDecision } = makeApprovalCallback({ interactive: true, conversationId: 'c1', emit: vi.fn() });
    const decision = callback({ id: 'req-1' });
    await new Promise((r) => setTimeout(r, 10));
    onDecision({ conversationId: 'c1', requestId: 'req-1', approved: false });
    expect((await decision).approved).toBe(false);
  });
});

describe('one socket, several runs', () => {
  it('ignores an answer meant for another conversation', async () => {
    // The codebase already does this for escalation decisions and the reason is
    // the same: an unkeyed answer resolves whichever request happened to be
    // first, so approving one run's action could approve another's.
    const { callback, onDecision } = makeApprovalCallback({ interactive: true, conversationId: 'c1', emit: vi.fn() });

    let settled = false;
    const decision = callback({ id: 'req-1' }).then((d) => { settled = true; return d; });
    await new Promise((r) => setTimeout(r, 10));

    onDecision({ conversationId: 'other-conversation', requestId: 'req-1', approved: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled, 'that answer was not for this run').toBe(false);

    onDecision({ conversationId: 'c1', requestId: 'req-1', approved: true });
    expect((await decision).approved).toBe(true);
  });

  it('ignores an answer for a request it is not holding', async () => {
    const { callback, onDecision, pending } = makeApprovalCallback({ interactive: true, conversationId: 'c1', emit: vi.fn() });
    void callback({ id: 'req-1' });
    await new Promise((r) => setTimeout(r, 10));

    onDecision({ conversationId: 'c1', requestId: 'some-other-request', approved: true });
    expect(pending.has('req-1'), 'the real request is still waiting').toBe(true);
  });
});

describe('a decision that does not name its conversation', () => {
  it('settles nothing', async () => {
    // One socket carries several conversations, and this is the answer to a
    // question about a DANGEROUS action. An id-less decision used to be matched
    // by request id alone, so a client that had navigated elsewhere — a blank
    // New Chat has no conversation id at all — could approve a browser click in
    // a run it was no longer looking at.
    const { callback, onDecision, pending } = makeApprovalCallback({
      interactive: true, conversationId: 'c1', emit: vi.fn(),
    });
    const decided = callback({ id: 'req-1' });
    await Promise.resolve();

    expect(onDecision({ requestId: 'req-1', approved: true }), 'no conversation named').toBe(false);
    expect(onDecision({ conversationId: undefined, requestId: 'req-1', approved: true })).toBe(false);
    expect(pending.has('req-1'), 'the run is still waiting for a real answer').toBe(true);

    // And the right answer still gets through.
    expect(onDecision({ conversationId: 'c1', requestId: 'req-1', approved: true })).toBe(true);
    await expect(decided).resolves.toEqual({ approved: true, always: false });
  });
});
