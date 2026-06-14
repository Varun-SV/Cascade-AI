// ─────────────────────────────────────────────
//  Cascade AI — agentic config surface (v0.8.0)
// ─────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { CascadeConfigSchema } from './schema.js';

describe('agentic config', () => {
  it('defaults autonomy to manual and maxReplanPasses to 2', () => {
    const cfg = CascadeConfigSchema.parse({});
    expect(cfg.autonomy).toBe('manual');
    expect(cfg.maxReplanPasses).toBe(2);
  });

  it('accepts autonomy: auto and a custom maxReplanPasses', () => {
    const cfg = CascadeConfigSchema.parse({ autonomy: 'auto', maxReplanPasses: 4 });
    expect(cfg.autonomy).toBe('auto');
    expect(cfg.maxReplanPasses).toBe(4);
  });

  it('rejects an unknown autonomy value', () => {
    expect(() => CascadeConfigSchema.parse({ autonomy: 'yolo' })).toThrow();
  });
});
