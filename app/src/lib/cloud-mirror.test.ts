import { describe, expect, it, vi } from 'vitest';
import { CloudMirror, mirrorAndConfirm, type ChatLinks } from './cloud-mirror.js';

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
    expect(api.createConversation).toHaveBeenCalledWith('from the cockpit', expect.anything());
    expect(api.appendTurn).toHaveBeenCalledWith('c1', { userContent: 'from the cockpit', runId: expect.any(String), assistant: { content: 'answer', ...accounting } }, expect.anything());
    expect(api.recordRunSpend).not.toHaveBeenCalled();
  });

  it('records a stopped run, and an empty answer, as spend only, with no chat made for them', async () => {
    const { api, mirror } = setup();
    await mirror.accounted({ sessionId: 's1', prompt: 'q', output: '', outcome: 'stopped', copyTurn: true, cloud: accounting });
    await mirror.accounted({ sessionId: 's2', prompt: 'q', output: '', outcome: 'answered', copyTurn: true, cloud: accounting });
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.recordRunSpend).toHaveBeenNthCalledWith(1, { conversationId: null, outcome: 'stopped', runId: expect.any(String), ...accounting }, { userId: 'u1', serverUrl: 'https://cloud' });
    expect(api.recordRunSpend).toHaveBeenNthCalledWith(2, { conversationId: null, outcome: 'answered', runId: expect.any(String), ...accounting }, { userId: 'u1', serverUrl: 'https://cloud' });
  });

  it('copies what a stopped run had written, marked as stopped', async () => {
    const { api, mirror } = setup();
    await mirror.accounted(answered('s1', { output: 'half an ans', outcome: 'stopped' }));
    expect(api.appendTurn).toHaveBeenCalledWith('c1', { userContent: 'q', runId: expect.any(String), outcome: 'stopped', assistant: { content: 'half an ans', ...accounting } }, expect.anything());
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
    expect(api.recordRunSpend).toHaveBeenCalledWith({ conversationId: null, outcome: 'answered', runId: expect.any(String), ...accounting }, expect.anything());
  });

  it('records a failed run against the chat already copied', async () => {
    const { api, mirror } = setup();
    await mirror.accounted(answered('s1'));
    await mirror.accounted({ sessionId: 's1', outcome: 'failed', cloud: accounting });
    expect(api.recordRunSpend).toHaveBeenCalledWith({ conversationId: 'c1', outcome: 'failed', runId: expect.any(String), ...accounting }, expect.anything());
  });

  it('continues the same cloud chat after a restart', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'kept-chat']]));
    await mirror.accounted(answered('s1'));
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.appendTurn).toHaveBeenCalledWith('kept-chat', expect.anything(), expect.anything());
  });

  it('starts a new chat for a session when another account signs in', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'chat-of-u1']]));
    api.status.mockResolvedValue(as('u2'));
    api.createConversation.mockResolvedValue({ ok: true, conversation: { id: 'chat-of-u2' } });
    await mirror.accounted(answered('s1'));
    expect(api.appendTurn).toHaveBeenCalledTimes(1);
    expect(api.appendTurn).toHaveBeenCalledWith('chat-of-u2', expect.anything(), expect.anything());
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
    expect(api.recordRunSpend).toHaveBeenCalledWith({ conversationId: 'chat', outcome: 'answered', runId: turnId, ...accounting }, expect.anything());
    // The link is kept for the next run.
    api.appendTurn.mockResolvedValue({ ok: true });
    await mirror.accounted(answered('s1', { output: 'next' }));
    expect(api.appendTurn).toHaveBeenLastCalledWith('chat', expect.anything(), expect.anything());
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
    expect(api.appendTurn).toHaveBeenCalledWith('live-chat', expect.anything(), expect.anything());
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
    // The turn could not be copied: its cost was counted on its own, and the
    // report is kept so the turn is copied when it is replayed.
    await expect(on.mirror.accounted(answered('s1'))).resolves.toBe('retry');
    expect(on.api.recordRunSpend).toHaveBeenCalledTimes(1);
    // A failure does not stop the next run from being sent.
    await on.mirror.accounted(answered('s1', { output: 'next' }));
    expect(on.api.appendTurn).toHaveBeenLastCalledWith('c1', expect.objectContaining({ assistant: expect.objectContaining({ content: 'next' }) }), expect.anything());
  });
});

