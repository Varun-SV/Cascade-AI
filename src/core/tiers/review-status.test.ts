// ─────────────────────────────────────────────
//  Cascade AI — an approved pass clears the card
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { parseReviewResponse } from './review.js';

describe('an approved verdict is a clear, not a silence', () => {
  it('carries no gaps, so a client can tell it apart from "no review here"', () => {
    // The distinction the UI needs. A status event with no review field means
    // "nothing to say"; one carrying an approved verdict means "the previous
    // rejection is over". Without the second, a rejection card sat on screen
    // saying "replanning" while the run assembled an accepted result.
    const v = parseReviewResponse('APPROVED');
    expect(v.approved).toBe(true);
    expect(v.gaps).toEqual([]);
    expect(v.summary).toBeUndefined();
  });
});
