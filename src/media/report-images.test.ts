import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  ImageAssets, ImageFetchError, MAX_STORED_IMAGES, annotateImage, captionFor, commonsImages, fetchImage,
  jsonLdImages, pageImages,
} from './report-images.js';

/** A solid-colour picture, as a real encoded file. */
async function picture(w: number, h: number, format: 'png' | 'jpeg' = 'png', color = { r: 240, g: 240, b: 240 }): Promise<Buffer> {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: color } });
  return format === 'png' ? img.png().toBuffer() : img.jpeg().toBuffer();
}

const respond = (body: Buffer | string, type: string, status = 200) => async () =>
  new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'content-type': type } });

async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

describe('pageImages', () => {
  it('ranks the page\'s chosen picture first, then product data, then large body images; resolves against <base>', () => {
    const html = `<html><head><title>Moondrop Aria 2</title><base href="https://cdn.example/shop/">
      <meta property="og:image" content="/img/aria2-hero.jpg">
      <meta name="twitter:image" content="https://cdn.example/tw.jpg">
      <script type="application/ld+json">{"@type":"Product","name":"Aria 2","image":["https://cdn.example/p1.jpg",{"url":"https://cdn.example/p2.jpg"}]}</script>
      </head><body>
      <img src="logo.png" width="40" height="40">
      <img src="icons/cart.png">
      <img src="gallery/side.jpg" width="800" height="600" alt="Aria 2 from the side">
      <img src="vector.svg" width="900">
      </body></html>`;
    const c = pageImages(html, 'https://shop.example/aria2');
    expect(c.map((x) => x.url)).toEqual([
      'https://cdn.example/img/aria2-hero.jpg',
      'https://cdn.example/tw.jpg',
      'https://cdn.example/p1.jpg',
      'https://cdn.example/p2.jpg',
      'https://cdn.example/shop/gallery/side.jpg',
    ]);
    expect(c[4]!.alt).toBe('Aria 2 from the side');
    expect(c[0]!.alt).toBe('Moondrop Aria 2');
    expect(c.every((x) => x.page === 'https://shop.example/aria2')).toBe(true);
  });

  it('takes the largest image of a srcset', () => {
    const c = pageImages('<img srcset="a.jpg 320w, b.jpg 1280w, c.jpg 640w" width="400">', 'https://x.example/');
    expect(c[0]!.url).toBe('https://x.example/b.jpg');
  });

  it('ignores unparseable JSON-LD and non-http addresses', () => {
    expect(jsonLdImages('{not json')).toEqual([]);
    expect(pageImages('<meta property="og:image" content="javascript:alert(1)">', 'https://x.example/')).toEqual([]);
  });
});

describe('fetchImage', () => {
  it('fetches, turns upright, shrinks and re-encodes a picture', async () => {
    const big = await picture(3200, 1600, 'jpeg');
    const got = await fetchImage('https://img.example/a.jpg', { fetcher: respond(big, 'image/jpeg') });
    expect(got.mime).toBe('image/jpeg');
    expect([got.width, got.height]).toEqual([1600, 800]);
    expect((await sharp(got.bytes).metadata()).exif).toBeUndefined();
  });

  it('keeps a PNG with transparency as PNG', async () => {
    const png = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const got = await fetchImage('https://img.example/a.png', { fetcher: respond(png, 'image/png') });
    expect(got.mime).toBe('image/png');
  });

  it('refuses an SVG, a page, a tiny icon and an error status', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><script>alert(1)</script></svg>';
    await expect(fetchImage('https://x.example/a.svg', { fetcher: respond(svg, 'image/svg+xml') })).rejects.toThrow(ImageFetchError);
    await expect(fetchImage('https://x.example/a', { fetcher: respond('<html></html>', 'text/html') })).rejects.toThrow(/not an image/);
    await expect(fetchImage('https://x.example/i.png', { fetcher: respond(await picture(32, 32), 'image/png') })).rejects.toThrow(/too small/);
    await expect(fetchImage('https://x.example/i.png', { fetcher: respond('', 'image/png', 404) })).rejects.toThrow(/404/);
  });

  it('refuses bytes that only claim to be an image', async () => {
    await expect(fetchImage('https://x.example/i.png', { fetcher: respond('not really a png at all', 'image/png') })).rejects.toThrow(ImageFetchError);
  });
});

