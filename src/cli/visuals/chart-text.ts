// ─────────────────────────────────────────────
//  Cascade AI — Charts drawn in the terminal
// ─────────────────────────────────────────────
//
//  A reply's ```chart:<kind>``` block (core/documents/blocks.ts) is a real
//  chart in the web and desktop apps. In the CLI it was printed as its CSV.
//  These draw it with characters every terminal has:
//
//  - bar:               a row per category (per series), ▇ scaled to the widest
//  - line, area, scatter: braille dots (2×4 per cell), axis labels at the edges
//  - pie, doughnut:     one bar split by share, and a legend with percentages
//
//  Plain functions from a ChartSpec to lines of text, coloured with chalk
//  (which falls back to fewer colours, or none, by itself). The numbers are
//  always written out too, so nothing depends on telling colours apart.

import chalk from 'chalk';
import stringWidth from 'string-width';
import { chartKind, parseChartSpec, type ChartSpec } from '../../core/documents/blocks.js';

/** Series colours: distinct on dark and light backgrounds, in this order. */
const PALETTE = ['#4C8DFF', '#2DD4BF', '#F5A524', '#E5484D', '#A78BFA', '#38B0DE', '#F472B6', '#84CC16'];
const colour = (i: number) => chalk.hex(PALETTE[i % PALETTE.length]!);

/** A number as people write it: 9542 → "9,542", 0.125 → "0.13", 1.5e6 → "1.5M". */
export function shortNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e4) return Math.round(n).toLocaleString('en-US');
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return trim(n);
}
const trim = (n: number): string => n.toFixed(2).replace(/\.?0+$/, '');

// Measured in terminal columns, not UTF-16 units: 東 takes two, an accent none.
const cols = (s: string): number => stringWidth(s);
const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - cols(s)));
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** `s` in at most `n` columns, ending in "…" when it had to be cut. */
const cut = (s: string, n: number): string => {
  if (cols(s) <= n) return s;
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(s)) {
    const w = cols(segment);
    if (used + w > n - 1) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
};

/** The lines that draw `spec` within `width` columns. */
export function chartToLines(spec: ChartSpec, width: number): string[] {
  const w = Math.max(30, Math.min(width, 120));
  const lines: string[] = [];
  if (spec.title) lines.push(chalk.bold(spec.title));
  switch (spec.kind) {
    case 'pie':
    case 'doughnut':
      lines.push(...pieLines(spec, w));
      break;
    case 'line':
    case 'area':
    case 'scatter':
      lines.push(...plotLines(spec, w));
      break;
    default:
      lines.push(...barLines(spec, w));
  }
  return lines;
}

/** The series names, as many to a row as fit in `w` columns: the rows and lines carry no names of their own. */
function legend(spec: ChartSpec, w: number): string[] {
  const rows: string[] = [];
  let row = '';
  let used = 0;
  spec.series.forEach((s, i) => {
    const name = cut(s.name, Math.max(1, w - 2));
    const width = 2 + cols(name);
    if (used && used + 3 + width > w) { rows.push(row); row = ''; used = 0; }
    row += `${used ? '   ' : ''}${colour(i)('■')} ${name}`;
    used += (used ? 3 : 0) + width;
  });
  if (row) rows.push(row);
  return rows;
}

// ── Bars ─────────────────────────────────────────────────────────

function barLines(spec: ChartSpec, w: number): string[] {
  const many = spec.series.length > 1;
  const values = spec.series.flatMap((s) => s.values);
  const max = Math.max(...values.map(Math.abs), 0);
  const valueWidth = Math.max(...values.map((v) => shortNumber(v).length));
  // The value is never cut: labels give way first, down to 4 characters, then the bar.
  const wanted = Math.min(28, Math.max(...spec.categories.map(cols), 4));
  const label = Math.max(4, Math.min(wanted, w - valueWidth - 4 - 8));
  const room = Math.max(1, w - label - valueWidth - 4);
  const out: string[] = [];
  spec.categories.forEach((cat, ci) => {
    spec.series.forEach((s, si) => {
      const v = s.values[ci] ?? 0;
      const cells = max > 0 ? Math.abs(v) / max * room : 0;
      const whole = Math.floor(cells);
      const bar = '█'.repeat(whole) + (cells - whole >= 0.5 ? '▌' : '') || (v !== 0 ? '▏' : '');
      const name = si === 0 ? pad(cut(cat, label), label) : ' '.repeat(label);
      // A negative value is drawn the same length, marked by its own sign.
      out.push(`${name}  ${colour(si)(bar)} ${shortNumber(v)}`);
    });
    if (many && ci < spec.categories.length - 1) out.push('');
  });
  if (many) out.push('', ...legend(spec, w));
  return out;
}

