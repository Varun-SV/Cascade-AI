// ─────────────────────────────────────────────
//  Cascade AI — browser_control
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { BrowserControlTool, type BrowserAction, type BrowserController } from './browser-control.js';

/** A controller that records what it was asked to do. */
function recorder(outcome: Partial<Awaited<ReturnType<BrowserController>>> = {}) {
  const calls: BrowserAction[] = [];
  const controller: BrowserController = async (action) => {
    calls.push(action);
    return { ok: true, detail: 'done', ...outcome };
  };
  return { calls, controller };
}

describe('BrowserControlTool', () => {
  it('requires approval — it drives the session the user is signed into', () => {
    // The whole reason this tool exists separately from `browser` (headless
    // Playwright) is that it acts on real, authenticated pages. If this ever
    // returns false, every action runs unprompted.
    expect(new BrowserControlTool(async () => ({ ok: true, detail: '' })).isDangerous()).toBe(true);
  });

  it('passes the action through and reports where the page ended up', async () => {
    const { calls, controller } = recorder({ detail: 'Clicked #go', url: 'https://e.example/next', title: 'Next' });
    const tool = new BrowserControlTool(controller);

    const out = await tool.execute({ action: 'click', selector: '#go' }, {} as never);

    expect(calls).toEqual([{ kind: 'click', selector: '#go' }]);
    expect(out).toContain('Clicked #go');
    expect(out).toContain('Next — https://e.example/next');
  });

  it('marks a refusal so the model does not read it as success', async () => {
    // A controller reporting ok:false is normal — a selector matching nothing
    // is recoverable, not exceptional. But the model has to be able to tell.
    const tool = new BrowserControlTool(async () => ({ ok: false, detail: 'Nothing matches #missing on this page.' }));
    const out = await tool.execute({ action: 'click', selector: '#missing' }, {} as never);
    expect(out.startsWith('Failed: ')).toBe(true);
  });

  describe('argument validation', () => {
    // Caught here rather than in the host so the model gets a specific,
    // correctable message instead of a generic failure three layers down —
    // and so a malformed call never reaches the page at all.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['navigate without a url', { action: 'navigate' }, 'a url'],
      ['click without a selector', { action: 'click' }, 'a selector'],
      ['fill without a selector', { action: 'fill', value: 'x' }, 'a selector'],
      ['fill without a value', { action: 'fill', selector: '#a' }, 'a value'],
      ['press without a key', { action: 'press' }, 'a key'],
      ['wait_for without a selector', { action: 'wait_for' }, 'a selector'],
    ];

    for (const [name, input, wanted] of cases) {
      it(`rejects ${name}`, async () => {
        const { calls, controller } = recorder();
        const out = await new BrowserControlTool(controller).execute(input, {} as never);
        expect(out).toContain(wanted);
        expect(calls, 'a malformed call must never reach the page').toEqual([]);
      });
    }

    it('allows extract_text with no selector — the whole page is the default', async () => {
      const { calls, controller } = recorder({ detail: 'page text' });
      await new BrowserControlTool(controller).execute({ action: 'extract_text' }, {} as never);
      expect(calls).toEqual([{ kind: 'extract_text' }]);
    });

    it('rejects a call with no action at all', async () => {
      const { calls, controller } = recorder();
      const out = await new BrowserControlTool(controller).execute({}, {} as never);
      expect(out).toContain('action is required');
      expect(calls).toEqual([]);
    });
  });

  it('clamps an absurd wait to something bounded', async () => {
    // A model asking to wait an hour would otherwise pin a worker for an hour.
    const { calls, controller } = recorder();
    await new BrowserControlTool(controller).execute(
      { action: 'wait_for', selector: '#a', timeoutMs: 3_600_000 },
      {} as never,
    );
    expect(calls[0]?.timeoutMs).toBe(30_000);
  });

  it('reports a thrown controller as an error rather than letting it escape', async () => {
    // executeTool treats a throw as a systemic failure and can escalate the
    // whole worker; a closed browser is an ordinary, recoverable condition.
    const tool = new BrowserControlTool(async () => { throw new Error('view was destroyed'); });
    const out = await tool.execute({ action: 'click', selector: '#a' }, {} as never);
    expect(out).toContain('view was destroyed');
  });

  it('does not leak an unknown field into the action', async () => {
    const { calls, controller } = recorder();
    await new BrowserControlTool(controller).execute(
      { action: 'click', selector: '#a', script: 'alert(1)' },
      {} as never,
    );
    expect(calls[0]).toEqual({ kind: 'click', selector: '#a' });
  });

  it('is named so the model cannot confuse it with the headless browser tool', () => {
    const def = new BrowserControlTool(async () => ({ ok: true, detail: '' })).getDefinition();
    expect(def.name).toBe('browser_control');
    // The description has to say the consequence out loud: the two tools differ in
    // exactly the way that matters and the model picks between them by text.
    expect(def.description).toMatch(/real browser|signed into/i);
  });
});

describe('BrowserControlTool — registration gate', () => {
  it('is only constructed with a controller, so it cannot exist without a browser', () => {
    // The type is the gate: there is no zero-argument constructor, so a host
    // with no browser view has nothing to pass and the tool never registers.
    // Cascade.setBrowserController applies the config gate on top of that.
    const spy = vi.fn(async () => ({ ok: true, detail: 'ok' }));
    const tool = new BrowserControlTool(spy);
    expect(tool.name).toBe('browser_control');
    expect(spy).not.toHaveBeenCalled();
  });
});
