// ─────────────────────────────────────────────
//  Cascade AI — Real images for reports
// ─────────────────────────────────────────────
//
//  A report about real things (a product, a place, a page the run looked at)
//  is better with the real picture than with an invented one, and the real one
//  costs nothing: generating an image is the most expensive call a run makes.
//  This module finds, fetches, keeps and marks up real images:
//
//    • ImageAssets — the images a run has made or found, by the locator the
//      sink returned, so a later step can mark one up or credit it;
//    • fetchImage — one image from the web, through the SSRF guard, checked to
//      be a real raster picture, normalised (orientation, size, no metadata);
//    • pageImages / commonsImages — where to look: a page's own pictures (its
//      og:image, its product data, its large images) and Wikimedia Commons;
//    • annotateImage — circles, boxes, arrows, highlights, labels, numbers and
//      blurs drawn on a copy.
//
//  sharp is loaded lazily: a host without it still runs, and only marking up or
//  normalising says why it can't.

import type { GeneratedAsset } from '../core/multimodal/generate.js';
import { parseHtml, type Node } from '../tools/open-web/html.js';
import { safeFetch } from '../tools/utils/safe-fetch.js';

/** A rectangle in an image's own pixels. */
export interface Box { x: number; y: number; w: number; h: number }

/** Where an image came from, for the caption under it in a report. */
export interface ImageSource {
  kind: 'web' | 'screenshot' | 'annotated' | 'generated';
  /** The image's own address, for a web image. */
  url?: string;
  /** The page it is on, or the page a screenshot is of. */
  page?: string;
  /** Who made it, when the source says (Wikimedia Commons does). */
  credit?: string;
  license?: string;
  /** ISO date, for a screenshot. */
  capturedAt?: string;
}

export interface StoredImage {
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  source?: ImageSource;
  /** For a screenshot: where each control the page view listed was, by ref. */
  boxes?: Record<string, Box>;
}

/** Images kept per run, at most. The oldest goes first. */
export const MAX_STORED_IMAGES = 40;
/** Bytes kept per run, at most. */
export const MAX_STORED_BYTES = 80 * 1024 * 1024;

/**
 * The images a run has made or found, by locator (a workspace path on the
 * desktop, a file address in the cloud). Bounded: a long run drops its oldest.
 */
export class ImageAssets {
  private readonly images = new Map<string, StoredImage>();
  private bytes = 0;

  set(locator: string, image: StoredImage): void {
    const old = this.images.get(locator);
    if (old) { this.bytes -= old.bytes.length; this.images.delete(locator); }
    this.images.set(locator, image);
    this.bytes += image.bytes.length;
    while (this.images.size > MAX_STORED_IMAGES || this.bytes > MAX_STORED_BYTES) {
      const [first, img] = this.images.entries().next().value as [string, StoredImage];
      if (first === locator) break;
      this.images.delete(first);
      this.bytes -= img.bytes.length;
    }
  }

  get(locator: string): StoredImage | undefined {
    return this.images.get(locator.trim());
  }

  /**
   * The sink, keeping what passes through it. An image generated, found,
   * captured or marked up can then be marked up again by its locator.
   */
  recording<A extends Pick<GeneratedAsset, 'data' | 'mimeType' | 'filename'>>(
    sink: (asset: A) => Promise<string>,
    source?: ImageSource,
  ): (asset: A) => Promise<string> {
    return async (asset) => {
      const locator = await sink(asset);
      if (asset.mimeType.startsWith('image/')) {
        const size = await measure(asset.data).catch(() => undefined);
        if (size) this.set(locator, { bytes: asset.data, mime: asset.mimeType, ...size, ...(source ? { source } : {}) });
      }
      return locator;
    };
  }
}

// ── sharp, lazily ──────────────────────────────

type Sharp = typeof import('sharp');
let sharpModule: Promise<Sharp | null> | undefined;

