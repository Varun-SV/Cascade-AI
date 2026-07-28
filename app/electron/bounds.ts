// ─────────────────────────────────────────────
//  Cascade Desktop — Browser view bounds
// ─────────────────────────────────────────────
//
// Split out from browser.ts so it can be tested without importing electron.

/** Where the renderer wants the page drawn, in renderer CSS pixels. */
export interface Bounds { x: number; y: number; width: number; height: number }

/**
 * Round to the integers Electron's `Rectangle` contract requires.
 *
 * `getBoundingClientRect()` returns fractional values on fractional display
 * scaling, and `WebContentsView.setBounds()` rejects a non-integer silently —
 * the page never appears, with no error the renderer can see. Applied to
 * every bounds update, including the FIRST one at `browser:open`, so the
 * initial paint doesn't fail the one time it matters most: a newly opened tab
 * with nothing on screen yet to explain why.
 */
export function normalizeBounds(b: Bounds): Bounds {
  return {
    x: Math.round(b.x), y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)),
  };
}
