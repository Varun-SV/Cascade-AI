import { describe, expect, it, vi } from 'vitest';
import { CloudMirror, type ChatLinks } from './cloud-mirror.js';

const accounting = { costUsd: 0.01, why: '{"totalCostUsd":0.01}' };

function links(initial: Array<[string, string]> = []): ChatLinks {
  const m = new Map(initial);
  return { get: (s) => m.get(s), set: (s, c) => { m.set(s, c); }, delete: (s) => { m.delete(s); } };
}

const as = (id: string) => ({ signedIn: true, user: { id }, serverUrl: 'https://cloud' });

function setup(optedOut = false, chats = links()) {
  const api = {
    status: vi.fn().mockResolvedValue(as('u1')),
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
    expect(api.appendTurn).toHaveBeenCalledWith('c1', { userContent: 'from the cockpit', runId: expect.any(String), assistant: { content: 'answer', ...accounting } });
    expect(api.recordRunSpend).not.toHaveBeenCalled();
  });

  it('records a stopped run, and an empty answer, as spend only, with no chat made for them', async () => {
    const { api, mirror } = setup();
    await mirror.accounted({ sessionId: 's1', prompt: 'q', output: '', outcome: 'stopped', copyTurn: true, cloud: accounting });
    await mirror.accounted({ sessionId: 's2', prompt: 'q', output: '', outcome: 'answered', copyTurn: true, cloud: accounting });
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.recordRunSpend).toHaveBeenNthCalledWith(1, { conversationId: null, outcome: 'stopped', runId: expect.any(String), ...accounting });
    expect(api.recordRunSpend).toHaveBeenNthCalledWith(2, { conversationId: null, outcome: 'answered', runId: expect.any(String), ...accounting });
  });

  it('copies what a stopped run had written, marked as stopped', async () => {
    const { api, mirror } = setup();
    await mirror.accounted(answered('s1', { output: 'half an ans', outcome: 'stopped' }));
    expect(api.appendTurn).toHaveBeenCalledWith('c1', { userContent: 'q', runId: expect.any(String), outcome: 'stopped', assistant: { content: 'half an ans', ...accounting } });
    expect(api.recordRunSpend).not.toHaveBeenCalled();
  });

  it('sends a report replayed by the backend under the backend\'s id, so it is counted once', async () => {
    const { api, mirror } = setup();
    const id = '6a1c2f3e-0000-4000-8000-123456789abc';
    await mirror.accounted({ id, sessionId: 'sched', outcome: 'answered', copyTurn: false, prompt: 'q', output: 'a', cloud: accounting });
    await mirror.accounted({ id, sessionId: 'sched', outcome: 'answered', copyTurn: false, prompt: 'q', output: 'a', cloud: accounting });
    expect(api.recordRunSpend.mock.calls.map((c) => (c[0] as { runId: string }).runId)).toEqual([id, id]);
  });

  it('sends the time the run ended with its turn and its spend', async () => {
    const { api, mirror } = setup();
    const endedAt = Date.UTC(2026, 9, 21, 23, 58);
    await mirror.accounted(answered('s1', { endedAt }));
    await mirror.accounted({ sessionId: 's2', outcome: 'failed', endedAt, cloud: accounting });
    expect((api.appendTurn.mock.calls[0]![1] as { endedAt?: number }).endedAt).toBe(endedAt);
    expect((api.recordRunSpend.mock.calls[0]![0] as { endedAt?: number }).endedAt).toBe(endedAt);
  });

  it('counts a scheduled run\'s spend without copying it as a chat', async () => {
    const { api, mirror } = setup();
    await mirror.accounted(answered('sched', { copyTurn: false }));
    expect(api.appendTurn).not.toHaveBeenCalled();
    expect(api.recordRunSpend).toHaveBeenCalledWith({ conversationId: null, outcome: 'answered', runId: expect.any(String), ...accounting });
  });

  it('records a failed run against the chat already copied', async () => {
    const { api, mirror } = setup();
    await mirror.accounted(answered('s1'));
    await mirror.accounted({ sessionId: 's1', outcome: 'failed', cloud: accounting });
    expect(api.recordRunSpend).toHaveBeenCalledWith({ conversationId: 'c1', outcome: 'failed', runId: expect.any(String), ...accounting });
  });

  it('continues the same cloud chat after a restart', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'kept-chat']]));
    await mirror.accounted(answered('s1'));
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.appendTurn).toHaveBeenCalledWith('kept-chat', expect.anything());
  });

  it('starts a new chat for a session when another account signs in', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'chat-of-u1']]));
    api.status.mockResolvedValue(as('u2'));
    api.createConversation.mockResolvedValue({ ok: true, conversation: { id: 'chat-of-u2' } });
    await mirror.accounted(answered('s1'));
    expect(api.appendTurn).toHaveBeenCalledTimes(1);
    expect(api.appendTurn).toHaveBeenCalledWith('chat-of-u2', expect.anything());
  });

  it('replaces a chat that can no longer be reached, and still counts a run with no turn', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'deleted-chat']]));
    api.appendTurn.mockResolvedValueOnce({ ok: false, error: 'Request failed (404).' }).mockResolvedValue({ ok: true });
    await mirror.accounted(answered('s1'));
    expect(api.appendTurn.mock.calls.map((c) => c[0])).toEqual(['deleted-chat', 'c1']);

    const other = setup(false, links([['https://cloud|u1|s2', 'deleted-chat']]));
    other.api.recordRunSpend.mockResolvedValueOnce({ ok: false, error: 'Request failed (404).' }).mockResolvedValue({ ok: true });
    await other.mirror.accounted({ sessionId: 's2', outcome: 'failed', cloud: accounting });
    const calls = other.api.recordRunSpend.mock.calls.map((c) => c[0] as { conversationId: string | null; runId: string });
    expect(calls.map((c) => c.conversationId)).toEqual(['deleted-chat', null]);
    // The same run id both times: if the first was recorded after all, the second is not.
    expect(calls[0]!.runId).toBeTruthy();
    expect(calls[1]!.runId).toBe(calls[0]!.runId);
  });

  it('resends a turn whose answer was lost to the same chat, under the same run id', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'chat']]));
    // The first request was added, but its response never came back.
    api.appendTurn.mockResolvedValueOnce({ ok: false, error: 'socket hang up' }).mockResolvedValue({ ok: true });
    await mirror.accounted(answered('s1'));
    const calls = api.appendTurn.mock.calls as Array<[string, { runId: string }]>;
    expect(calls.map((c) => c[0])).toEqual(['chat', 'chat']);
    expect(calls[1]![1].runId).toBe(calls[0]![1].runId);
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.recordRunSpend).not.toHaveBeenCalled();
  });

  it('keeps the chat when the cloud cannot be reached, and counts the run under the turn\'s id', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'chat']]));
    api.appendTurn.mockResolvedValue({ ok: false, error: 'Request failed (502).' });
    await mirror.accounted(answered('s1'));
    expect(api.createConversation).not.toHaveBeenCalled();
    const turnId = (api.appendTurn.mock.calls[0]![1] as { runId: string }).runId;
    // If a turn got through after all, the cloud counts the run once.
    expect(api.recordRunSpend).toHaveBeenCalledWith({ conversationId: 'chat', outcome: 'answered', runId: turnId, ...accounting });
    // The link is kept for the next run.
    api.appendTurn.mockResolvedValue({ ok: true });
    await mirror.accounted(answered('s1', { output: 'next' }));
    expect(api.appendTurn).toHaveBeenLastCalledWith('chat', expect.anything());
  });

  it('does not send a queued run to an account that signed in after it ended', async () => {
    const { api, mirror } = setup();
    let release!: () => void;
    api.appendTurn.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true }); }));
    const first = mirror.accounted(answered('s1', { output: 'first' }));
    const second = mirror.accounted(answered('s2', { output: 'second, by u1' }));
    await new Promise((r) => setTimeout(r, 0));
    // While the first send is stalled, u1 signs out and u2 signs in.
    api.status.mockResolvedValue(as('u2'));
    release();
    await first; await second;
    expect(api.appendTurn.mock.calls.map((c) => (c[1] as { assistant: { content: string } }).assistant.content)).toEqual(['first']);
    expect(api.recordRunSpend).not.toHaveBeenCalled();
  });

  it('does not send a queued run once syncing was turned off before it ended', async () => {
    let off = false;
    const api = {
      status: vi.fn().mockResolvedValue(as('u1')),
      createConversation: vi.fn().mockResolvedValue({ ok: true, conversation: { id: 'c1' } }),
      appendTurn: vi.fn().mockResolvedValue({ ok: true }),
      recordRunSpend: vi.fn().mockResolvedValue({ ok: true }),
    };
    const mirror = new CloudMirror(() => api, () => off, links());
    off = true;
    const queued = mirror.accounted(answered('s1'));
    off = false;
    await queued;
    expect(api.appendTurn).not.toHaveBeenCalled();
  });

  it('keeps the chat link when spend alone fails without a 404, and resends to it once', async () => {
    const chats = links([['https://cloud|u1|s1', 'live-chat']]);
    const { api, mirror } = setup(false, chats);
    api.recordRunSpend.mockResolvedValueOnce({ ok: false, error: 'socket hang up' }).mockResolvedValue({ ok: true });
    await mirror.accounted({ sessionId: 's1', outcome: 'failed', cloud: accounting });
    const calls = api.recordRunSpend.mock.calls.map((c) => c[0] as { conversationId: string | null; runId: string });
    expect(calls.map((c) => c.conversationId)).toEqual(['live-chat', 'live-chat']);
    expect(calls[1]!.runId).toBe(calls[0]!.runId);
    // The session's next answered turn still goes to the same chat.
    await mirror.accounted(answered('s1'));
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.appendTurn).toHaveBeenCalledWith('live-chat', expect.anything());
  });

  it('sends nothing while signed out', async () => {
    const { api, mirror } = setup();
    api.status.mockResolvedValue({ signedIn: false, user: null, serverUrl: 'https://cloud' });
    await mirror.accounted(answered('s1'));
    expect(api.appendTurn).not.toHaveBeenCalled();
    expect(api.recordRunSpend).not.toHaveBeenCalled();
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
    on.api.appendTurn.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    await expect(on.mirror.accounted(answered('s1'))).resolves.toBeUndefined();
    // A failure does not stop the next run from being sent.
    await on.mirror.accounted(answered('s1', { output: 'next' }));
    expect(on.api.appendTurn).toHaveBeenLastCalledWith('c1', expect.objectContaining({ assistant: expect.objectContaining({ content: 'next' }) }));
  });
});
