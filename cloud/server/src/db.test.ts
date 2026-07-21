import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
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

  it('stores, versions, and scopes the E2E key-sync envelope per user', () => {
    const alice = store.upsertUser({ provider: 'github', providerId: 'alice', email: null, name: null, avatar: null });
    const bob = store.upsertUser({ provider: 'github', providerId: 'bob', email: null, name: null, avatar: null });

    expect(store.getUserSecrets(alice.id)).toBeNull();

    const first = store.putUserSecrets(alice.id, '{"ciphertext":"a","salt":"s","iv":"i"}');
    expect(first.version).toBe(1);
    const second = store.putUserSecrets(alice.id, '{"ciphertext":"b","salt":"s","iv":"i"}');
    expect(second.version).toBe(2); // replacing bumps the version

    const rec = store.getUserSecrets(alice.id)!;
    expect(rec.version).toBe(2);
    expect(JSON.parse(rec.blob).ciphertext).toBe('b');

    // Scoped per user; deleting one leaves the other.
    expect(store.getUserSecrets(bob.id)).toBeNull();
    expect(store.deleteUserSecrets(alice.id)).toBe(true);
    expect(store.getUserSecrets(alice.id)).toBeNull();
  });

  it('tracks Cascade Files per user with correct storage accounting', () => {
    const alice = store.upsertUser({ provider: 'github', providerId: 'fa', email: null, name: null, avatar: null });
    const bob = store.upsertUser({ provider: 'github', providerId: 'fb', email: null, name: null, avatar: null });

    const f1 = store.addFile({ userId: alice.id, name: 'a.md', mime: 'text/markdown', size: 100 });
    store.addFile({ userId: alice.id, name: 'b.txt', mime: 'text/plain', size: 250 });
    store.addFile({ userId: bob.id, name: 'c.md', mime: 'text/markdown', size: 999 });

    expect(store.sumUserFileBytes(alice.id)).toBe(350);
    expect(store.sumUserFileBytes(bob.id)).toBe(999);
    expect(store.listFiles(alice.id).map((f) => f.name)).toEqual(['b.txt', 'a.md']); // newest-first

    // Scoped delete frees only that user's quota; can't touch another user's file.
    expect(store.getFile(f1.id, bob.id)).toBeNull();
    expect(store.deleteFile(f1.id, alice.id)).toBe(true);
    expect(store.sumUserFileBytes(alice.id)).toBe(250);
  });

  it('deletes a conversation with its messages, owner-scoped', () => {
    const alice = store.upsertUser({ provider: 'dev', providerId: 'da', email: null, name: null, avatar: null });
    const bob = store.upsertUser({ provider: 'dev', providerId: 'db', email: null, name: null, avatar: null });
    const conv = store.createConversation(alice.id, 'Doomed');
    store.addMessage({ conversationId: conv.id, role: 'user', content: 'hi' });

    expect(store.deleteConversation(conv.id, bob.id)).toBe(false); // not the owner
    expect(store.deleteConversation(conv.id, alice.id)).toBe(true);
    expect(store.getConversation(conv.id, alice.id)).toBeNull();
    expect(store.getMessages(conv.id)).toHaveLength(0);
  });

  it('clears all conversations for one user without touching another user', () => {
    const alice = store.upsertUser({ provider: 'dev', providerId: 'ca', email: null, name: null, avatar: null });
    const bob = store.upsertUser({ provider: 'dev', providerId: 'cb', email: null, name: null, avatar: null });
    const a1 = store.createConversation(alice.id, 'A1');
    store.addMessage({ conversationId: a1.id, role: 'user', content: 'hi' });
    store.createConversation(alice.id, 'A2');
    const b1 = store.createConversation(bob.id, 'B1');

    expect(store.deleteAllConversations(alice.id)).toBe(2);
    expect(store.listConversations(alice.id)).toHaveLength(0);
    expect(store.getMessages(a1.id)).toHaveLength(0);
    // Bob's data is untouched.
    expect(store.getConversation(b1.id, bob.id)).not.toBeNull();
    expect(store.deleteAllConversations(alice.id)).toBe(0); // idempotent
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

  it('renames a conversation only for its owner and without bumping recency', () => {
    const alice = store.upsertUser({ provider: 'dev', providerId: 'ra', email: null, name: null, avatar: null });
    const bob = store.upsertUser({ provider: 'dev', providerId: 'rb', email: null, name: null, avatar: null });
    const conv = store.createConversation(alice.id, 'Old title');
    const before = store.getConversation(conv.id, alice.id)!.updatedAt;

    expect(store.renameConversation(conv.id, bob.id, 'Hijacked')).toBe(false);
    expect(store.renameConversation(conv.id, alice.id, 'New title')).toBe(true);

    const after = store.getConversation(conv.id, alice.id)!;
    expect(after.title).toBe('New title');
    // A background auto-title must not reorder the recency-sorted list.
    expect(after.updatedAt).toBe(before);
  });

  it('stores and updates a memory category', () => {
    const user = store.upsertUser({ provider: 'dev', providerId: 'm', email: null, name: null, avatar: null });
    const mem = store.addMemory(user.id, 'Prefers TypeScript', 'STACK');
    expect(mem.category).toBe('STACK');
    const updated = store.updateMemory(mem.id, user.id, 'Prefers TypeScript strict mode', 'STYLE');
    expect(updated?.category).toBe('STYLE');
    // A null category clears it.
    const cleared = store.updateMemory(mem.id, user.id, 'Prefers TypeScript', null);
    expect(cleared?.category).toBeNull();
  });

  it('does CRUD on per-user custom skills and scopes them to the owner', () => {
    const alice = store.upsertUser({ provider: 'dev', providerId: 'sa', email: null, name: null, avatar: null });
    const bob = store.upsertUser({ provider: 'dev', providerId: 'sb', email: null, name: null, avatar: null });

    const skill = store.createUserSkill(alice.id, { name: 'SQL Tutor', description: 'teaches SQL', systemPrompt: 'You teach SQL.' });
    expect(skill.usageCount).toBe(0);
    expect(store.listUserSkills(alice.id)).toHaveLength(1);
    // Bob cannot see or fetch Alice's skill.
    expect(store.listUserSkills(bob.id)).toHaveLength(0);
    expect(store.getUserSkill(skill.id, bob.id)).toBeNull();

    const updated = store.updateUserSkill(skill.id, alice.id, { name: 'SQL Coach', description: 'coaches SQL', systemPrompt: 'You coach SQL.' });
    expect(updated?.name).toBe('SQL Coach');
    // Bob's update is a no-op (not his skill).
    expect(store.updateUserSkill(skill.id, bob.id, { name: 'Hijack', description: '', systemPrompt: 'x' })).toBeNull();

    store.incrementSkillUsage(skill.id, alice.id);
    store.incrementSkillUsage(skill.id, bob.id); // ignored — wrong owner
    expect(store.getUserSkill(skill.id, alice.id)?.usageCount).toBe(1);

    expect(store.deleteUserSkill(skill.id, bob.id)).toBe(false);
    expect(store.deleteUserSkill(skill.id, alice.id)).toBe(true);
    expect(store.listUserSkills(alice.id)).toHaveLength(0);
  });

  it('groups a user\'s assistant messages by tier for the tier-mix panel', () => {
    const user = store.upsertUser({ provider: 'dev', providerId: 'tm', email: null, name: null, avatar: null });
    const conv = store.createConversation(user.id, 'c');
    store.addMessage({ conversationId: conv.id, role: 'user', content: 'q' });
    store.addMessage({ conversationId: conv.id, role: 'assistant', content: 'a', tier: 'T1' });
    store.addMessage({ conversationId: conv.id, role: 'assistant', content: 'b', tier: 'T1' });
    store.addMessage({ conversationId: conv.id, role: 'assistant', content: 'c', tier: 'T3' });
    // A tier-less (conversational fast-path) reply is excluded.
    store.addMessage({ conversationId: conv.id, role: 'assistant', content: 'd', tier: null });

    const mix = store.tierMixSince(user.id, 0);
    expect(mix).toEqual([
      { tier: 'T1', count: 2 },
      { tier: 'T3', count: 1 },
    ]);
    // A future cutoff excludes everything.
    expect(store.tierMixSince(user.id, Date.now() + 60_000)).toEqual([]);
  });

  it('stores MCP servers per user, redacts auth, and exposes it only for runs', () => {
    const alice = store.upsertUser({ provider: 'dev', providerId: 'mcp-a', email: null, name: null, avatar: null });
    const bob = store.upsertUser({ provider: 'dev', providerId: 'mcp-b', email: null, name: null, avatar: null });

    const withAuth = store.addMcpServer({
      userId: alice.id, name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer secret-token' }, connectorId: 'github',
    });
    const noAuth = store.addMcpServer({ userId: alice.id, name: 'Open', url: 'https://mcp.example.com/', headers: null });

    // Listing redacts the header value — only a hasAuth flag is exposed.
    const listed = store.listMcpServers(alice.id);
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain('secret-token');
    expect(listed.find((s) => s.id === withAuth.id)!.hasAuth).toBe(true);
    expect(listed.find((s) => s.id === noAuth.id)!.hasAuth).toBe(false);

    // Run wiring gets the real header back.
    const forRun = store.listEnabledMcpServersWithAuth(alice.id);
    expect(forRun.find((s) => s.name === 'GitHub')!.headers).toEqual({ Authorization: 'Bearer secret-token' });

    // Disabling drops it from the run set but keeps it listed.
    expect(store.setMcpServerEnabled(withAuth.id, alice.id, false)).toBe(true);
    expect(store.listEnabledMcpServersWithAuth(alice.id).map((s) => s.name)).toEqual(['Open']);
    expect(store.listMcpServers(alice.id)).toHaveLength(2);

    // Ownership is enforced.
    expect(store.setMcpServerEnabled(withAuth.id, bob.id, true)).toBe(false);
    expect(store.deleteMcpServer(withAuth.id, bob.id)).toBe(false);
    expect(store.deleteMcpServer(withAuth.id, alice.id)).toBe(true);
    expect(store.listMcpServers(alice.id)).toHaveLength(1);
    expect(store.listMcpServers(bob.id)).toHaveLength(0);
  });

  it('exposes a working hybrid vector store over the tenant DB', () => {
    const vs = store.getVectorStore();
    // Two chunks with hand-made 3-d vectors under one namespace/source.
    vs.upsert([
      { chunk: { id: 'u1:d1:0', text: 'photosynthesis in green plants', sourceId: 'd1', ord: 0, meta: { namespace: 'u1' } }, vector: [1, 0, 0] },
      { chunk: { id: 'u1:d1:1', text: 'interest rates and bond prices', sourceId: 'd1', ord: 1, meta: { namespace: 'u1' } }, vector: [0, 1, 0] },
    ], 'fake-model');

    expect(vs.hasSource('u1', 'd1', 'fake-model')).toBe(true);
    expect(vs.hasSource('u1', 'd1', 'other-model')).toBe(false);

    // Lexical (BM25) finds the keyword match.
    const lex = vs.lexicalSearch('photosynthesis', { namespace: 'u1', k: 5 });
    expect(lex[0]!.id).toBe('u1:d1:0');

    // Dense finds the nearest vector.
    const dense = vs.denseSearch([0.9, 0.1, 0], { namespace: 'u1', k: 1 });
    expect(dense[0]!.id).toBe('u1:d1:0');

    // Namespace isolation.
    expect(vs.denseSearch([1, 0, 0], { namespace: 'other', k: 5 })).toHaveLength(0);
  });
});

