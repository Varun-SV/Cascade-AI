// ─────────────────────────────────────────────
//  Cascade AI — Planning around a live browser
// ─────────────────────────────────────────────
//
//  Every tier that decides the SHAPE of a run has to know the browser exists,
//  and none of them did. These pin the fact to each one, and pin its absence
//  when there is no browser, so a run without one keeps the prompt it had.

import { describe, expect, it, vi } from 'vitest';
import { BROWSER_ROUTING_RULE, BROWSER_WORKER_RULE, describeBrowserForPlanner } from './browser-planning.js';
import { buildT1SystemPrompt } from './t1-administrator.js';
import { buildT2SystemPrompt } from './t2-manager.js';
import { buildWorkerRules } from './t3-worker.js';
import { Cascade } from '../cascade.js';
import type { CascadeConfig } from '../../types.js';

/** Browser mode as the hosted server builds it: web off, so the browser is the only tool. */
const browserOnly = (name: string) => name === 'browser_control';
const none = () => false;

describe('describeBrowserForPlanner', () => {
  it('is empty when the run has no browser', () => {
    expect(describeBrowserForPlanner(none)).toBe('');
  });

  it('names the tool and says a website task is planned around it', () => {
    const text = describeBrowserForPlanner(browserOnly);
    expect(text).toContain('"browser_control"');
    expect(text).toMatch(/visit, open or use a website.*MUST be planned around that tool/);
  });

  it('keeps the whole errand on one worker, because there is one session', () => {
    // Split across workers, the second is refused with "All 1 browser session
    // are in use" while the first holds it.
    expect(describeBrowserForPlanner(browserOnly)).toMatch(/ONE subtask for ONE T3 worker, done end to end/);
  });

  it('rules out planning to write what the site would have said — the reported plan', () => {
    expect(describeBrowserForPlanner(browserOnly)).toContain('Never plan a step that writes what the site would have said');
  });
});

describe('the browser reaches every tier that shapes the run', () => {
  const facts = describeBrowserForPlanner(browserOnly);

  it('T1 plans with it', () => {
    expect(buildT1SystemPrompt(browserOnly)).toContain(facts);
    expect(buildT1SystemPrompt(none)).not.toContain('LIVE BROWSER');
  });

  it('T2 plans with it — T1’s one browser subtask is decomposed again one level down', () => {
    expect(buildT2SystemPrompt(browserOnly)).toContain(facts);
    expect(buildT2SystemPrompt(none)).not.toContain('LIVE BROWSER');
  });

  it('the worker is told to use it and to report what the page showed', () => {
    expect(buildWorkerRules(browserOnly)).toContain(BROWSER_WORKER_RULE);
    expect(buildWorkerRules(none)).not.toContain(BROWSER_WORKER_RULE);
  });

  it('a run whose only tool is the browser still gets tool guidance', () => {
    // Browser mode turns the web off, so this is the common shape — and it
    // counted as "no tools registered", dropping the generic tool lines.
    const rules = buildWorkerRules(browserOnly);
    expect(rules).toContain('- Use tools when needed.');
    expect(rules).toContain('- Only use tools directly relevant to THIS subtask.');
  });

  describe('the complexity classifier', () => {
    const config = { providers: [], tools: {} } as unknown as CascadeConfig;

    async function classifierPrompt(hasBrowser: boolean): Promise<string> {
      const cascade = new Cascade(config, process.cwd());
      const generate = vi.fn().mockResolvedValue({
        content: 'Simple — one site, one agent',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
        finishReason: 'stop',
      });
      (cascade as unknown as { router: unknown }).router = { generate };
      const registry = (cascade as unknown as { toolRegistry: { hasTool: (n: string) => boolean } }).toolRegistry;
      vi.spyOn(registry, 'hasTool').mockImplementation((n) => hasBrowser && n === 'browser_control');
      await (cascade as unknown as { determineComplexity: (p: string, w: string) => Promise<string> })
        .determineComplexity('go to https://chatgpt.com using browser control, ask it an extremely difficult question and give me its answer unchanged', process.cwd());
      return (generate.mock.calls[0]?.[1] as { systemPrompt: string }).systemPrompt;
    }

    it('routes a one-site errand as one agent’s job when there is a browser', async () => {
      expect(await classifierPrompt(true)).toContain(BROWSER_ROUTING_RULE);
    });

    it('says nothing about a browser the run does not have', async () => {
      expect(await classifierPrompt(false)).not.toContain(BROWSER_ROUTING_RULE);
    });

    async function withHint(hasBrowser: boolean): Promise<{ verdict: string; asked: boolean }> {
      const cascade = new Cascade(config, process.cwd());
      const generate = vi.fn().mockResolvedValue({
        content: 'Simple — one site, one agent',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
        finishReason: 'stop',
      });
      (cascade as unknown as { router: unknown }).router = { generate };
      const registry = (cascade as unknown as { toolRegistry: { hasTool: (n: string) => boolean } }).toolRegistry;
      vi.spyOn(registry, 'hasTool').mockImplementation((n) => hasBrowser && n === 'browser_control');
      const verdict = await (cascade as unknown as {
        determineComplexity: (p: string, w: string, h: unknown[], hint: string) => Promise<string>;
      }).determineComplexity('go to https://chatgpt.com using browser control and bring back its answer', process.cwd(), [], 'Complex');
      const asked = generate.mock.calls.some((c) => String((c[1] as { systemPrompt?: string }).systemPrompt).includes(BROWSER_ROUTING_RULE));
      return { verdict, asked };
    }

    it('sets an on-device hint aside when there is a browser — the device cannot know about it', async () => {
      // The opt-in local classifier returned before the browser-aware prompt
      // was built, so a hinted browser errand was still planned as research.
      expect(await withHint(true)).toEqual({ verdict: 'Simple', asked: true });
    });

    it('still takes the on-device hint when there is no browser to know about', async () => {
      expect(await withHint(false)).toEqual({ verdict: 'Complex', asked: false });
    });
  });
});
