// ─────────────────────────────────────────────
//  Cascade AI — a desktop run's accounting for the cloud
// ─────────────────────────────────────────────
//
//  The desktop copies a finished run into the user's cloud chat. What the run
//  cost has to go with it, or the cloud's spend report never counts the run:
//  the app sends what `run:accounting` carries as `cloud`, which the backend
//  sends once the run's calls have settled.

import { describe, expect, it, vi } from 'vitest';
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

describe('the desktop\'s run accounting for the cloud', () => {
  it('is the run\'s cost and its /why, split by tier and model', async () => {
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
    (router as unknown as Record<string, unknown>)['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
    await router.init({ providers: [], models: {}, tools: { allowedTools: [] } } as unknown as CascadeConfig);
    (router as unknown as {
      recordStats: (tier: string, model: { id: string; provider: string }, usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number }) => void;
    }).recordStats('T3', { id: 'mini', provider: 'openai' }, { inputTokens: 1000, outputTokens: 0, totalTokens: 1000, estimatedCostUsd: 0.001 });
    vi.spyOn(router, 'getTierModel').mockReturnValue({ id: 'big', provider: 'anthropic', inputCostPer1kTokens: 0.01, outputCostPer1kTokens: 0.03 } as ModelInfo);
    const cascade = { getRouter: () => router, getDecisionLog: () => [{ at: 'now', kind: 'model', detail: 'T3 → mini' }] };

    const server = new DashboardServer(config, store, '/tmp');
    const sent: Array<{ event: string; payload: { cloud?: { costUsd: number; why: string }; outcome?: string; copyTurn?: boolean; prompt?: string } }> = [];
    await (server as unknown as {
      emitRunAccounting: (emit: (e: string, p: unknown) => void, sessionId: string, cascade: unknown, run: Record<string, unknown>) => Promise<void>;
    }).emitRunAccounting((event, payload) => sent.push({ event, payload: payload as never }), 's1', cascade,
      { prompt: 'q', output: 'a', outcome: 'answered', durationMs: 900, copyTurn: true });
    expect(sent.map((s) => s.event)).toEqual(['run:accounting']);
    expect(sent[0]!.payload).toMatchObject({ outcome: 'answered', copyTurn: true, prompt: 'q' });
    // When the run ended, so the cloud counts it on that day.
    expect((sent[0]!.payload as { endedAt?: number }).endedAt).toBeLessThanOrEqual(Date.now());
    // Kept, under an id, until a window confirms it: a run can end with no window open.
    const id = (sent[0]!.payload as { id?: string }).id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const pending = (server as unknown as { pendingAccounting: { unconfirmed(): Array<{ id: string }>; confirm(id: string): void } }).pendingAccounting;
    expect(pending.unconfirmed().map((r) => r.id)).toEqual([id]);
    pending.confirm(id!);
    expect(pending.unconfirmed()).toEqual([]);
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

  it('keeps an unconfirmed report for the next backend, on whatever port it starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-acct-'));
    try {
      const file = path.join(dir, 'pending-accounting.jsonl');
      const router = new CascadeRouter();
      (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
      (router as unknown as Record<string, unknown>)['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
      await router.init({ providers: [], models: {}, tools: { allowedTools: [] } } as unknown as CascadeConfig);
      (router as unknown as { recordStats: (t: string, m: { id: string; provider: string }, u: Record<string, number>) => void })
        .recordStats('T3', { id: 'mini', provider: 'openai' }, { inputTokens: 100, outputTokens: 0, totalTokens: 100, estimatedCostUsd: 0.0001 });
      const cascade = { getRouter: () => router, getDecisionLog: () => [] };
      const first = new DashboardServer({ ...config, dashboard: { ...config.dashboard, port: 51001 } } as CascadeConfig, store, '/tmp', { pendingAccountingFile: file });
      let sentId = '';
      await (first as unknown as {
        emitRunAccounting: (emit: (e: string, p: unknown) => void, sessionId: string, cascade: unknown, run: Record<string, unknown>) => Promise<void>;
      }).emitRunAccounting((_e, p) => { sentId = (p as { id: string }).id; }, 'sched', cascade,
        { prompt: 'q', output: 'a', outcome: 'answered', durationMs: 1, copyTurn: false });
      // No window confirmed it. The app restarts and its backend gets a new port.
      const next = new DashboardServer({ ...config, dashboard: { ...config.dashboard, port: 51002 } } as CascadeConfig, store, '/tmp', { pendingAccountingFile: file });
      const pending = (next as unknown as { pendingAccounting: { unconfirmed(): Array<{ id: string }> } }).pendingAccounting;
      expect(pending.unconfirmed().map((r) => r.id)).toEqual([sentId]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
