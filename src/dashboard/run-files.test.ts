// ─────────────────────────────────────────────
//  Cascade AI — files sent with a desktop message
// ─────────────────────────────────────────────

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory/store.js';
import { DashboardServer } from './server.js';
import { attachmentIdsFrom, filesForRun, parseNewAttachment, withDocuments } from './run-files.js';
import type { CascadeConfig } from '../types.js';

const hasSqlite = (() => {
  try { const D = createRequire(import.meta.url)('better-sqlite3'); new D(':memory:').close(); return true; } catch { return false; }
})();

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function tempStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-files-'));
  const store = new MemoryStore(path.join(dir, 'memory.db'));
  closers.push(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

/** Writes are queued; this waits for the queue to drain. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('what an upload may be', () => {
  it('an image in a type a model takes, as base64; a document with text', () => {
    expect(parseNewAttachment({ kind: 'image', mime: 'image/png', filename: ' a.png ', data: PNG })).toEqual({ kind: 'image', mime: 'image/png', filename: 'a.png', data: PNG });
    expect(parseNewAttachment({ kind: 'document', text: 'hi' })).toEqual({ kind: 'document', filename: 'document', text: 'hi' });
  });

  it('anything else is refused, never trimmed', () => {
    expect(parseNewAttachment({ kind: 'image', mime: 'image/svg+xml', data: PNG })).toMatchObject({ error: expect.any(String) });
    expect(parseNewAttachment({ kind: 'image', mime: 'image/png', data: '<svg/>' })).toMatchObject({ error: expect.any(String) });
    expect(parseNewAttachment({ kind: 'image', mime: 'image/png', data: 'A'.repeat(7_000_004) })).toMatchObject({ error: expect.stringContaining('too large') });
    expect(parseNewAttachment({ kind: 'document', text: 'x'.repeat(8_000_001) })).toMatchObject({ error: expect.stringContaining('too long') });
    expect(parseNewAttachment({ kind: 'document', text: '  ' })).toMatchObject({ error: expect.any(String) });
    expect(parseNewAttachment({ kind: 'video' })).toMatchObject({ error: expect.any(String) });
  });

  it('a run takes at most ten ids, strings only, each once', () => {
    expect(attachmentIdsFrom(['a', 'a', 3, '', 'b'])).toEqual(['a', 'b']);
    expect(attachmentIdsFrom(Array.from({ length: 12 }, (_, i) => `f${i}`))).toHaveLength(10);
    expect(attachmentIdsFrom('a')).toEqual([]);
  });
});

describe('what a run gets', () => {
  it('images as images, documents as text before the request', () => {
    const files = filesForRun([
      { id: '1', kind: 'image', mime: 'image/png', filename: 'a.png', size: 1, data: PNG },
      { id: '2', kind: 'document', mime: 'text/plain', filename: 'r"1".pdf', size: 3, data: 'Q3 up' },
    ]);
    expect(files.images).toEqual([{ type: 'base64', data: PNG, mimeType: 'image/png' }]);
    const prompt = withDocuments('summarise it', files.documents);
    expect(prompt).toContain('<document filename="r&quot;1&quot;.pdf">\nQ3 up\n</document>');
    expect(prompt.endsWith('---\n\nsummarise it')).toBe(true);
    expect(withDocuments('plain', [])).toBe('plain');
  });
});

describe.skipIf(!hasSqlite)('files kept with messages', () => {
  it('an upload waits unclaimed, a message claims it once, and the session shows it', async () => {
    const store = tempStore();
    store.createSession({ id: 's1', title: 't', createdAt: '', updatedAt: '', identityId: 'default', workspacePath: '', messages: [], metadata: { totalTokens: 0, totalCostUsd: 0, modelsUsed: [], toolsUsed: [], taskCount: 0 } });
    const img = store.addAttachment({ kind: 'image', mime: 'image/png', filename: 'a.png', data: PNG });
    const doc = store.addAttachment({ kind: 'document', filename: 'n.txt', text: 'notes' });
    expect(store.getUnclaimedAttachments([doc.id, img.id, 'nope']).map((f) => f.id)).toEqual([doc.id, img.id]);
    store.addMessage({ id: 'm1', sessionId: 's1', role: 'user', content: 'look', timestamp: new Date().toISOString() });
    store.claimAttachments('m1', 's1', [img.id, doc.id]);
    await settle();
    expect(store.getUnclaimedAttachments([img.id])).toEqual([]);
    const [m] = store.getSessionMessages('s1');
    expect(m!.attachments).toEqual([
      { id: img.id, kind: 'image', mime: 'image/png', filename: 'a.png', size: img.size },
      { id: doc.id, kind: 'document', mime: 'text/plain', filename: 'n.txt', size: 5 },
    ]);
    expect(store.getAttachment(doc.id)?.data).toBe('notes');

    store.branchSession('s1', 's2');
    const [copy] = store.getSessionMessages('s2');
    expect(copy!.attachments?.map((f) => f.filename)).toEqual(['a.png', 'n.txt']);
    expect(copy!.attachments![0]!.id).not.toBe(img.id);

    store.deleteSession('s1');
    expect(store.getAttachment(img.id)).toBeNull();
    expect(store.getAttachment(copy!.attachments![0]!.id)).not.toBeNull();
  });

  it('one never claimed goes after a day', () => {
    const store = tempStore();
    const old = store.addAttachment({ kind: 'document', filename: 'x', text: 'x' }, new Date('2026-01-01T00:00:00Z'));
    store.addAttachment({ kind: 'document', filename: 'y', text: 'y' }, new Date('2026-01-02T00:00:01Z'));
    expect(store.getAttachment(old.id)).toBeNull();
  });
});

const config = {
  version: '1.0', defaultIdentityId: 'default', providers: [], models: {},
  tools: { shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false },
  hooks: {}, dashboard: { port: 0, auth: false, teamMode: 'single' }, telemetry: { enabled: false },
  memory: { maxSessionMessages: 10, autoSummarizeAt: 1000, retentionDays: 1 }, theme: 'cascade',
  workspace: { cascadeMdPath: 'CASCADE.md', configPath: '.cascade/config.json', keystorePath: '.cascade/keystore.enc', auditLogPath: '.cascade/audit.log' },
} as unknown as CascadeConfig;

describe.skipIf(!hasSqlite)('the backend routes', () => {
  async function serve() {
    const store = tempStore();
    const server = new DashboardServer(config, store, os.tmpdir());
    const app = (server as unknown as { app: http.RequestListener }).app;
    const httpServer = http.createServer(app);
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise((r) => httpServer.close(r)));
    closers.push(() => server.stop().catch(() => { /* its own http server never listened */ }));
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { store, server, base, post };
  }

  it('uploads a file, serves it back, and an import claims it for its message', async () => {
    const { store, base, post } = await serve();
    const bad = await post('/api/attachments', { kind: 'image', mime: 'image/svg+xml', data: PNG });
    expect(bad.status).toBe(400);
    const img = (await (await post('/api/attachments', { kind: 'image', mime: 'image/png', filename: 'a.png', data: PNG })).json()) as { id: string };
    const doc = (await (await post('/api/attachments', { kind: 'document', filename: 'n.txt', text: 'notes' })).json()) as { id: string };
    const bytes = await fetch(`${base}/api/attachments/${img.id}`);
    expect(bytes.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await bytes.arrayBuffer()).toString('base64')).toBe(PNG);
    expect(await (await fetch(`${base}/api/attachments/${doc.id}`)).json()).toEqual({ filename: 'n.txt', text: 'notes' });

    const imported = (await (await post('/api/import', {
      format: 'cascade-export@1',
      sessions: [{ title: 'From the web', messages: [{ role: 'user', content: 'look', attachmentIds: [img.id, doc.id] }] }],
    })).json()) as { sessions: Array<{ id: string; title: string }> };
    expect(imported.sessions).toHaveLength(1);
    const [m] = store.getSessionMessages(imported.sessions[0]!.id);
    expect(m!.attachments?.map((f) => f.id)).toEqual([img.id, doc.id]);
  });

  it("a run's start claims the files it was sent", async () => {
    const { store, server } = await serve();
    const img = store.addAttachment({ kind: 'image', mime: 'image/png', filename: null, data: PNG });
    (server as unknown as { persistRunStart: (s: string, p: string, ids: string[]) => string }).persistRunStart('s9', 'what is this', [img.id]);
    await settle();
    const [m] = store.getSessionMessages('s9');
    expect(m!.content).toBe('what is this');
    expect(m!.attachments?.map((f) => f.id)).toEqual([img.id]);
  });
});