/** sharp, or null where it isn't installed or won't load on this platform. */
export function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import('sharp').then((m) => ((m as { default?: Sharp }).default ?? m) as Sharp).catch(() => null);
  return sharpModule;
}

export class ImageToolsUnavailableError extends Error {
  constructor() {
    super('Image processing is not available on this machine (the sharp library could not be loaded).');
    this.name = 'ImageToolsUnavailableError';
  }
}

async function measure(bytes: Buffer): Promise<{ width: number; height: number } | undefined> {
  const sharp = await loadSharp();
  if (!sharp) return undefined;
  const m = await sharp(bytes).metadata();
  return m.width && m.height ? { width: m.width, height: m.height } : undefined;
}

// ── Fetching one image ─────────────────────────

/** Largest image downloaded. A product photo is rarely over 2 MB. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Longest edge kept: plenty for a page of a report, and a tenth of the bytes of a camera original. */
export const MAX_IMAGE_EDGE = 1600;
/** Smaller than this is an icon, a logo or a tracking pixel, not a picture of the thing. */
export const MIN_IMAGE_EDGE = 120;
const FETCH_TIMEOUT_MS = 15_000;

export type ImageFetch = (url: string, init: RequestInit) => Promise<Response>;

export class ImageFetchError extends Error {}

/**
 * One image from the web: fetched through the SSRF guard, refused unless it is
 * a raster picture (PNG, JPEG, WebP, GIF, AVIF; never SVG, which can carry
 * script and links), turned upright, shrunk to MAX_IMAGE_EDGE and stripped of
 * its metadata (a phone photo's GPS position among it).
 */
