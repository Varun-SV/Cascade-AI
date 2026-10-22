import { describe, expect, it, vi } from 'vitest';
import { CloudMirror, type ChatLinks } from './cloud-mirror.js';

const accounting = { costUsd: 0.01, why: '{"totalCostUsd":0.01}' };

function links(initial: Array<[string, string]> = []): ChatLinks {
  const m = new Map(initial);
  return { get: (s) => m.get(s), set: (s, c) => { m.set(s, c); } };
}

function setup(optedOut = false, chats = links()) {
  const api = {
    createConversation: vi.fn().mockResolvedValue({ ok: true, conversation: { id: 'c1' } }),
    appendTurn: vi.fn().mockResolvedValue({ ok: true }),
    recordRunSpend: vi.fn().mockResolvedValue({ ok: true }),
  };
  return { api, mirror: new CloudMirror(() => api, () => optedOut, chats) };
}

const answered = (sessionId: string, extra: Record<string, unknown> = {}) =>
  ({ sessionId, prompt: 'q', output: 'answer', outcome: 'answered' as const, copyTurn: true, cloud: accounting, ...extra });

describe('CloudMirror', () => {
  it('copies an answered turn with its cost, by the prompt the backend sends', async () => {
    const { api, mirror } = setup();
    await mirror.accounted(answered('s1', { prompt: 'from the cockpit' }));
    expect(api.createConversation).toHaveBeenCalledWith('from the cockpit');
    expect(api.appendTurn).toHaveBeenCalledWith('c1', { userContent: 'from the cockpit', assistant: { content: 'answer', ...accounting } });
    expect(api.recordRunSpend).not.toHaveBeenCalled();
  });

  it('records a stopped run, and an empty answer, as spend only, with no chat made for them', async () => {
    const { api, mirror } = setup();
    await mirror.accounted({ sessionId: 's1', prompt: 'q', output: '', outcome: 'stopped', copyTurn: true, cloud: accounting });
    await mirror.accounted({ sessionId: 's2', prompt: 'q', output: '', outcome: 'answered', copyTurn: true, cloud: accounting });
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.recordRunSpend).toHaveBeenNthCalledWith(1, { conversationId: null, outcome: 'stopped', ...accounting });
    expect(api.recordRunSpend).toHaveBeenNthCalledWith(2, { conversationId: null, outcome: 'answered', ...accounting });
  });

  it('counts a scheduled run\'s spend without copying it as a chat', async () => {
    const { api, mirror } = setup();
    await mirror.accounted(answered('sched', { copyTurn: false }));
    expect(api.appendTurn).not.toHaveBeenCalled();
    expect(api.recordRunSpend).toHaveBeenCalledWith({ conversationId: null, outcome: 'answered', ...accounting });
  });

  it('records a failed run against the chat already copied', async () => {
    const { api, mirror } = setup();
    await mirror.accounted(answered('s1'));
    await mirror.accounted({ sessionId: 's1', outcome: 'failed', cloud: accounting });
    expect(api.recordRunSpend).toHaveBeenCalledWith({ conversationId: 'c1', outcome: 'failed', ...accounting });
  });

  it('continues the same cloud chat after a restart', async () => {
    const { api, mirror } = setup(false, links([['s1', 'kept-chat']]));
    await mirror.accounted(answered('s1'));
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.appendTurn).toHaveBeenCalledWith('kept-chat', expect.anything());
  });

  it('sends runs one at a time, in the order they ended', async () => {
    const { api, mirror } = setup();
    let release!: () => void;
    api.appendTurn.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true }); }));
    const first = mirror.accounted(answered('s1', { output: 'first' }));
    const second = mirror.accounted(answered('s1', { output: 'second' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.appendTurn).toHaveBeenCalledTimes(1);
    release();
    await first; await second;
    expect(api.appendTurn.mock.calls.map((c) => (c[1] as { assistant: { content: string } }).assistant.content)).toEqual(['first', 'second']);
  });

  it('does nothing when opted out, or with no accounting, and never throws', async () => {
    const off = setup(true);
    await off.mirror.accounted(answered('s1'));
    expect(off.api.appendTurn).not.toHaveBeenCalled();
    expect(off.api.recordRunSpend).not.toHaveBeenCalled();
    const on = setup();
    await on.mirror.accounted({ sessionId: 's1', outcome: 'failed' });
    expect(on.api.recordRunSpend).not.toHaveBeenCalled();
    on.api.appendTurn.mockRejectedValueOnce(new Error('offline'));
    await expect(on.mirror.accounted(answered('s1'))).resolves.toBeUndefined();
    // A failure does not stop the next run from being sent.
    await on.mirror.accounted(answered('s1', { output: 'next' }));
    expect(on.api.appendTurn).toHaveBeenCalledTimes(2);
  });
});
