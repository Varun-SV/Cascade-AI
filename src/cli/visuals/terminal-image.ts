// ─────────────────────────────────────────────
//  Cascade AI — Images in a reply, in the terminal
// ─────────────────────────────────────────────
//
//  A reply's `![alt](path)` was printed as that text. Now an image on this
//  machine is drawn as a small colour thumbnail, each character cell two pixels
//  (▀: the top pixel in the foreground colour, the bottom one in the
//  background), with a link under it that opens the full image.
//
//  Half blocks rather than a terminal's own image protocol (Kitty, iTerm2,
//  Sixel): the reply goes through Ink, which measures and wraps every line it
//  writes, and an image protocol's payload is not text it can measure, so the
//  layout around it would break. Half blocks are plain coloured characters,
//  which every truecolor terminal (Windows Terminal included) shows, and chalk
//  lowers to fewer colours where that's all there is.
//
//  Only files on this machine, inside the project or Cascade's own folders, are
//  read, and only to draw them here: a web address is left as a link and never
//  fetched, so showing a reply never sends anything anywhere.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { loadSharp } from '../../media/report-images.js';
import { statePathFor } from '../../config/project-state.js';

export interface ImageRef { alt: string; src: string; start: number; end: number }

/** Thumbnails by the `src` the reply wrote, made before the reply is shown. */
export type Thumbnails = Record<string, { lines: string[]; file: string }>;

/** Largest image file read to draw: a thumbnail of anything bigger isn't worth the wait. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_ROWS = 16;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.svg']);

/** Every `![alt](src)` in `text`, in order. */
/**
 * The images `text` shows, in order. Not one written inside inline code
 * (`` `![Cover](cover.png)` ``): that is an example to read and copy, and is left as written.
 */
export function findImages(text: string): ImageRef[] {
  const found = scanImages(text);
  const spans = codeSpans(text);
  if (!spans.length) return found;
  let k = 0;
  return found.filter((img) => {
    while (k < spans.length && spans[k]![1] <= img.start) k++;
    return !(k < spans.length && spans[k]![0] <= img.start);
  });
}

/**
 * Inline code spans as [start, end), in order, the way Markdown finds them: a run
 * of backticks opens one that the next run of exactly as many closes; a run with
 * none to close it is plain text. Each run is looked at a fixed number of times.
 */
function codeSpans(text: string): Array<[number, number]> {
  const runs: Array<{ at: number; len: number }> = [];
  for (let i = 0; i < text.length;) {
    if (text[i] !== '`') { i++; continue; }
    let j = i;
    while (j < text.length && text[j] === '`') j++;
    runs.push({ at: i, len: j - i });
    i = j;
  }
  const nextSame = new Array<number>(runs.length).fill(-1);
  const lastOfLength = new Map<number, number>();
  for (let r = runs.length - 1; r >= 0; r--) {
    nextSame[r] = lastOfLength.get(runs[r]!.len) ?? -1;
    lastOfLength.set(runs[r]!.len, r);
  }
  const spans: Array<[number, number]> = [];
  for (let r = 0; r < runs.length;) {
    const close = nextSame[r]!;
    if (close < 0) { r++; continue; }
    spans.push([runs[r]!.at, runs[close]!.at + runs[close]!.len]);
    r = close + 1;
  }
  return spans;
}

function scanImages(text: string): ImageRef[] {
  // Scanned, not matched with one pattern: a reply is model-written, and a pattern
  // tried at every "![" takes quadratic time on a long run of them. Here the next
  // "]", ")", line end and space after a point are looked up once and remembered
  // while the scan moves forward, so the whole reply is read in linear time.
  const out: ImageRef[] = [];
  const MAX_ALT = 400;
  const MAX_SRC = 2000;
  const next = new Map<string, number>();
  const nextOf = (ch: string, at: number): number => {
    const known = next.get(ch);
    if (known !== undefined && (known === -1 || known >= at)) return known;
    const found = text.indexOf(ch, at);
    next.set(ch, found);
    return found;
  };
  let space = -2;
  const nextSpace = (at: number): number => {
    if (space !== -2 && (space === -1 || space >= at)) return space;
    const re = /\s/g;
    re.lastIndex = at;
    const m = re.exec(text);
    space = m ? m.index : -1;
    return space;
  };
  const before = (a: number, b: number): boolean => a !== -1 && (b === -1 || a < b);
  // Parentheses, counted once: a destination may hold balanced ones
  // (`cover(1).png`), so its end is the first ")" with as many "(" as ")"
  // before it. Prefix counts make each check constant time.
  const opens = new Int32Array(text.length + 1);
  const shuts = new Int32Array(text.length + 1);
  const closers: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    opens[i + 1] = opens[i]! + (c === '(' ? 1 : 0);
    shuts[i + 1] = shuts[i]! + (c === ')' ? 1 : 0);
    if (c === ')') closers.push(i);
  }
  /** The ")" ending a destination that starts at `at`, or -1. A few nesting levels at most. */
  const destinationEnd = (at: number): number => {
    let lo = 0;
    let hi = closers.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (closers[mid]! < at) lo = mid + 1; else hi = mid; }
    for (let k = lo, tries = 0; k < closers.length && tries < 8; k++, tries++) {
      const q = closers[k]!;
      if (q - at > MAX_SRC) break;
      if (opens[q]! - opens[at]! === shuts[q]! - shuts[at]!) return q;
    }
    return -1;
  };
  let from = 0;
  for (;;) {
    const start = text.indexOf('![', from);
    if (start < 0) break;
    from = start + 2;
    const close = nextOf(']', start + 2);
    if (!before(close, nextOf('\n', start + 2)) || close - start - 2 > MAX_ALT || text[close + 1] !== '(') continue;
    const srcStart = close + 2;
    // Not one that can be matched: left as written, never cut short.
    const paren = destinationEnd(srcStart);
    const gap = nextSpace(srcStart);
    if (paren === -1) continue;
    const srcEnd = before(gap, paren) ? gap : paren;
    if (srcEnd === srcStart || srcEnd - srcStart > MAX_SRC) continue;
    let end = srcEnd;
    if (srcEnd !== paren) {
      // An optional title, ` "…"`, then the closing paren, all on this line.
      const title = /^[ \t]+"([^"\n]*)"[ \t]*\)/.exec(text.slice(srcEnd, Math.min(text.length, srcEnd + MAX_ALT + 8)));
      if (!title) continue;
      end = srcEnd + title[0].length - 1;
    }
    out.push({ alt: text.slice(start + 2, close), src: text.slice(srcStart, srcEnd), start, end: end + 1 });
    from = end + 1;
  }
  return out;
}