describe('which reports are confirmed to the backend', () => {
  const failing = { ok: false, error: 'Cloud request failed (502)' };

  it('none whose upload failed: both turn attempts and both spend attempts', async () => {
    const { api, mirror } = setup();
    api.appendTurn.mockResolvedValue(failing);
    api.recordRunSpend.mockResolvedValue(failing);
    const confirm = vi.fn();
    await expect(mirrorAndConfirm(mirror, answered('s1', { id: 'run-0001' }), confirm)).resolves.toBe('retry');
    expect(api.appendTurn).toHaveBeenCalledTimes(2);
    expect(api.recordRunSpend).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('none when the cloud is unreachable, the bridge throws, or who is signed in cannot be read', async () => {
    const offline = setup();
    offline.api.recordRunSpend.mockRejectedValue(new Error('offline'));
    const confirm = vi.fn();
    await expect(mirrorAndConfirm(offline.mirror, { id: 'run-0002', sessionId: 's1', outcome: 'failed', cloud: accounting }, confirm)).resolves.toBe('retry');
    const throwing = setup();
    throwing.api.createConversation.mockRejectedValue(new Error('bridge gone'));
    await expect(mirrorAndConfirm(throwing.mirror, answered('s1', { id: 'run-0003' }), confirm)).resolves.toBe('retry');
    const unknown = setup();
    unknown.api.status.mockRejectedValue(new Error('ipc failed'));
    await expect(mirrorAndConfirm(unknown.mirror, answered('s1', { id: 'run-0004' }), confirm)).resolves.toBe('retry');
    expect(unknown.api.appendTurn).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('none when a gone chat\'s cost could not be counted on its own either', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'gone-chat']]));
    api.recordRunSpend.mockResolvedValueOnce({ ok: false, error: 'Not found (404)' }).mockResolvedValue(failing);
    const confirm = vi.fn();
    await expect(mirrorAndConfirm(mirror, { id: 'run-0005', sessionId: 's1', outcome: 'failed', cloud: accounting }, confirm)).resolves.toBe('retry');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a delivered report, and one skipped on purpose (opted out, signed out, nothing to send)', async () => {
    const confirm = vi.fn();
    await expect(mirrorAndConfirm(setup().mirror, answered('s1', { id: 'run-0006' }), confirm)).resolves.toBe('delivered');
    await expect(mirrorAndConfirm(setup(true).mirror, answered('s1', { id: 'run-0007' }), confirm)).resolves.toBe('skipped');
    const out = setup();
    out.api.status.mockResolvedValue({ signedIn: false, user: null, serverUrl: 'https://cloud' });
    await expect(mirrorAndConfirm(out.mirror, answered('s1', { id: 'run-0008' }), confirm)).resolves.toBe('skipped');
    await expect(mirrorAndConfirm(setup().mirror, { id: 'run-0009', sessionId: 's1', outcome: 'failed' }, confirm)).resolves.toBe('skipped');
    expect(confirm.mock.calls.map((c) => c[0])).toEqual(['run-0006', 'run-0007', 'run-0008', 'run-0009']);
  });

  it('a report the cloud refuses for good, once, so it is not resent on every connect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api, mirror } = setup();
    // A 400, as /usage/runs gives a report whose /why is too long.
    api.recordRunSpend.mockResolvedValue({ ok: false, error: 'Request failed (400).' });
    const confirm = vi.fn();
    await expect(mirrorAndConfirm(mirror, { id: 'run-0012', sessionId: 's1', outcome: 'failed', cloud: accounting }, confirm)).resolves.toBe('rejected');
    expect(api.recordRunSpend).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('run-0012');
    warn.mockRestore();
  });

  it('none whose sign-in needs renewing, or that was rate limited', async () => {
    const confirm = vi.fn();
    for (const error of ['Request failed (401).', 'Request failed (429).', 'Request failed (408).']) {
      const { api, mirror } = setup();
      api.recordRunSpend.mockResolvedValue({ ok: false, error });
      await expect(mirrorAndConfirm(mirror, { id: 'run-0013', sessionId: 's1', outcome: 'failed', cloud: accounting }, confirm)).resolves.toBe('retry');
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('none whose turn was not copied, though its cost was counted; the replay copies it once', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'chat']]));
    api.appendTurn.mockResolvedValue(failing);
    const confirm = vi.fn();
    const report = answered('s1', { id: 'run-0014' });
    await expect(mirrorAndConfirm(mirror, report, confirm)).resolves.toBe('retry');
    // The cost is counted now, under the run's id.
    expect(api.recordRunSpend).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'chat', runId: 'run-0014' }), expect.anything());
    expect(confirm).not.toHaveBeenCalled();
    // Replayed on the next connect, with the cloud back: the turn goes to the same chat, same id.
    api.appendTurn.mockResolvedValue({ ok: true });
    await expect(mirrorAndConfirm(mirror, report, confirm)).resolves.toBe('delivered');
    expect(api.appendTurn).toHaveBeenLastCalledWith('chat', expect.objectContaining({ runId: 'run-0014' }), expect.anything());
    expect(confirm).toHaveBeenCalledWith('run-0014');
  });

  it('a turn refused for good is not retried, once its cost is counted', async () => {
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'chat']]));
    api.appendTurn.mockResolvedValue({ ok: false, error: 'Request failed (413).' });
    const confirm = vi.fn();
    await expect(mirrorAndConfirm(mirror, answered('s1', { id: 'run-0015' }), confirm)).resolves.toBe('delivered');
    expect(api.appendTurn).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('run-0015');
  });

  it('sends a report only to the account the backend stamped as the run ended', async () => {
    const confirm = vi.fn();
    const stampedU1 = { userId: 'u1', serverUrl: 'https://cloud' };
    // u2 is signed in now: u1's run is skipped, not uploaded into u2's account.
    const now2 = setup();
    now2.api.status.mockResolvedValue(as('u2'));
    await expect(mirrorAndConfirm(now2.mirror, answered('s1', { id: 'run-0112', account: stampedU1 }), confirm)).resolves.toBe('skipped');
    expect(now2.api.createConversation).not.toHaveBeenCalled();
    expect(now2.api.recordRunSpend).not.toHaveBeenCalled();
    // The same account on another server is another account.
    const elsewhere = setup();
    await expect(mirrorAndConfirm(elsewhere.mirror, answered('s1', { id: 'run-0113', account: { userId: 'u1', serverUrl: 'https://other' } }), confirm)).resolves.toBe('skipped');
    // Signed out when it ended: nothing goes, whoever is signed in now.
    const out = setup();
    await expect(mirrorAndConfirm(out.mirror, answered('s1', { id: 'run-0114', account: null }), confirm)).resolves.toBe('skipped');
    expect(out.api.appendTurn).not.toHaveBeenCalled();
    // Still u1: sent, into u1's chat for the session.
    const chats = links([['https://cloud|u1|s1', 'u1-chat']]);
    const same = setup(false, chats);
    await expect(mirrorAndConfirm(same.mirror, answered('s1', { id: 'run-0115', account: stampedU1 }), confirm)).resolves.toBe('delivered');
    expect(same.api.appendTurn).toHaveBeenCalledWith('u1-chat', expect.anything(), expect.anything());
  });

  it('stops, sending nothing more, when another account signs in part-way through', async () => {
    // Like the main process: a request meant for another account than the one signed in is refused.
    let current = 'u1';
    const check = (account?: { userId: string }) => (account && account.userId !== current ? { ok: false, accountChanged: true } : null);
    const { api, mirror } = setup(false, links([['https://cloud|u1|s1', 'u1-chat']]));
    api.appendTurn.mockImplementation(async (_chat: string, _turn: unknown, account?: { userId: string }) => {
      const refused = check(account);
      if (refused) return refused;
      // u1 signs out and u2 signs in while this request is out; it then answers 404.
      current = 'u2';
      return { ok: false, error: 'Request failed (404).' };
    });
    api.createConversation.mockImplementation(async (_t?: string, account?: { userId: string }) => check(account) ?? { ok: true, conversation: { id: 'u2-chat' } });
    api.recordRunSpend.mockImplementation(async (_r: unknown, account?: { userId: string }) => check(account) ?? { ok: true });
    const confirm = vi.fn();
    const stamped = { userId: 'u1', serverUrl: 'https://cloud' };
    await expect(mirrorAndConfirm(mirror, answered('s1', { id: 'run-0016', account: stamped }), confirm)).resolves.toBe('skipped');
    // Every request named u1; the replacement chat was refused, and nothing reached u2.
    expect(api.appendTurn.mock.calls.map((c) => c[2])).toEqual([stamped]);
    expect(api.createConversation.mock.calls.map((c) => c[1])).toEqual([stamped]);
    expect(api.recordRunSpend).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith('run-0016');
    // The spend-only path stops the same way.
    current = 'u2';
    const spend = setup();
    spend.api.status.mockResolvedValue(as('u1'));
    spend.api.recordRunSpend.mockImplementation(async (_r: unknown, account?: { userId: string }) => { const r = check(account); current = 'u1'; return r ?? { ok: true }; });
    spend.api.status.mockResolvedValueOnce(as('u1')).mockResolvedValueOnce(as('u1'));
    await expect(mirrorAndConfirm(spend.mirror, { id: 'run-0017', sessionId: 's1', outcome: 'failed', cloud: accounting, account: stamped }, confirm)).resolves.toBe('skipped');
    expect(spend.api.recordRunSpend).toHaveBeenCalledTimes(1);
  });

  it('a failure does not hold up the runs queued behind it', async () => {
    const { api, mirror } = setup();
    api.recordRunSpend.mockResolvedValueOnce(failing).mockResolvedValueOnce(failing);
    const first = mirror.accounted({ id: 'run-0010', sessionId: 's1', outcome: 'failed', cloud: accounting });
    const second = mirror.accounted({ id: 'run-0011', sessionId: 's1', outcome: 'failed', cloud: accounting });
    expect([await first, await second]).toEqual(['retry', 'delivered']);
  });
});
