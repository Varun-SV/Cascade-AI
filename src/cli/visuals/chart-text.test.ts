import { describe, expect, it } from 'vitest';
import { parseChartSpec } from '../../core/documents/blocks.js';
import stringWidth from 'string-width';
import { chartToLines, shortNumber } from './chart-text.js';

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const draw = (kind: Parameters<typeof parseChartSpec>[0], body: string, width = 80) =>
  chartToLines(parseChartSpec(kind, body)!, width).map(plain);

const WORDS = `title: Fiction Word Count Standards vs Current Manuscript
Format,Word Count
Flash Fiction,1000
Short Story,7500
Current Manuscript (20 pages),9542
Novelette Ceiling,17500
Commercial Novel Target,80000`;

describe('charts in the terminal', () => {
  it('bar: a row per category, bars to scale, every value written out', () => {
    const lines = draw('bar', WORDS);
    expect(lines[0]).toBe('Fiction Word Count Standards vs Current Manuscript');
    const row = (name: string) => lines.find((l) => l.startsWith(name))!;
    expect(row('Flash Fiction')).toMatch(/1,000$/);
    expect(row('Commercial Novel Target')).toMatch(/80,000$/);
    const len = (name: string) => (row(name).match(/[█▌▏]+/)?.[0] ?? '').length;
    expect(len('Commercial Novel Target')).toBeGreaterThan(len('Novelette Ceiling') * 4);
    expect(len('Flash Fiction')).toBeGreaterThan(0);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
  });

  it('bar with several series: grouped per category, with a legend', () => {
    const lines = draw('bar', 'Quarter,Revenue,Costs\nQ1,120,80\nQ2,150,95');
    expect(lines.filter((l) => l.startsWith('Q1')).length).toBe(1);
    expect(lines.at(-1)).toContain('■ Revenue');
    expect(lines.at(-1)).toContain('■ Costs');
  });

  it('pie: one bar split by share, exactly as wide as asked, and percentages that add up', () => {
    const lines = draw('pie', 'Part,Share\nA,50\nB,30\nC,20', 60);
    expect(lines[0]!.length).toBe(58);
    expect(lines.find((l) => l.includes(' A '))).toContain('50.0%');
    expect(lines.find((l) => l.includes(' C '))).toContain('20.0%');
  });

  it('line: braille dots on an axis with its range and first and last labels', () => {
    const lines = draw('line', 'Month,Users\nJan,10\nFeb,40\nMar,25\nApr,90', 60);
    expect(lines[0]).toMatch(/^90 ┤/);
    expect(lines.find((l) => /^10 ┤/.test(l))).toBeTruthy();
    expect(lines.some((l) => /[⠁-⣿]/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/Jan.*Apr/);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
  });

  it('a pie of zeros says so instead of drawing nothing', () => {
    expect(draw('pie', 'Part,Share\nA,0\nB,0').join('\n')).toContain('every value is zero');
  });

  it('numbers as people write them', () => {
    expect(shortNumber(9542)).toBe('9,542');
    expect(shortNumber(80000)).toBe('80,000');
    expect(shortNumber(1_500_000)).toBe('1.5M');
    expect(shortNumber(0.125)).toBe('0.13');
  });
});

describe('charts in a reply shown as plain lines', () => {
  it('a chart block is replaced by its drawing; one that does not parse stays', async () => {
    const { expandCharts } = await import('./chart-text.js');
    const out = plain(expandCharts('Intro\n```chart:bar\nItem,Value\nA,1\nB,2\n```\n```chart:bar\nonly\n```\nEnd', 60));
    expect(out).toMatch(/^Intro\nA +[█▌]+ 1\nB +[█▌]+ 2\n/);
    expect(out).toContain('```chart:bar\nonly\n```');
    expect(out).not.toContain('Item,Value');
  });
});

describe('Codex on 5721352', () => {
  it('on a narrow terminal the labels give way and the value is never cut', () => {
    const lines = draw('bar', 'Format,Words\nCommercial Novel Target,80000\nFlash Fiction,1000', 30);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(30);
    expect(lines.find((l) => l.startsWith('Comm'))).toMatch(/80,000$/);
  });

  it('many unclosed chart fences are passed over in linear time, as written', async () => {
    const { expandCharts } = await import('./chart-text.js');
    const text = '```chart:bar\nA,1\n'.repeat(8000);
    const t0 = performance.now();
    expect(expandCharts(text, 60)).toBe(text);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('a block that does not parse is passed over whole, openers inside it included', async () => {
    const { expandCharts } = await import('./chart-text.js');
    const block = '```chart:bar\nonly\n```chart:bar\n```';
    expect(expandCharts(block, 60)).toBe(block);
  });
});

describe('Codex on f697ac7', () => {
  it('a flat series of huge values is drawn, not thrown on', () => {
    const lines = draw('line', 'Day,Bytes\nMon,1e16\nTue,1e16\nWed,1e16', 60);
    expect(lines.some((l) => /[⠁-⣿]/.test(l))).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
  });

  it('a pie legend on a narrow terminal keeps its share and value', () => {
    const lines = draw('pie', 'Format,Words\nCommercial Novel Target,80000\nFlash Fiction,1000', 30);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(30);
    expect(lines.find((l) => l.includes('98.8%'))).toMatch(/98\.8%\s+80,000$/);
  });
});

describe('Codex on 356220c', () => {
  const columns = (s: string) => stringWidth(s);

  it('labels are measured in terminal columns: a double-width name never pushes its value off', () => {
    const bar = draw('bar', 'Name,Value\n東京の長い名前ABCDEFGHIJKLMN,80000\nOther,1000', 30);
    for (const l of bar) expect(columns(l), l).toBeLessThanOrEqual(30);
    expect(bar.find((l) => l.startsWith('東京'))).toMatch(/…\s+█+\s80,000$/);
    const pie = draw('pie', 'Name,Value\n東京の長い名前ABCDEFGHIJKLMN,80000\nOther,1000', 30);
    for (const l of pie) expect(columns(l), l).toBeLessThanOrEqual(30);
    expect(pie.find((l) => l.includes('東京'))).toMatch(/80,000$/);
    // Control: a name that fits is left whole.
    expect(draw('bar', 'Name,Value\n東京,5', 30).some((l) => l.startsWith('東京  '))).toBe(true);
  });

  it('area: a negative value is shaded up to zero, and zero is always on the scale', () => {
    const dots = (lines: string[]) => lines.join('').replace(/[^⠁-⣿]/g, '').length;
    const allBelow = draw('area', 'Day,Profit\nMon,-10\nTue,-20\nWed,-15');
    expect(allBelow[0]).toMatch(/^\s*0 ┤/);
    expect(dots(allBelow)).toBeGreaterThan(dots(draw('line', 'Day,Profit\nMon,-10\nTue,-20\nWed,-15')) * 3);
    // Both sides: dots in the top row (above zero) and in the bottom row (below it).
    const both = draw('area', 'Day,Profit\nMon,10\nTue,-20\nWed,10');
    const plot = both.filter((l) => l.includes('┤'));
    const zeroRow = Math.round(10 / 30 * (plot.length - 1));
    const shaded = (row: string) => row.replace(/[^⠁-⣿]/g, '').length;
    expect(plot.slice(0, zeroRow).some((r) => shaded(r) > 4)).toBe(true);
    expect(plot.slice(zeroRow + 1, -1).some((r) => shaded(r) > 4)).toBe(true);
  });
});

describe('Codex on f238e53', () => {
  it('a chart shown inside an ordinary fence is an example, left as written', async () => {
    const { expandCharts } = await import('./chart-text.js');
    const example = 'To draw one, write:\n````markdown\n```chart:bar\nItem,Value\nA,1\n```\n````\nDone.';
    expect(expandCharts(example, 60)).toBe(example);
    const tilde = '~~~\n```chart:bar\nItem,Value\nA,1\n```\n~~~';
    expect(expandCharts(tilde, 60)).toBe(tilde);
    // Control: the same chart on its own is drawn, after an example or not.
    const drawn = plain(expandCharts(`${example}\n\`\`\`chart:bar\nItem,Value\nA,1\n\`\`\``, 60));
    expect(drawn).toContain('```chart:bar');
    expect(drawn).toMatch(/A\s+█+ 1$/m);
  });

  it('both ends of a plot are named, within the width', () => {
    for (const w of [30, 40]) {
      const lines = draw('line', 'Month,Value\nA very long category label that fills the whole plot width,10\nDec,20', w);
      const labels = lines.find((l) => l.includes('Dec'));
      expect(labels, lines.join('\n')).toBeDefined();
      for (const l of lines) expect(stringWidth(l), l).toBeLessThanOrEqual(w);
    }
    // A long last label gives way to a short first one.
    const lines = draw('line', 'Month,Value\nJan,10\nA very long category label that fills the whole plot width,20', 30);
    expect(lines.some((l) => /^\s+Jan\s+A very.*…$/.test(l))).toBe(true);
    // Control: short labels both whole, one at each end.
    expect(draw('line', 'Month,Value\nJan,10\nDec,20', 40).some((l) => /^\s+Jan\s{3,}Dec$/.test(l))).toBe(true);
  });
});

describe('Codex on 6a8ae21', () => {
  it('a legend of long series names wraps within the width, every series named', () => {
    const body = 'Year,Revenue ($ millions),Operating Expenses ($ millions),Net Income ($ millions)\n2024,10,8,2\n2025,12,9,3';
    for (const kind of ['bar', 'line'] as const) {
      const lines = draw(kind, body, 60);
      for (const l of lines) expect(stringWidth(l), l).toBeLessThanOrEqual(60);
      const legendText = lines.filter((l) => l.includes('■')).join(' ');
      for (const name of ['Revenue ($ millions)', 'Operating Expenses ($ millions)', 'Net Income ($ millions)']) expect(legendText, kind).toContain(name);
      expect(lines.filter((l) => l.includes('■')).length, kind).toBeGreaterThan(1);
    }
    // Control: short names share one row.
    expect(draw('bar', 'Q,A,B\nq1,1,2', 60).filter((l) => l.includes('■'))).toHaveLength(1);
  });
});
