// ─────────────────────────────────────────────
//  Cascade AI — find_image and annotate_image
// ─────────────────────────────────────────────
//
//  Real pictures for reports, instead of generated ones. `find_image` takes a
//  real product, place or page's own picture from the web (and credits it);
//  `annotate_image` circles, boxes, points at, highlights, labels, numbers or
//  blurs parts of any image the run has (found, captured by browser_control,
//  generated, or a picture in the workspace). Both hand their result to the
//  same sink the media tools use, so it lands where a generated image would:
//  in the workspace on the desktop, as a file of the conversation in the cloud.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { resolveInWorkspace } from './utils/workspace-path.js';
import { safeFetch } from './utils/safe-fetch.js';
import { MAX_PAGE_BYTES, bodyText, openWebSearch } from './open-web/index.js';
import {
  type ImageAssets, type ImageCandidate, type ImageFetch, type Mark, type MarkShape, type StoredImage,
  ImageToolsUnavailableError, MAX_MARKS, annotateImage, captionFor, commonsImages, fetchImage, loadSharp, pageImages,
} from '../media/report-images.js';

/** Saves bytes where generated media go, and says where. */
export type ImageSink = (asset: { data: Buffer; mimeType: string; filename: string }) => Promise<string>;

/** A web search for pages about a thing: their addresses, best first. */
export type PageSearch = (query: string, signal?: AbortSignal) => Promise<string[]>;

export interface ReportImageDeps {
  assets: ImageAssets;
  sink: ImageSink;
  fetcher?: ImageFetch;
  search?: PageSearch;
  now?: () => Date;
}

/** Pictures returned per call, at most. */
const MAX_COUNT = 3;
/** Downloads tried per call, at most: a dead link costs one try, not the call. */
const MAX_TRIES = 8;
/** Pages opened to look for a picture, at most. */
const MAX_PAGES = 4;
/** Of MAX_TRIES, kept for Wikimedia Commons when the web's pictures all fail. */
const COMMONS_TRIES = 3;

const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
/**
 * A name no earlier save has: the sink writes over a file of the same name, and
 * a path this run already handed out (in a report, with its caption) must keep
 * showing the picture it showed.
 */
export const uniqueName = (base: string, ext: string): string => `${base}-${randomBytes(4).toString('hex')}.${ext}`;

/** The open-web search, keeping only the pages' addresses. */
export const openWebPages: PageSearch = async (query, signal) => {
  const found = await openWebSearch(query, { maxResults: 6, ...(signal ? { signal } : {}) });
  return found.results.map((r) => r.url);
};

/**
 * A page's HTML, bounded, through the SSRF guard, with the address it was
 * finally served from: a relative picture is relative to that, after any
 * redirect, not to the address asked for. Null when it isn't an HTML page.
 */
async function fetchHtml(url: string, fetcher: ImageFetch, signal?: AbortSignal): Promise<{ html: string; url: string } | null> {
  const timeout = AbortSignal.timeout(10_000);
  const res = await fetcher(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok || !(res.headers.get('content-type') ?? 'text/html').includes('html')) { await res.body?.cancel().catch(() => {}); return null; }
  // Read no further than the cap: a huge page is never held whole.
  return { html: (await bodyText(res, MAX_PAGE_BYTES)).text, url: res.url || url };
}

