// ─────────────────────────────────────────────
//  Cascade AI — review verdict parsing
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { parseReviewResponse, reviewStatusLine } from './review.js';

/** The shape the reviewer is asked for. */
const structured = `REJECTED
Summary: The output partly answers the request; four things are missing.
- Requested internet search is not evidenced || sections 1, 2, 4 || No sources cited and no findings quoted.
- One thesis where a range was asked for || all || Everything converges on a single control-plane pitch.
- No build-vs-buy comparison || Build vs buy, Risks || Directions are never pressure-tested against each other.
- Unrequested background included || section 5 ||`;

describe('a verdict is data, not a paragraph', () => {
  it('reads the summary and the gaps', () => {
    const v = parseReviewResponse(structured);
    expect(v.approved).toBe(false);
    expect(v.summary).toBe('The output partly answers the request; four things are missing.');
    expect(v.gaps).toHaveLength(4);
    expect(v.gaps[0]).toEqual({
      title: 'Requested internet search is not evidenced',
      sections: ['sections 1', '2', '4'],
      detail: 'No sources cited and no findings quoted.',
    });
  });

  it('treats "all" as no attribution rather than a section named all', () => {
    expect(parseReviewResponse(structured).gaps[1]!.sections).toBeUndefined();
  });

  it('omits detail when the reviewer left it empty', () => {
    expect(parseReviewResponse(structured).gaps[3]!.detail).toBeUndefined();
  });

  it('keeps a section title that contains "and" whole', () => {
    // Splitting on " and " invented two sections, neither of them in the plan.
    const v = parseReviewResponse('REJECTED\nSummary: s\n- gap || Research and Development ||');
    expect(v.gaps[0]!.sections).toEqual(['Research and Development']);
  });

  it('keeps a section title that merely starts with "All"', () => {
    // `/^all\b/` read this as the wildcard and dropped the attribution.
    const v = parseReviewResponse('REJECTED\nSummary: s\n- gap || All Hands Migration ||');
    expect(v.gaps[0]!.sections).toEqual(['All Hands Migration']);
  });

  it('still reads the bare wildcard as every section', () => {
    for (const raw of ['all', 'All', 'all sections', '-']) {
      const v = parseReviewResponse(`REJECTED\nSummary: s\n- gap || ${raw} ||`);
      expect(v.gaps[0]!.sections, raw).toBeUndefined();
    }
  });

  it('keeps a summary short enough for a status line', () => {
    // The whole point. This string is rendered unclamped by the web chat's
    // status button, so anything long here is a wall of text on screen.
    const v = parseReviewResponse(`REJECTED\nSummary: ${'word '.repeat(200)}\n- a gap || all ||`);
    expect(v.summary!.length).toBeLessThanOrEqual(121);
  });

  it('accepts numbered items, because models write those too', () => {
    const v = parseReviewResponse('REJECTED\nSummary: two missing\n1. first thing\n2. second thing');
    expect(v.gaps.map((g) => g.title)).toEqual(['first thing', 'second thing']);
  });

  it('recognises approval', () => {
    expect(parseReviewResponse('APPROVED').approved).toBe(true);
    expect(parseReviewResponse('  approved  \n').approved).toBe(true);
    expect(parseReviewResponse('APPROVED').gaps).toEqual([]);
  });
});

