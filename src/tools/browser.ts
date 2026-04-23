// ─────────────────────────────────────────────
//  Cascade AI — Browser Automation Tool (T3 + multimodal only)
// ─────────────────────────────────────────────

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

const BROWSER_LAUNCH_TIMEOUT_MS = 15_000;

export class BrowserTool extends BaseTool {
  readonly name = 'browser';
  readonly description = 'Control a browser: navigate to URLs, click elements, fill forms, take screenshots. Only available with multimodal models.';
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
          const buf = await page.screenshot({ type: 'png' });
          return `data:image/png;base64,${buf.toString('base64')}`;
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