export async function fetchImage(
  url: string,
  opts: { signal?: AbortSignal; fetcher?: ImageFetch; referer?: string } = {},
): Promise<{ bytes: Buffer; mime: string; width: number; height: number }> {
  const sharp = await loadSharp();
  if (!sharp) throw new ImageToolsUnavailableError();
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await (opts.fetcher ?? safeFetch)(url, {
    signal,
    headers: {
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9',
      ...(opts.referer ? { referer: opts.referer } : {}),
    },
  });
  if (!res.ok) throw new ImageFetchError(`the image answered ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
    throw new ImageFetchError(`not an image (${type.split(';')[0]})`);
  }
  if (type.includes('svg')) throw new ImageFetchError('an SVG drawing, not a picture');
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new ImageFetchError('the image is too large');
  const raw = await readCapped(res, MAX_IMAGE_BYTES);
  let meta: import('sharp').Metadata;
  try {
    meta = await sharp(raw, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new ImageFetchError('the file is not an image this can read');
  }
  if (!meta.format || meta.format === 'svg' || !meta.width || !meta.height) throw new ImageFetchError('the file is not a picture');
  if (Math.min(meta.width, meta.height) < MIN_IMAGE_EDGE) throw new ImageFetchError(`too small to be a picture of the thing (${meta.width}×${meta.height})`);
  const keepAlpha = meta.hasAlpha === true && (meta.format === 'png' || meta.format === 'webp' || meta.format === 'gif');
  const pipeline = sharp(raw, { limitInputPixels: 40_000_000, animated: false })
    .rotate()
    .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true });
  const out = keepAlpha
    ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
    : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { bytes: out.data, mime: keepAlpha ? 'image/png' : 'image/jpeg', width: out.info.width, height: out.info.height };
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer()).subarray(0, max + 1);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new ImageFetchError('the image is too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ── Where to look ──────────────────────────────

export interface ImageCandidate {
  url: string;
  /** The page it was found on. */
  page: string;
  /** What the page says it shows: its alt text, or the page's title. */
  alt?: string;
  /** How sure: the page's chosen picture (og:image, product data) before an image in its body. */
  rank: number;
  credit?: string;
  license?: string;
}

/** What image finding reads off a tag, besides the reader's own attributes. */
const IMAGE_ATTRS = ['src', 'srcset', 'data-src', 'data-srcset', 'alt', 'width', 'height', 'rel', 'type'];

/** Candidates kept per page, at most. */
const PAGE_CANDIDATES = 6;

/**
 * The pictures a page offers for what it is about, best first: the image it
 * names for sharing (og:image, twitter:image, image_src), the images in its
 * product or article data (JSON-LD), then large images in its body. Addresses
 * are made absolute against the page (and its <base href>).
 */
export function pageImages(html: string, pageUrl: string): ImageCandidate[] {
  const root = parseHtml(html, { extraAttrs: IMAGE_ATTRS, keepJsonLd: true });
  let base = pageUrl;
  let title = '';
  const found = new Map<string, ImageCandidate>();
  const add = (raw: string | undefined, rank: number, alt?: string): void => {
    if (!raw) return;
    let url: string;
    try { url = new URL(raw.trim(), base).toString(); } catch { return; }
    if (!/^https?:/i.test(url) || /\.svg(?:$|[?#])/i.test(url) || url.length > 2000) return;
    const seen = found.get(url);
    if (!seen || seen.rank > rank) found.set(url, { url, page: pageUrl, rank, ...(alt ? { alt } : seen?.alt ? { alt: seen.alt } : {}) });
  };
  const scripts: string[] = [];
  const walk = (node: Node): void => {
    const a = node.attrs;
    switch (node.tag) {
      case 'base': if (a['href']) { try { base = new URL(a['href'], pageUrl).toString(); } catch { /* kept */ } } break;
      case 'title': title = textOf(node).trim(); break;
      case 'meta': {
        const key = (a['property'] ?? a['name'] ?? '').toLowerCase();
        if (key === 'og:image' || key === 'og:image:secure_url' || key === 'og:image:url') add(a['content'], 0);
        else if (key === 'twitter:image' || key === 'twitter:image:src') add(a['content'], 1);
        break;
      }
      case 'link':
        if ((a['rel'] ?? '').toLowerCase().split(/\s+/).includes('image_src')) add(a['href'], 1);
        break;
      case 'script':
        if ((a['type'] ?? '').toLowerCase().includes('ld+json')) scripts.push(textOf(node));
        break;
      case 'img': {
        const w = Number(a['width'] ?? 0);
        const h = Number(a['height'] ?? 0);
        // Declared small: an icon. Undeclared: maybe, ranked last.
        if ((w && w < MIN_IMAGE_EDGE) || (h && h < MIN_IMAGE_EDGE)) break;
        const src = largestFromSrcset(a['srcset'] ?? a['data-srcset']) ?? a['data-src'] ?? a['src'];
        if (src && /logo|icon|sprite|avatar|badge|pixel|spacer|1x1/i.test(src)) break;
        add(src, w >= 300 || h >= 300 ? 3 : 4, a['alt']?.trim() || undefined);
        break;
      }
    }
    for (const c of node.children) if (typeof c !== 'string') walk(c);
  };
  walk(root);
  for (const json of scripts) for (const url of jsonLdImages(json)) add(url, 2);
  const out = [...found.values()].sort((x, y) => x.rank - y.rank).slice(0, PAGE_CANDIDATES);
  for (const c of out) if (!c.alt && title) c.alt = title;
  return out;
}

function textOf(node: Node): string {
  return node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

function largestFromSrcset(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  let best: { url: string; w: number } | undefined;
  for (const part of srcset.split(',')) {
    const [url, size] = part.trim().split(/\s+/);
    if (!url) continue;
    const w = size ? parseFloat(size) * (size.endsWith('x') ? 1000 : 1) : 0;
    if (!best || w > best.w) best = { url, w };
  }
  return best?.url;
}

/** Image addresses in JSON-LD: `image` as a string, a list, or an ImageObject, anywhere in the graph. */
export function jsonLdImages(json: string): string[] {
  let data: unknown;
  try { data = JSON.parse(json); } catch { return []; }
  const out: string[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8 || out.length >= PAGE_CANDIDATES || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    const img = o['image'];
    const take = (x: unknown): void => {
      if (typeof x === 'string') out.push(x);
      else if (x && typeof x === 'object' && !Array.isArray(x)) {
        const u = (x as Record<string, unknown>)['url'] ?? (x as Record<string, unknown>)['contentUrl'];
        if (typeof u === 'string') out.push(u);
      }
    };
    if (Array.isArray(img)) img.forEach(take); else take(img);
    for (const [k, x] of Object.entries(o)) if (k !== 'image') visit(x, depth + 1);
  };
  visit(data, 0);
  return out;
}

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

/**
 * Freely licensed pictures from Wikimedia Commons, with their author and
 * licence: the right source for places, landmarks, animals, plants, people in
 * public life and historical subjects. Rarely has a current product.
 */
export async function commonsImages(query: string, opts: { signal?: AbortSignal; fetcher?: ImageFetch; limit?: number } = {}): Promise<ImageCandidate[]> {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6',
    gsrsearch: `${query} filetype:bitmap`, gsrlimit: String(Math.min(opts.limit ?? 5, 10)),
    prop: 'imageinfo', iiprop: 'url|extmetadata|size', iiurlwidth: String(MAX_IMAGE_EDGE),
  });
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await (opts.fetcher ?? safeFetch)(`${COMMONS_API}?${params}`, {
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null) as {
    query?: { pages?: Record<string, {
      title?: string; index?: number;
      imageinfo?: Array<{ thumburl?: string; url?: string; descriptionurl?: string; width?: number; height?: number;
        extmetadata?: Record<string, { value?: string } | undefined> }>;
    }> };
  } | null;
  const pages = Object.values(body?.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: ImageCandidate[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    const url = info?.thumburl ?? info?.url;
    if (!url || /\.svg(?:$|[?#])/i.test(info?.url ?? '')) continue;
    const meta = info?.extmetadata ?? {};
    const plain = (k: string): string | undefined => {
      const v = meta[k]?.value;
      // Tags out, then any bracket left over: one pass alone leaves "<script" from
      // "<<script>script>", and this text goes into the report's Markdown.
      return v ? v.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined : undefined;
    };
    out.push({
      url,
      page: info?.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title ?? '')}`,
      rank: 0,
      alt: (plain('ImageDescription') ?? p.title?.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''))?.slice(0, 120),
      ...(plain('Artist') ? { credit: plain('Artist') } : {}),
      ...(plain('LicenseShortName') ? { license: plain('LicenseShortName') } : {}),
    });
  }
  return out;
}