describe('when the reviewer answers in prose anyway', () => {
  // Some model, some day, will ignore the format. The fallback has to degrade
  // to a SHORT summary plus a gap — putting the paragraph in `summary` would
  // reproduce the exact bug this replaces.
  const prose = 'The outputs only partially satisfy the request. '
    + 'The user asked for an internet search and there is no evidence of one, no cited sources, '
    + 'and no concrete findings. The summaries also converge on a single thesis rather than offering '
    + 'a range of distinct product directions to compare.';

  it('does not put the paragraph on the status line', () => {
    const v = parseReviewResponse(`REJECTED: ${prose}`);
    expect(v.summary!.length).toBeLessThanOrEqual(121);
    expect(v.summary).toBe('The outputs only partially satisfy the request.');
  });

  it('keeps the rest as a gap rather than losing it', () => {
    const v = parseReviewResponse(`REJECTED: ${prose}`);
    expect(v.gaps).toHaveLength(1);
    expect(v.gaps[0]!.title).toContain('no cited sources');
  });

  it('still hands the correction prompt the full detail', () => {
    // The replan needs everything; only the STATUS line needs to be short.
    const v = parseReviewResponse(structured);
    expect(v.reason).toContain('No sources cited');
    expect(v.reason).toContain('Build vs buy');
    expect(v.reason!.split('\n')).toHaveLength(5);
  });
});

describe('a rejection with nothing in it', () => {
  // An empty or truncated response that got as far as REJECTED. This used to
  // produce approved:false with zero gaps and the summary "0 things are
  // missing" — the orchestrator spent a corrective pass on a reason that said
  // nothing, while the client read zero gaps as an approval and cleared the
  // card. Whatever it does, the two have to agree.
  it('is still a rejection, and still has something to show', () => {
    for (const raw of ['REJECTED', 'REJECTED:', 'REJECTED\n\n', 'REJECTED: \n']) {
      const v = parseReviewResponse(raw);
      expect(v.approved, raw).toBe(false);
      expect(v.gaps.length, raw).toBe(1);
      expect(v.summary, raw).toBeTruthy();
      expect(v.summary, raw).not.toContain('0 things');
    }
  });

  it('never reports a count it does not have', () => {
    const line = reviewStatusLine(parseReviewResponse('REJECTED'), 1, 2);
    expect(line).toContain('1 gap,');
    expect(line).not.toContain('0 gap');
  });
});

describe('the status line', () => {
  it('fits the tightest budget any surface imposes', () => {
    // The CLI truncates currentAction at 38 characters in the agent tree. This
    // will not fit that, but it must stay readable when it is cut — and it must
    // fit the 80-character status bar whole.
    const v = parseReviewResponse(structured);
    const line = reviewStatusLine(v, 1, 2);
    expect(line).toBe('The output partly answers the request; four things are… — 4 gaps, pass 1 of 2');
    expect(line.length).toBeLessThanOrEqual(80);
    // The summary leads, so the 38-character cut still says what is wrong.
    expect(line.slice(0, 38)).toContain('partly answers');
  });

  it('carries the summary, which is all three non-cloud surfaces get', () => {
    // Only cloud/web renders the structured verdict as a card. The CLI, the
    // local dashboard and the desktop drawer show currentAction alone, so a
    // line without the summary tells them the run is repeating but not why.
    const v = parseReviewResponse(structured);
    expect(reviewStatusLine(v, 1, 2)).toContain('partly answers the request');
  });

  it('still fits 80 characters at the widest counter', () => {
    const gaps = Array.from({ length: 12 }, (_, i) => `- gap ${i} || all ||`).join('\n');
    const v = parseReviewResponse(
      `REJECTED\nSummary: ${'x'.repeat(300)}\n${gaps}`,
    );
    const line = reviewStatusLine(v, 9, 9);
    expect(line).toContain('12 gaps, pass 9 of 9');
    expect(line.length).toBeLessThanOrEqual(80);
  });

  it('does not say "1 gaps"', () => {
    const v = parseReviewResponse('REJECTED\nSummary: one thing\n- a single gap || all ||');
    expect(reviewStatusLine(v, 2, 2)).toBe('one thing — 1 gap, pass 2 of 2');
  });

  it('falls back to the count when there is no summary to lead with', () => {
    expect(reviewStatusLine({ approved: false, gaps: [{ title: 'x' }, { title: 'y' }] }, 1, 3))
      .toBe('Review found 2 gaps — replanning, pass 1 of 3');
  });
});
