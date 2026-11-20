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

export interface ImageRef { alt: string; src: string; start: number; end: number }

/** Thumbnails by the `src` the reply wrote, made before the reply is shown. */
export type Thumbnails = Record<string, { lines: string[]; file: string }>;

/** Largest image file read to draw: a thumbnail of anything bigger isn't worth the wait. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_ROWS = 16;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.svg']);

/** Every `![alt](src)` in `text`, in order. */
export function findImages(text: string): ImageRef[] {
  const out: ImageRef[] = [];
  const re = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ alt: m[1]!, src: m[2]!, start: m.index, end: m.index + m[0].length });
  }
  return out;
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
  const abs = path.resolve(workspace, normal);
  if (!IMAGE_EXTENSIONS.has(path.extname(abs).toLowerCase())) return null;
  const inside = roots.some((root) => {
    const rel = path.relative(path.resolve(root), abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  return inside ? abs : null;
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
  const out: Thumbnails = {};
  const cols = Math.max(16, Math.min(56, width - 8));
  for (const ref of findImages(text).slice(0, MAX_IMAGES)) {
    if (out[ref.src]) continue;
    const file = resolveLocalImage(ref.src, workspace, roots ?? [workspace]);
    if (!file) continue;
    const lines = await thumbnailLines(file, cols);
    if (lines) out[ref.src] = { lines, file };
  }
  return out;
}