// ── Marking up ─────────────────────────────────

export type MarkShape = 'circle' | 'box' | 'arrow' | 'highlight' | 'label' | 'number' | 'blur';

export interface Mark {
  shape: MarkShape;
  /** Where: a box in pixels, or as fractions of the image (all four between 0 and 1). */
  box?: [number, number, number, number];
  /** Or a control from the screenshot's page view, by its ref (e14). */
  ref?: string;
  /** Text for a label, an arrow or a circle; a number's digits. */
  text?: string;
  /** A CSS colour name or #hex. Default red (highlight: yellow). */
  color?: string;
  /** For an arrow: where it starts, in the same units as box. Default: up and to the left of it. */
  from?: [number, number];
}

/** Marks per call, at most. */
export const MAX_MARKS = 24;
const COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i;

/**
 * A copy of the image with the marks drawn on it, as PNG. A blur is applied to
 * the pixels themselves (to hide a name or a number), everything else is drawn
 * over them. Throws on a mark that names a ref the screenshot doesn't have, or
 * a box outside the image, so the model can correct it.
 */
export async function annotateImage(
  image: Pick<StoredImage, 'bytes' | 'width' | 'height' | 'boxes'>,
  marks: Mark[],
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const sharp = await loadSharp();
  if (!sharp) throw new ImageToolsUnavailableError();
  if (!marks.length) throw new Error('Give at least one mark.');
  if (marks.length > MAX_MARKS) throw new Error(`At most ${MAX_MARKS} marks at once.`);
  const { width: W, height: H } = image;
  const resolved = marks.map((m, i) => ({ ...m, at: boxOf(m, i, W, H, image.boxes) }));

  let base = sharp(image.bytes).rotate();
  const blurs = resolved.filter((m) => m.shape === 'blur');
  if (blurs.length) {
    const composites = [];
    for (const m of blurs) {
      const r = clampBox(pad(m.at, 4), W, H);
      const region = await sharp(image.bytes).rotate().extract({ left: r.x, top: r.y, width: r.w, height: r.h })
        .blur(Math.max(8, Math.min(r.w, r.h) / 6)).toBuffer();
      composites.push({ input: region, left: r.x, top: r.y });
    }
    base = sharp(await base.composite(composites).png().toBuffer());
  }
  const svg = overlaySvg(resolved.filter((m) => m.shape !== 'blur'), W, H);
  const out = await base.composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  return { bytes: out.data, width: out.info.width, height: out.info.height };
}

