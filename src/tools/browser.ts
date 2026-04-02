// ─────────────────────────────────────────────
//  Cascade AI — Browser Automation Tool (T3 + multimodal only)
// ─────────────────────────────────────────────

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

export class BrowserTool extends BaseTool {
  readonly name = 'browser';
  readonly description = 'Control a browser: navigate to URLs, click elements, fill forms, take screenshots. Only available with multimodal models.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['navigate', 'click', 'fill', 'screenshot', 'evaluate', 'extract_text', 'wait'],
      },
      url: { type: 'string', description: 'URL to navigate to' },
      selector: { type: 'string', description: 'CSS selector for click/fill' },
      value: { type: 'string', description: 'Value for fill action' },
      script: { type: 'string', description: 'JavaScript for evaluate action' },
      timeout: { type: 'number', description: 'Timeout ms (default 10000)' },
    },
    required: ['action'],
  };

  private browser: unknown = null;
  private page: unknown = null;

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    let playwright: typeof import('playwright');
    try {
      playwright = await import('playwright');
    } catch {
      throw new Error('Playwright is not installed. Run: npm install playwright && npx playwright install chromium');
    }

    if (!this.browser) {
      const pw = playwright as typeof import('playwright');
      this.browser = await pw.chromium.launch({ headless: true });
      const b = this.browser as import('playwright').Browser;
      this.page = await b.newPage();
    }

    const page = this.page as import('playwright').Page;
    const action = input['action'] as string;
    const timeout = (input['timeout'] as number | undefined) ?? 10_000;

    switch (action) {
      case 'navigate': {
        await page.goto(input['url'] as string, { timeout });
        return `Navigated to ${input['url']}`;
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
        const text = await page.evaluate(() => document.body.innerText);
        return text.slice(0, 10_000);
      }
      case 'wait': {
        await page.waitForTimeout(timeout);
        return `Waited ${timeout}ms`;
      }
      default:
        throw new Error(`Unknown browser action: ${action}`);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await (this.browser as import('playwright').Browser).close();
      this.browser = null;
      this.page = null;
    }
  }
}
