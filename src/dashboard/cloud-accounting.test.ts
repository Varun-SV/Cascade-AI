// ─────────────────────────────────────────────
//  Cascade AI — a desktop run's accounting for the cloud
// ─────────────────────────────────────────────
//
//  The desktop copies a finished run into the user's cloud chat. What the run
//  cost has to go with it, or the cloud's spend report never counts the run:
//  the app sends what `run:accounting` carries as `cloud`, which the backend
//  sends once the run's calls have settled.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DashboardServer } from './server.js';
import { CascadeRouter } from '../core/router/index.js';
import type { CascadeConfig, ModelInfo } from '../types.js';
import { CloudMirror, mirrorAndConfirm, type AccountedRun } from '../../app/src/lib/cloud-mirror.js';

const config = {
  version: '1.0',
  defaultIdentityId: 'default',
  providers: [],
  models: {},
  tools: { shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false },
  hooks: {},
  dashboard: { port: 4898, auth: false, teamMode: 'single' },
  telemetry: { enabled: false },
  memory: { maxSessionMessages: 10, autoSummarizeAt: 1000, retentionDays: 1 },
  theme: 'cascade',
  workspace: {
    cascadeMdPath: 'CASCADE.md', configPath: '.cascade/config.json',
    keystorePath: '.cascade/keystore.enc', auditLogPath: '.cascade/audit.log',
  },
} as unknown as CascadeConfig;

const store = {} as unknown as never;

