// ─────────────────────────────────────────────
//  Cascade AI — read_current_page
// ─────────────────────────────────────────────
//
//  The agent half of the desktop's built-in browser.

import { describe, expect, it, vi } from 'vitest';
import { CurrentPageTool, MAX_PAGE_TEXT_CHARS } from './current-page.js';
import type { ToolExecuteOptions } from '../types.js';

const opts = {} as ToolExecuteOptions;

describe('CurrentPageTool', () => {
  it('returns the URL, title and text of the open page', async () => {
    const tool = new CurrentPageTool(async () => ({
      url: 'https://example.com/docs',
      title: 'The Docs',
      text: 'Install it with npm.',
    }));
    const out = await tool.execute({}, opts);
    expect(out).toContain('https://example.com/docs');
    expect(out).toContain('The Docs');
    expect(out).toContain('Install it with npm.');
  });

  it('says plainly when nothing is open, rather than returning empty', async () => {
    // An empty string reads to a model as "the page was blank", and it will
    // then answer about a page it never saw. Naming the state stops that.
    const tool = new CurrentPageTool(async () => null);
    const out = await tool.execute({}, opts);
    expect(out).toMatch(/no page is open/i);
    expect(out).toMatch(/web_fetch/);
  });

  it('truncates a huge page and says that it did', async () => {
    const tool = new CurrentPageTool(async () => ({
      url: 'https://example.com', title: 'Big', text: 'x'.repeat(MAX_PAGE_TEXT_CHARS + 5_000),
    }));
    const out = await tool.execute({}, opts);
    expect(out).toContain('[truncated');
    expect(out.length).toBeLessThan(MAX_PAGE_TEXT_CHARS + 500);
  });

  it('reports a provider failure instead of pretending the page was empty', async () => {
    const tool = new CurrentPageTool(async () => { throw new Error('view was destroyed'); });
    const out = await tool.execute({}, opts);
    expect(out).toMatch(/^Error:/);
    expect(out).toContain('view was destroyed');
  });

  it('flags a page that rendered nothing readable', async () => {
    const tool = new CurrentPageTool(async () => ({ url: 'https://example.com', title: 'Blank', text: '   ' }));
    const out = await tool.execute({}, opts);
    expect(out).toContain('[the page rendered no readable text]');
  });

  it('is not dangerous — it reads what the user already opened', async () => {
    // Approval-gating this would put a prompt in front of every "summarise
    // this page", for an action that reaches nothing new.
    expect(new CurrentPageTool(async () => null).isDangerous()).toBe(false);
  });

  it('takes no input, so the model cannot aim it at another URL', async () => {
    // The point is "the page the user is on". An input parameter would invite
    // the model to pass a different address and quietly get a fetch instead.
    const tool = new CurrentPageTool(async () => ({ url: 'https://a.example', title: 'A', text: 'a' }));
    expect(tool.inputSchema).toEqual({ type: 'object', properties: {}, required: [] });

    const provider = vi.fn(async () => ({ url: 'https://a.example', title: 'A', text: 'a' }));
    const t2 = new CurrentPageTool(provider);
    await t2.execute({ url: 'https://evil.example' }, opts);
    expect(provider).toHaveBeenCalledOnce();
  });
});
