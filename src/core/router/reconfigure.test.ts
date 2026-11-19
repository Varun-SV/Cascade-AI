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
});