// ── Pie ──────────────────────────────────────────────────────────

function pieLines(spec: ChartSpec, w: number): string[] {
  const s = spec.series[0]!;
  const parts = spec.categories.map((name, i) => ({ name, v: Math.max(0, s.values[i] ?? 0), i }));
  const total = parts.reduce((a, p) => a + p.v, 0);
  if (total <= 0) return [chalk.dim('(nothing to draw: every value is zero)')];
  const room = Math.max(10, w - 2);
  // Largest remainder, so the cells add up to exactly the width.
  const exact = parts.map((p) => p.v / total * room);
  const cells = exact.map(Math.floor);
  let left = room - cells.reduce((a, c) => a + c, 0);
  exact.map((e, i) => ({ r: e - Math.floor(e), i })).sort((a, b) => b.r - a.r).forEach(({ i }) => { if (left > 0) { cells[i]! += 1; left -= 1; } });
  const bar = parts.map((p, i) => colour(p.i)('█'.repeat(cells[i]!))).join('');
  // Room for the share and the value first; the names give way, down to 4 characters.
  const valueWidth = Math.max(...parts.map((p) => shortNumber(p.v).length));
  const wanted = Math.min(28, Math.max(...parts.map((p) => cols(p.name))));
  const name = Math.max(4, Math.min(wanted, w - 2 - 2 - 6 - 2 - valueWidth));
  const rows = parts.map((p) => `${colour(p.i)('■')} ${pad(cut(p.name, name), name)}  ${pad(`${(p.v / total * 100).toFixed(1)}%`, 6)}  ${shortNumber(p.v)}`);
  return [bar, '', ...rows];
}

// ── Line, area, scatter: braille ─────────────────────────────────

// The dot each (x, y) within a 2×4 braille cell sets, as an offset from U+2800.
const DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

