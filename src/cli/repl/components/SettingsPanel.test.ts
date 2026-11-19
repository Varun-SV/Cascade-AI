import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { SettingsPanel } from './SettingsPanel.js';
import { getTheme } from '../../themes/index.js';
import type { CascadeConfig } from '../../../types.js';
import type { SettingItem } from '../../settings/spec.js';

/** A terminal Ink can draw into and read keys from. */
function terminal() {
  let frame = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns: 140, rows: 40, isTTY: true,
    write: (s: string) => { frame = s; return true; },
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, setRawMode: () => undefined, setEncoding: () => undefined, resume: () => undefined, pause: () => undefined,
    ref: () => undefined, unref: () => undefined, read: () => null as string | null,
  });
  let queued: string[] = [];
  stdin.read = () => queued.shift() ?? null;
  const press = async (s: string) => { queued.push(s); stdin.emit('readable'); await tick(); };
  /** Several reads with no redraw between them. */
  const burst = (...chunks: string[]) => { for (const c of chunks) { queued.push(c); stdin.emit('readable'); } };
  return { stdout, stdin, press, burst, frame: () => frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

const config = () => ({ providers: [{ type: 'anthropic', apiKey: 'sk-ant-xyz9876' }], theme: 'cascade', autonomy: 'manual', budget: { warnAtPct: 80 } } as unknown as CascadeConfig);

function mount(c: CascadeConfig, opts: { section?: 'models' | 'autonomy' | 'account' } = {}) {
  const t = terminal();
  const changes: Array<[string, unknown]> = [];
  const actions: Array<[string, string | undefined]> = [];
  let closed = false;
  const app = render(
    React.createElement(SettingsPanel, {
      config: c,
      theme: getTheme('cascade'),
      ...(opts.section ? { initialSection: opts.section } : {}),
      onChange: (item: SettingItem, v: unknown) => { changes.push([item.id, v]); item.set?.(c, v); return `${item.label} saved`; },
      onAction: (item: SettingItem, pass: string | undefined) => { actions.push([item.id, pass]); return 'done'; },
      onClose: () => { closed = true; },
    }),
    { stdout: t.stdout as never, stdin: t.stdin as never, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  return { ...t, changes, actions, closed: () => closed, unmount: () => app.unmount() };
}

describe('/settings panel', () => {
  it('shows a section, with keys masked', async () => {
    const p = mount(config(), { section: 'models' });
    await tick();
    expect(p.frame()).toContain('Models & keys');
    expect(p.frame()).toContain('set ••••9876');
    expect(p.frame()).not.toContain('sk-ant-xyz9876');
    p.unmount();
  });

  it('Enter on a choice changes it; arrows move between sections; Esc closes', async () => {
    const c = config();
    const p = mount(c, { section: 'autonomy' });
    await tick();
    await p.press('\r');
    expect(p.changes).toEqual([['autonomy', 'auto']]);
    expect(p.frame()).toContain('Mode saved');
    await p.press('\x1b[C');
    expect(p.frame()).toContain('Context & memory');
    await p.press('\x1b');
    await tick();
    expect(p.closed()).toBe(true);
    p.unmount();
  });

  it('a sync action asks for the passphrase, masked, then runs with it', async () => {
    const p = mount(config(), { section: 'account' });
    await tick();
    await p.press('\x1b[B');
    await p.press('\x1b[B');
    await p.press('\r');
    expect(p.frame()).toContain('sync passphrase');
    for (const ch of 'hunter2') await p.press(ch);
    expect(p.frame()).toContain('•••••••');
    expect(p.frame()).not.toContain('hunter2');
    await p.press('\r');
    expect(p.actions).toEqual([['sync-push', 'hunter2']]);
    p.unmount();
  });

  it('/ searches across sections', async () => {
    const p = mount(config());
    await tick();
    await p.press('/');
    for (const ch of 'budget') await p.press(ch);
    expect(p.frame()).toContain('Most a run may cost');
    // Keys that arrive before a redraw all count (fast typing, a paste in pieces).
    await p.press('\x1b');
    await p.press('/');
    p.burst('bud', 'get');
    await new Promise((r) => setTimeout(r, 60));
    expect(p.frame()).toContain('search: budget');
    p.unmount();
  });
});
