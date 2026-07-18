import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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

  it('lists conversations and pulls a transcript with the stored token', async () => {
    const client = new CloudClient(stub.url, dir);
    await client.runDeviceLogin(() => {});
    const convos = await client.listConversations();
    expect(convos.map((c) => c.id)).toEqual(['c1', 'c2']);
    const msgs = await client.getMessages('c1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('user');
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
