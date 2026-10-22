// ─────────────────────────────────────────────
//  Cascade AI — a desktop run's accounting for the cloud
// ─────────────────────────────────────────────
//
//  The desktop copies a finished run into the user's cloud chat. What the run
//  cost has to go with it, or the cloud's spend report never counts the run:
//  the app sends what `run:accounting` carries as `cloud`, which the backend
//  sends once the run's calls have settled.

import { describe, expect, it, vi } from 'vitest';
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
});