function boxOf(m: Mark, i: number, W: number, H: number, boxes?: Record<string, Box>): Box {
  const which = `Mark ${i + 1} (${m.shape})`;
  if (m.ref) {
    const b = boxes && Object.hasOwn(boxes, m.ref) ? boxes[m.ref] : undefined;
    if (!b) throw new Error(`${which}: ${m.ref} is not on this screenshot.${boxes ? ` Refs on it: ${Object.keys(boxes).slice(0, 30).join(', ')}.` : ' Only a screenshot from browser_control capture has refs.'}`);
    return b;
  }
  if (!m.box || m.box.length !== 4 || m.box.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error(`${which}: give a box [x, y, width, height] or a ref.`);
  }
  const fractional = m.box.every((v) => v >= 0 && v <= 1);
  const [x, y, w, h] = fractional ? [m.box[0] * W, m.box[1] * H, m.box[2] * W, m.box[3] * H] : m.box;
  if (w <= 0 || h <= 0 || x >= W || y >= H || x + w <= 0 || y + h <= 0) {
    throw new Error(`${which}: the box is outside the ${W}×${H} image.`);
  }
  return { x, y, w, h };
}

function pad(b: Box, p: number): Box { return { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p }; }

function clampBox(b: Box, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const w = Math.max(1, Math.min(W - x, Math.ceil(b.w + Math.min(0, b.x))));
  const h = Math.max(1, Math.min(H - y, Math.ceil(b.h + Math.min(0, b.y))));
  return { x, y, w, h };
}

const xml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

