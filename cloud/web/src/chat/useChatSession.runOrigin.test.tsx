// ─────────────────────────────────────────────
//  Cascade Cloud — which run an ending is for
// ─────────────────────────────────────────────
//
//  Its own file because of the mocks. The on-device classifier makes `emitRun`
//  run a TURN LATER than `runChat`, and that gap is the whole subject here —
//  reproducing it needs `localModelEnabled`, the capability probe and the
//  classifier itself replaced, which the other suites must not inherit.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useChatSession } from './useChatSession.js';

vi.mock('../lib/api.js', () => ({
  getMessages: vi.fn(async () => ({ messages: [] })),
  fetchFeedback: vi.fn(async () => ({ feedback: {} })),
  selectBranch: vi.fn(async () => ({ messages: [] })),
  deleteMessage: vi.fn(async () => ({ messages: [] })),
}));

vi.mock('../lib/prefs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/prefs.js')>()),
  // The opt-in that puts a classifier call in front of the emit.
  localModelEnabled: () => true,
}));

vi.mock('../lib/localModel/capability.js', () => ({
  detectLocalModelCapability: () => ({ supported: true }),
}));

vi.mock('../lib/localModel/engine.js', () => ({ warmLocalModel: vi.fn() }));

/** The classifier, held open so a test can navigate while it is pending. */
let releaseClassifier: ((hint: string | null) => void) | undefined;
vi.mock('../lib/localModel/classifier.js', () => ({
  classifyLocalComplexity: vi.fn(() => new Promise((resolve) => { releaseClassifier = resolve as (h: string | null) => void; })),
}));

function fakeSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const sent: Array<{ event: string; payload: unknown }> = [];
  const runAcks: Array<(a: unknown) => void> = [];
  const socket = {
    on(event: string, listener: (...args: unknown[]) => void) {
      let set = handlers.get(event);
      if (!set) { set = new Set(); handlers.set(event, set); }
      set.add(listener);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) { handlers.get(event)?.delete(listener); return this; },
    connected: false,
    connect() { socket.connected = true; return this; },
    emit(event: string, payload: unknown, ack?: (a: unknown) => void) {
      sent.push({ event, payload });
      if (event === 'chat:run' && ack) runAcks.push(ack);
      return this;
    },
  };
  return {
    sent,
    /** The run failed, on an ack that carries no conversation id at all. */
    failRun(error = 'the run failed') { runAcks.shift()?.({ error }); },
    /** And the ordinary ending, so a test can get a second send past `busy`. */
    ackRun(conversationId: string) { runAcks.shift()?.({ conversationId, output: 'done' }); },
    fire(event: string, payload?: unknown) { for (const h of [...(handlers.get(event) ?? [])]) h(payload); },
    socket: socket as unknown as Socket,
  };
}

beforeEach(() => { vi.clearAllMocks(); releaseClassifier = undefined; });

