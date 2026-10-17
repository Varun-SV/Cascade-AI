// ─────────────────────────────────────────────
//  Cascade AI — Refs drawn on a screenshot
// ─────────────────────────────────────────────
//
//  The drawing itself runs in Chrome (OffscreenCanvas in an isolated world)
//  and was checked against a real page by eye. These hold the part that runs
//  here: that it is asked for in a world of its own, with what it needs, and
//  that every way it can fail hands back nothing rather than a broken picture.

import { describe, expect, it } from 'vitest';
import { drawMarks, type MarkSession } from './marks.js';

const IMAGE = { data: 'Q0xFQU4=', width: 1280, height: 800 };
const MARKS = [{ ref: 'e14', x: 10, y: 20, w: 100, h: 30 }];

function session(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const cdp: MarkSession = {
    async send(method, params) {
      calls.push({ method, ...(params ? { params } : {}) });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { cdp, calls };
}

const WORKS = {
  'Page.getFrameTree': { frameTree: { frame: { id: 'MAIN' } } },
  'Page.createIsolatedWorld': { executionContextId: 7 },
  'Runtime.evaluate': { result: { value: 'TUFSS0VE' } },
};

describe('drawMarks', () => {
  it('draws in an isolated world of its own, which the page\'s scripts cannot reach', async () => {
    const { cdp, calls } = session(WORKS);
    expect(await drawMarks(cdp, IMAGE, MARKS)).toBe('TUFSS0VE');
    expect(calls.map((c) => c.method)).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate']);
    expect(calls[1]!.params).toEqual({ frameId: 'MAIN', worldName: 'cascade-marks' });
    const evaluate = calls[2]!.params!;
    expect(evaluate).toMatchObject({ contextId: 7, awaitPromise: true, returnByValue: true });
    // On a canvas, not in the document.
    expect(evaluate['expression']).toContain('OffscreenCanvas');
    expect(evaluate['expression']).not.toMatch(/document\./);
    expect(evaluate['expression']).toContain('"ref":"e14"');
  });

  it('hands back the clean picture when there is nothing to mark', async () => {
    const { cdp, calls } = session(WORKS);
    expect(await drawMarks(cdp, IMAGE, [])).toBe(IMAGE.data);
    expect(calls).toEqual([]);
  });

  it('hands back nothing — never a broken picture — when it cannot draw', async () => {
    const cases: Array<Record<string, unknown>> = [
      { ...WORKS, 'Page.getFrameTree': {} },
      { ...WORKS, 'Page.createIsolatedWorld': {} },
      { ...WORKS, 'Runtime.evaluate': { exceptionDetails: { text: 'OffscreenCanvas is not defined' } } },
      { ...WORKS, 'Runtime.evaluate': { exceptionDetails: { text: 'Uncaught' }, result: { value: 'Error: canvas lost' } } },
      { ...WORKS, 'Runtime.evaluate': { result: { value: '' } } },
      { ...WORKS, 'Runtime.evaluate': { result: { value: 42 } } },
      { ...WORKS, 'Runtime.evaluate': new Error('Target closed') },
    ];
    for (const answers of cases) {
      expect(await drawMarks(session(answers).cdp, IMAGE, MARKS)).toBeNull();
    }
  });
});