function overlaySvg(marks: Array<Mark & { at: Box }>, W: number, H: number): string {
  const stroke = Math.max(3, Math.round(Math.min(W, H) / 220));
  const font = Math.max(14, Math.round(Math.min(W, H) / 40));
  const parts: string[] = [];
  const label = (text: string, x: number, y: number, color: string): void => {
    const t = xml(text.slice(0, 80));
    const w = Math.ceil(t.length * font * 0.58) + font;
    const h = Math.round(font * 1.6);
    const lx = Math.max(2, Math.min(W - w - 2, x));
    const ly = Math.max(2, Math.min(H - h - 2, y));
    parts.push(`<rect x="${lx}" y="${ly}" width="${w}" height="${h}" rx="${Math.round(h / 3)}" fill="${color}" fill-opacity="0.92"/>`);
    parts.push(`<text x="${lx + font / 2}" y="${ly + h * 0.7}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="${font}" font-weight="bold" fill="#ffffff">${t}</text>`);
  };
  for (const m of marks) {
    const c = m.color && COLOR.test(m.color) ? m.color : m.shape === 'highlight' ? '#ffd400' : '#e11d48';
    const b = m.at;
    const above = (h: number) => (b.y - h - 6 >= 0 ? b.y - h - 6 : b.y + b.h + 6);
    switch (m.shape) {
      case 'circle': {
        const p = stroke * 3;
        parts.push(`<ellipse cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" rx="${b.w / 2 + p}" ry="${b.h / 2 + p}" fill="none" stroke="${c}" stroke-width="${stroke}"/>`);
        if (m.text) label(m.text, b.x, above(font * 1.6) - p, c);
        break;
      }
      case 'box':
        parts.push(`<rect x="${b.x - stroke}" y="${b.y - stroke}" width="${b.w + 2 * stroke}" height="${b.h + 2 * stroke}" rx="${stroke * 2}" fill="none" stroke="${c}" stroke-width="${stroke}"/>`);
        if (m.text) label(m.text, b.x, above(font * 1.6), c);
        break;
      case 'highlight':
        parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${c}" fill-opacity="0.35"/>`);
        if (m.text) label(m.text, b.x, above(font * 1.6), '#1f2937');
        break;
      case 'label':
        label(m.text ?? '', b.x, b.y, c);
        break;
      case 'number': {
        const r = font;
        const cx = Math.max(r, Math.min(W - r, b.x));
        const cy = Math.max(r, Math.min(H - r, b.y));
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" stroke="#ffffff" stroke-width="2"/>`);
        parts.push(`<text x="${cx}" y="${cy + font * 0.35}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="${font}" font-weight="bold" fill="#ffffff">${xml((m.text ?? '').slice(0, 3))}</text>`);
        break;
      }
      case 'arrow': {
        const tx = b.x + b.w / 2;
        const ty = b.y + b.h / 2;
        const fractional = m.box?.every((v) => v >= 0 && v <= 1) ?? false;
        const [fx, fy] = m.from
          ? (fractional ? [m.from[0] * W, m.from[1] * H] : m.from)
          : [Math.max(10, tx - Math.max(80, b.w)), Math.max(10, ty - Math.max(80, b.h))];
        // Stop at the box's edge, not its middle.
        const len = Math.hypot(tx - fx, ty - fy) || 1;
        const reach = Math.max(0, len - Math.min(b.w, b.h) / 2 - stroke);
        const ex = fx + ((tx - fx) * reach) / len;
        const ey = fy + ((ty - fy) * reach) / len;
        const ang = Math.atan2(ey - fy, ex - fx);
        const head = stroke * 5;
        const p1 = [ex - head * Math.cos(ang - 0.45), ey - head * Math.sin(ang - 0.45)];
        const p2 = [ex - head * Math.cos(ang + 0.45), ey - head * Math.sin(ang + 0.45)];
        parts.push(`<line x1="${fx}" y1="${fy}" x2="${ex - (head / 2) * Math.cos(ang)}" y2="${ey - (head / 2) * Math.sin(ang)}" stroke="${c}" stroke-width="${stroke}" stroke-linecap="round"/>`);
        parts.push(`<polygon points="${ex},${ey} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}" fill="${c}"/>`);
        if (m.text) label(m.text, fx - font, fy - font * 2, c);
        break;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

/** A short "where this came from" line for under the image in a report. */
export function captionFor(source: ImageSource | undefined): string {
  if (!source) return '';
  const site = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };
  switch (source.kind) {
    case 'screenshot': return `Screenshot of ${site(source.page) || 'the page'}${source.capturedAt ? `, ${source.capturedAt.slice(0, 10)}` : ''}`;
    case 'web': {
      const who = [source.credit, source.license].filter(Boolean).join(', ');
      return `Image: ${site(source.page) || site(source.url)}${who ? ` (${who})` : ''}`;
    }
    case 'generated': return 'AI-generated image';
    case 'annotated': return '';
  }
}
