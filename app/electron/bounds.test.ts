// ─────────────────────────────────────────────
//  Cascade Desktop — Browser view bounds
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { normalizeBounds } from './bounds.js';

describe('normalizeBounds', () => {
  it('rounds fractional coordinates — the case getBoundingClientRect() produces on scaled displays', () => {
    // WebContentsView.setBounds() rejects a non-integer Rectangle silently;
    // the page just never appears, with nothing on screen to explain why.
    expect(normalizeBounds({ x: 10.4, y: 20.6, width: 300.5, height: 200.49 }))
      .toEqual({ x: 10, y: 21, width: 301, height: 200 });
  });

  it('leaves already-integer bounds untouched', () => {
    expect(normalizeBounds({ x: 0, y: 0, width: 800, height: 600 }))
      .toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('clamps a negative width/height to zero rather than passing it through', () => {
    expect(normalizeBounds({ x: 0, y: 0, width: -5.2, height: -0.1 }))
      .toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('does not clamp negative x/y — a view can legitimately sit partly off-screen', () => {
    expect(normalizeBounds({ x: -12.6, y: -3.1, width: 100, height: 100 }).x).toBe(-13);
  });
});