/** The thumbnail made for `src`, if any: own entries only, so `![x](constructor)` is no thumbnail. */
export function thumbnailFor(thumbnails: Thumbnails, src: string): Thumbnails[string] | undefined {
  return Object.hasOwn(thumbnails, src) ? thumbnails[src] : undefined;
}

/** Whether `src` names a file on this machine rather than a web or data address. */
export function isLocalImage(src: string): boolean {
  return !/^[a-z][a-z\d+.-]*:\/\//i.test(src) && !/^data:/i.test(src);
}

/**
 * Where `src` is on disk: resolved against the project, with Windows separators
 * read as separators, and only inside one of `roots`. Null for anything else.
 */
export function resolveLocalImage(src: string, workspace: string, roots: readonly string[] = [workspace]): string | null {
  if (!isLocalImage(src)) return null;
  const decoded = (() => { try { return decodeURIComponent(src); } catch { return src; } })();
  const normal = path.sep === '/' ? decoded.replace(/\\/g, '/') : decoded;
  // A browser screenshot is named as the tools return it, `@screenshots/<file>`,
  // which is in the project's state folder, not the workspace. Still only shown
  // when that folder is one of `roots`.
  const abs = (normal.startsWith('@screenshots/') ? statePathFor(workspace, normal) : null) ?? path.resolve(workspace, normal);
  if (!IMAGE_EXTENSIONS.has(path.extname(abs).toLowerCase())) return null;
  const inside = roots.some((root) => {
    const rel = path.relative(path.resolve(root), abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  return inside ? abs : null;
}

/** `file` with every link in its path followed, when that is still inside one of `roots`; else null. */
async function realInside(file: string, roots: readonly string[]): Promise<string | null> {
  try {
    const real = await fs.realpath(file);
    for (const root of roots) {
      const realRoot = await fs.realpath(root).catch(() => null);
      if (!realRoot) continue;
      const rel = path.relative(realRoot, real);
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return real;
    }
    return null;
  } catch {
    return null;
  }
}

/** A link a terminal can open (OSC 8); terminals without links show the text alone. */
export function fileLink(file: string, label: string): string {
  const url = pathToFileURL(file).href;
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

/** The thumbnail's lines, `cols` wide at most, or null when the file can't be drawn. */
export async function thumbnailLines(file: string, cols: number): Promise<string[] | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const { data, info } = await sharp(file, { animated: false, limitInputPixels: 64_000_000 })
      .flatten({ background: '#000000' })
      // Each cell is about twice as tall as it is wide, and holds two pixels stacked.
      .resize({ width: Math.max(8, cols), height: MAX_ROWS * 2, fit: 'inside', withoutEnlargement: false })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const px = (x: number, y: number): [number, number, number] => {
      const i = (y * width + x) * channels;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    const lines: string[] = [];
    for (let y = 0; y < height; y += 2) {
      let line = '';
      for (let x = 0; x < width; x++) {
        const top = px(x, y);
        line += y + 1 < height ? chalk.rgb(...top).bgRgb(...px(x, y + 1))('▀') : chalk.rgb(...top)('▀');
      }
      lines.push(line);
    }
    return lines;
  } catch {
    return null;
  }
}

/**
 * Thumbnails for the images `text` shows, made once before the reply is
 * written: a reply in the scrollback is never drawn again, so it has to carry
 * them. At most a few, each read only if it is one of ours.
 */
export async function prepareThumbnails(text: string, workspace: string, width: number, roots?: readonly string[]): Promise<Thumbnails> {
  // No prototype: a src of "__proto__" or "constructor" is just a key here.
  const out: Thumbnails = Object.create(null) as Thumbnails;
  const cols = Math.max(16, Math.min(56, width - 8));
  for (const ref of findImages(text).slice(0, MAX_IMAGES)) {
    if (Object.hasOwn(out, ref.src)) continue;
    const named = resolveLocalImage(ref.src, workspace, roots ?? [workspace]);
    // Judged again where it really is: a link inside the project can point anywhere.
    const file = named ? await realInside(named, roots ?? [workspace]) : null;
    if (!file) continue;
    const lines = await thumbnailLines(file, cols);
    if (lines) out[ref.src] = { lines, file };
  }
  return out;
}
