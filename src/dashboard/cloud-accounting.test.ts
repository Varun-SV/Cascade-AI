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
function desktopServer(file: string, port = 51001) {
  const server = new DashboardServer({ ...config, dashboard: { ...config.dashboard, port } } as CascadeConfig, store, '/tmp',
    { pendingAccountingFile: file, desktopToken: 'desk-token' }) as unknown as Internals;
  const delivered: Array<{ socketId: string; payload: { id: string; cloud: { costUsd: number } } }> = [];
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
  });
});