describe('commonsImages', () => {
  it('reads thumbnails, author and licence, without HTML, and skips SVG files', async () => {
    const body = { query: { pages: {
      '2': { index: 2, title: 'File:Tower.jpg', imageinfo: [{ thumburl: 'https://upload.example/t1600.jpg', url: 'https://upload.example/t.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Tower.jpg',
        extmetadata: { Artist: { value: '<a href="x">Jane Doe</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } } }] },
      '1': { index: 1, title: 'File:Logo.svg', imageinfo: [{ url: 'https://upload.example/logo.svg' }] },
    } } };
    let asked = '';
    const c = await commonsImages('eiffel tower', { fetcher: async (url) => { asked = url; return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); } });
    expect(asked).toContain('commons.wikimedia.org');
    expect(c).toEqual([expect.objectContaining({ url: 'https://upload.example/t1600.jpg', credit: 'Jane Doe', license: 'CC BY-SA 4.0', page: 'https://commons.wikimedia.org/wiki/File:Tower.jpg' })]);
  });
});

describe('annotateImage', () => {
  it('draws every shape on a copy of the same size', async () => {
    const bytes = await picture(800, 600);
    const out = await annotateImage({ bytes, width: 800, height: 600 }, [
      { shape: 'circle', box: [100, 100, 100, 60], text: 'Price' },
      { shape: 'box', box: [0.5, 0.5, 0.2, 0.1] },
      { shape: 'arrow', box: [600, 400, 80, 40], text: 'here' },
      { shape: 'highlight', box: [50, 400, 200, 30] },
      { shape: 'label', box: [300, 20, 10, 10], text: 'Note' },
      { shape: 'number', box: [700, 100, 10, 10], text: '1' },
    ]);
    expect([out.width, out.height]).toEqual([800, 600]);
    expect((await sharp(out.bytes).metadata()).format).toBe('png');
    // The circle's stroke passes above the box's top edge, at its middle.
    const [r, g] = await pixel(out.bytes, 150, 100 - 9);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(120);
    // Untouched corner stays the background.
    expect(await pixel(out.bytes, 790, 590)).toEqual([240, 240, 240]);
  });

  it('marks a control by its ref on a screenshot', async () => {
    const bytes = await picture(400, 300);
    const out = await annotateImage({ bytes, width: 400, height: 300, boxes: { e7: { x: 100, y: 100, w: 80, h: 30 } } }, [{ shape: 'highlight', ref: 'e7', color: '#00ff00' }]);
    const [r, g, b] = await pixel(out.bytes, 140, 115);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('blurs the pixels themselves', async () => {
    const bytes = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: await picture(20, 200, 'png', { r: 0, g: 0, b: 0 }), left: 90, top: 0 }]).png().toBuffer();
    const out = await annotateImage({ bytes, width: 200, height: 200 }, [{ shape: 'blur', box: [60, 60, 80, 80] }]);
    const [r] = await pixel(out.bytes, 100, 100);
    expect(r).toBeGreaterThan(20);
    expect(await pixel(out.bytes, 100, 10)).toEqual([0, 0, 0]);
  });

  it('says what is wrong with a mark', async () => {
    const img = { bytes: await picture(100, 100), width: 100, height: 100, boxes: { e1: { x: 1, y: 1, w: 5, h: 5 } } };
    await expect(annotateImage(img, [{ shape: 'circle', ref: 'e9' }])).rejects.toThrow(/e9 is not on this screenshot. Refs on it: e1/);
    await expect(annotateImage(img, [{ shape: 'circle', box: [500, 500, 10, 10] }])).rejects.toThrow(/outside the 100×100 image/);
    await expect(annotateImage(img, [{ shape: 'circle' }])).rejects.toThrow(/give a box/);
    await expect(annotateImage(img, [])).rejects.toThrow(/at least one/);
  });

  it('escapes label text, so a label is never markup', async () => {
    const out = await annotateImage({ bytes: await picture(300, 200), width: 300, height: 200 }, [{ shape: 'label', box: [10, 10, 5, 5], text: '<script>&"\'' }]);
    expect(out.width).toBe(300);
  });
});

describe('ImageAssets', () => {
  it('keeps what passes through the sink, by locator, and forgets the oldest past its bound', async () => {
    const assets = new ImageAssets();
    const bytes = await picture(200, 150);
    let n = 0;
    const sink = assets.recording(async () => `generated/${++n}.png`);
    const first = await sink({ data: bytes, mimeType: 'image/png', filename: 'a.png' });
    expect(assets.get(first)).toEqual(expect.objectContaining({ width: 200, height: 150, mime: 'image/png' }));
    for (let i = 0; i < MAX_STORED_IMAGES; i++) await sink({ data: bytes, mimeType: 'image/png', filename: 'b.png' });
    expect(assets.get(first)).toBeUndefined();
    expect(assets.get(`generated/${n}.png`)).toBeDefined();
  });

  it('records nothing for audio', async () => {
    const assets = new ImageAssets();
    const loc = await assets.recording(async () => 'a.mp3')({ data: Buffer.from('x'), mimeType: 'audio/mpeg', filename: 'a.mp3' });
    expect(assets.get(loc)).toBeUndefined();
  });
});

describe('captionFor', () => {
  it('names the site, the author and licence, or the screenshot date', () => {
    expect(captionFor({ kind: 'web', url: 'https://cdn.x/a.jpg', page: 'https://www.rtings.com/headphones' })).toBe('Image: rtings.com');
    expect(captionFor({ kind: 'web', page: 'https://commons.wikimedia.org/wiki/File:T.jpg', credit: 'Jane Doe', license: 'CC BY-SA 4.0' }))
      .toBe('Image: commons.wikimedia.org (Jane Doe, CC BY-SA 4.0)');
    expect(captionFor({ kind: 'screenshot', page: 'https://www.amazon.in/dp/x', capturedAt: '2026-11-19T06:00:00Z' })).toBe('Screenshot of amazon.in, 2026-11-19');
  });
});
