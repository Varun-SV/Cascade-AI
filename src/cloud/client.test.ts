import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudClient } from './client.js';
import { loadCloudSession } from './session-store.js';

// A minimal stub of the cloud native-auth + read API. The device grant returns
// 'pending' on the first poll, then issues tokens (as if the user approved).
function startStubServer() {
  let pollCount = 0;
  let refreshCount = 0;
  let loopCount = 0;
  const challenges = new Map<string, string>(); // one-time code → PKCE challenge
  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    });

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const auth = req.headers['authorization'];
    const url = req.url ?? '';

    // Loopback flow — begin: mint a one-time code bound to the PKCE challenge,
    // then 302 back to the app's loopback listener (standing in for the browser
    // OAuth leg the real server runs).
    if (req.method === 'GET' && url.startsWith('/auth/native/')) {
      const u = new URL(url, 'http://stub');
      const redirect = u.searchParams.get('redirect_uri') ?? '';
      const challenge = u.searchParams.get('code_challenge') ?? '';
      const state = u.searchParams.get('state') ?? '';
      const code = `loop-${++loopCount}`;
      challenges.set(code, challenge);
      const loc = `${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      res.writeHead(302, { Location: loc });
      return res.end();
    }
    // Loopback flow — redeem: verify the PKCE verifier hashes to the stored
    // challenge before issuing tokens.
    if (req.method === 'POST' && url === '/api/native/token') {
      const body = await readBody(req);
      const code = String(body.code ?? '');
      const verifier = String(body.code_verifier ?? '');
      const expected = challenges.get(code);
      const got = createHash('sha256').update(verifier).digest('base64url');
      if (!expected || expected !== got) return send(400, { error: 'invalid_grant' });
      challenges.delete(code);
      return send(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 });
    }
    if (req.method === 'POST' && url === '/api/native/device') {
      return send(200, { device_code: 'dev-code', user_code: 'WXYZ-1234', verification_uri: 'https://example.test/activate', expires_in: 300, interval: 0 });
    }
    if (req.method === 'POST' && url === '/api/native/device/token') {
      pollCount++;
      if (pollCount === 1) return send(428, { error: 'authorization_pending' });
      return send(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 });
    }
    if (req.method === 'POST' && url === '/api/native/refresh') {
      refreshCount++;
      return send(200, { access_token: `access-${refreshCount + 1}`, refresh_token: `refresh-${refreshCount + 1}`, token_type: 'Bearer', expires_in: 3600 });
    }
    if (req.method === 'POST' && url === '/api/native/logout') { await readBody(req); return send(200, { ok: true }); }
    if (req.method === 'GET' && url === '/api/me') {
      if (!auth?.startsWith('Bearer ')) return send(401, { error: 'no' });
      return send(200, { user: { id: 'u1', email: 'a@b.com', name: 'Alice', plan: 'free' } });
    }
    if (req.method === 'GET' && url === '/api/conversations') {
      if (!auth?.startsWith('Bearer ')) return send(401, { error: 'no' });
      return send(200, { conversations: [{ id: 'c1', title: 'First chat' }, { id: 'c2', title: 'Second' }] });
    }
    // Create a cloud conversation (native write API).
    if (req.method === 'POST' && url === '/api/conversations') {
      if (!auth?.startsWith('Bearer ')) return send(401, { error: 'no' });
      const body = await readBody(req);
      return send(200, { conversation: { id: 'c-new', title: body.title ?? null } });
    }
    // Append a locally-executed turn; echo it back as a two-message active path.
    if (req.method === 'POST' && url.endsWith('/turns')) {
      if (!auth?.startsWith('Bearer ')) return send(401, { error: 'no' });
      const body = await readBody(req);
      return send(200, { messages: [
        { id: 'm1', role: 'user', content: body.userContent, parentId: null, siblingIds: ['m1'] },
        { id: 'm2', role: 'assistant', content: body.assistant?.content, parentId: 'm1', siblingIds: ['m2'] },
      ] });
    }
    if (req.method === 'POST' && url.endsWith('/select-branch')) {
      if (!auth?.startsWith('Bearer ')) return send(401, { error: 'no' });
      const body = await readBody(req);
      return send(200, { messages: [{ id: body.messageId, role: 'user', content: 'switched', siblingIds: [body.messageId] }] });
    }
    if (req.method === 'DELETE' && url.includes('/messages/')) {
      if (!auth?.startsWith('Bearer ')) return send(401, { error: 'no' });
      return send(200, { messages: [] });
    }
    if (req.method === 'GET' && url.startsWith('/api/conversations/')) {
      if (!auth?.startsWith('Bearer ')) return send(401, { error: 'no' });
      return send(200, { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });
    }
    send(404, { error: 'not found' });
  });
  return new Promise<{ url: string; close: () => Promise<void>; polls: () => number }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())), polls: () => pollCount });
    });
  });
}

describe('CloudClient', () => {
  let dir: string;
  let stub: Awaited<ReturnType<typeof startStubServer>>;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-cloud-cli-'));
    stub = await startStubServer();
  });
  afterEach(async () => { await stub.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('runs the device flow, persists the session, and loads the user', async () => {
    const client = new CloudClient(stub.url, dir);
    let shown: string | undefined;
    const session = await client.runDeviceLogin((d) => { shown = d.userCode; });
    expect(shown).toBe('WXYZ-1234');
    expect(session.user.name).toBe('Alice');
    expect(stub.polls()).toBeGreaterThanOrEqual(2); // pending, then approved
    // Persisted for later commands.
    expect(loadCloudSession(dir)?.refreshToken).toBe('refresh-1');
  });

  it('runs the loopback flow: PKCE round-trips and the session persists', async () => {
    const client = new CloudClient(stub.url, dir);
    // `openUrl` stands in for the system browser: following the authorize URL
    // 302s to our loopback listener with the one-time code.
    const session = await client.runLoopbackLogin((u) => { void fetch(u); }, { provider: 'google' });
    expect(session.user.name).toBe('Alice');
    expect(loadCloudSession(dir)?.refreshToken).toBe('refresh-1');
  });

  it('rejects a loopback code whose state does not match', async () => {
    const client = new CloudClient(stub.url, dir);
    // Tamper with the echoed state so the listener sees a mismatch.
    await expect(
      client.runLoopbackLogin((u) => { void fetch(u.replace(/state=[^&]*/, 'state=tampered')); }, { provider: 'google', timeoutMs: 3000 }),
    ).rejects.toThrow();
    expect(loadCloudSession(dir)).toBeNull();
  });

  it('lists conversations and pulls a transcript with the stored token', async () => {
    const client = new CloudClient(stub.url, dir);
    await client.runDeviceLogin(() => {});
    const convos = await client.listConversations();
    expect(convos.map((c) => c.id)).toEqual(['c1', 'c2']);
    const msgs = await client.getMessages('c1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('user');
  });

  it('creates a conversation and appends a locally-executed turn (cloud-backed sessions)', async () => {
    const client = new CloudClient(stub.url, dir);
    await client.runDeviceLogin(() => {});
    const convo = await client.createConversation('From the CLI');
    expect(convo.id).toBe('c-new');
    expect(convo.title).toBe('From the CLI');
    const path = await client.appendTurn(convo.id, { userContent: 'q', assistant: { content: 'a', tier: 'T3' } });
    expect(path.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(path[0]!.content).toBe('q');
    expect(path[1]!.parentId).toBe('m1');
  });

  it('drives the branch operations (select-branch, delete) against the tree API', async () => {
    const client = new CloudClient(stub.url, dir);
    await client.runDeviceLogin(() => {});
    const switched = await client.selectBranch('c1', 'sib-2');
    expect(switched[0]!.id).toBe('sib-2');
    const afterDelete = await client.deleteMessage('c1', 'm1');
    expect(afterDelete).toEqual([]);
  });

  it('refreshes a near-expired access token and rotates the refresh token', async () => {
    const client = new CloudClient(stub.url, dir);
    await client.runDeviceLogin(() => {});
    // Force the stored access token to look expired.
    const s = loadCloudSession(dir)!;
    fs.writeFileSync(path.join(dir, 'cloud-session.json'), JSON.stringify({ ...s, accessExpiresAt: Date.now() - 1000 }));
    await client.me(); // triggers a refresh
    expect(loadCloudSession(dir)?.refreshToken).toBe('refresh-2'); // rotated
  });

  it('logout revokes and clears the local session', async () => {
    const client = new CloudClient(stub.url, dir);
    await client.runDeviceLogin(() => {});
    await client.logout();
    expect(loadCloudSession(dir)).toBeNull();
    expect(CloudClient.fromSession(dir)).toBeNull();
  });
});
