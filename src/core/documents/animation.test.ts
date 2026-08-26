// ─────────────────────────────────────────────
//  Cascade AI — pptx tables and animation
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseSlide, splitSlides, parseAnimationDirective, parseBlocks } from './blocks.js';
import { renderPptx } from './render.js';
import {
  animateSlideXml,
  animatePptx,
  renumberShapes,
  timingXml,
  transitionXml,
  DEFAULT_ANIMATION,
} from './animate.js';

const deck = `# Quarterly numbers

Revenue held up.

| Region | Q1 | Q2 |
|--------|----|----|
| EMEA   | 12 | 18 |
| APAC   |  9 | 14 |
`;

describe('a Markdown table becomes a real PowerPoint table', () => {
  it('parses table rows out of a slide instead of bulleting them', () => {
    // The bug as a behaviour: parseSlide had branches for headings, images,
    // list items, quotes and chart fences, and none for `|…|`. Every row fell
    // through to the paragraph branch, so a deck showed `|---|---|` as literal
    // text where Word, from the SAME Markdown, showed a real table.
    const slide = parseSlide(deck);
    expect(slide.tables).toHaveLength(1);
    expect(slide.tables[0]).toEqual([
      ['Region', 'Q1', 'Q2'],
      ['EMEA', '12', '18'],
      ['APAC', '9', '14'],
    ]);
    // …and none of it is left behind as bullet text.
    expect(slide.body.join(' ')).not.toContain('|');
    expect(slide.body).toContain('Revenue held up.');
  });

  it('drops the alignment rule rather than rendering it as a row', () => {
    expect(parseSlide(deck).tables[0]!.some((r) => r.join('').includes('---'))).toBe(false);
  });

  it('keeps inline markup in cells for the renderer that can style it', () => {
    // The Word renderer puts every cell through inlineRuns, so **Total** is
    // bold in a docx table. Stripping markup in the shared scanner — which the
    // first version of it did — silently flattened every one of them.
    const blocks = parseBlocks('| Item | Cost |\n|---|---|\n| **Total** | `42` |');
    const table = blocks.find((b) => b.t === 'table');
    expect(table && table.t === 'table' && table.rows[1]).toEqual(['**Total**', '`42`']);
  });

  it('strips that markup on the way into a slide, where it cannot be styled', async () => {
    const zip = await JSZip.loadAsync(await renderPptx('# T\n\n| Item | Cost |\n|---|---|\n| **Total** | 42 |'));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('Total');
    expect(xml).not.toContain('**Total**');
  });

  it('reads a table written without outer pipes', () => {
    // Ordinary Markdown. Requiring the leading pipe left this common form as
    // bullet text while the tool description advertised plain Markdown tables.
    const slide = parseSlide('# T\n\nName | Score\n--- | ---\nAda | 99');
    expect(slide.tables[0]).toEqual([['Name', 'Score'], ['Ada', '99']]);
  });

  it('does not turn a line that merely opens with a pipe into a table', () => {
    // `| alternative syntax` is prose. The predicate this replaced required a
    // closing delimiter, and dropping that turned one-pipe lines into
    // single-cell tables in both Word and PowerPoint.
    const slide = parseSlide('# T\n\n| alternative syntax\n\nAnd more prose.');
    expect(slide.tables).toHaveLength(0);
    expect(slide.body.join(' ')).toContain('alternative syntax');
  });

  it('does not turn prose containing a pipe into a table', () => {
    // The other half of that change: a bare pipe is ordinary punctuation, so a
    // line only opens a table when the next line is the alignment rule.
    const slide = parseSlide('# T\n\nRun `ls | wc -l` to count them.\n\nThen read the output.');
    expect(slide.tables).toHaveLength(0);
    expect(slide.body.join(' ')).toContain('wc -l');
  });

  it('treats an escaped pipe as content, not a column break', () => {
    // `| A \| B | union |` is a two-column row. Splitting on every pipe made a
    // phantom third column and left the backslash in the text.
    const slide = parseSlide('# T\n\n| Expression | Meaning |\n|---|---|\n| A \\| B | union |');
    expect(slide.tables[0]![1]).toEqual(['A | B', 'union']);
  });

  it('leaves a table-shaped line inside a code fence as code', () => {
    // Only chart: fences were consumed, so a code sample containing
    // `| in | out |` had that line lifted out as a real table while its
    // backticks stayed behind in the body.
    const slide = parseSlide('# T\n\n```\n| in | out |\n| 1  | 2   |\n```\n\nAfter.');
    expect(slide.tables).toHaveLength(0);
    expect(slide.body.join(' ')).not.toContain('```');
    expect(slide.body.join(' ')).toContain('| in | out |');
  });

  it('does not backtrack itself to death on a pathological row', () => {
    // CodeQL, high severity: the obvious alignment-rule regex
    // /^\|[\s:|-]+\|?\s*$/ puts two whitespace-matching quantifiers next to
    // each other, so `|` plus a long run of tabs makes the engine try every
    // split between them. Document text is model-authored and can be
    // arbitrarily long — precisely the input class where quadratic matching
    // stops being academic. Measured on the old pattern: 2k tabs 4ms, 4k 17ms,
    // 8k 64ms — doubling the input quadruples the time, so 60k runs seconds.
    //
    // The row must END in a pipe, or isTableRow rejects it before the
    // alignment check ever runs and the test passes against the bug. It did.
    const evil = `|${'\t'.repeat(60_000)}x|`;
    const started = Date.now();
    const slide = parseSlide(`# T\n\n${evil}`);
    expect(Date.now() - started, 'linear scan, not polynomial backtracking').toBeLessThan(1_000);
    // …and it is still read as a data row, since it is not an alignment rule.
    expect(slide.tables.length + slide.body.length).toBeGreaterThan(0);
  });

  it('keeps a slide that is nothing but a table', () => {
    const slides = splitSlides('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(slides).toHaveLength(1);
    expect(slides[0]!.tables[0]).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('emits a real table shape in the rendered file', async () => {
    const zip = await JSZip.loadAsync(await renderPptx(deck));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    // <a:tbl> is the DrawingML table — an actual grid a user can edit, not a
    // text box that happens to contain pipes.
    expect(xml).toContain('<a:tbl>');
    expect(xml).toContain('EMEA');
  });
});

describe('a long table stays on the slide', () => {
  it('cuts a table that cannot fit and says how much was dropped', async () => {
    // pptxgenjs draws every row it is given and autoPage defaults off, so a
    // long table ran past the bottom edge and those rows were simply not in
    // the deck — no warning, no indication anything was missing.
    const rows = Array.from({ length: 60 }, (_, i) => `| row ${i} | ${i} |`).join('\n');
    const zip = await JSZip.loadAsync(await renderPptx(`# Big\n\n| a | b |\n|---|---|\n${rows}`));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toMatch(/\+\d+ more rows/);
    expect(xml).not.toContain('row 59');
  });

  it('leaves a table that fits alone', async () => {
    const zip = await JSZip.loadAsync(await renderPptx('# Small\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).not.toMatch(/more rows/);
    expect(xml).toContain('3');
  });
});

describe('shape ids have to be unique before anything can be animated', () => {
  it('renumbers the duplicate ids pptxgenjs emits', () => {
    // Not defensive tidying: pptxgenjs numbers shapes per KIND, so a slide with
    // two text boxes and a table emits id=2 twice. Animations address shapes by
    // spid, so on unrenumbered output an animation aimed at id=2 hits whichever
    // shape PowerPoint happens to resolve first.
    const xml = '<p:sld><p:cNvPr id="1" name=""/><p:cNvPr id="2" name="Text 0"/>'
      + '<p:cNvPr id="3" name="Text 1"/><p:cNvPr id="2" name="Table 0"/></p:sld>';
    const { xml: out, shapeIds } = renumberShapes(xml);
    const ids = [...out.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => Number(m[1]));
    expect(new Set(ids).size, 'every shape needs its own id').toBe(ids.length);
    // The first cNvPr belongs to the shape tree itself and is not animatable.
    expect(shapeIds).toEqual(ids.slice(1));
  });

  it('preserves shape names while renumbering', () => {
    const { xml } = renumberShapes('<p:cNvPr id="9" name="Chart 0"/>');
    expect(xml).toContain('name="Chart 0"');
  });
});

describe('the timing tree', () => {
  it('gives every shape its own entrance targeting that shape', () => {
    const xml = timingXml([3, 4], DEFAULT_ANIMATION);
    expect([...xml.matchAll(/spid="(\d+)"/g)].map((m) => m[1])).toEqual(['3', '3', '4', '4']);
  });

  it('uses unique cTn ids, because duplicates are what corrupt a deck', () => {
    const xml = timingXml([3, 4, 5], DEFAULT_ANIMATION);
    const ids = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes every shape wait for its own click', () => {
    // "On click" means the presenter advances each build. Gating only the
    // first step made one click reveal the whole slide — which is `auto` with
    // an extra keypress, not a build.
    const xml = timingXml([3, 4, 5], { ...DEFAULT_ANIMATION, advance: 'click' });
    expect(xml.match(/delay="indefinite"/g)).toHaveLength(3);
    expect(xml.match(/nodeType="clickEffect"/g)).toHaveLength(3);
    expect(xml).not.toContain('afterEffect');
  });

  it('never waits when the deck advances on its own', () => {
    const xml = timingXml([3, 4], { ...DEFAULT_ANIMATION, advance: 'auto' });
    expect(xml).not.toContain('delay="indefinite"');
  });

  it('writes nothing at all when entrance is off', () => {
    expect(timingXml([3, 4], { ...DEFAULT_ANIMATION, entrance: 'none' })).toBe('');
  });

  it('writes nothing for a slide with no shapes', () => {
    expect(timingXml([], DEFAULT_ANIMATION)).toBe('');
  });

  it('always sets visibility as well as playing the effect', () => {
    // A reader that does not understand the effect still has to show the shape.
    // Without the set, an unrecognised filter leaves it invisible forever.
    const xml = timingXml([3], DEFAULT_ANIMATION);
    expect(xml).toContain('style.visibility');
    expect(xml).toContain('<p:strVal val="visible"/>');
  });
});

describe('animateSlideXml', () => {
  const slide = '<p:sld><p:cSld><p:spTree><p:cNvPr id="1" name=""/>'
    + '<p:cNvPr id="2" name="Text 0"/></p:spTree></p:cSld>'
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';

  it('places transition and timing after clrMapOvr, where the schema requires', () => {
    const out = animateSlideXml(slide, DEFAULT_ANIMATION);
    expect(out.indexOf('<p:transition')).toBeGreaterThan(out.indexOf('</p:clrMapOvr>'));
    expect(out.indexOf('<p:timing')).toBeGreaterThan(out.indexOf('<p:transition'));
    expect(out.endsWith('</p:sld>')).toBe(true);
  });

  it('leaves a slide that already has timing alone', () => {
    // A second, conflicting timeline is how a deck stops opening.
    const already = slide.replace('</p:sld>', '<p:timing/></p:sld>');
    expect(animateSlideXml(already, DEFAULT_ANIMATION)).toBe(already);
  });

  it('adds nothing when both transition and entrance are off', () => {
    const off = { ...DEFAULT_ANIMATION, transition: 'none' as const, entrance: 'none' as const };
    expect(animateSlideXml(slide, off)).not.toContain('<p:timing');
    expect(animateSlideXml(slide, off)).not.toContain('<p:transition');
  });

  it('writes a transition even when entrances are off', () => {
    const out = animateSlideXml(slide, { ...DEFAULT_ANIMATION, entrance: 'none' });
    expect(out).toContain('<p:transition');
    expect(out).not.toContain('<p:timing');
  });
});

describe('animation reaches the rendered deck', () => {
  it('animates every slide, not just the first', async () => {
    const zip = await JSZip.loadAsync(await renderPptx('# One\n\n- a\n\n---\n\n# Two\n\n- b'));
    for (const path of ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']) {
      const xml = await zip.file(path)!.async('string');
      expect(xml, path).toContain('<p:timing');
      expect(xml, path).toContain('<p:transition');
    }
  });

  it('hands back the original deck rather than throwing on unreadable bytes', async () => {
    // Failing here costs the animation; throwing costs the whole export, and
    // the deck was fine before this step opened it.
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await animatePptx(bytes, DEFAULT_ANIMATION)).toBe(bytes);
  });

  it('still fixes duplicate shape ids when animation is switched off', async () => {
    // The ids are invalid OOXML on their own account — every reference to a
    // shape resolves through them. Animation is only what made it visible.
    const zip = await JSZip.loadAsync(await renderPptx('animation: none\n\n# One\n\n- a\n\n| x | y |\n|---|---|\n| 1 | 2 |'));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(xml).not.toContain('<p:timing');
  });
});

describe('host animation options', () => {
  it('ignores fields that are present but undefined', async () => {
    // exactOptionalPropertyTypes is off, so a caller assembling this from
    // optional config can legally pass { durationMs: undefined }. A plain
    // spread put that over the default and emitted dur="NaN" — which
    // PowerPoint reads as a corrupt file, not a bad animation.
    const zip = await JSZip.loadAsync(await renderPptx('# One\n\n- a', {
      animation: { durationMs: undefined, transition: undefined },
    }));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).not.toContain('NaN');
    expect(xml).not.toContain('undefined');
    expect(xml).toContain('<p:fade/>');
  });

  it('rejects an out-of-range host value the same way it rejects a bad directive', async () => {
    const zip = await JSZip.loadAsync(await renderPptx('# One\n\n- a', {
      animation: { transition: 'explode' as never, durationMs: -5 },
    }));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('<p:fade/>');
    expect(xml).not.toContain('explode');
    expect(xml).not.toContain('dur="-5"');
  });
});

describe('the animation directive', () => {
  it('turns everything off', () => {
    const { directive, rest } = parseAnimationDirective('animation: none\n\n# Slide');
    expect(directive).toEqual({ transition: 'none', entrance: 'none' });
    expect(rest.trim()).toBe('# Slide');
  });

  it('reads individual settings', () => {
    const { directive } = parseAnimationDirective('animation: transition=push entrance=fly advance=auto duration=300');
    expect(directive).toEqual({ transition: 'push', entrance: 'fly', advance: 'auto', duration: '300' });
  });

  it('leaves ordinary Markdown alone', () => {
    const md = '# A deck about animation: a history';
    expect(parseAnimationDirective(md)).toEqual({ rest: md, directive: null });
  });

  it('actually changes the rendered deck', async () => {
    const zip = await JSZip.loadAsync(await renderPptx('animation: none\n\n# One\n\n- a'));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).not.toContain('<p:timing');
    expect(xml).not.toContain('<p:transition');
  });

  it('ignores a nonsense duration rather than writing dur="NaN"', async () => {
    // PowerPoint reads a malformed duration as a corrupt file, not a slow fade.
    const zip = await JSZip.loadAsync(await renderPptx('animation: duration=soon\n\n# One\n\n- a'));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).not.toContain('NaN');
    expect(xml).toContain('<p:timing');
  });

  it('ignores an unknown value rather than writing it into the XML', async () => {
    const zip = await JSZip.loadAsync(await renderPptx('animation: transition=explode\n\n# One\n\n- a'));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('<p:fade/>');
    expect(xml).not.toContain('explode');
  });
});

describe('transitionXml', () => {
  it('writes nothing for none', () => {
    expect(transitionXml({ ...DEFAULT_ANIMATION, transition: 'none' })).toBe('');
  });
  it('writes the named transition', () => {
    expect(transitionXml({ ...DEFAULT_ANIMATION, transition: 'wipe' })).toContain('<p:wipe');
  });
});