function plotLines(spec: ChartSpec, w: number): string[] {
  const values = spec.series.flatMap((s) => s.values);
  let lo = Math.min(...values, spec.kind === 'area' ? 0 : Infinity);
  // An area is filled to zero, so zero is always on the scale, above or below.
  let hi = Math.max(...values, spec.kind === 'area' ? 0 : -Infinity);
  // A flat series still needs a range to draw in. Padding relative to its size,
  // since adding 1 to 1e16 changes nothing and the scale would divide by zero.
  if (!(hi > lo)) {
    const pad = Math.max(Math.abs(hi) * 1e-3, 1);
    hi += pad;
    lo -= pad;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || !(hi > lo)) return [chalk.dim('(these values cannot be drawn: ' + values.map(shortNumber).join(', ').slice(0, 80) + ')')];
  const axis = Math.max(shortNumber(hi).length, shortNumber(lo).length);
  const width = Math.max(10, w - axis - 3);
  const rows = Math.max(4, Math.min(12, Math.round(width / 5)));
  const dotsX = width * 2;
  const dotsY = rows * 4;
  const cells: number[][] = Array.from({ length: rows }, () => new Array<number>(width).fill(0));
  const owner: number[][] = Array.from({ length: rows }, () => new Array<number>(width).fill(-1));
  const set = (x: number, y: number, si: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= dotsX || y >= dotsY) return;
    const r = Math.floor(y / 4);
    const c = Math.floor(x / 2);
    cells[r]![c]! |= DOT[y % 4]![x % 2]!;
    owner[r]![c] = si;
  };
  const n = spec.categories.length;
  const xAt = (i: number): number => (n <= 1 ? 0 : Math.round(i / (n - 1) * (dotsX - 1)));
  const yAt = (v: number): number => Math.round((hi - v) / (hi - lo) * (dotsY - 1));
  spec.series.forEach((s, si) => {
    let prev: { x: number; y: number } | null = null;
    s.values.forEach((v, i) => {
      const p = { x: xAt(i), y: yAt(v) };
      if (spec.kind === 'scatter') { set(p.x, p.y, si); return; }
      if (prev) {
        // A straight line between neighbours, one dot per step along the longer side.
        const steps = Math.max(Math.abs(p.x - prev.x), Math.abs(p.y - prev.y), 1);
        for (let k = 0; k <= steps; k++) {
          const x = Math.round(prev.x + (p.x - prev.x) * k / steps);
          const y = Math.round(prev.y + (p.y - prev.y) * k / steps);
          set(x, y, si);
          if (spec.kind === 'area') {
            // Shaded between the line and zero, on whichever side of it the value is.
            const base = yAt(0);
            const [from, to] = y < base ? [y + 1, base] : [base, y - 1];
            for (let yy = from; yy <= to; yy++) if ((x + yy) % 2 === 0) set(x, yy, si);
          }
        }
      } else set(p.x, p.y, si);
      prev = p;
    });
  });
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const tick = r === 0 ? shortNumber(hi) : r === rows - 1 ? shortNumber(lo) : '';
    let line = '';
    for (let c = 0; c < width; c++) {
      const ch = String.fromCodePoint(0x2800 + cells[r]![c]!);
      line += owner[r]![c]! >= 0 ? colour(owner[r]![c]!)(ch) : ch;
    }
    out.push(`${tick.padStart(axis)} ┤${line}`);
  }
  out.push(`${' '.repeat(axis)} └${'─'.repeat(width)}`);
  const first = spec.categories[0] ?? '';
  const last = n > 1 ? spec.categories[n - 1]! : '';
  // Both ends named, in the width: each gets half, and gives what it doesn't need
  // to the other.
  let firstShown = cut(first, width);
  let lastShown = '';
  if (last) {
    const room = width - 1;
    const half = Math.floor(room / 2);
    const cf = cols(first);
    const cl = cols(last);
    const firstRoom = cf + cl <= room || cf <= half ? cf : cl <= room - half ? room - cl : half;
    firstShown = cut(first, Math.min(firstRoom, room - 1));
    lastShown = cut(last, room - cols(firstShown));
  }
  const gap = lastShown ? Math.max(1, width - cols(firstShown) - cols(lastShown)) : 0;
  out.push(`${' '.repeat(axis + 2)}${firstShown}${' '.repeat(gap)}${lastShown}`);
  if (spec.series.length > 1) out.push('', ...legend(spec, w));
  return out;
}

/**
 * `text` with each ```chart:<kind>``` block that parses replaced by its drawing,
 * for places that show a reply as plain lines (the alt-screen transcript). A
 * block that doesn't parse is left as written.
 */
export function expandCharts(text: string, width: number): string {
  // Line by line, not one pattern over the whole reply: a reply is model-written and
  // can be long. Every fenced block is passed over whole, so each line is read once.
  // Fences as Markdown has them: ``` or ~~~, closed by a run of the same at least as
  // long, or by the end of the reply. A ```chart:<kind> block is drawn only as a block
  // of its own: one shown inside an ordinary fence (````markdown … ````) is an example,
  // left as written to be read and copied.
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    // A backtick in a backtick fence's info string makes it no fence.
    if (!open || (open[1]![0] === '`' && open[2]!.includes('`'))) { out.push(lines[i]!); continue; }
    const fence = open[1]!;
    const closer = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    let end = i + 1;
    while (end < lines.length && !closer.test(lines[end]!)) end++;
    const chart = fence[0] === '`' && end < lines.length ? /^[ \t]*chart[ \t]*:(.*)$/i.exec(open[2]!) : null;
    const k = chart ? chartKind(chart[1]!) : null;
    const spec = k ? parseChartSpec(k, lines.slice(i + 1, end).join('\n')) : null;
    out.push(...(spec ? chartToLines(spec, width) : lines.slice(i, end + 1)));
    i = end;
  }
  return out.join('\n');
}
