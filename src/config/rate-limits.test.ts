// ─────────────────────────────────────────────
//  Cascade AI — rateLimits config surface
// ─────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { CascadeConfigSchema } from './schema.js';

describe('rateLimits config', () => {
  it('is undefined by default (no override configured)', () => {
    const cfg = CascadeConfigSchema.parse({});
    expect(cfg.rateLimits).toBeUndefined();
  });

  it('survives validation instead of being stripped as an unknown key', () => {
    // Regression (Codex P2): CascadeConfigSchema is a plain z.object(), which
    // strips unrecognised keys by default. Before rateLimits was declared
    // here, config.rateLimits.providerTpm — the escape hatch documented in
    // tpm-limiter.ts for raising GitHub Models' conservative default — was
    // silently discarded by every call that goes through validateConfig(),
    // even though the router's own init() reads it.
    const cfg = CascadeConfigSchema.parse({
      rateLimits: { providerTpm: { 'openai-compatible': 20_000 } },
    });
    expect(cfg.rateLimits?.providerTpm?.['openai-compatible']).toBe(20_000);
  });

  it('rejects a non-positive override rather than silently disabling the limiter', () => {
    expect(() =>
      CascadeConfigSchema.parse({ rateLimits: { providerTpm: { openai: 0 } } }),
    ).toThrow();
  });
});
