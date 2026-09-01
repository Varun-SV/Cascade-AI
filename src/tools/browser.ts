// ─────────────────────────────────────────────
//  Cascade AI — Browser Automation Tool
// ─────────────────────────────────────────────
//
//  Registered only when `tools.browserEnabled` is on (registry.ts). That flag
//  is the whole gate — this header used to claim "T3 + multimodal only" and the
//  README claimed a vision-model restriction to match, but no model capability
//  has ever been consulted anywhere. The claim was harmless only because the
//  flag defaults to false, which would stop being true the moment anything in
//  the product turned it on.
//
//  Vision matters for exactly one action, `screenshot`, and it is handled where
//  it actually applies: the PNG is written into the workspace and the path
//  handed back for `image_analyze` to read, so a non-vision model can still
//  navigate, fill and extract text without being denied the tool outright.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { resolveInWorkspace } from './utils/workspace-path.js';

const BROWSER_LAUNCH_TIMEOUT_MS = 15_000;

export class BrowserTool extends BaseTool {
  readonly name = 'browser';
  readonly description = 'Control a browser: navigate to URLs, click elements, fill forms, take screenshots. Screenshots are saved to a file for image_analyze to read.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['navigate', 'click', 'fill', 'screenshot', 'evaluate', 'extract_text', 'wait', 'close'],
      },
      url: { type: 'string', description: 'URL to navigate to' },
      selector: { type: 'string', description: 'CSS selector for click/fill' },
      value: { type: 'string', description: 'Value for fill action' },
      script: { type: 'string', description: 'JavaScript for evaluate action' },
      timeout: { type: 'number', description: 'Timeout ms (default 10000)' },
    },
    required: ['action'],
  };

  private browser: import('playwright').Browser | null = null;
  private page: import('playwright').Page | null = null;

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    let playwright: typeof import('playwright');
    try {
      playwright = await import('playwright');
    } catch {
      return 'Error: Playwright is not installed. Run: npm install playwright && npx playwright install chromium';
    }

    const action = input['action'] as string;
    const timeout = (input['timeout'] as number | undefined) ?? 10_000;

    // Allow explicit close action to clean up
    if (action === 'close') {
      await this.close();
      return 'Browser closed.';
    }

    // Lazy-initialize browser with a launch timeout
    if (!this.browser || !this.page) {
      await this.close(); // clean up any partial state

      const launchPromise = playwright.chromium.launch({ headless: true });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Browser launch timed out after ${BROWSER_LAUNCH_TIMEOUT_MS}ms. Is Chromium installed? Run: npx playwright install chromium`)), BROWSER_LAUNCH_TIMEOUT_MS),
      );

      try {
        this.browser = await Promise.race([launchPromise, timeoutPromise]);
        this.page = await this.browser.newPage();
      } catch (err) {
        this.browser = null;
        this.page = null;
        return `Browser launch failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const page = this.page;

    try {
      switch (action) {
        case 'navigate': {
          await page.goto(input['url'] as string, { timeout });
          const title = await page.title();
          return `Navigated to ${input['url']} (title: "${title}")`;
        }
        case 'click': {
          await page.click(input['selector'] as string, { timeout });
          return `Clicked ${input['selector']}`;
        }
        case 'fill': {
          await page.fill(input['selector'] as string, input['value'] as string);
          return `Filled ${input['selector']} with value`;
        }
        case 'screenshot': {
          // Written to a file, NOT returned inline. This used to hand back a
          // `data:image/png;base64,…` string, and a tool result is plain text
          // that goes straight into the model's context — nothing anywhere in
          // the codebase turns a data URI into an image content block. So the
          // one action that needed a vision model was also the one action no
          // model could see: a few hundred KB of base64 spent as tokens to say
          // nothing. A path costs a dozen and `image_analyze` can actually read
          // it.
          const buf = await page.screenshot({ type: 'png' });
          // `Date.now()` alone collides: T3 workers run concurrently and share
          // one registry and one workspace, so two screenshots taken in the
          // same millisecond resolve to the same path and one silently
          // overwrites the other — each worker then told to inspect a file
          // holding someone else's page.
          // Under `.cascade/screenshots/`, not the workspace root. A workspace
          // is usually a git checkout, `.gitignore` already covers `.cascade/`,
          // and the alternative is every browser call leaving an untracked PNG
          // in someone's repo for them to notice and delete. Same convention as
          // the interpreter's `.cascade/tmp` scratch.
          const rel = path.join('.cascade', 'screenshots', `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
          const abs = resolveInWorkspace(this.workspaceRoot, rel);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, buf);
          // The ABSOLUTE path, not the relative one. image_analyze reads with a
          // bare `fs.readFile(filePath)` and never consults its own workspace
          // root, so a relative path resolves against process.cwd() — which is
          // not the workspace for an SDK embedder, a hosted run, or the
          // desktop app, and the read fails with ENOENT.
          return [
            `Screenshot saved to ${abs} (${Math.round(buf.byteLength / 1024)} KB).`,
            `Call image_analyze with that path to see what is on it — that needs a vision-capable model.`,
          ].join(' ');
        }
        case 'evaluate': {
          const result = await page.evaluate(input['script'] as string);
          return JSON.stringify(result);
        }
        case 'extract_text': {
          const text = await page.locator('body').innerText();
          return text.slice(0, 10_000);
        }
        case 'wait': {
          await page.waitForTimeout(timeout);
          return `Waited ${timeout}ms`;
        }
        default:
          return `Unknown browser action: ${action}. Supported: navigate, click, fill, screenshot, evaluate, extract_text, wait, close`;
      }
    } catch (err) {
      // If the page crashed or navigated away mid-action, reset so next call re-initializes
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/Target closed|Page crashed|Navigation failed/i.test(errMsg)) {
        await this.close();
        return `Browser error (page reset): ${errMsg}`;
      }
      return `Browser action "${action}" failed: ${errMsg}`;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close().catch(() => {});
        this.page = null;
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
    } catch {
      // Swallow errors on cleanup — the browser may already be dead
      this.browser = null;
      this.page = null;
    }
  }
}
