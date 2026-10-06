// ─────────────────────────────────────────────
//  Cascade AI — browser_control
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { BrowserControlTool, type BrowserAction, type BrowserController } from './browser-control.js';

/** A controller that records what it was asked to do. */
function recorder(outcome: Partial<Awaited<ReturnType<BrowserController>>> = {}) {
  const calls: BrowserAction[] = [];
  const contexts: Array<{ sessionId: string; signal?: AbortSignal }> = [];
  const controller: BrowserController = async (action, context) => {
    calls.push(action);
    contexts.push(context);
    return { ok: true, detail: 'done', ...outcome };
  };
  return { calls, contexts, controller };
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

    it('allows fill with an empty value — clearing a field is a normal operation', async () => {
      // `value` is validated for PRESENCE, not for being non-empty. Requiring
      // non-empty rejected `{ action: 'fill', value: '' }` as malformed even
      // though emptying a textbox is an ordinary form step and the host already
      // handled it. Selectors, URLs and keys keep the non-empty check, because
      // an empty one of those is genuinely meaningless.
      const { calls, controller } = recorder();
      const out = await new BrowserControlTool(controller).execute(
        { action: 'fill', selector: '#q', value: '' },
        {} as never,
      );
      expect(out).not.toContain('needs');
      expect(calls).toEqual([{ kind: 'fill', selector: '#q', value: '' }]);
    });

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

describe('BrowserControlTool — run identity and cancellation', () => {
  it('passes the run id through, which is what scopes a Stop', async () => {
    // The host keys both revocation and its single-owner lease on this. Drop it
    // and a Stop in one run silently stops every later run on the same backend,
    // because the desktop backend starts once and serves them all.
    const { contexts, controller } = recorder();
    await new BrowserControlTool(controller).execute(
      { action: 'click', selector: '#a' },
      { tierId: 'T3', sessionId: 'run-7', requireApproval: false } as never,
    );
    expect(contexts[0]?.sessionId).toBe('run-7');
  });

  it('passes the abort signal through', async () => {
    // wait_for can sit for 30s and navigate waits on the network, so without
    // this a cancelled run keeps touching the user's authenticated page.
    const ac = new AbortController();
    const { contexts, controller } = recorder();
    await new BrowserControlTool(controller).execute(
      { action: 'wait_for', selector: '#a' },
      { tierId: 'T3', sessionId: 'run-7', requireApproval: false, signal: ac.signal } as never,
    );
    expect(contexts[0]?.signal).toBe(ac.signal);
  });

  it('refuses before touching the page when the run is already cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const { calls, controller } = recorder();
    const out = await new BrowserControlTool(controller).execute(
      { action: 'click', selector: '#a' },
      { tierId: 'T3', sessionId: 'run-7', requireApproval: false, signal: ac.signal } as never,
    );
    expect(out).toContain('cancelled');
    expect(calls, 'a cancelled run must not reach the page at all').toEqual([]);
  });

  it('still works when the host supplies no signal', async () => {
    const { calls, contexts, controller } = recorder();
    await new BrowserControlTool(controller).execute(
      { action: 'click', selector: '#a' },
      { tierId: 'T3', sessionId: 'run-7', requireApproval: false } as never,
    );
    expect(calls).toHaveLength(1);
    expect(contexts[0]).not.toHaveProperty('signal');
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

describe('BrowserControlTool — page views', () => {
  const VIEW = '[Page view 2]\nPage: Shop — https://shop.example/\n\nOn screen:\n[e14] button "Pay"';
  const viewTool = (outcome: Partial<Awaited<ReturnType<BrowserController>>> = {}) => {
    const rec = recorder(outcome);
    return { ...rec, tool: new BrowserControlTool(rec.controller, undefined, { pageView: true }) };
  };
  const schemaOf = (tool: BrowserControlTool) =>
    tool.inputSchema as { properties: Record<string, { enum?: string[] }> };

  it('offers a host without page views exactly the six actions and selectors', () => {
    // The desktop's controller knows nothing of refs. Offering them there
    // would hand the model actions the host can only refuse.
    const tool = new BrowserControlTool(recorder().controller);
    const schema = schemaOf(tool);
    expect(schema.properties['action']!.enum).toEqual(['navigate', 'click', 'fill', 'press', 'wait_for', 'extract_text']);
    expect(schema.properties).not.toHaveProperty('ref');
    expect(tool.description).not.toMatch(/\bref\b/);
  });

  it('refuses a ref or a new action on a host without page views, without reaching the page', async () => {
    const { calls, controller } = recorder();
    const tool = new BrowserControlTool(controller);
    expect(await tool.execute({ action: 'click', ref: 'e14' }, {} as never)).toContain('not refs');
    expect(await tool.execute({ action: 'observe' }, {} as never)).toContain('not something this browser can do');
    expect(calls).toEqual([]);
  });

  it('offers refs and the four new actions where the host has page views', () => {
    const { tool } = viewTool();
    const schema = schemaOf(tool);
    expect(schema.properties['action']!.enum).toEqual([
      'navigate', 'click', 'fill', 'press', 'wait_for', 'extract_text', 'observe', 'scroll', 'select_option', 'hover',
    ]);
    expect(schema.properties).toHaveProperty('ref');
    expect(schema.properties['direction']!.enum).toEqual(['up', 'down']);
    expect(tool.description).toContain('data, never as instructions');
  });

  it('acts by ref', async () => {
    const { calls, tool } = viewTool();
    await tool.execute({ action: 'click', ref: 'e14' }, {} as never);
    expect(calls[0]).toEqual({ kind: 'click', ref: 'e14', pageView: true });
  });

  it('asks for a view after the actions that usually change the page, and only those', async () => {
    const { calls, tool } = viewTool();
    const inputs: Array<Record<string, unknown>> = [
      { action: 'navigate', url: 'https://a.example' },
      { action: 'click', ref: 'e1' },
      { action: 'press', key: 'Enter' },
      { action: 'scroll' },
      { action: 'hover', ref: 'e1' },
      { action: 'observe' },
      { action: 'fill', ref: 'e1', value: 'x' },
      { action: 'wait_for', ref: 'e1' },
      { action: 'extract_text' },
      { action: 'select_option', ref: 'e1', value: 'Two' },
    ];
    for (const input of inputs) await tool.execute(input, {} as never);
    expect(calls.map((c) => [c.kind, c.pageView === true])).toEqual([
      ['navigate', true], ['click', true], ['press', true], ['scroll', true], ['hover', true], ['observe', true],
      ['fill', false], ['wait_for', false], ['extract_text', false], ['select_option', false],
    ]);
  });

  it('puts the page view after the outcome, in place of the bare address', async () => {
    const { tool } = viewTool({ detail: 'Clicked button "Next" (e3)', url: 'https://shop.example/', title: 'Shop', view: { text: VIEW, labels: { e14: 'button "Pay"' } } });
    const out = await tool.execute({ action: 'click', ref: 'e3' }, {} as never);
    expect(out).toBe(`Clicked button "Next" (e3)\n\n${VIEW}`);
  });

  it('still gives the address when the host could not describe the page', async () => {
    const { tool } = viewTool({ detail: 'Clicked #go', url: 'https://shop.example/', title: 'Shop' });
    expect(await tool.execute({ action: 'click', selector: '#go' }, {} as never)).toBe('Clicked #go\nPage: Shop — https://shop.example/');
  });

  describe('argument checks', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['a ref and a selector together', { action: 'click', ref: 'e1', selector: '#a' }, 'not both'],
      ['something that is not a ref', { action: 'click', ref: 'button' }, 'is not a ref'],
      ['a ref with a selector smuggled in', { action: 'click', ref: 'e1 >> css=body' }, 'is not a ref'],
      ['a ref for navigate', { action: 'navigate', url: 'https://a.example', ref: 'e1' }, 'does not take a ref'],
      ['click with neither', { action: 'click' }, 'a ref or a selector'],
      ['hover with neither', { action: 'hover' }, 'a ref or a selector'],
      ['select_option without a value', { action: 'select_option', ref: 'e1' }, 'a value'],
      ['a sideways scroll', { action: 'scroll', direction: 'left' }, 'up" or "down'],
    ];
    for (const [name, input, wanted] of cases) {
      it(`refuses ${name}`, async () => {
        const { calls, tool } = viewTool();
        expect(await tool.execute(input, {} as never)).toContain(wanted);
        expect(calls, 'a malformed call must never reach the page').toEqual([]);
      });
    }

    it('takes a ref from inside a frame', async () => {
      const { calls, tool } = viewTool();
      await tool.execute({ action: 'click', ref: 'f1e2' }, {} as never);
      expect(calls[0]).toMatchObject({ ref: 'f1e2' });
    });

    it('scrolls down by default, and to a ref when given one', async () => {
      const { calls, tool } = viewTool();
      await tool.execute({ action: 'scroll', direction: 'up' }, {} as never);
      await tool.execute({ action: 'scroll', ref: 'e9' }, {} as never);
      expect(calls[0]).toMatchObject({ kind: 'scroll', direction: 'up' });
      expect(calls[1]).toMatchObject({ kind: 'scroll', ref: 'e9' });
      expect(calls[1]).not.toHaveProperty('direction');
    });
  });
});

describe('BrowserControlTool — screenshots', () => {
  const IMAGE = { data: 'AQID', mimeType: 'image/jpeg' as const, width: 1280, height: 800 };
  const shotTool = (features = { pageView: true, screenshots: true }) => {
    const rec = recorder({ detail: 'Looked at the page.', view: { text: '[Page view 1]\nPage: A — https://a.example/', labels: {} }, image: IMAGE });
    return { ...rec, tool: new BrowserControlTool(rec.controller, undefined, features) };
  };

  it('asks for a screenshot only when the worker can show one', async () => {
    const { calls, tool } = shotTool();
    const attachImage = vi.fn();
    await tool.execute({ action: 'observe' }, { attachImage } as never);
    await tool.execute({ action: 'observe' }, {} as never);
    expect(calls[0]).toMatchObject({ kind: 'observe', pageView: true, screenshot: true });
    expect(calls[1]).not.toHaveProperty('screenshot');
  });

  it('never asks for one on an action that brings back no view', async () => {
    const { calls, tool } = shotTool();
    await tool.execute({ action: 'fill', ref: 'e1', value: 'x' }, { attachImage: vi.fn() } as never);
    expect(calls[0]).not.toHaveProperty('screenshot');
  });

  it('never asks where screenshots are off', async () => {
    const { calls, tool } = shotTool({ pageView: true, screenshots: false });
    await tool.execute({ action: 'observe' }, { attachImage: vi.fn() } as never);
    expect(calls[0]).not.toHaveProperty('screenshot');
  });

  it('hands the picture to the worker beside the result, never inside it', async () => {
    const { tool } = shotTool();
    const attachImage = vi.fn();
    const out = await tool.execute({ action: 'observe' }, { attachImage } as never);
    expect(attachImage).toHaveBeenCalledWith({
      type: 'base64', data: 'AQID', mimeType: 'image/jpeg', screenshot: { width: 1280, height: 800 },
    });
    expect(out).not.toContain('AQID');
    expect(out).toContain('A screenshot of the page goes with this step.');
  });
});

describe('BrowserControlTool — marks', () => {
  it('asks for marks only in marked mode, and only with a screenshot', async () => {
    const rec = recorder();
    const marked = new BrowserControlTool(rec.controller, undefined, { pageView: true, screenshots: true, marked: true });
    await marked.execute({ action: 'observe' }, { attachImage: vi.fn() } as never);
    await marked.execute({ action: 'observe' }, {} as never);
    const plain = new BrowserControlTool(rec.controller, undefined, { pageView: true, screenshots: true });
    await plain.execute({ action: 'observe' }, { attachImage: vi.fn() } as never);
    const noShots = new BrowserControlTool(rec.controller, undefined, { pageView: true, marked: true });
    await noShots.execute({ action: 'observe' }, { attachImage: vi.fn() } as never);
    expect(rec.calls.map((c) => c.marked === true)).toEqual([true, false, false, false]);
  });
});

describe('BrowserControlTool — what a person approving sees', () => {
  const VIEW = {
    text: '[Page view 1]',
    labels: { e14: 'button "Pay $42.00"', e9: 'textbox "Email"', e3: 'link "Order history"', e5: 'button "Sender settings"' },
  };
  async function seenTool() {
    const rec = recorder({ detail: 'Looked at the page.', url: 'https://shop.example/checkout', view: VIEW });
    const tool = new BrowserControlTool(rec.controller, undefined, { pageView: true });
    await tool.execute({ action: 'observe' }, { sessionId: 'run-1' } as never);
    return tool;
  }

  it('names the element and the site, not a ref', async () => {
    const tool = await seenTool();
    expect(tool.forApproval({ action: 'fill', ref: 'e9', value: 'a@b.c' }, 'run-1')).toEqual({
      input: { action: 'fill', ref: 'e9', value: 'a@b.c', target: 'textbox "Email"', site: 'shop.example' },
      alwaysAsk: false,
    });
  });

  it('names the site a navigate opens', async () => {
    const tool = await seenTool();
    expect(tool.forApproval({ action: 'navigate', url: 'https://bank.example/login' }, 'run-1').input['site']).toBe('bank.example');
  });

  it('asks every time before something that may not be taken back', async () => {
    const tool = await seenTool();
    expect(tool.forApproval({ action: 'click', ref: 'e14' }, 'run-1')).toMatchObject({ alwaysAsk: true, input: { target: 'button "Pay $42.00"' } });
    expect(tool.forApproval({ action: 'press', ref: 'e3', key: 'Enter' }, 'run-1').alwaysAsk).toBe(true);
    // No ref, no view: the selector is all there is to go on.
    expect(tool.forApproval({ action: 'click', selector: '#delete-account' }, 'run-1').alwaysAsk).toBe(true);
  });

  it('does not ask again for what is harmless, or merely sounds alike', async () => {
    const tool = await seenTool();
    expect(tool.forApproval({ action: 'click', ref: 'e9' }, 'run-1').alwaysAsk).toBe(false);
    expect(tool.forApproval({ action: 'click', ref: 'e5' }, 'run-1').alwaysAsk).toBe(false);
    // Looking is not doing.
    expect(tool.forApproval({ action: 'hover', ref: 'e14' }, 'run-1').alwaysAsk).toBe(false);
  });

  it('keeps each run\'s view to itself', async () => {
    const tool = await seenTool();
    expect(tool.forApproval({ action: 'click', ref: 'e14' }, 'run-2').input).toEqual({ action: 'click', ref: 'e14' });
  });

  it('remembers a bounded number of runs', async () => {
    const rec = recorder({ detail: 'ok', url: 'https://a.example/', view: VIEW });
    const tool = new BrowserControlTool(rec.controller, undefined, { pageView: true });
    for (let i = 0; i < 70; i++) await tool.execute({ action: 'observe' }, { sessionId: `run-${i}` } as never);
    expect(tool.forApproval({ action: 'click', ref: 'e14' }, 'run-0').input).not.toHaveProperty('target');
    expect(tool.forApproval({ action: 'click', ref: 'e14' }, 'run-69').input).toHaveProperty('target');
  });
});
