// ─────────────────────────────────────────────
//  Cascade AI — plan-review config surface
// ─────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { CascadeConfigSchema } from './schema.js';

describe('plan-review config', () => {
  it('accepts the broadened planApproval values and applies planReview defaults', () => {
    const cfg = CascadeConfigSchema.parse({ planApproval: 'all' });
    expect(cfg.planApproval).toBe('all');
    expect(cfg.planReview.editable).toBe(true);
    expect(cfg.planReview.autoReviewer).toBe(false);
    expect(cfg.planReview.maxRevisionRounds).toBe(5);
  });

  it("keeps 'always' for back-compat and defaults to 'never'", () => {
    expect(CascadeConfigSchema.parse({ planApproval: 'always' }).planApproval).toBe('always');
    expect(CascadeConfigSchema.parse({}).planApproval).toBe('never');
  });

  it('honours explicit planReview overrides', () => {
    const cfg = CascadeConfigSchema.parse({ planReview: { autoReviewer: true, editable: false, maxRevisionRounds: 2 } });
    expect(cfg.planReview.autoReviewer).toBe(true);
    expect(cfg.planReview.editable).toBe(false);
    expect(cfg.planReview.maxRevisionRounds).toBe(2);
  });
});
