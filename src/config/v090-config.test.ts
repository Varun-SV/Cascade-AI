// ─────────────────────────────────────────────
//  Cascade AI — v0.9.0 config surface
// ─────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { CascadeConfigSchema } from './schema.js';

describe('v0.9.0 config', () => {
  it('defaults reflection off and t3Execution to auto', () => {
    const cfg = CascadeConfigSchema.parse({});
    expect(cfg.reflection.enabled).toBe(false);
    expect(cfg.reflection.maxRounds).toBe(1);
    expect(cfg.t3Execution).toBe('auto');
  });

  it('accepts reflection + t3Execution overrides', () => {
    const cfg = CascadeConfigSchema.parse({ reflection: { enabled: true, maxRounds: 3 }, t3Execution: 'sequential' });
    expect(cfg.reflection.enabled).toBe(true);
    expect(cfg.reflection.maxRounds).toBe(3);
    expect(cfg.t3Execution).toBe('sequential');
  });

  it('rejects an invalid t3Execution value', () => {
    expect(() => CascadeConfigSchema.parse({ t3Execution: 'fast' })).toThrow();
  });
});
