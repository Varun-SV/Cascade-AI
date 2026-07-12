import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CloudStore } from './db.js';

describe('CloudStore', () => {
  let dir: string;
  let store: CloudStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-db-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a new user on first upsert and reuses it on subsequent logins', () => {
    const first = store.upsertUser({ provider: 'github', providerId: '123', email: 'a@b.com', name: 'A', avatar: null });
    const second = store.upsertUser({ provider: 'github', providerId: '123', email: 'a@b.com', name: 'A Updated', avatar: 'x.png' });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('A Updated');
    expect(second.avatar).toBe('x.png');
  });

  it('keeps github and google users with the same providerId separate', () => {
    const gh = store.upsertUser({ provider: 'github', providerId: 'same-id', email: null, name: null, avatar: null });
    const gg = store.upsertUser({ provider: 'google', providerId: 'same-id', email: null, name: null, avatar: null });
    expect(gh.id).not.toBe(gg.id);
  });

  it('defaults new users to the free plan', () => {
    const user = store.upsertUser({ provider: 'github', providerId: '1', email: null, name: null, avatar: null });
    expect(user.plan).toBe('free');
  });

  it('creates conversations scoped to a user and lists them newest-first', () => {
    const user = store.upsertUser({ provider: 'github', providerId: '1', email: null, name: null, avatar: null });
    const c1 = store.createConversation(user.id, 'First');
    const c2 = store.createConversation(user.id, 'Second');
    const list = store.listConversations(user.id);
    expect(list.map((c) => c.id)).toEqual([c2.id, c1.id]);
  });

  it('does not return another user\'s conversation via getConversation', () => {
    const alice = store.upsertUser({ provider: 'github', providerId: 'alice', email: null, name: null, avatar: null });
    const bob = store.upsertUser({ provider: 'github', providerId: 'bob', email: null, name: null, avatar: null });
    const conv = store.createConversation(alice.id, 'Alice convo');
    expect(store.getConversation(conv.id, bob.id)).toBeNull();
    expect(store.getConversation(conv.id, alice.id)?.id).toBe(conv.id);
  });

  it('adds messages and touches the parent conversation updated_at', async () => {
    const user = store.upsertUser({ provider: 'github', providerId: '1', email: null, name: null, avatar: null });
    const conv = store.createConversation(user.id);
    const before = store.getConversation(conv.id, user.id)!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    store.addMessage({ conversationId: conv.id, role: 'user', content: 'hi' });
    const msg = store.addMessage({ conversationId: conv.id, role: 'assistant', content: 'hello', model: 'gpt-5', costUsd: 0.01 });
    const after = store.getConversation(conv.id, user.id)!.updatedAt;

    expect(store.getMessages(conv.id).map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(msg.model).toBe('gpt-5');
    expect(msg.costUsd).toBe(0.01);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('increments per-day usage counters independently per user', () => {
    const alice = store.upsertUser({ provider: 'github', providerId: 'alice', email: null, name: null, avatar: null });
    const bob = store.upsertUser({ provider: 'github', providerId: 'bob', email: null, name: null, avatar: null });
    store.incrementUsage(alice.id, '2026-07-12');
    store.incrementUsage(alice.id, '2026-07-12');
    store.incrementUsage(bob.id, '2026-07-12');

    expect(store.getUsage(alice.id, '2026-07-12')).toBe(2);
    expect(store.getUsage(bob.id, '2026-07-12')).toBe(1);
    expect(store.getUsage(alice.id, '2026-07-13')).toBe(0);
  });
});
