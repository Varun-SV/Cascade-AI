import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ImageAssets } from '../media/report-images.js';
import { AnnotateImageTool, FindImageTool, buildReportImageTools } from './report-images.js';
import { BrowserControlTool, type BrowserAction, type BrowserController } from './browser-control.js';

async function picture(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 210, b: 220 } } }).jpeg().toBuffer();
}

/** A sink that keeps what it is given, saying where like the workspace sink does. */
function sinkInto() {
  const saved: Array<{ name: string; data: Buffer; mimeType: string }> = [];
  const sink = vi.fn(async (a: { data: Buffer; mimeType: string; filename: string }) => {
    saved.push({ name: a.filename, data: a.data, mimeType: a.mimeType });
    return `generated/${a.filename}`;
  });
  return { saved, sink };
}

/** A web of pages and pictures, by address. */
function web(routes: Record<string, { body: string | Buffer; type: string; status?: number }>) {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(typeof r.body === 'string' ? r.body : new Uint8Array(r.body), { status: r.status ?? 200, headers: { 'content-type': r.type } });
  };
  return { asked, fetcher };
}

describe('find_image', () => {
  it('takes the product pictures the search\'s pages name, one per page first, and credits each', async () => {
    const img = await picture(900, 700);
    const { asked, fetcher } = web({
      'https://shop.example/aria2': { body: '<title>Aria 2</title><meta property="og:image" content="https://shop.example/hero.jpg">', type: 'text/html' },
      'https://review.example/aria2': { body: '<meta property="og:image" content="/r.jpg">', type: 'text/html; charset=utf-8' },
      'https://shop.example/hero.jpg': { body: img, type: 'image/jpeg' },
      'https://review.example/r.jpg': { body: img, type: 'image/jpeg' },
    });
    const assets = new ImageAssets();
    const { saved, sink } = sinkInto();
    const tool = new FindImageTool({ assets, sink, fetcher, search: async () => ['https://shop.example/aria2', 'https://review.example/aria2'] });

    const out = await tool.execute({ query: 'Moondrop Aria 2', count: 2 }, {} as never);

    // Each save gets a name of its own: a second search for the same thing must
    // not write over the first's picture (Codex on 53a9cae).
    expect(saved.map((s) => s.name)).toEqual([expect.stringMatching(/^moondrop-aria-2-[0-9a-f]{8}\.jpg$/), expect.stringMatching(/^moondrop-aria-2-[0-9a-f]{8}\.jpg$/)]);
    expect(saved[0]!.name).not.toBe(saved[1]!.name);
    const first = `generated/${saved[0]!.name}`;
    expect(out).toContain(`![Aria 2](${first})`);
    expect(out).toContain('*Image: shop.example*');
    expect(out).toContain('*Image: review.example*');
    expect(assets.get(first)?.source).toEqual(expect.objectContaining({ kind: 'web', page: 'https://shop.example/aria2' }));
    expect(asked).not.toContain('https://commons.wikimedia.org');
  });

  it('skips a dead or tiny picture and takes the next', async () => {
    const { fetcher } = web({
      'https://p.example/': { body: '<meta property="og:image" content="https://p.example/gone.jpg"><img src="https://p.example/tiny.png" ><img src="https://p.example/ok.jpg" width="600" height="400">', type: 'text/html' },
      'https://p.example/tiny.png': { body: await sharp({ create: { width: 30, height: 30, channels: 3, background: 'red' } }).png().toBuffer(), type: 'image/png' },
      'https://p.example/ok.jpg': { body: await picture(600, 400), type: 'image/jpeg' },
    });
    const { saved, sink } = sinkInto();
    const out = await new FindImageTool({ assets: new ImageAssets(), sink, fetcher }).execute({ page_url: 'https://p.example/' }, {} as never);
    expect(saved).toHaveLength(1);
    expect(out).toContain('(600×400)');
  });

  it('falls back to Wikimedia Commons, with author and licence', async () => {
    const commons = { query: { pages: { '1': { index: 1, title: 'File:Charminar.jpg', imageinfo: [{ thumburl: 'https://upload.example/c.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Charminar.jpg',
      extmetadata: { Artist: { value: 'A. Photographer' }, LicenseShortName: { value: 'CC BY 4.0' } } }] } } } };
    const fetcher = async (url: string) => url.startsWith('https://commons.wikimedia.org/w/api.php')
      ? new Response(JSON.stringify(commons), { headers: { 'content-type': 'application/json' } })
      : url === 'https://upload.example/c.jpg' ? new Response(new Uint8Array(await picture(800, 600)), { headers: { 'content-type': 'image/jpeg' } })
        : new Response('', { status: 404 });
    const { sink } = sinkInto();
    const out = await new FindImageTool({ assets: new ImageAssets(), sink, fetcher, search: async () => [] }).execute({ query: 'Charminar' }, {} as never);
    expect(out).toContain('*Image: commons.wikimedia.org (A. Photographer, CC BY 4.0)*');
  });

  it('still tries Commons when every picture the web pages name turns out unusable (Codex on 53a9cae)', async () => {
    // Four pages, two dead pictures each: eight candidates, as many as a call may try.
    const pages = Array.from({ length: 4 }, (_, i) => `https://p${i}.example/`);
    const commons = { query: { pages: { '1': { index: 1, title: 'File:C.jpg', imageinfo: [{ thumburl: 'https://upload.example/c.jpg', extmetadata: {} }] } } } };
    const fetcher = async (url: string) => {
      if (pages.includes(url)) return new Response(`<meta property="og:image" content="${url}a.jpg"><meta name="twitter:image" content="${url}b.jpg">`, { headers: { 'content-type': 'text/html' } });
      if (url.startsWith('https://commons.wikimedia.org/w/api.php')) return new Response(JSON.stringify(commons), { headers: { 'content-type': 'application/json' } });
      if (url === 'https://upload.example/c.jpg') return new Response(new Uint8Array(await picture(800, 600)), { headers: { 'content-type': 'image/jpeg' } });
      return new Response('', { status: 404 });
    };
    const { saved, sink } = sinkInto();
    const out = await new FindImageTool({ assets: new ImageAssets(), sink, fetcher, search: async () => pages }).execute({ query: 'thing' }, {} as never);
    expect(saved).toHaveLength(1);
    expect(out).toContain('commons.wikimedia.org');
  });

  it('reads no more of a page than the cap, however large it is (Codex on 53a9cae)', async () => {
    let sent = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode(`<p>${'x'.repeat(64 * 1024)}</p>`);
    const huge = () => new ReadableStream<Uint8Array>({
      pull(c) { if (sent > 50 * 1024 * 1024) { c.close(); return; } sent += chunk.byteLength; c.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const fetcher = async () => new Response(huge(), { headers: { 'content-type': 'text/html' } });
    await new FindImageTool({ assets: new ImageAssets(), sink: sinkInto().sink, fetcher }).execute({ page_url: 'https://big.example/' }, {} as never);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(5 * 1024 * 1024);
  });

  it('says what it tried when nothing is usable, and points away from generating', async () => {
    const { fetcher } = web({});
    const out = await new FindImageTool({ assets: new ImageAssets(), sink: sinkInto().sink, fetcher, search: async () => [] })
      .execute({ query: 'nonexistent gadget', source: 'web' }, {} as never);
    expect(out).toMatch(/^Error: found no usable picture/);
    expect(out).toContain('Generate an image only if the user wants an illustration');
  });

  it('needs something to look for', async () => {
    expect(await new FindImageTool({ assets: new ImageAssets(), sink: sinkInto().sink }).execute({}, {} as never)).toMatch(/give a query/);
  });
});

describe('annotate_image', () => {
  it('marks up a picture the run found and keeps its source for the caption', async () => {
    const assets = new ImageAssets();
    assets.set('generated/aria.jpg', { bytes: await picture(800, 600), mime: 'image/jpeg', width: 800, height: 600, source: { kind: 'web', page: 'https://www.rtings.com/x' } });
    const { saved, sink } = sinkInto();
    const out = await new AnnotateImageTool({ assets, sink }).execute({
      image: 'generated/aria.jpg',
      marks: [{ shape: 'circle', box: [0.4, 0.4, 0.2, 0.2], text: 'Nozzle' }, { shape: 'arrow', box: [100, 100, 50, 50] }],
      caption: 'The nozzle',
    }, {} as never);
    expect(saved[0]!.mimeType).toBe('image/png');
    expect(saved[0]!.name).toMatch(/^aria-marked-[0-9a-f]{8}\.png$/);
    expect(out).toContain(`![The nozzle](generated/${saved[0]!.name})`);
    expect(out).toContain('*Image: rtings.com*');
    expect(assets.get(`generated/${saved[0]!.name}`)?.source?.page).toBe('https://www.rtings.com/x');
  });

  it('marks up a photo whose EXIF turns it on its side, as it is seen (Codex on 53a9cae)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annot-'));
    // Stored 400×200, shown 200×400: orientation 6 is "turn 90° clockwise".
    await fs.writeFile(path.join(dir, 'side.jpg'), await sharp({ create: { width: 400, height: 200, channels: 3, background: 'white' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer());
    const tool = new AnnotateImageTool({ assets: new ImageAssets(), sink: sinkInto().sink });
    tool.setWorkspaceRoot(dir);
    const out = await tool.execute({ image: 'side.jpg', marks: [{ shape: 'box', box: [0.1, 0.8, 0.5, 0.1] }, { shape: 'blur', box: [0.1, 0.1, 0.5, 0.5] }] }, {} as never);
    expect(out).toMatch(/\(200×400, 2 marks\)/);
  });

  it('makes no copy of a local-only picture where other workers can read it (Codex on 53a9cae)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annot-'));
    await fs.mkdir(path.join(dir, 'private'));
    await fs.writeFile(path.join(dir, 'private', 'id.png'), await sharp({ create: { width: 300, height: 200, channels: 3, background: 'white' } }).png().toBuffer());
    const { saved, sink } = sinkInto();
    const tool = new AnnotateImageTool({ assets: new ImageAssets(), sink });
    tool.setWorkspaceRoot(dir);
    // As the registry answers for privacy.paths: readable by a private model, not copyable out.
    const asked: unknown[] = [];
    const mayRead = (_p: string, to: unknown) => { asked.push(to); return to === 'model'; };
    const out = await tool.execute({ image: 'private/id.png', marks: [{ shape: 'blur', box: [0, 0, 100, 50] }] }, { mayRead } as never);
    expect(out).toMatch(/^Error: private\/id\.png is local-only/);
    expect(saved).toHaveLength(0);
    expect(asked).toContainEqual({ file: expect.stringMatching(/generated[\\/]id-marked-[0-9a-f]{8}\.png$/) });
  });

  it('reads an image from the workspace', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annot-'));
    await fs.writeFile(path.join(dir, 'chart.png'), await sharp({ create: { width: 300, height: 200, channels: 3, background: 'white' } }).png().toBuffer());
    const tool = new AnnotateImageTool({ assets: new ImageAssets(), sink: sinkInto().sink });
    tool.setWorkspaceRoot(dir);
    const out = await tool.execute({ image: 'chart.png', marks: [{ shape: 'highlight', box: [10, 10, 100, 20] }] }, {} as never);
    expect(out).toMatch(/Saved the marked-up copy: generated\/chart-marked-[0-9a-f]{8}\.png \(300×200, 1 mark\)/);
  });

  it('refuses a file outside the workspace, a remote address and a bad mark', async () => {
    const assets = new ImageAssets();
    assets.set('a.jpg', { bytes: await picture(100, 100), mime: 'image/jpeg', width: 100, height: 100 });
    const tool = new AnnotateImageTool({ assets, sink: sinkInto().sink });
    tool.setWorkspaceRoot(os.tmpdir());
    expect(await tool.execute({ image: '../../etc/passwd', marks: [{ shape: 'box', box: [1, 1, 1, 1] }] }, {} as never)).toMatch(/outside the workspace|no image/);
    expect(await tool.execute({ image: 'https://x.example/a.jpg', marks: [{ shape: 'box', box: [1, 1, 1, 1] }] }, {} as never)).toMatch(/Save it with find_image/);
    expect(await tool.execute({ image: 'a.jpg', marks: [{ shape: 'sparkle' }] }, {} as never)).toMatch(/needs a shape/);
    expect(await tool.execute({ image: 'a.jpg', marks: [{ shape: 'box' }] }, {} as never)).toMatch(/give a box/);
  });
});

