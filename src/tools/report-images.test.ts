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

    expect(saved.map((s) => s.name)).toEqual(['moondrop-aria-2-1.jpg', 'moondrop-aria-2-2.jpg']);
    expect(out).toContain('![Aria 2](generated/moondrop-aria-2-1.jpg)');
    expect(out).toContain('*Image: shop.example*');
    expect(out).toContain('*Image: review.example*');
    expect(assets.get('generated/moondrop-aria-2-1.jpg')?.source).toEqual(expect.objectContaining({ kind: 'web', page: 'https://shop.example/aria2' }));
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
    expect(out).toContain('![The nozzle](generated/aria-marked.png)');
    expect(out).toContain('*Image: rtings.com*');
    expect(assets.get('generated/aria-marked.png')?.source?.page).toBe('https://www.rtings.com/x');
  });

  it('reads an image from the workspace', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annot-'));
    await fs.writeFile(path.join(dir, 'chart.png'), await sharp({ create: { width: 300, height: 200, channels: 3, background: 'white' } }).png().toBuffer());
    const tool = new AnnotateImageTool({ assets: new ImageAssets(), sink: sinkInto().sink });
    tool.setWorkspaceRoot(dir);
    const out = await tool.execute({ image: 'chart.png', marks: [{ shape: 'highlight', box: [10, 10, 100, 20] }] }, {} as never);
    expect(out).toContain('Saved the marked-up copy: generated/chart-marked.png (300×200, 1 mark)');
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
    expect(saved[0]!.name).toBe('screenshot-amazon.in-1.jpg');
    expect(out).toContain('![Moondrop Aria 2](generated/screenshot-amazon.in-1.jpg)');
    expect(out).toMatch(/\*Screenshot of amazon\.in, \d{4}-\d\d-\d\d\*/);
    expect(out).toContain('e3 button "Add to cart" at [100, 100, 80, 30]');
    expect(assets.get('generated/screenshot-amazon.in-1.jpg')?.boxes?.['e3']).toEqual({ x: 100, y: 100, w: 80, h: 30 });
  });

  it('with a ref, crops to that control and keeps the boxes inside it', async () => {
    const { tool, assets } = await capturing();
    await tool.execute({ action: 'observe' }, { sessionId: 's' } as never);
    const out = await tool.execute({ action: 'capture', ref: 'e3' }, { sessionId: 's' } as never);
    const img = assets.get('generated/screenshot-amazon.in-1.jpg')!;
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
