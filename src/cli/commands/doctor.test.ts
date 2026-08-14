// ─────────────────────────────────────────────
//  Cascade AI — `cascade doctor` reporting
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { linkableCredentialsDetail } from './doctor.js';

describe('what doctor says about discovered credentials', () => {
  it('offers `cascade link` when something would actually be adopted', () => {
    expect(linkableCredentialsDetail([{ directlyUsable: true }, { directlyUsable: false }]))
      .toBe('2 found (1 usable) — run `cascade link` to adopt');
  });

  it('does not prescribe adoption when nothing can be adopted', () => {
    // The case this exists for: a Claude Code subscription token is the only
    // credential on the machine, and `cascade link` is REQUIRED to refuse it.
    // Telling the user to run link anyway makes an unusable credential read as
    // a step they forgot to take.
    const detail = linkableCredentialsDetail([{ directlyUsable: false }]);
    expect(detail).not.toContain('to adopt');
    expect(detail).toBe('1 found, none usable — run `cascade link` to see why');
  });
});
