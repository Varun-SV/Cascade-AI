import { describe, expect, it } from 'vitest';
import { parseChartSpec } from '../../core/documents/blocks.js';
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
