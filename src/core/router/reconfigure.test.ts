import { describe, it, expect, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import type { CascadeConfig, ModelInfo } from '../../types.js';

const model = { id: 'claude-sonnet-4-5', provider: 'anthropic' } as ModelInfo;
const config = (key: string) => ({ providers: [{ type: 'anthropic', apiKey: key }], models: {}, tools: {} } as unknown as CascadeConfig);

describe('router.init with new settings', () => {
  it('binds a model again with the new key, not the one it was first bound with', async () => {
    const router = new CascadeRouter();
    const r = router as unknown as Record<string, unknown> & { ensureProvider(m: ModelInfo, c: unknown): void; getProvider(m: ModelInfo): unknown };
    r['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
    await router.init(config('sk-old'));
    r.ensureProvider(model, config('sk-old').providers);
    const first = r.getProvider(model);
    // The same settings again keep the binding.
    await router.init(config('sk-old'));
    expect(r.getProvider(model)).toBe(first);
    // A new key (a /settings change) drops it, and the next call binds afresh.
    await router.init(config('sk-new'));
    expect(r.getProvider(model)).toBeUndefined();
    r.ensureProvider(model, config('sk-new').providers);
    expect((r.getProvider(model) as { config: { apiKey?: string } }).config.apiKey).toBe('sk-new');
  });

  it('a tier model kept across new settings is bound again, not left unbound (Codex on f8f4a10)', async () => {
    const router = new CascadeRouter();
    const r = router as unknown as Record<string, unknown> & { getProvider(m: ModelInfo): unknown; tierModels: Map<string, ModelInfo> };
    r['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
    await router.init(config('sk-old'));
    r.tierModels.set('T1', model);
    await router.init(config('sk-old'));
    await router.init(config('sk-new'));
    expect(r.tierModels.get('T1')).toBe(model);
    expect((r.getProvider(model) as { config: { apiKey?: string } }).config.apiKey).toBe('sk-new');
    // Its provider gone: the tier is chosen afresh rather than kept unbound.
    await router.init({ providers: [], models: {}, tools: {} } as unknown as CascadeConfig);
    expect(r.tierModels.get('T1')).not.toBe(model);
  });
});