describe('an ending names the run that was sent', () => {
  it('records the origin of the run actually emitted, not the chat opened while it was queued', async () => {
    // The origin moved to immediately before `socket.emit` so a locally refused
    // send could not leave one behind — and that move put it on the far side of
    // the classifier await. `runChat` captures the payload for A; the emit can
    // happen a turn later, and reading the LIVE ref there recorded whatever
    // chat the user had opened in the meantime.
    //
    // Then an error ack — which carries no conversation id — settled B's gates
    // and left A's standing, which is the bug the origin was introduced to fix,
    // arriving through the delay instead of through navigation.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'convo-A'));

    act(() => { void view.result.current.send({ prompt: 'refactor the parser' }); });
    expect(fake.sent.filter((m) => m.event === 'chat:run'), 'still classifying, nothing sent').toEqual([]);

    // The user opens another chat while the classifier is still thinking.
    act(() => { view.result.current.setConversationId('convo-B'); });

    // Classification lands, and the run finally goes out — for A.
    await act(async () => { releaseClassifier?.(null); await Promise.resolve(); });
    const payload = fake.sent.find((m) => m.event === 'chat:run')?.payload as Record<string, unknown>;
    expect(payload?.['conversationId'], 'the run on the wire is A’s').toBe('convo-A');

    act(() => {
      fake.fire('escalation:decision-required', {
        conversationId: 'convo-A', requestId: 'e1', sectionId: 's1', issues: [], timeoutMs: 300_000,
      });
      fake.fire('escalation:decision-required', {
        conversationId: 'convo-B', requestId: 'e2', sectionId: 's2', issues: [], timeoutMs: 300_000,
      });
    });
    act(() => { fake.failRun(); });

    expect(view.result.current.escalations.map((e) => e.requestId), 'B is untouched').toEqual(['e2']);
    act(() => { view.result.current.setConversationId('convo-A'); });
    expect(view.result.current.escalations, 'the run that was sent is the one settled').toEqual([]);
  });

  it('does not emit a send the reconnect already settled', async () => {
    // There is a window where `busy` is true and NOTHING has been emitted: the
    // classifier runs first, and the emit is its continuation. A reconnect in
    // that window correctly reports `active: 0` — the server really does have
    // no run — so the pane clears `busy`, and the continuation then started the
    // run anyway. A live run with no Stop state, and a composer free to start
    // a second one on top of it.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'convo-A'));

    act(() => { void view.result.current.send({ prompt: 'refactor the parser' }); });
    expect(view.result.current.busy, 'waiting on the classifier').toBe(true);
    expect(fake.sent.filter((m) => m.event === 'chat:run'), 'nothing on the wire yet').toEqual([]);

    // The socket comes back and the server has no run for this pane.
    act(() => { fake.fire('run:resumed', { active: 0, finished: [] }); });
    expect(view.result.current.busy, 'the pane is idle').toBe(false);

    // The classifier finally answers. The send is over and must stay over.
    await act(async () => { releaseClassifier?.(null); await Promise.resolve(); });

    expect(fake.sent.filter((m) => m.event === 'chat:run'), 'the cancelled send stayed cancelled').toEqual([]);
    expect(view.result.current.busy, 'and the composer is still free').toBe(false);
  });

  it('cancels a send Stop reached before the wire did', async () => {
    // The same window through the other door, and not reported: with nothing
    // emitted there is no run for the server to abort and no ack coming back,
    // so `chat:stop` would go into the void and the composer would sit disabled
    // until the continuation started the very run the user asked not to happen.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'convo-A'));

    act(() => { void view.result.current.send({ prompt: 'refactor the parser' }); });
    act(() => { view.result.current.stop(); });

    expect(view.result.current.busy, 'stopped immediately, with nothing to wait for').toBe(false);
    expect(fake.sent.filter((m) => m.event === 'chat:stop'), 'and nothing was asked to abort').toEqual([]);

    await act(async () => { releaseClassifier?.(null); await Promise.resolve(); });
    expect(fake.sent.filter((m) => m.event === 'chat:run'), 'the run never happened').toEqual([]);
  });

  it('takes the unsent turn back off screen when the send is cancelled', async () => {
    // `runChat` shows the user's turn before the classifier is consulted, so
    // cancelling left it standing for a `chat:run` that never went out — an
    // unsent message visible indefinitely, with nothing to remove it.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'convo-A'));

    act(() => { void view.result.current.send({ prompt: 'refactor the parser' }); });
    expect(view.result.current.messages.map((m) => m.content), 'shown optimistically').toEqual(['refactor the parser']);

    act(() => { view.result.current.stop(); });

    expect(view.result.current.messages, 'and taken back when it is cancelled').toEqual([]);
    await act(async () => { releaseClassifier?.(null); await Promise.resolve(); });
    expect(view.result.current.messages, 'and it stays gone').toEqual([]);
  });

  it('does not restore one chat\'s snapshot into another chat', async () => {
    // The rollback and the chat it belongs to are two things, and cancellation
    // knew only the first. The classifier runs for a while — that is the whole
    // reason this cancellation is deferred — which is time enough to open
    // another chat, and the pre-send snapshot was then written over WHATEVER
    // was on screen. B's loaded transcript replaced by A's, standing until
    // another reload.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'convo-A'));

    // A turn lands in A, so there is a snapshot worth mis-restoring.
    act(() => { void view.result.current.send({ prompt: 'first' }); });
    await act(async () => { releaseClassifier?.(null); await Promise.resolve(); });
    act(() => { fake.ackRun('convo-A'); });

    // A second send in A, then the user opens B while it is still classifying.
    act(() => { void view.result.current.send({ prompt: 'second' }); });
    act(() => { view.result.current.setConversationId('convo-B'); });
    // Let B's own transcript land, so what is on screen is genuinely B's and
    // not A's optimistic turn still waiting to be replaced.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(view.result.current.messages, 'B, freshly loaded').toEqual([]);

    act(() => { view.result.current.stop(); });

    expect(
      view.result.current.messages,
      'B is left exactly as it was — A\'s rollback is not B\'s business',
    ).toEqual([]);
    await act(async () => { releaseClassifier?.(null); await Promise.resolve(); });
    expect(fake.sent.filter((m) => m.event === 'chat:run'), 'and the cancelled send stayed cancelled').toHaveLength(1);
  });

  it('stops expecting a first-turn id once the send is cancelled', async () => {
    // Cancellation put the transcript back and left the ROUTING state alone.
    // `awaitingFirstTurnRef` stayed armed from `runChat`, so the blank pane was
    // still willing to adopt — and the next event naming a conversation, from a
    // background or inherited run this pane never started, claimed it. That
    // run's browser panel and approval prompts then rendered in a chat the user
    // had never opened.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    expect(view.result.current.conversationId, 'a blank pane').toBeUndefined();

    act(() => { void view.result.current.send({ prompt: 'refactor the parser' }); });
    act(() => { view.result.current.stop(); });

    // Somebody else's run says its name. The pane must not take it.
    act(() => {
      fake.fire('escalation:decision-required', {
        conversationId: 'convo-elsewhere', requestId: 'e1', sectionId: 's1', issues: [], timeoutMs: 300_000,
      });
    });

    expect(view.result.current.conversationId, 'the pane claimed nothing').toBeUndefined();
    expect(
      view.result.current.escalations,
      'and is not showing a run it never started',
    ).toEqual([]);
  });

  it('disarms adoption when the encoded payload is refused too', async () => {
    // The third door onto the same cancellation, and the one that had its own
    // copy of half the rule. A prompt of backslashes passes the raw byte check
    // and fails the encoded one — JSON escaping nearly doubles it — so the
    // refusal happens after the optimistic turn is on screen and after
    // adoption is armed. It restored the transcript and left the routing state
    // armed, which is the same stranded blank pane, reached by a path Stop and
    // the reconnect never touch.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    // Under the 1.9 MB raw ceiling, over it once encoded.
    act(() => { void view.result.current.send({ prompt: '\\'.repeat(1_000_000) }); });
    await act(async () => { releaseClassifier?.(null); await Promise.resolve(); });

    expect(fake.sent.filter((m) => m.event === 'chat:run'), 'refused before the wire').toEqual([]);
    expect(view.result.current.error, 'and said so').toBeTruthy();

    act(() => {
      fake.fire('escalation:decision-required', {
        conversationId: 'convo-elsewhere', requestId: 'e1', sectionId: 's1', issues: [], timeoutMs: 300_000,
      });
    });

    expect(view.result.current.conversationId, 'the pane claimed nothing').toBeUndefined();
    expect(view.result.current.escalations, 'and shows no run it never started').toEqual([]);
  });

  it('cancels a pending send rather than stacking it on an inherited run', async () => {
    // The successor of a tab collision is told `active: 0`, starts a send, and
    // while its classifier is thinking the incumbent drops and hands over its
    // live run. The `active: 0` cancellation was already handled; this is the
    // same window with `active > 0`, and it was not.
    //
    // Left alone the continuation emits a SECOND run, which overwrites the
    // inherited run's origin so nothing will ever end it — and on a plan that
    // allows one run at a time the second is refused outright, whose ack frees
    // the composer over a run that is still going.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'convo-A'));

    act(() => { void view.result.current.send({ prompt: 'refactor the parser' }); });
    expect(fake.sent.filter((m) => m.event === 'chat:run'), 'still classifying').toEqual([]);

    // The incumbent's run arrives instead.
    act(() => { fake.fire('run:resumed', { active: 1, active_conversations: ['convo-B'] }); });

    await act(async () => { releaseClassifier?.(null); await Promise.resolve(); });

    expect(fake.sent.filter((m) => m.event === 'chat:run'), 'no second run was stacked on it').toEqual([]);
    expect(view.result.current.busy, 'and the pane is busy for the run it inherited').toBe(true);

    // The inherited run ends by name, and that is what frees the composer.
    act(() => { fake.fire('session:complete', { conversationId: 'convo-B' }); });
    expect(view.result.current.busy, 'the inherited run kept its origin').toBe(false);
  });

  it('restores the transcript a cancelled reconnect send had truncated', async () => {
    // The worse half of the same bug. An edit or a regenerate TRUNCATES the
    // branch before sending, so cancelling one left the conversation visibly
    // shortened until a reload — messages the user still had, hidden on the
    // strength of a run that never happened.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'convo-A'));

    // Two turns on screen, then an edit of the first — which truncates.
    act(() => { void view.result.current.send({ prompt: 'first' }); });
    await act(async () => { releaseClassifier?.(null); await Promise.resolve(); });
    act(() => { fake.fire('stream:token', { conversationId: 'convo-A', text: 'an answer' }); });
    const before = view.result.current.messages.length;
    expect(before, 'a turn and its streaming reply').toBeGreaterThan(1);

    act(() => { fake.fire('run:resumed', { active: 0, finished: [] }); });
    expect(view.result.current.busy).toBe(false);
    act(() => { void view.result.current.send({ prompt: 'second' }); });
    act(() => { fake.fire('run:resumed', { active: 0, finished: [] }); });

    expect(
      view.result.current.messages.map((m) => m.content),
      'the pre-send transcript is back, without the unsent turn',
    ).not.toContain('second');
  });
});
