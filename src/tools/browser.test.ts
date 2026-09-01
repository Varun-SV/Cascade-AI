// ─────────────────────────────────────────────
//  Cascade AI — browser tool
// ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserTool } from './browser.js';

/** A page that records what it was asked to do and hands back a fake PNG. */
function fakePage(png: Buffer) {
  return {
    screenshot: vi.fn().mockResolvedValue(png),
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue('T'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Stub `playwright` at the module level — the tool imports it dynamically, so
 * this intercepts that import without the package (or a real Chromium) being
 * involved.
 */
function stubPlaywright(page: ReturnType<typeof fakePage>) {
  vi.doMock('playwright', () => ({
    chromium: {
      launch: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue(page),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    },
  }));
}

describe('BrowserTool — screenshot', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-browser-'));
    vi.resetModules();
  });

  afterEach(async () => {
    vi.doUnmock('playwright');
    // The collision test freezes Date.now(); leaving it frozen would quietly
    // change what any later test in this file measures.
    vi.restoreAllMocks();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('writes the PNG to the workspace and returns the path, not the image', async () => {
    // The bug this pins: it used to return `data:image/png;base64,…`. A tool
    // result is plain text that goes straight into the model's context, and
    // NOTHING in the codebase turns a data URI into an image content block —
    // so the one action that needed a vision model was the one action no model
    // could see, and it spent a few hundred KB of base64 as tokens saying
    // nothing. `image_analyze` takes a path, so a path is what composes.
    const png = Buffer.from('89504e470d0a1a0a' + '00'.repeat(4096), 'hex');
    stubPlaywright(fakePage(png));
    const { BrowserTool: Tool } = await import('./browser.js');
    const tool = new Tool();
    tool.setWorkspaceRoot(workspace);

    const out = await tool.execute({ action: 'screenshot' }, {} as never);

    expect(out).not.toContain('base64');
    expect(out).not.toContain('data:image');
    expect(out).toContain('image_analyze');

    // ABSOLUTE, because image_analyze reads with a bare fs.readFile and never
    // consults its own workspace root — a relative path would resolve against
    // process.cwd() and ENOENT wherever the workspace isn't the cwd, which is
    // every hosted run, every SDK embedder, and the desktop app.
    const named = /\S*screenshot-[\w-]+\.png/.exec(out)?.[0];
    expect(named, `no filename in: ${out}`).toBeTruthy();
    expect(path.isAbsolute(named!), `expected an absolute path, got: ${named}`).toBe(true);
    expect(named!.startsWith(await fs.realpath(workspace))).toBe(true);

    const written = await fs.readFile(named!);
    expect(written.equals(png)).toBe(true);
  });

  it('gives screenshots taken in the same millisecond distinct filenames', async () => {
    // T3 workers run in parallel and share one registry and one workspace, so
    // a `Date.now()`-only name collides whenever two land in the same
    // millisecond — one PNG overwrites the other and both workers are told to
    // inspect the survivor, each believing it holds their own page.
    //
    // The clock is FROZEN rather than the calls being raced. Racing them only
    // reproduces the collision if two happen to land in the same millisecond,
    // and they mostly do not — an earlier version of this test passed against
    // the very bug it was written for, because every iteration got its own
    // millisecond and uniqueness proved nothing. Pinning Date.now() makes the
    // collision certain instead of likely: with a timestamp-only name all 25
    // of these are the same path.
    vi.spyOn(Date, 'now').mockReturnValue(1_788_000_000_000);

    stubPlaywright(fakePage(Buffer.from('89504e470d0a1a0a', 'hex')));
    const { BrowserTool: Tool } = await import('./browser.js');
    const tool = new Tool();
    tool.setWorkspaceRoot(workspace);

    const names: string[] = [];
    for (let i = 0; i < 25; i++) {
      const out = await tool.execute({ action: 'screenshot' }, {} as never);
      names.push(/\S*screenshot-\S*\.png/.exec(out)?.[0] ?? '');
    }

    expect(names.every(Boolean), `a call produced no filename: ${JSON.stringify(names)}`).toBe(true);
    expect(new Set(names).size, `collided: ${JSON.stringify(names.slice(0, 3))}`).toBe(names.length);

    // And every one of them is still on disk — a collision would have left
    // fewer files than calls even if the names had differed.
    const written = (await fs.readdir(path.join(workspace, '.cascade', 'screenshots')))
      .filter((f) => f.endsWith('.png'));
    expect(written.length).toBe(names.length);
  });

  it('writes into .cascade/, leaving the workspace root clean', async () => {
    // A workspace is usually a git checkout. Dropping PNGs in its root leaves
    // the worktree dirty after ordinary browser use and they are never cleaned
    // up, so they accumulate. `.gitignore` already covers `.cascade/`, and the
    // interpreter's scratch dir sets the precedent.
    stubPlaywright(fakePage(Buffer.from('89504e470d0a1a0a', 'hex')));
    const { BrowserTool: Tool } = await import('./browser.js');
    const tool = new Tool();
    tool.setWorkspaceRoot(workspace);

    const out = await tool.execute({ action: 'screenshot' }, {} as never);

    expect(out).toContain(path.join('.cascade', 'screenshots'));
    const rootEntries = await fs.readdir(workspace);
    expect(rootEntries.filter((f) => f.endsWith('.png'))).toEqual([]);
    expect(rootEntries).toContain('.cascade');
  });

  it('keeps the result small enough to be worth putting in a context window', async () => {
    // A 4 KB PNG became ~5.5 KB of base64 before; a real viewport screenshot is
    // hundreds of KB. The assertion is on the ORDER of magnitude, not a byte
    // count — the point is that the result no longer scales with the image.
    const png = Buffer.alloc(512_000, 7);
    stubPlaywright(fakePage(png));
    const { BrowserTool: Tool } = await import('./browser.js');
    const tool = new Tool();
    tool.setWorkspaceRoot(workspace);

    const out = await tool.execute({ action: 'screenshot' }, {} as never);
    expect(out.length).toBeLessThan(300);
  });
});

describe('BrowserTool — gating', () => {
  it('requires approval, since it drives a real browser', () => {
    expect(new BrowserTool().isDangerous()).toBe(true);
  });

  it('no longer advertises a model restriction it does not enforce', () => {
    // registry.ts gates this tool on `tools.browserEnabled` and nothing else —
    // no model capability is consulted anywhere. The description used to claim
    // "Only available with multimodal models", and the README said the same,
    // which was harmless only while the flag defaulted to false.
    const { description } = new BrowserTool().getDefinition();
    expect(description).not.toMatch(/multimodal|vision.only/i);
  });
});