describe('buildReportImageTools', () => {
  it('offers find_image only where the run may reach the web, and annotate_image only where there is an image to mark up', () => {
    const deps = { assets: new ImageAssets(), sink: sinkInto().sink };
    expect(buildReportImageTools(deps, { web: true, imageSource: false }).map((t) => t.name)).toEqual(['find_image', 'annotate_image']);
    expect(buildReportImageTools(deps, { web: false, imageSource: true }).map((t) => t.name)).toEqual(['annotate_image']);
    // A pure chat: nothing to find, nothing to mark up.
    expect(buildReportImageTools(deps, { web: false, imageSource: false })).toEqual([]);
  });
});

describe('browser_control capture', () => {
  async function capturing(boxes = [{ ref: 'e3', x: 100, y: 100, w: 80, h: 30 }, { ref: 'e9', x: 600, y: 500, w: 40, h: 20 }]) {
    const shot = await picture(800, 600);
    const calls: BrowserAction[] = [];
    const controller: BrowserController = async (action) => {
      calls.push(action);
      return {
        ok: true, detail: 'Observed the page.', url: 'https://www.amazon.in/dp/B0X', title: 'Moondrop Aria 2',
        view: { text: 'PAGE VIEW', labels: { e3: 'button "Add to cart"', e9: 'link "Reviews"' } },
        image: { data: shot.toString('base64'), mimeType: 'image/jpeg', width: 800, height: 600 },
        boxes,
      };
    };
    const assets = new ImageAssets();
    const { saved, sink } = sinkInto();
    const tool = new BrowserControlTool(controller, undefined, { pageView: true, reportImages: { assets, sink } });
    return { tool, calls, assets, saved };
  }

  it('saves a clean screenshot with where each control is, and does not show it to the model', async () => {
    const { tool, calls, assets, saved } = await capturing();
    const attachImage = vi.fn();
    const out = await tool.execute({ action: 'capture' }, { sessionId: 's', attachImage } as never);
    expect(calls).toEqual([{ kind: 'observe', pageView: true, screenshot: true, capture: true }]);
    expect(attachImage).not.toHaveBeenCalled();
    expect(saved[0]!.name).toMatch(/^screenshot-amazon\.in-1-[0-9a-f]{8}\.jpg$/);
    const shot = `generated/${saved[0]!.name}`;
    expect(out).toContain(`![Moondrop Aria 2](${shot})`);
    expect(out).toMatch(/\*Screenshot of amazon\.in, \d{4}-\d\d-\d\d\*/);
    expect(out).toContain('e3 button "Add to cart" at [100, 100, 80, 30]');
    expect(assets.get(shot)?.boxes?.['e3']).toEqual({ x: 100, y: 100, w: 80, h: 30 });
  });

  it('with a ref, crops to that control and keeps the boxes inside it', async () => {
    const { tool, assets, saved } = await capturing();
    await tool.execute({ action: 'observe' }, { sessionId: 's' } as never);
    const out = await tool.execute({ action: 'capture', ref: 'e3' }, { sessionId: 's' } as never);
    const img = assets.get(`generated/${saved[0]!.name}`)!;
    expect([img.width, img.height]).toEqual([176, 126]);
    expect(img.boxes).toEqual({ e3: { x: 48, y: 48, w: 80, h: 30 } });
    expect(out).not.toContain('e9');
  });

  it('says why when no picture could be taken', async () => {
    const controller: BrowserController = async () => ({
      ok: true, detail: 'Observed.', view: { text: 'PAGE VIEW\n\nNo screenshot: a password, card or one-time-code field is on screen.', labels: {} }, imageWithheld: true,
    });
    const tool = new BrowserControlTool(controller, undefined, { pageView: true, reportImages: { assets: new ImageAssets(), sink: sinkInto().sink } });
    expect(await tool.execute({ action: 'capture' }, { sessionId: 's' } as never)).toBe('No screenshot: a password, card or one-time-code field is on screen.');
  });

  it('is not offered without somewhere to save pictures', async () => {
    const tool = new BrowserControlTool(async () => ({ ok: true, detail: '' }), undefined, { pageView: true });
    expect(JSON.stringify(tool.getDefinition())).not.toContain('capture');
    expect(await tool.execute({ action: 'capture' }, { sessionId: 's' } as never)).toMatch(/not something this browser can do/);
  });
});
