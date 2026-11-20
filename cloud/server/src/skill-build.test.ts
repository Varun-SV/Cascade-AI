import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { CloudStore } from './db.js';
import { attachSkillBuild } from './skill-build.js';

const PROVIDERS = [{ type: 'anthropic', apiKey: 'sk-test' }];

function rig(store: CloudStore, userId: string, answer: (prompt: string) => { content: string; finishReason?: string } | Promise<never>) {
  const socket = new EventEmitter();
  const prompts: string[] = [];
  const router = {
    getModelForTier: () => ({ id: 'm', name: 'm', inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015 }),
    generate: async (_t: string, o: { messages: Array<{ content: string }> }) => { prompts.push(o.messages[0]!.content); return answer(o.messages[0]!.content); },
    getStats: () => ({ totalCostUsd: 0.01, totalTokens: 500, costByTierModel: { T3: { m: 0.01 } }, tokensByTierModel: { T3: { m: 500 } }, untrackedByTierModel: {} }),
  };
  attachSkillBuild({ on: (e, fn) => socket.on(e, fn) }, store, userId, async () => router as never);
  const call = (event: string, payload: unknown) => new Promise<any>((resolve) => { socket.emit(event, payload, resolve); });
  return { call, prompts, socket };
}

describe('skills written with a model\'s help (server)', () => {
  let dir: string;
  let store: CloudStore;
  let u1: string;
  let u2: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-skill-build-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    u1 = store.upsertUser({ provider: 'github', providerId: '1', email: null, name: null, avatar: null }).id;
    u2 = store.upsertUser({ provider: 'github', providerId: '2', email: null, name: null, avatar: null }).id;
  });
  afterEach(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });

  it('drafts a skill from what the person wants, saves nothing, and records the spend', async () => {
    const { call } = rig(store, u1, () => ({ content: '{"name":"PR security review","description":"Reviews diffs.","instructions":"You review PRs for security."}' }));
    expect(await call('skills:draft', { providers: PROVIDERS, want: 'review my PRs for security' }))
      .toEqual({ draft: { name: 'PR security review', description: 'Reviews diffs.', instructions: 'You review PRs for security.' } });
    expect(store.listUserSkills(u1)).toEqual([]);
    expect(store.spend.firstSpendAt(u1)).toEqual(expect.any(Number));
    expect(await call('skills:draft', { providers: PROVIDERS, want: 'x' })).toHaveProperty('error');
  });

  it('refines only the person\'s own skill, and returns it as it was beside the change', async () => {
    const skill = store.createUserSkill(u1, { name: 'Tutor', description: 'SQL', systemPrompt: 'You teach SQL.' });
    const { call, prompts } = rig(store, u1, () => ({ content: '{"name":"Tutor","description":"SQL","instructions":"You teach SQL, strictly."}' }));
    const out = await call('skills:refine', { providers: PROVIDERS, skillId: skill.id, change: 'be stricter' });
    expect(out).toEqual({ draft: { name: 'Tutor', description: 'SQL', instructions: 'You teach SQL, strictly.' }, before: { name: 'Tutor', description: 'SQL', instructions: 'You teach SQL.' } });
    expect(prompts[0]).toContain('You teach SQL.');
    // Not saved until the person saves it.
    expect(store.getUserSkill(skill.id, u1)?.systemPrompt).toBe('You teach SQL.');
    const other = rig(store, u2, () => ({ content: '{}' }));
    expect(await other.call('skills:refine', { providers: PROVIDERS, skillId: skill.id, change: 'be stricter' })).toEqual({ error: 'That skill was not found.' });
  });

  it('suggests skills from the person\'s own chats only, each naming the chats it came from', async () => {
    const a = store.importConversation(u1, 'PR review 1', null, [{ role: 'user', content: 'review this PR for SQL injection' }]).id;
    const b = store.importConversation(u1, 'PR review 2', null, [{ role: 'user', content: 'check this diff for XSS' }]).id;
    const theirs = store.importConversation(u2, 'Theirs', null, [{ role: 'user', content: 'private words' }]).id;
    const { call, prompts } = rig(store, u1, () => ({ content: JSON.stringify([
      { name: 'PR security review', description: 'd', instructions: 'You review PRs.', why: 'Asked twice', chats: [a, b] },
      { name: 'Ghost', description: 'd', instructions: 'x', why: 'w', chats: [a, theirs] },
    ]) }));
    const out = await call('skills:suggest', { providers: PROVIDERS, conversationIds: [a, b, theirs] });
    expect(out.suggestions).toEqual([expect.objectContaining({ name: 'PR security review', chats: [{ id: a, title: 'PR review 1' }, { id: b, title: 'PR review 2' }] })]);
    expect(prompts[0]).not.toContain('private words');
    const est = await call('skills:suggest-estimate', { providers: PROVIDERS, conversationIds: [a, b] });
    expect(est).toMatchObject({ chats: 2, model: 'm', costUsd: expect.any(Number) });
  });

  it('reports a rejected key, or a cut-off answer, rather than an empty result; one job at a time', async () => {
    const refused = rig(store, u1, async () => { throw new Error('401 invalid x-api-key'); });
    expect(await refused.call('skills:draft', { providers: PROVIDERS, want: 'a tutor' })).toEqual({ error: expect.stringMatching(/refused the request/) });
    const cut = rig(store, u1, () => ({ content: '{"name":"T', finishReason: 'length' }));
    expect(await cut.call('skills:draft', { providers: PROVIDERS, want: 'a tutor' })).toEqual({ error: expect.stringMatching(/returned an error/) });

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const slow = rig(store, u1, async () => { await held; return { content: '{"name":"T","instructions":"x"}' } as never; });
    const first = slow.call('skills:draft', { providers: PROVIDERS, want: 'a tutor' });
    await new Promise((r) => setTimeout(r, 5));
    expect(await slow.call('skills:draft', { providers: PROVIDERS, want: 'another' })).toEqual({ error: expect.stringMatching(/Another skill is being written/) });
    release();
    expect(await first).toHaveProperty('draft');
  });

  it('stops when cancelled', async () => {
    let seen: AbortSignal | undefined;
    const socket = new EventEmitter();
    const router = {
      getModelForTier: () => undefined,
      generate: (_t: string, o: { signal: AbortSignal }) => new Promise((_, rej) => { seen = o.signal; o.signal.addEventListener('abort', () => rej(new Error('aborted'))); }),
      getStats: () => ({ totalCostUsd: 0, totalTokens: 0, costByTierModel: {}, tokensByTierModel: {}, untrackedByTierModel: {} }),
    };
    attachSkillBuild({ on: (e, fn) => socket.on(e, fn) }, store, u1, async () => router as never);
    const p = new Promise<any>((resolve) => { socket.emit('skills:draft', { providers: PROVIDERS, want: 'a tutor' }, resolve); });
    await new Promise((r) => setTimeout(r, 5));
    socket.emit('skills:cancel');
    expect(await p).toEqual({ cancelled: true });
    expect(seen?.aborted).toBe(true);
  });
});