export class FindImageTool extends BaseTool {
  readonly name = 'find_image';
  readonly description =
    'Find a REAL picture on the web and save it for the report: a product, a place, a building, an animal, a person in public life, or the picture a given page shows. '
    + 'Costs nothing, unlike generate_image: for anything that exists, use this instead of generating a picture of it. '
    + 'Give a query (what to find, e.g. "Moondrop Aria 2 IEM"), or page_url (a page you already found: its own pictures are taken), or image_url (one picture). '
    + 'source "commons" searches Wikimedia Commons, which has freely licensed photos of places, nature and public figures with their author and licence. '
    + 'Each picture comes back with a path, a ready Markdown line to embed it, and a caption naming where it is from: keep the caption under the picture. '
    + 'Use annotate_image afterwards to circle, label or point at parts of it.';

  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the picture should show, as you would search for it.' },
      page_url: { type: 'string', description: 'A page whose own pictures to take (its main/product picture first).' },
      image_url: { type: 'string', description: 'The address of one picture to save.' },
      source: { type: 'string', enum: ['auto', 'web', 'commons'], description: 'Where to look for a query. auto (default): the web, then Wikimedia Commons.' },
      count: { type: 'number', description: `How many different pictures (1-${MAX_COUNT}, default 1).` },
    },
  };

  constructor(private readonly deps: ReportImageDeps) { super(); }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const query = typeof input['query'] === 'string' ? input['query'].trim() : '';
    const pageUrl = typeof input['page_url'] === 'string' ? input['page_url'].trim() : '';
    const imageUrl = typeof input['image_url'] === 'string' ? input['image_url'].trim() : '';
    const source = input['source'] === 'web' || input['source'] === 'commons' ? input['source'] : 'auto';
    const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(Number(input['count'] ?? 1)) || 1));
    if (!query && !pageUrl && !imageUrl) return 'Error: give a query, a page_url or an image_url.';
    if (!(await loadSharp())) return `Error: ${new ImageToolsUnavailableError().message}`;
    const fetcher = this.deps.fetcher ?? safeFetch;
    const signal = options.signal;
    const notes: string[] = [];

    // Where to look, best first.
    const candidates: ImageCandidate[] = [];
    if (imageUrl) candidates.push({ url: imageUrl, page: pageUrl || imageUrl, rank: 0, ...(query ? { alt: query } : {}) });
    const fromPage = async (url: string): Promise<void> => {
      try {
        const page = await fetchHtml(url, fetcher, signal);
        if (page) candidates.push(...pageImages(page.html, page.url));
      } catch (err) {
        notes.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (pageUrl && !imageUrl) await fromPage(pageUrl);
    if (query && !pageUrl && !imageUrl && source !== 'commons') {
      const pages = await (this.deps.search ?? openWebPages)(query, signal).catch(() => [] as string[]);
      // Side by side, then in the search's order: the first page's pictures first.
      const found = await Promise.all(pages.slice(0, MAX_PAGES).map(async (url) => {
        try {
          const page = await fetchHtml(url, fetcher, signal);
          return page ? pageImages(page.html, page.url).slice(0, 2) : [];
        } catch { return []; }
      }));
      // One picture per page before a second from any: different sources, not the same photo twice.
      for (let i = 0; i < 2; i++) for (const list of found) if (list[i]) candidates.push(list[i]!);
      if (!pages.length) notes.push('the web search found no pages');
    }
    const fromCommons = (): Promise<ImageCandidate[]> => commonsImages(query, { fetcher, ...(signal ? { signal } : {}) }).catch(() => []);
    if (query && !pageUrl && !imageUrl && source === 'commons') candidates.push(...await fromCommons());

    const saved: string[] = [];
    const seen = new Set<string>();
    let tries = 0;
    // auto: the web's pictures first, with some tries kept back, so pictures that
    // all turn out dead, tiny or not pictures at all still leave room for Commons.
    const commonsAfter = query && !pageUrl && !imageUrl && source === 'auto';
    const tryAll = async (list: ImageCandidate[], budget: number): Promise<string | null> => {
      for (const c of list) {
        if (saved.length >= count || tries >= budget) break;
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        tries++;
        const failed = await this.saveOne(c, query, fetcher, signal, saved);
        if (failed instanceof ImageToolsUnavailableError) return `Error: ${failed.message}`;
        if (failed) notes.push(`${c.url}: ${failed}`);
      }
      return null;
    };
    const stop = await tryAll(candidates, commonsAfter ? MAX_TRIES - COMMONS_TRIES : MAX_TRIES);
    if (stop) return stop;
    if (commonsAfter && saved.length < count) {
      const more = await tryAll(await fromCommons(), MAX_TRIES);
      if (more) return more;
    }

    if (!saved.length) {
      const why = notes.length ? ` Tried: ${notes.slice(0, 4).join('; ')}.` : '';
      return `Error: found no usable picture${query ? ` for "${query}"` : ''}.${why} Try other words, a product or shop page as page_url, or source "commons". Generate an image only if the user wants an illustration rather than the real thing.`;
    }
    return [
      `Saved ${saved.length} real picture${saved.length > 1 ? 's' : ''}${query ? ` for "${query}"` : ''}. Embed with the Markdown line and keep the caption under it:`,
      ...saved,
      'To circle, label, point at or blur part of one: annotate_image with its path.',
    ].join('\n');
  }

  /** Downloads and saves one picture, adding its lines to `saved`. Says why not, if not. */
  private async saveOne(c: ImageCandidate, query: string, fetcher: ImageFetch, signal: AbortSignal | undefined, saved: string[]): Promise<string | ImageToolsUnavailableError | null> {
    {
      try {
        const img = await fetchImage(c.url, { fetcher, ...(signal ? { signal } : {}), referer: c.page });
        const name = uniqueName(slug(query || c.alt || new URL(c.page).hostname), img.mime === 'image/png' ? 'png' : 'jpg');
        const locator = await this.deps.sink({ data: img.bytes, mimeType: img.mime, filename: name });
        const src = { kind: 'web' as const, url: c.url, page: c.page, ...(c.credit ? { credit: c.credit } : {}), ...(c.license ? { license: c.license } : {}) };
        this.deps.assets.set(locator, { bytes: img.bytes, mime: img.mime, width: img.width, height: img.height, source: src });
        const alt = (c.alt || query || 'image').replace(/[[\]\n]/g, ' ').slice(0, 100);
        saved.push(`${saved.length + 1}. ${locator} (${img.width}×${img.height}) from ${c.page}\n   ![${alt}](${locator})\n   *${captionFor(src)}*`);
        return null;
      } catch (err) {
        if (err instanceof ImageToolsUnavailableError) return err;
        return err instanceof Error ? err.message : String(err);
      }
    }
  }
}