describe('CloudStore — message branching (conversation tree)', () => {
  let dir: string;
  let store: CloudStore;
  let userId: string;
  let convId: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-branch-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    userId = store.upsertUser({ provider: 'github', providerId: 'b1', email: null, name: null, avatar: null }).id;
    convId = store.createConversation(userId, 'Branch test').id;
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // A helper to add a message under a parent and return its id.
  const add = (role: string, content: string, parentId: string | null = null) =>
    store.addMessage({ conversationId: convId, role, content, parentId }).id;

  it('addMessage chains parents and moves the active leaf to the new tip', () => {
    const u1 = add('user', 'hello');
    const a1 = add('assistant', 'hi there', u1);
    expect(store.getMessageById(u1)?.parentId).toBeNull();
    expect(store.getMessageById(a1)?.parentId).toBe(u1);
    // Active path follows the leaf up to the root, oldest first.
    expect(store.getActivePath(convId).map((m) => m.id)).toEqual([u1, a1]);
    expect(store.getConversation(convId, userId)?.activeLeafId).toBe(a1);
  });

  it('editing a prompt forks a sibling branch; both survive and the active path shows the newest', () => {
    const u1 = add('user', 'first prompt');
    add('assistant', 'first answer', u1);
    // Edit u1 → a sibling user turn (same parent: null) + its own answer.
    const u1b = add('user', 'edited prompt', null);
    const a2 = add('assistant', 'second answer', u1b);

    // u1 and u1b are siblings (both roots).
    expect(store.getSiblingIds(u1)).toEqual([u1, u1b]);
    // Active path now runs through the edited branch.
    expect(store.getActivePath(convId).map((m) => m.content)).toEqual(['edited prompt', 'second answer']);

    // Switching back to the original branch descends to its newest leaf.
    const back = store.selectBranch(convId, userId, u1)!;
    expect(back.map((m) => m.content)).toEqual(['first prompt', 'first answer']);
    expect(store.getConversation(convId, userId)?.activeLeafId).toBe(store.getActivePath(convId).at(-1)?.id);
    // Restoring the edited branch descends to a2.
    store.selectBranch(convId, userId, u1b);
    expect(store.getConversation(convId, userId)?.activeLeafId).toBe(a2);
  });

  it('regenerating produces an assistant sibling under the same user turn', () => {
    const u1 = add('user', 'q');
    const a1 = add('assistant', 'answer A', u1);
    const a2 = add('assistant', 'answer B', u1); // regenerate → sibling of a1
    expect(store.getSiblingIds(a1)).toEqual([a1, a2]);
    // The newest reply is active.
    expect(store.getActivePath(convId).at(-1)?.id).toBe(a2);
  });

  it('deleting a message removes its entire subtree and relocates the active leaf', () => {
    const u1 = add('user', 'root');
    const a1 = add('assistant', 'a1', u1);
    const u2 = add('user', 'follow-up', a1);
    const a2 = add('assistant', 'a2', u2); // active leaf here

    // Delete the follow-up turn: u2 + a2 vanish; active leaf falls back to a1.
    const path = store.deleteMessageSubtree(convId, userId, u2)!;
    expect(path.map((m) => m.id)).toEqual([u1, a1]);
    expect(store.getMessageById(u2)).toBeNull();
    expect(store.getMessageById(a2)).toBeNull();
    expect(store.getConversation(convId, userId)?.activeLeafId).toBe(a1);
  });

  it('deleting the whole root subtree empties the conversation', () => {
    const u1 = add('user', 'only');
    add('assistant', 'reply', u1);
    const path = store.deleteMessageSubtree(convId, userId, u1)!;
    expect(path).toEqual([]);
    expect(store.getActivePath(convId)).toEqual([]);
    expect(store.getConversation(convId, userId)?.activeLeafId).toBeNull();
  });

  it('branch operations are owner-scoped', () => {
    const u1 = add('user', 'mine');
    const otherId = store.upsertUser({ provider: 'github', providerId: 'b2', email: null, name: null, avatar: null }).id;
    expect(store.selectBranch(convId, otherId, u1)).toBeNull();
    expect(store.deleteMessageSubtree(convId, otherId, u1)).toBeNull();
    // The message is untouched.
    expect(store.getMessageById(u1)).not.toBeNull();
  });

  it('appendTurn persists a normal turn at the tip, and edit/regenerate as siblings', () => {
    // Normal turn → user + assistant appended at the (empty) root.
    const p1 = store.appendTurn(convId, userId, { userContent: 'q1', assistant: { content: 'a1', tier: 'T3' } })!;
    expect(p1.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(p1[1]!.tier).toBe('T3');
    const u1 = p1[0]!;

    // Follow-up appends under the previous assistant (the active leaf).
    const p2 = store.appendTurn(convId, userId, { userContent: 'q2', assistant: { content: 'a2' } })!;
    expect(p2.map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2']);

    // Edit q1 → a NEW root branch; the original path is no longer active.
    const p3 = store.appendTurn(convId, userId, { userContent: 'q1 edited', assistant: { content: 'a1b' }, editOfMessageId: u1.id })!;
    expect(p3.map((m) => m.content)).toEqual(['q1 edited', 'a1b']);
    expect(store.getSiblingIds(u1.id)).toHaveLength(2); // original + edited roots
    const u1b = p3[0]!;

    // Regenerate under the edited turn → assistant sibling, no new user message.
    const p4 = store.appendTurn(convId, userId, { userContent: 'q1 edited', assistant: { content: 'a1c' }, regenerateFromUserMessageId: u1b.id })!;
    expect(p4.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(p4[0]!.id).toBe(u1b.id);
    expect(store.getSiblingIds(p4[1]!.id)).toHaveLength(2);
  });

  it('appendTurn is owner-scoped', () => {
    const otherId = store.upsertUser({ provider: 'github', providerId: 'b3', email: null, name: null, avatar: null }).id;
    expect(store.appendTurn(convId, otherId, { userContent: 'x', assistant: { content: 'y' } })).toBeNull();
    expect(store.getActivePath(convId)).toEqual([]);
  });

  it('imported transcripts form a single linear branch', () => {
    const convo = store.importConversation(userId, 'Imported', null, [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ]);
    const path = store.getActivePath(convo.id);
    expect(path.map((m) => m.content)).toEqual(['u1', 'a1', 'u2']);
    // Each turn is the parent of the next (a valid single path).
    expect(path[0]!.parentId).toBeNull();
    expect(path[1]!.parentId).toBe(path[0]!.id);
    expect(path[2]!.parentId).toBe(path[1]!.id);
  });
});

describe('CloudStore — branching back-fill migration', () => {
  it('upgrades a pre-branching (flat) database into a linear tree', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-migrate-'));
    const dbPath = path.join(dir, 'legacy.db');

    // Seed a legacy database: the messages/conversations schema BEFORE parent_id
    // and active_leaf_id existed, with a flat run of messages.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, provider TEXT, provider_id TEXT, email TEXT, name TEXT, avatar TEXT, plan TEXT, created_at INTEGER);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER);
    `);
    legacy.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run('u', 'github', '1', null, null, null, 'free', 1);
    legacy.prepare('INSERT INTO conversations VALUES (?,?,?,?,?)').run('c', 'u', 'Legacy', 1, 1);
    const ins = legacy.prepare('INSERT INTO messages VALUES (?,?,?,?,?)');
    ins.run('m1', 'c', 'user', 'first', 10);
    ins.run('m2', 'c', 'assistant', 'reply', 20);
    ins.run('m3', 'c', 'user', 'again', 30);
    legacy.close();

    // Opening the store runs migrate(), which adds the columns and back-fills.
    const store = new CloudStore(dbPath);
    try {
      const pathMsgs = store.getActivePath('c');
      expect(pathMsgs.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
      // The flat run is now a linear chain, and the last message is the active leaf.
      expect(pathMsgs[0]!.parentId).toBeNull();
      expect(pathMsgs[1]!.parentId).toBe('m1');
      expect(pathMsgs[2]!.parentId).toBe('m2');
      expect(store.getConversation('c', 'u')?.activeLeafId).toBe('m3');
    } finally {
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
