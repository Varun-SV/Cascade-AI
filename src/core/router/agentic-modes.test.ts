// ─────────────────────────────────────────────
//  Cascade AI — router agentic modes (v0.9.0)
// ─────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import type { CascadeConfig } from '../../types.js';

function makeConfig(overrides: Partial<CascadeConfig> = {}): CascadeConfig {
  return { providers: [], models: {}, tools: { allowedTools: [] }, ...overrides } as unknown as CascadeConfig;
}

async function makeRouter(overrides: Partial<CascadeConfig> = {}): Promise<CascadeRouter> {
  const router = new CascadeRouter();
  (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
  await router.init(makeConfig(overrides));
  return router;
}

describe('router agentic modes', () => {
  it('t3Execution: auto resolves to parallel when the T3 tier is not local', async () => {
    expect((await makeRouter({})).getT3ExecutionMode()).toBe('parallel');
  });

  it('t3Execution: explicit sequential / parallel are honored', async () => {
    expect((await makeRouter({ t3Execution: 'sequential' } as Partial<CascadeConfig>)).getT3ExecutionMode()).toBe('sequential');
    expect((await makeRouter({ t3Execution: 'parallel' } as Partial<CascadeConfig>)).getT3ExecutionMode()).toBe('parallel');
  });

  it('t3Execution: auto resolves to sequential for a LOCAL T3 tier', async () => {
    const router = await makeRouter({});
    (router as unknown as { tierModels: Map<string, { isLocal: boolean }> }).tierModels.set('T3', { isLocal: true } as never);
    expect(router.getT3ExecutionMode()).toBe('sequential');
  });

  it('reflection: off by default, honored when configured', async () => {
    expect((await makeRouter({})).getReflectionConfig()).toEqual({ enabled: false, maxRounds: 1 });
    expect((await makeRouter({ reflection: { enabled: true, maxRounds: 2 } })).getReflectionConfig())
      .toEqual({ enabled: true, maxRounds: 2 });
  });

  it('setMaxTokensPerRun raises the per-task cap at runtime', async () => {
    const router = await makeRouter({ budget: { maxTokensPerRun: 100 } } as Partial<CascadeConfig>);
    router.setMaxTokensPerRun(500);
    const cfg = (router as unknown as { config: CascadeConfig }).config;
    expect(cfg.budget.maxTokensPerRun).toBe(500);
  });
});
