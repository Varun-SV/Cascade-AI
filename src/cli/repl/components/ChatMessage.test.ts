import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatMessage } from './ChatMessage.js';
import { getTheme } from '../../themes/index.js';
import { loadSharp } from '../../../media/report-images.js';
import { prepareThumbnails } from '../../visuals/terminal-image.js';

const REPLY = [
  'No, 20 pages is not enough to be sold as a commercial novel.',
  '',
  '```chart:bar',
  'title: Fiction Word Count Standards vs Current Manuscript',
  'Format,Word Count',
  'Flash Fiction,1000',
  'Short Story,7500',
  'Current Manuscript (20 pages),9542',
  'Novelette Ceiling,17500',
  'Commercial Novel Target,80000',
  '```',
  '',
  '![A fantasy book cover concept](generated\\cover.png)',
  '',
  'And a chart that does not parse stays as written:',
  '```chart:bar',
  'just one line',
  '```',
].join('\n');

let dir = '';
const level = chalk.level;
beforeAll(async () => {
  chalk.level = 3;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-msg-'));
  fs.mkdirSync(path.join(dir, 'generated'));
  const raw = Buffer.alloc(30 * 40 * 3, 0x60);
  await (await loadSharp())!(raw, { raw: { width: 30, height: 40, channels: 3 } }).png().toFile(path.join(dir, 'generated', 'cover.png'));
});
afterAll(() => { chalk.level = level; fs.rmSync(dir, { recursive: true, force: true }); });

async function frame(width: number): Promise<string> {
  const thumbnails = await prepareThumbnails(REPLY, dir, width);
  let out = '';
  const stdout = Object.assign(new EventEmitter(), { columns: width, rows: 60, isTTY: true, write: (s: string) => { if (s.includes('CASCADE')) out = s; return true; } });
  const app = render(React.createElement(ChatMessage, { role: 'assistant', content: REPLY, theme: getTheme('cascade'), thumbnails, width }),
    { stdout: stdout as never, debug: true, patchConsole: false });
  app.unmount();
  return out;
}
const visible = (s: string) => s.replace(/\x1b\]8;;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '');

describe('a reply with a chart and an image, in the CLI', () => {
  it('draws the chart instead of printing its CSV, and keeps a chart that does not parse as code', async () => {
    const f = visible(await frame(100));
    expect(f).toContain('Fiction Word Count Standards vs Current Manuscript');
    expect(f).toMatch(/Commercial Novel Target\s+█+ 80,000/);
    expect(f).not.toContain('Format,Word Count');
    expect(f).toContain('just one line');
  });

  it('draws the image as a thumbnail with a link to open it, not as markdown', async () => {
    const raw = await frame(100);
    const f = visible(raw);
    expect(f).not.toContain('![A fantasy');
    expect(f).toMatch(/▀{10,}/);
    expect(f).toContain('▣ A fantasy book cover concept  open full size');
    expect(raw).toContain(`\u001b]8;;file://${path.join(dir, 'generated', 'cover.png').replace(/\\/g, '/')}`);
  });

  it('fits a narrow terminal: no line wider than it', async () => {
    for (const l of visible(await frame(60)).split('\n')) expect(l.length, l).toBeLessThanOrEqual(60);
  });
});
