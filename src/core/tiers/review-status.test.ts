// ─────────────────────────────────────────────
//  Cascade AI — an approved pass clears the card
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { parseReviewResponse } from './review.js';
import { BaseTier } from './base.js';

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

describe('an explicit review clear survives the status emit', () => {
  it('forwards review: null rather than dropping it as falsy', () => {
    // The clear T1 sends when the correction loop stops on a rejection is
    // `null`. base.ts tested `update.review` for TRUTHINESS, which drops null —
    // and on the client an absent `review` means "carry the last one forward",
    // so the stale rejection card this is meant to clear would have stayed on
    // screen. The fix is invisible in T1's own unit tests; it lives here.
    const events: Array<Record<string, unknown>> = [];
    class Probe extends BaseTier {
      protected router = {} as never;
      constructor() { super('T1'); }
      async execute(): Promise<void> { /* unused */ }
      emitClear(): void { this.sendStatusUpdate({ currentAction: 'Compiling final output', status: 'IN_PROGRESS', review: null }); }
      emitNothing(): void { this.sendStatusUpdate({ currentAction: 'Working', status: 'IN_PROGRESS' }); }
    }
    const probe = new Probe();
    probe.on('tier:status', (e) => events.push(e as Record<string, unknown>));

    probe.emitClear();
    expect('review' in events[0]!, 'the clear must be present on the wire').toBe(true);
    expect(events[0]!['review']).toBeNull();

    // An update that carries no verdict must still omit the key entirely —
    // that is what lets the client carry the last review forward.
    probe.emitNothing();
    expect('review' in events[1]!).toBe(false);
  });
});