async function routerWith(tokens: number, costUsd: number): Promise<CascadeRouter> {
  const router = new CascadeRouter();
  (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
  (router as unknown as Record<string, unknown>)['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
  await router.init({ providers: [], models: {}, tools: { allowedTools: [] } } as unknown as CascadeConfig);
  record(router, tokens, costUsd);
  return router;
}
function record(router: CascadeRouter, tokens: number, costUsd: number): void {
  (router as unknown as {
    recordStats: (tier: string, model: { id: string; provider: string }, usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number }) => void;
  }).recordStats('T3', { id: 'mini', provider: 'openai' }, { inputTokens: tokens, outputTokens: 0, totalTokens: tokens, estimatedCostUsd: costUsd });
}

type Internals = {
  emitRunAccounting: (emit: (e: string, p: unknown) => void, sessionId: string, cascade: unknown, run: Record<string, unknown>) => Promise<void>;
  replayAccountingTo: (socketId: string) => void;
  confirmAccounting: (id: unknown, socketId: string) => void;
  pendingAccounting: { unconfirmed(): Array<{ id: string; cloud?: { costUsd: number } }> } | null;
  socket: unknown;
};

/** A desktop backend whose socket layer has one desktop window and one stranger. */
function desktopServer(file: string, port = 51001, cloudAccount?: () => { userId: string; serverUrl: string } | null, cloudSyncAllowed?: () => boolean | undefined) {
  const server = new DashboardServer({ ...config, dashboard: { ...config.dashboard, port } } as CascadeConfig, store, '/tmp',
    { pendingAccountingFile: file, desktopToken: 'desk-token', cloudAccount, cloudSyncAllowed }) as unknown as Internals;
  const delivered: Array<{ socketId: string; payload: { id: string; sessionId: string; prompt: string; cloud: { costUsd: number }; account?: unknown; sync?: boolean } }> = [];
  server.socket = {
    socketIds: () => ['desk', 'stranger'],
    handshakeToken: (id: string) => (id === 'desk' ? 'desk-token' : id === 'stranger' ? 'guess' : undefined),
    emitToSocket: (socketId: string, _event: string, payload: never) => { delivered.push({ socketId, payload }); },
  };
  return { server, delivered };
}

const run = { prompt: 'q', output: 'a', outcome: 'answered', durationMs: 1, copyTurn: false };

describe('the desktop\'s run accounting for the cloud', () => {
  it('is the run\'s cost and its /why, split by tier and model', async () => {
    const router = await routerWith(1000, 0.001);
    vi.spyOn(router, 'getTierModel').mockReturnValue({ id: 'big', provider: 'anthropic', inputCostPer1kTokens: 0.01, outputCostPer1kTokens: 0.03 } as ModelInfo);
    const cascade = { getRouter: () => router, getDecisionLog: () => [{ at: 'now', kind: 'model', detail: 'T3 → mini' }] };

    // A host that is not the desktop app (the CLI's dashboard): sent as is, nothing kept.
    const server = new DashboardServer(config, store, '/tmp') as unknown as Internals;
    const sent: Array<{ event: string; payload: { cloud?: { costUsd: number; why: string }; outcome?: string; copyTurn?: boolean; prompt?: string; endedAt?: number } }> = [];
    await server.emitRunAccounting((event, payload) => sent.push({ event, payload: payload as never }), 's1', cascade,
      { prompt: 'q', output: 'a', outcome: 'answered', durationMs: 900, copyTurn: true });
    expect(sent.map((s) => s.event)).toEqual(['run:accounting']);
    expect(sent[0]!.payload).toMatchObject({ outcome: 'answered', copyTurn: true, prompt: 'q' });
    // When the run ended, so the cloud counts it on that day.
    expect(sent[0]!.payload.endedAt).toBeLessThanOrEqual(Date.now());
    expect(server.pendingAccounting).toBeNull();
    const cloud = sent[0]!.payload.cloud;

    expect(cloud?.costUsd).toBeCloseTo(0.001, 8);
    const why = JSON.parse(cloud!.why) as Record<string, unknown>;
    expect(why['costByModel']).toEqual({ T3: { 'openai:mini': 0.001 } });
    expect(why['tokensByModel']).toEqual({ T3: { 'openai:mini': 1000 } });
    expect(why['savedUsd'] as number).toBeCloseTo(0.009, 8);
    expect(why['models']).toEqual({ T3: 'openai:mini' });
    expect(why['decisions']).toEqual([{ at: 'now', kind: 'model', detail: 'T3 → mini' }]);
    expect(why['durationMs']).toBe(900);
  });

  describe('on the desktop', () => {
    let dir: string;
    let file: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-acct-')); file = path.join(dir, 'pending-accounting.jsonl'); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('goes only to the desktop\'s own windows, which alone can confirm it', async () => {
      const router = await routerWith(100, 0.0001);
      const { server, delivered } = desktopServer(file);
      const emit = vi.fn();
      await server.emitRunAccounting(emit, 'sched', { getRouter: () => router, getDecisionLog: () => [] }, run);
      expect(emit).not.toHaveBeenCalled();
      expect(delivered.map((d) => d.socketId)).toEqual(['desk']);
      const id = delivered[0]!.payload.id;
      // Replayed to the desktop window on connect, never to the stranger.
      server.replayAccountingTo('stranger');
      server.replayAccountingTo('desk');
      expect(delivered.map((d) => d.socketId)).toEqual(['desk', 'desk']);
      // A stranger that learned the id cannot make it disappear.
      server.confirmAccounting(id, 'stranger');
      expect(server.pendingAccounting!.unconfirmed().map((r) => r.id)).toEqual([id]);
      server.confirmAccounting(id, 'desk');
      expect(server.pendingAccounting!.unconfirmed()).toEqual([]);
    });

    it('is written down when the run ends, before waiting for its late calls', async () => {
      const router = await routerWith(100, 0.0001);
      let settle!: () => void;
      vi.spyOn(router, 'whenRunSettled').mockImplementation(() => new Promise((r) => { settle = () => { record(router, 50, 0.00005); r(true); }; }));
      const { server, delivered } = desktopServer(file);
      const done = server.emitRunAccounting(vi.fn(), 'sched', { getRouter: () => router, getDecisionLog: () => [] }, run);
      await new Promise((r) => setTimeout(r, 0));
      // Waiting: kept already, but not sent while this process still waits.
      expect(server.pendingAccounting!.unconfirmed()).toHaveLength(1);
      server.replayAccountingTo('desk');
      expect(delivered).toEqual([]);
      // Had the app quit now, the next start would replay what was written.
      const restarted = desktopServer(file, 51002);
      expect(restarted.server.pendingAccounting!.unconfirmed()[0]!.cloud!.costUsd).toBeCloseTo(0.0001, 8);
      settle();
      await done;
      // Once settled, the final figures replace it under the same id.
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.payload.cloud.costUsd).toBeCloseTo(0.00015, 8);
      expect(server.pendingAccounting!.unconfirmed()).toHaveLength(1);
    });

    it('keeps an unconfirmed report for the next backend, on whatever port it starts', async () => {
      const router = await routerWith(100, 0.0001);
      const first = desktopServer(file, 51001);
      await first.server.emitRunAccounting(vi.fn(), 'sched', { getRouter: () => router, getDecisionLog: () => [] }, run);
      // No window confirmed it. The app restarts and its backend gets a new port.
      const next = desktopServer(file, 51002);
      expect(next.server.pendingAccounting!.unconfirmed().map((r) => r.id)).toEqual([first.delivered[0]!.payload.id]);
    });

    it('stays on disk when the signed-in desktop cannot upload it, and goes once a replay is delivered', async () => {
      const router = await routerWith(100, 0.0001);
      const { server, delivered } = desktopServer(file, 51001, () => ({ userId: 'u1', serverUrl: 'https://cloud' }), () => true);
      await server.emitRunAccounting(vi.fn(), 's1', { getRouter: () => router, getDecisionLog: () => [] }, { ...run, copyTurn: true });
      // The desktop window's mirror, signed in, while the cloud answers 502.
      const failing = { ok: false, error: 'Cloud request failed (502)' };
      const api = {
        status: vi.fn().mockResolvedValue({ signedIn: true, user: { id: 'u1' }, serverUrl: 'https://cloud' }),
        createConversation: vi.fn().mockResolvedValue({ ok: true, conversation: { id: 'c1' } }),
        appendTurn: vi.fn().mockResolvedValue(failing),
        recordRunSpend: vi.fn().mockResolvedValue(failing),
      };
      const chats = new Map<string, string>();
      const mirror = new CloudMirror(() => api, () => false,
        { get: (k) => chats.get(k), set: (k, c) => { chats.set(k, c); }, delete: (k) => { chats.delete(k); } });
      const confirm = (id: string) => server.confirmAccounting(id, 'desk');
      const report = delivered[0]!.payload as unknown as AccountedRun & { id: string };

      expect(await mirrorAndConfirm(mirror, report, confirm)).toBe('retry');
      expect(api.appendTurn).toHaveBeenCalledTimes(2);
      expect(api.recordRunSpend).toHaveBeenCalledTimes(2);
      // Not confirmed: still kept, and still there after a restart.
      expect(server.pendingAccounting!.unconfirmed().map((r) => r.id)).toEqual([report.id]);
      expect(desktopServer(file, 51003).server.pendingAccounting!.unconfirmed().map((r) => r.id)).toEqual([report.id]);

      // The window reconnects with the cloud back: the replay is uploaded once, then confirmed.
      api.appendTurn.mockResolvedValue({ ok: true });
      server.replayAccountingTo('desk');
      const replayed = delivered[1]!.payload as unknown as AccountedRun & { id: string };
      expect(replayed.id).toBe(report.id);
      expect(await mirrorAndConfirm(mirror, replayed, confirm)).toBe('delivered');
      expect(api.appendTurn).toHaveBeenCalledTimes(3);
      // The same run id every time, so the cloud counts it once.
      expect(new Set(api.appendTurn.mock.calls.map((c) => (c[1] as { runId: string }).runId))).toEqual(new Set([report.id]));
      expect(server.pendingAccounting!.unconfirmed()).toEqual([]);
      expect(desktopServer(file, 51004).server.pendingAccounting!.unconfirmed()).toEqual([]);
    });

    it('keeps a session\'s turns in order when one fails to upload and is replayed later', async () => {
      const account = () => ({ userId: 'u1', serverUrl: 'https://cloud' });
      const { server, delivered } = desktopServer(file, 51001, account, () => true);
      const cascade = async () => { const router = await routerWith(100, 0.0001); return { getRouter: () => router, getDecisionLog: () => [] }; };
      await server.emitRunAccounting(vi.fn(), 's1', await cascade(), { ...run, copyTurn: true, prompt: 'first question' });
      await server.emitRunAccounting(vi.fn(), 's1', await cascade(), { ...run, copyTurn: true, prompt: 'second question' });
      // The cloud's chat, as it ends up: the first turn's uploads fail during an outage.
      const chat: string[] = [];
      let outage = true;
      const api = {
        status: vi.fn().mockResolvedValue({ signedIn: true, user: { id: 'u1' }, serverUrl: 'https://cloud' }),
        createConversation: vi.fn().mockResolvedValue({ ok: true, conversation: { id: 'c1' } }),
        appendTurn: vi.fn().mockImplementation(async (_c: string, turn: { userContent: string }) => {
          if (outage) return { ok: false, error: 'Request failed (503).' };
          chat.push(turn.userContent);
          return { ok: true };
        }),
        recordRunSpend: vi.fn().mockResolvedValue({ ok: true }),
      };
      const chats = new Map<string, string>();
      const mirror = new CloudMirror(() => api, () => false,
        { get: (k) => chats.get(k), set: (k, c) => { chats.set(k, c); }, delete: (k) => { chats.delete(k); } });
      const confirm = (id: string) => server.confirmAccounting(id, 'desk');
      const [first, second] = delivered.map((d) => d.payload as unknown as AccountedRun & { id: string });
      expect(await mirrorAndConfirm(mirror, first, confirm)).toBe('retry');
      // The outage ends; the second run arrives before any replay of the first. It waits.
      outage = false;
      expect(await mirrorAndConfirm(mirror, second, confirm)).toBe('retry');
      expect(chat).toEqual([]);
      // The window reconnects: both are replayed, oldest first, and copied in order.
      server.replayAccountingTo('desk');
      for (const replay of delivered.slice(2)) await mirrorAndConfirm(mirror, replay.payload as unknown as AccountedRun, confirm);
      expect(chat).toEqual(['first question', 'second question']);
      expect(server.pendingAccounting!.unconfirmed()).toEqual([]);
    });

    it('is never sent to an account that signed in after the run ended, even when replayed', async () => {
      const router = await routerWith(100, 0.0001);
      let signedIn: { userId: string; serverUrl: string } | null = { userId: 'u1', serverUrl: 'https://cloud' };
      let settle!: () => void;
      vi.spyOn(router, 'whenRunSettled').mockImplementation(() => new Promise((r) => { settle = () => r(true); }));
      const { server, delivered } = desktopServer(file, 51001, () => signedIn);
      const done = server.emitRunAccounting(vi.fn(), 's1', { getRouter: () => router, getDecisionLog: () => [] }, { ...run, copyTurn: true });
      // u1 signs out and u2 signs in while the run's late calls settle: the run is still u1's.
      signedIn = { userId: 'u2', serverUrl: 'https://cloud' };
      settle();
      await done;
      expect(delivered[0]!.payload.account).toEqual({ userId: 'u1', serverUrl: 'https://cloud' });
      expect(desktopServer(file, 51005).server.pendingAccounting!.unconfirmed()[0]).toMatchObject({ account: { userId: 'u1' } });

      // The window, signed in as u2 now, gets the report (or its replay after a failed upload under u1).
      const api = {
        status: vi.fn().mockResolvedValue({ signedIn: true, user: { id: 'u2' }, serverUrl: 'https://cloud' }),
        createConversation: vi.fn().mockResolvedValue({ ok: true, conversation: { id: 'c2' } }),
        appendTurn: vi.fn().mockResolvedValue({ ok: true }),
        recordRunSpend: vi.fn().mockResolvedValue({ ok: true }),
      };
      const mirror = new CloudMirror(() => api, () => false, { get: () => undefined, set: () => {}, delete: () => {} });
      server.replayAccountingTo('desk');
      const replayed = delivered[1]!.payload as unknown as AccountedRun & { id: string };
      expect(await mirrorAndConfirm(mirror, replayed, (id) => server.confirmAccounting(id, 'desk'))).toBe('skipped');
      expect(api.createConversation).not.toHaveBeenCalled();
      expect(api.appendTurn).not.toHaveBeenCalled();
      expect(api.recordRunSpend).not.toHaveBeenCalled();
    });

    describe('whether syncing was on as the run ended', () => {
      const u1 = { userId: 'u1', serverUrl: 'https://cloud' };
      const slowRun = async () => {
        const router = await routerWith(100, 0.0001);
        let settle!: () => void;
        vi.spyOn(router, 'whenRunSettled').mockImplementation(() => new Promise((r) => { settle = () => r(true); }));
        return { cascade: { getRouter: () => router, getDecisionLog: () => [] }, settle: () => settle() };
      };
      // The window's side: the main process answers `syncOff` while syncing is off now.
      const window = (syncOnNow: () => boolean) => {
        const refuse = <T>(ok: T) => async () => (syncOnNow() ? ok : { ok: false, syncOff: true, error: 'Cloud sync is off.' });
        const api = {
          status: vi.fn().mockResolvedValue({ signedIn: true, user: { id: 'u1' }, serverUrl: 'https://cloud' }),
          createConversation: vi.fn().mockImplementation(refuse({ ok: true, conversation: { id: 'c1' } })),
          appendTurn: vi.fn().mockImplementation(refuse({ ok: true })),
          recordRunSpend: vi.fn().mockImplementation(refuse({ ok: true })),
        };
        const mirror = new CloudMirror(() => api, () => false, { get: () => undefined, set: () => {}, delete: () => {} });
        const calls = () => api.createConversation.mock.calls.length + api.appendTurn.mock.calls.length + api.recordRunSpend.mock.calls.length;
        return { api, mirror, calls };
      };

      it('off at run end, on again before it is sent or replayed after a restart: nothing is uploaded', async () => {
        let on = false;
        const { cascade, settle } = await slowRun();
        const { server, delivered } = desktopServer(file, 51001, () => u1, () => on);
        const done = server.emitRunAccounting(vi.fn(), 's1', cascade, { ...run, copyTurn: true });
        // Turned back on during the settle wait.
        on = true;
        settle();
        await done;
        expect(delivered[0]!.payload.sync).toBe(false);
        const { mirror, calls } = window(() => on);
        const confirm = (id: string) => server.confirmAccounting(id, 'desk');
        // The app quits before the window handles it: the journal keeps the stamp.
        const restarted = desktopServer(file, 51006, () => u1, () => on);
        expect(restarted.server.pendingAccounting!.unconfirmed()[0]).toMatchObject({ sync: false });
        restarted.server.replayAccountingTo('desk');
        expect(await mirrorAndConfirm(mirror, restarted.delivered[0]!.payload as unknown as AccountedRun,
          (id) => restarted.server.confirmAccounting(id, 'desk'))).toBe('skipped');
        expect(await mirrorAndConfirm(mirror, delivered[0]!.payload as unknown as AccountedRun, confirm)).toBe('skipped');
        expect(calls()).toBe(0);
        expect(desktopServer(file, 51007).server.pendingAccounting!.unconfirmed()).toEqual([]);
      });

      it('kept by an older build with no stamp, replayed after the upgrade with syncing on: nothing is uploaded', async () => {
        // The older build could not say (the user had opted out in the window then).
        const router = await routerWith(100, 0.0001);
        const older = desktopServer(file, 51001, () => u1);
        await older.server.emitRunAccounting(vi.fn(), 's1', { getRouter: () => router, getDecisionLog: () => [] }, { ...run, copyTurn: true });
        expect(older.delivered[0]!.payload).not.toHaveProperty('sync');
        // Upgraded and restarted, with syncing on now.
        const upgraded = desktopServer(file, 51006, () => u1, () => true);
        upgraded.server.replayAccountingTo('desk');
        const { mirror, calls, api } = window(() => true);
        expect(await mirrorAndConfirm(mirror, upgraded.delivered[0]!.payload as unknown as AccountedRun,
          (id) => upgraded.server.confirmAccounting(id, 'desk'))).toBe('skipped');
        expect(calls()).toBe(0);
        expect(api.status).not.toHaveBeenCalled();
        // Settled for good: not replayed on the next start.
        expect(desktopServer(file, 51007).server.pendingAccounting!.unconfirmed()).toEqual([]);
      });

      it('on at run end, off before it is sent: the main process refuses every upload and it is not retried', async () => {
        let on = true;
        const { cascade, settle } = await slowRun();
        const { server, delivered } = desktopServer(file, 51001, () => u1, () => on);
        const done = server.emitRunAccounting(vi.fn(), 's1', cascade, { ...run, copyTurn: true });
        on = false;
        settle();
        await done;
        expect(delivered[0]!.payload.sync).toBe(true);
        const { api, mirror } = window(() => on);
        const restarted = desktopServer(file, 51006, () => u1, () => on);
        restarted.server.replayAccountingTo('desk');
        for (const report of [delivered[0]!.payload, restarted.delivered[0]!.payload]) {
          expect(await mirrorAndConfirm(mirror, report as unknown as AccountedRun, (id) => restarted.server.confirmAccounting(id, 'desk'))).toBe('skipped');
        }
        // Each send stopped at its first refused request: nothing reached the cloud.
        expect(api.appendTurn).not.toHaveBeenCalled();
        expect(api.recordRunSpend).not.toHaveBeenCalled();
        expect(desktopServer(file, 51007).server.pendingAccounting!.unconfirmed()).toEqual([]);
      });

      it('is off when it cannot be told, and not stamped by hosts that do not say', async () => {
        const router = await routerWith(100, 0.0001);
        const cascade = { getRouter: () => router, getDecisionLog: () => [] };
        const throwing = desktopServer(file, 51001, () => u1, () => { throw new Error('no settings'); });
        await throwing.server.emitRunAccounting(vi.fn(), 's1', cascade, { ...run });
        const unknown = desktopServer(file, 51002, () => u1, () => undefined);
        await unknown.server.emitRunAccounting(vi.fn(), 's2', cascade, { ...run });
        const silent = desktopServer(file, 51003, () => u1);
        await silent.server.emitRunAccounting(vi.fn(), 's3', cascade, { ...run });
        expect(throwing.delivered[0]!.payload.sync).toBe(false);
        expect(unknown.delivered[0]!.payload.sync).toBe(false);
        expect(silent.delivered[0]!.payload).not.toHaveProperty('sync');
      });
    });

    it('is sent in the order the session\'s runs ended, not the order their late calls settled', async () => {
      const slow = await routerWith(100, 0.0001);
      const fast = await routerWith(100, 0.0001);
      const other = await routerWith(100, 0.0001);
      let settle!: () => void;
      vi.spyOn(slow, 'whenRunSettled').mockImplementation(() => new Promise((r) => { settle = () => r(true); }));
      const { server, delivered } = desktopServer(file);
      const cascade = (router: CascadeRouter) => ({ getRouter: () => router, getDecisionLog: () => [] });
      const first = server.emitRunAccounting(vi.fn(), 's1', cascade(slow), { ...run, prompt: 'first' });
      const second = server.emitRunAccounting(vi.fn(), 's1', cascade(fast), { ...run, prompt: 'second' });
      const elsewhere = server.emitRunAccounting(vi.fn(), 's2', cascade(other), { ...run, prompt: 'other session' });
      await elsewhere;
      await new Promise((r) => setTimeout(r, 0));
      // Another session is not held up; this one's second run waits for its first.
      expect(delivered.map((d) => d.payload.prompt)).toEqual(['other session']);
      // A window connecting meanwhile is not sent the second run ahead of the first either.
      server.replayAccountingTo('desk');
      expect(delivered.map((d) => d.payload.prompt)).toEqual(['other session', 'other session']);
      settle();
      await first; await second;
      expect(delivered.map((d) => d.payload.prompt)).toEqual(['other session', 'other session', 'first', 'second']);
    });
  });
});
