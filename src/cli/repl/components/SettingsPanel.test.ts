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
  /** Waits for a frame with `text` in it (a loaded machine redraws late), up to 2 s. */
  const until = async (text: string) => {
    const end = Date.now() + 2000;
    while (!frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').includes(text) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  };
  return { stdout, stdin, press, burst, until, frame: () => frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

const config = () => ({ providers: [{ type: 'anthropic', apiKey: 'sk-ant-xyz9876' }], theme: 'cascade', autonomy: 'manual', budget: { warnAtPct: 80 } } as unknown as CascadeConfig);

function mount(c: CascadeConfig, opts: { section?: 'models' | 'autonomy' | 'account'; active?: boolean } = {}) {
  const t = terminal();
  const changes: Array<[string, unknown]> = [];
  const actions: Array<[string, string | undefined]> = [];
  let closed = false;
  const app = render(
    React.createElement(SettingsPanel, {
      config: c,
      theme: getTheme('cascade'),
      ...(opts.section ? { initialSection: opts.section } : {}),
      ...(opts.active !== undefined ? { active: opts.active } : {}),
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
    expect(await p.until('Models & keys')).toContain('Models & keys');
    expect(await p.until('set ••••9876')).toContain('set ••••9876');
    expect(p.frame()).not.toContain('sk-ant-xyz9876');
    p.unmount();
  });

  it('Enter on a choice changes it; arrows move between sections; Esc closes', async () => {
    const c = config();
    const p = mount(c, { section: 'autonomy' });
    await tick();
    await p.press('\r');
    expect(p.changes).toEqual([['autonomy', 'auto']]);
    expect(await p.until('Mode saved')).toContain('Mode saved');
    await p.press('\x1b[C');
    expect(await p.until('Context & memory')).toContain('Context & memory');
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
    expect(await p.until('sync passphrase')).toContain('sync passphrase');
    for (const ch of 'hunter2') await p.press(ch);
    expect(await p.until('•••••••')).toContain('•••••••');
    expect(p.frame()).not.toContain('hunter2');
    await p.press('\r');
    expect(p.actions).toEqual([['sync-push', 'hunter2']]);
    // Pasted with Enter in one go, before any redraw: every character still counts.
    await p.until('done');
    await p.press('\r');
    await p.until('sync passphrase');
    p.burst('pass', 'word', '\r');
    await p.until('done');
    expect(p.actions.at(-1)).toEqual(['sync-push', 'password']);
    p.unmount();
  });

  it('/ searches across sections', async () => {
    const p = mount(config());
    await tick();
    await p.press('/');
    for (const ch of 'budget') await p.press(ch);
    expect(await p.until('Most a run may cost')).toContain('Most a run may cost');
    p.unmount();
  });

  it('while a tool approval waits it reads no keys, so nothing typed here can answer it (Codex on 806c9af)', async () => {
    const p = mount(config(), { section: 'autonomy', active: false });
    await tick();
    for (const k of ['\r', 'a', 'y', '\x1b[C']) await p.press(k);
    expect(p.changes).toEqual([]);
    expect(p.closed()).toBe(false);
    expect(await p.until('answer the question below first')).toContain('answer the question below first');
    p.unmount();
  });

  it('keys that arrive before a redraw all count (fast typing, a paste in pieces)', async () => {
    const p = mount(config());
    await tick();
    await p.press('/');
    await p.until('search: ▌');
    p.burst('bud', 'get');
    expect(await p.until('search: budget')).toContain('search: budget');
    p.unmount();
  });
});
