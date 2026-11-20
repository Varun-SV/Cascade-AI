import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSharp } from '../../media/report-images.js';
import { fileLink, findImages, isLocalImage, prepareThumbnails, resolveLocalImage } from './terminal-image.js';

let dir = '';
const level = chalk.level;
beforeAll(async () => {
  // A truecolor terminal, as in a real session: chalk writes no colour to a pipe.
  chalk.level = 3;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-img-'));
  fs.mkdirSync(path.join(dir, 'generated'));
  const sharp = (await loadSharp())!;
  // 40×20, left half red, right half blue.
  const raw = Buffer.alloc(40 * 20 * 3);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) raw.set(x < 20 ? [255, 0, 0] : [0, 0, 255], (y * 40 + x) * 3);
  await sharp(raw, { raw: { width: 40, height: 20, channels: 3 } }).png().toFile(path.join(dir, 'generated', 'cover.png'));
});
afterAll(() => { chalk.level = level; fs.rmSync(dir, { recursive: true, force: true }); });

describe('images in a reply', () => {
  it('finds every image, with its alt text and address', () => {
    const refs = findImages('Before ![A cover](generated\\cover.png) and ![](https://x.test/a.png "t") after');
    expect(refs.map((r) => [r.alt, r.src])).toEqual([['A cover', 'generated\\cover.png'], ['', 'https://x.test/a.png']]);
  });

  it('a web or data address is never treated as a file', () => {
    expect(isLocalImage('https://x.test/a.png')).toBe(false);
    expect(isLocalImage('data:image/png;base64,AAAA')).toBe(false);
    expect(isLocalImage('generated/a.png')).toBe(true);
  });

  it('reads Windows separators as separators, and nothing outside the project or not an image', () => {
    expect(resolveLocalImage('generated\\cover.png', dir)).toBe(path.join(dir, 'generated', 'cover.png'));
    expect(resolveLocalImage('../outside.png', dir)).toBeNull();
    expect(resolveLocalImage('/etc/passwd', dir)).toBeNull();
    expect(resolveLocalImage('generated/notes.txt', dir)).toBeNull();
  });

  it('draws a local image as half blocks in its colours, and leaves a web image alone', async () => {
    const thumbs = await prepareThumbnails('![Cover](generated/cover.png) ![Web](https://x.test/a.png)', dir, 60);
    expect(Object.keys(thumbs)).toEqual(['generated/cover.png']);
    const { lines, file } = thumbs['generated/cover.png']!;
    expect(file).toBe(path.join(dir, 'generated', 'cover.png'));
    expect(lines.length).toBeGreaterThan(2);
    // Red on the left, blue on the right, as 24-bit colour codes.
    expect(lines[0]).toContain('38;2;255;0;0');
    expect(lines[0]).toContain('38;2;0;0;255');
    expect(lines[0]!.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/^▀+$/);
  });

  it('a file that is not there, or not an image, is left as a link', async () => {
    expect(await prepareThumbnails('![x](generated/missing.png)', dir, 60)).toEqual({});
  });

  it('links to the file as a file URL', () => {
    expect(fileLink('/tmp/a b.png', 'open')).toBe('\u001b]8;;file:///tmp/a%20b.png\u0007open\u001b]8;;\u0007');
  });
});

describe('Codex and CodeQL on 5721352', () => {
  it('finding images stays fast on a long run of openers that never close', () => {
    const t0 = performance.now();
    expect(findImages('![\\'.repeat(50_000))).toEqual([]);
    expect(findImages('![](!'.repeat(50_000))).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('still finds images among them, with or without a title', () => {
    const refs = findImages('![a](x.png "Title") ![b](y.png)![ ](z.png "unclosed');
    expect(refs.map((r) => [r.alt, r.src])).toEqual([['a', 'x.png'], ['b', 'y.png']]);
  });

  it('a src named like an object property is no thumbnail', async () => {
    const { thumbnailFor } = await import('./terminal-image.js');
    const thumbs = await prepareThumbnails('![x](constructor) ![y](__proto__) ![z](toString)', dir, 60);
    for (const src of ['constructor', '__proto__', 'toString']) expect(thumbnailFor(thumbs, src)).toBeUndefined();
    expect(thumbnailFor({}, 'constructor')).toBeUndefined();
  });

  it('a link inside the project that points outside it is not followed', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-outside-'));
    try {
      fs.copyFileSync(path.join(dir, 'generated', 'cover.png'), path.join(outside, 'secret.png'));
      fs.symlinkSync(outside, path.join(dir, 'linked'), 'dir');
      expect(await prepareThumbnails('![s](linked/secret.png)', dir, 60)).toEqual({});
      // Control: the same image, really inside the project, is drawn.
      expect(Object.keys(await prepareThumbnails('![c](generated/cover.png)', dir, 60))).toEqual(['generated/cover.png']);
    } finally {
      fs.rmSync(path.join(dir, 'linked'), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