const SHAPES: readonly MarkShape[] = ['circle', 'box', 'arrow', 'highlight', 'label', 'number', 'blur'];

export class AnnotateImageTool extends BaseTool {
  readonly name = 'annotate_image';
  // Draws on a copy, on this machine.
  override readonly localOnlySafe = true;
  readonly description =
    'Mark up a copy of an image for a report: circle or box a part, point an arrow at it, highlight it, add a label or a number, or blur something private (a name, an address, a card number). '
    + 'Works on a picture from find_image, a screenshot from browser_control capture, a generated image, or an image file in the workspace. '
    + 'Each mark has a shape and a place: box [x, y, width, height] in the image\'s pixels or as fractions of it (0-1), or, on a capture, ref (e14) to mark a control by its ref. '
    + 'Returns the marked copy\'s path and a Markdown line to embed it.';

  readonly inputSchema = {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'The path find_image, browser_control capture or generate_image returned, or a workspace image path.' },
      marks: {
        type: 'array',
        description: `What to draw, in order (at most ${MAX_MARKS}).`,
        items: {
          type: 'object',
          properties: {
            shape: { type: 'string', enum: [...SHAPES], description: 'circle, box, arrow (points at the place), highlight (translucent fill), label (text), number (a numbered badge), blur (hides what is there).' },
            box: { type: 'array', items: { type: 'number' }, description: '[x, y, width, height] in pixels, or all four as fractions 0-1 of the image.' },
            ref: { type: 'string', description: 'On a capture: a control from its page view, such as e14, instead of a box.' },
            text: { type: 'string', description: 'Text for a label, or a caption on a circle, box, arrow or highlight; the digits for a number.' },
            color: { type: 'string', description: 'A colour name or #hex. Default red (highlight: yellow).' },
            from: { type: 'array', items: { type: 'number' }, description: 'For an arrow: [x, y] where it starts. Default: up and to the left of the place.' },
          },
          required: ['shape'],
        },
      },
      caption: { type: 'string', description: 'Optional: words for the image\'s Markdown alt text.' },
    },
    required: ['image', 'marks'],
  };

  constructor(private readonly deps: Pick<ReportImageDeps, 'assets' | 'sink'>) { super(); }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const locator = typeof input['image'] === 'string' ? input['image'].trim() : '';
    if (!locator) return 'Error: image is required: the path an image tool returned.';
    const rawMarks = Array.isArray(input['marks']) ? input['marks'] : [];
    const marks: Mark[] = [];
    for (const [i, m] of rawMarks.entries()) {
      if (!m || typeof m !== 'object') return `Error: mark ${i + 1} is not an object.`;
      const o = m as Record<string, unknown>;
      if (!SHAPES.includes(o['shape'] as MarkShape)) return `Error: mark ${i + 1} needs a shape: one of ${SHAPES.join(', ')}.`;
      const nums = (v: unknown, n: number) => (Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number') ? v as number[] : undefined);
      const box = nums(o['box'], 4);
      const from = nums(o['from'], 2);
      marks.push({
        shape: o['shape'] as MarkShape,
        ...(box ? { box: box as [number, number, number, number] } : {}),
        ...(typeof o['ref'] === 'string' ? { ref: o['ref'] } : {}),
        ...(typeof o['text'] === 'string' ? { text: o['text'] } : {}),
        ...(typeof o['color'] === 'string' ? { color: o['color'] } : {}),
        ...(from ? { from: from as [number, number] } : {}),
      });
    }

    const name = uniqueName(`${slug(locator.split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, ''))}-marked`, 'png');
    let image: StoredImage | undefined = this.deps.assets.get(locator);
    if (!image) {
      const read = await this.readWorkspaceImage(locator, options);
      if (typeof read === 'string') return read;
      // The copy goes where generated media go, readable by every worker: a
      // local-only picture (privacy.paths) is not copied there.
      const dest = path.join(this.workspaceRoot, 'generated', name);
      if (!this.readGate(options, { file: dest })(read.abs) || options.isOffline?.()) {
        return `Error: ${locator} is local-only (privacy.paths), and a marked copy would be saved where other workers can read it. Mark it up outside Cascade, or remove it from privacy.paths.`;
      }
      image = read.image;
    }
    // Whatever the picture, the marks are this call's: a local-only subtask's
    // labels can carry what it read from privacy.paths, and generated/ is
    // readable by every worker. Checked as the copy is about to be made.
    if (options.isOffline?.()) {
      return 'Error: this subtask is local-only (privacy.paths), and a marked copy would be saved where other workers can read it, with its labels. Mark it up in a subtask that is not local-only, with no private details in the labels.';
    }
    try {
      const out = await annotateImage(image, marks);
      const saved = await this.deps.sink({ data: out.bytes, mimeType: 'image/png', filename: name });
      // The marked copy keeps the original's source, for its caption, and its refs.
      this.deps.assets.set(saved, {
        bytes: out.bytes, mime: 'image/png', width: out.width, height: out.height,
        ...(image.source ? { source: image.source } : {}),
        ...(image.boxes ? { boxes: image.boxes } : {}),
      });
      const alt = (typeof input['caption'] === 'string' && input['caption'].trim() ? input['caption'] : 'Marked-up image').replace(/[[\]\n]/g, ' ').slice(0, 100);
      const caption = captionFor(image.source);
      return [
        `Saved the marked-up copy: ${saved} (${out.width}×${out.height}, ${marks.length} mark${marks.length > 1 ? 's' : ''}).`,
        `![${alt}](${saved})`,
        ...(caption ? [`*${caption}*`] : []),
      ].join('\n');
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** An image file in the workspace, read through the same gate file_read uses. */
  private async readWorkspaceImage(locator: string, options: ToolExecuteOptions): Promise<{ image: StoredImage; abs: string } | string> {
    if (/^[a-z]+:\/\//i.test(locator)) {
      return `Error: ${locator} is not an image this run made or found. Save it with find_image (image_url) first, then annotate the path that returns.`;
    }
    let abs: string;
    try { abs = resolveInWorkspace(this.workspaceRoot, locator); } catch { return `Error: ${locator} is outside the workspace.`; }
    if (this.isProtectedPath(abs) || !this.readGate(options)(abs)) return `Error: ${locator} may not be read here.`;
    const sharp = await loadSharp();
    if (!sharp) return `Error: ${new ImageToolsUnavailableError().message}`;
    try {
      const bytes = await fs.readFile(abs);
      const meta = await sharp(bytes).metadata();
      if (!meta.width || !meta.height || meta.format === 'svg') return `Error: ${locator} is not a picture this can mark up.`;
      return { image: { bytes, mime: `image/${meta.format}`, width: meta.width, height: meta.height }, abs };
    } catch {
      return `Error: no image at ${locator}. Use the path an image tool returned.`;
    }
  }
}

/**
 * The two tools, sharing one store. find_image needs the web. annotate_image
 * needs something to mark up: a run with no way to get an image (no web, no
 * image model, no browser) is not offered it, so a pure chat stays toolless.
 */
export function buildReportImageTools(deps: ReportImageDeps, opts: { web: boolean; imageSource: boolean }): BaseTool[] {
  return [
    ...(opts.web ? [new FindImageTool(deps)] : []),
    ...(opts.web || opts.imageSource ? [new AnnotateImageTool(deps)] : []),
  ];
}
