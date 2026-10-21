import { describe, expect, it, vi } from 'vitest';
import { CloudMirror } from './cloud-mirror.js';

const accounting = { costUsd: 0.01, why: '{"totalCostUsd":0.01}' };

function setup(optedOut = false) {
  const api = {
    createConversation: vi.fn().mockResolvedValue({ ok: true, conversation: { id: 'c1' } }),
    appendTurn: vi.fn().mockResolvedValue({ ok: true }),
    recordUnansweredRun: vi.fn().mockResolvedValue({ ok: true }),
  };
  return { api, mirror: new CloudMirror(() => api, () => optedOut) };
}

describe('CloudMirror', () => {
  it('copies a finished turn with its cost, for any session, not just the one on screen', async () => {
    const { api, mirror } = setup();
    mirror.rememberPrompt('s1', 'first');
    mirror.rememberPrompt('s2', 'second');
    // s1 finishes while s2 is the session being shown: nothing here knows or cares.
    await mirror.completed({ sessionId: 's1', result: { output: 'answer' }, cloud: accounting });
    expect(api.createConversation).toHaveBeenCalledWith('first');
    expect(api.appendTurn).toHaveBeenCalledWith('c1', { userContent: 'first', assistant: { content: 'answer', ...accounting } });
  });

  it('records a run stopped before any answer as stopped, with no chat made for it', async () => {
    const { api, mirror } = setup();
    mirror.rememberPrompt('s1', 'q');
    await mirror.completed({ sessionId: 's1', result: { output: '' }, cloud: accounting });
    expect(api.appendTurn).not.toHaveBeenCalled();
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.recordUnansweredRun).toHaveBeenCalledWith({ conversationId: null, outcome: 'stopped', ...accounting });
  });

  it('records a failed run against the chat already copied', async () => {
    const { api, mirror } = setup();
    mirror.rememberPrompt('s1', 'q');
    await mirror.completed({ sessionId: 's1', result: { output: 'a' }, cloud: accounting });
    await mirror.failed({ sessionId: 's1', cloud: accounting });
    await mirror.failed({ sessionId: 's1', cloud: accounting, stopped: true });
    expect(api.recordUnansweredRun).toHaveBeenNthCalledWith(1, { conversationId: 'c1', outcome: 'failed', ...accounting });
    expect(api.recordUnansweredRun).toHaveBeenNthCalledWith(2, { conversationId: 'c1', outcome: 'stopped', ...accounting });
  });

  it('does nothing when opted out, or with no accounting to send', async () => {
    const off = setup(true);
    off.mirror.rememberPrompt('s1', 'q');
    await off.mirror.completed({ sessionId: 's1', result: { output: 'a' }, cloud: accounting });
    await off.mirror.failed({ sessionId: 's1', cloud: accounting });
    expect(off.api.appendTurn).not.toHaveBeenCalled();
    expect(off.api.recordUnansweredRun).not.toHaveBeenCalled();
    const on = setup();
    await on.mirror.failed({ sessionId: 's1' });
    expect(on.api.recordUnansweredRun).not.toHaveBeenCalled();
  });

  it('never throws when the account cannot be reached', async () => {
    const api = { recordUnansweredRun: vi.fn().mockRejectedValue(new Error('offline')) };
    const mirror = new CloudMirror(() => api, () => false);
    await expect(mirror.failed({ sessionId: 's1', cloud: accounting })).resolves.toBeUndefined();
  });
});
