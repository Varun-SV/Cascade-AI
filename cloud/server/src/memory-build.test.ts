import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { CloudStore } from './db.js';
import { acceptMemories, attachMemoryBuild, buildChatRows, buildMemories, chatsForMemory, estimateFor } from './memory-build.js';

const PROVIDERS = [{ type: 'anthropic', apiKey: 'sk-test' }];
const LONG = 'I am a backend engineer in Lisbon and I write most of my services in Go these days, mostly for a payments team that ships every week';

describe('memory build (server)', () => {
  let dir: string;
  let store: CloudStore;
  let mine: string;
  let short: string;
  let theirs: string;
  let users: { u1: string; u2: string };
  const U = (k: 'u1' | 'u2') => users[k];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-memory-build-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    const u1 = store.upsertUser({ provider: 'github', providerId: '1', email: null, name: null, avatar: null }).id;
    const u2 = store.upsertUser({ provider: 'github', providerId: '2', email: null, name: null, avatar: null }).id;
    users = { u1, u2 };
    mine = store.importConversation(U('u1'), 'Go services', null, [
      { role: 'user', content: LONG }, { role: 'assistant', content: 'Noted.' },
    ]).id;
    short = store.importConversation(U('u1'), 'hi', null, [{ role: 'user', content: 'hi' }]).id;
    theirs = store.importConversation(U('u2'), 'Other', null, [{ role: 'user', content: LONG }]).id;
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists only the person\'s own chats, with titles and counts and nothing that was said', () => {
    const rows = buildChatRows(store, U('u1'));
    expect(rows.map((r) => r.id).sort()).toEqual([mine, short].sort());
    expect(rows.find((r) => r.id === mine)).toMatchObject({ title: 'Go services', turns: 1, worth: true });
    expect(rows.find((r) => r.id === short)?.worth).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('Lisbon');
    // Asking for another person's chat by id finds nothing.
    expect(chatsForMemory(store, U('u1'), [theirs])).toEqual([]);
  });

  it('estimates the tokens, and a price only when the model has one', () => {
    const chats = chatsForMemory(store, U('u1'));
    const priced = estimateFor(chats, { getModelForTier: () => ({ id: 'm', name: 'm', inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015 }) as never });
    expect(priced.chats).toBe(1);
    expect(priced.model).toBe('m');
    expect(priced.costUsd).toBeGreaterThan(0);
    expect(estimateFor(chats, null)).toMatchObject({ chats: 1, model: null, costUsd: null });
  });

  it('builds from the chats worth reading, skips one that fails, and stops when cancelled', async () => {
    const chats = chatsForMemory(store, U('u1'));
    const progress: number[] = [];
    const out = await buildMemories({
      chats, existing: [], signal: new AbortController().signal,
      generate: async () => JSON.stringify([{ category: 'about-you', memory: 'Backend engineer in Lisbon', durable: true, quote: 'I am a backend engineer in Lisbon' }]),
      onProgress: (p) => progress.push(p.read),
    });
    expect(out).toMatchObject({ read: 1, total: 1, cancelled: false });
    expect(out.candidates).toEqual([expect.objectContaining({ category: 'about-you', content: 'Backend engineer in Lisbon', status: 'new' })]);
    expect(progress).toEqual([1]);

    const failing = await buildMemories({ chats, existing: [], signal: new AbortController().signal, generate: async () => { throw new Error('rate limited'); } });
    expect(failing).toMatchObject({ read: 1, candidates: [] });

    const stop = new AbortController();
    stop.abort();
    expect(await buildMemories({ chats, existing: [], signal: stop.signal, generate: async () => '[]' })).toMatchObject({ read: 0, cancelled: true });
  });

  it('saves what the person kept: new ones, and more evidence for one they have, but never evidence from someone else\'s chat', () => {
    const kept = store.addMemory(U('u1'), 'Writes Go', 'preferences', 'permanent');
    const ev = { conversationId: mine, quote: 'I write most of my services in Go', at: 1 };
    const { saved } = acceptMemories(store, U('u1'), { items: [
      { category: 'about-you', content: 'Backend engineer in Lisbon', durability: 'permanent', evidence: [ev] },
      { category: 'preferences', content: 'Writes most services in Go', durability: 'permanent', evidence: [ev], revises: kept.id },
      { category: 'facts', content: 'Stolen', durability: 'permanent', evidence: [{ conversationId: theirs, quote: 'x', at: 1 }] },
    ] });
    expect(saved.map((m) => m.content)).toEqual(['Backend engineer in Lisbon', 'Writes most services in Go']);
    const list = store.listMemories(U('u1'));
    expect(list).toHaveLength(2);
    const revised = list.find((m) => m.id === kept.id)!;
    expect(revised.revisions.map((r) => r.content)).toEqual(['Writes Go']);
    expect(revised.evidence).toEqual([ev]);
    expect(list.find((m) => m.content.startsWith('Backend'))).toMatchObject({ source: 'chats', category: 'about-you' });
    expect(() => acceptMemories(store, U('u1'), { items: [{ category: 'nonsense', content: 'x', durability: 'permanent', evidence: [ev] }] })).toThrow();
  });

  it('over the socket: estimates, builds with progress, records the spend, and allows one build at a time', async () => {
    const socket = new EventEmitter() as EventEmitter & { emitted: Array<[string, unknown]> };
    socket.emitted = [];
    const emit = socket.emit.bind(socket);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const fakeRouter = {
      getModelForTier: () => ({ id: 'm', name: 'm', inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015 }),
      generate: async () => {
        await held;
        return { content: JSON.stringify([{ category: 'projects', memory: 'Works on a payments team', durable: true, quote: 'mostly for a payments team' }]) };
      },
      getStats: () => ({ totalCostUsd: 0.01, totalTokens: 900, costByTierModel: { T3: { m: 0.01 } }, tokensByTierModel: { T3: { m: 900 } }, untrackedByTierModel: {} }),
    };
    const handle = attachMemoryBuild({
      on: (e, fn) => socket.on(e, fn),
      emit: (e, p) => { socket.emitted.push([e, p]); return true; },
    }, store, U('u1'), async () => fakeRouter as never);

    const call = (event: string, payload: unknown) => new Promise<any>((resolve) => { emit(event, payload, resolve); });
    expect(await call('memories:estimate', { providers: PROVIDERS, conversationIds: [mine, short] })).toMatchObject({ chats: 1, model: 'm' });
    expect(await call('memories:build', { providers: PROVIDERS, conversationIds: [] })).toHaveProperty('error');

    const first = call('memories:build', { providers: PROVIDERS, conversationIds: [mine] });
    await new Promise((r) => setTimeout(r, 5));
    expect(await call('memories:build', { providers: PROVIDERS, conversationIds: [mine] })).toEqual({ error: expect.stringMatching(/already running/) });
    release();
    const done = await first;
    expect(done).toMatchObject({ read: 1, total: 1, cancelled: false });
    expect(done.candidates[0]).toMatchObject({ category: 'projects', content: 'Works on a payments team' });
    expect(socket.emitted).toContainEqual(['memories:progress', { read: 1, total: 1, found: 1 }]);
    // Nothing is saved until the person keeps it; the build's cost is on their ledger.
    expect(store.listMemories(U('u1'))).toEqual([]);
    expect(store.spend.firstSpendAt(U('u1'))).toEqual(expect.any(Number));
    void handle;
  });
});
