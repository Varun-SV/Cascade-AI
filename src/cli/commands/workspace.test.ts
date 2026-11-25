import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalUi } from './workspace.js';
import { PRESETS } from '../workspace/consent.js';
import type { CallQuestion, ConsentQuestion } from '../workspace/service.js';

function terminal(opts: { yesReadOnly?: boolean; undo?: () => Promise<any>; stopping?: AbortSignal } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const printed: string[] = [];
  let written = '';
  output.on('data', (d) => { written += String(d); });
  const onInterrupt = vi.fn();
  const ui = createTerminalUi({
    io: { input, output, terminal: false }, onInterrupt, print: (l) => printed.push(l),
    ...(opts.yesReadOnly ? { yesReadOnly: true } : {}), ...(opts.undo ? { undo: opts.undo } : {}), ...(opts.stopping ? { stopping: opts.stopping } : {}),
  });
  const type = (text: string): void => { input.write(`${text}\n`); };
  return { ui, type, printed, written: () => written, onInterrupt };
}

const consent = (over: Partial<ConsentQuestion> = {}): ConsentQuestion => ({
  runId: 'run-1', chat: null, device: 'Ana PC', folderName: 'proj', expiresAt: Date.now() + 60_000, windowMs: 60_000,
  defaults: { tools: ['file_read'], labelMode: 'device' }, signal: new AbortController().signal, ...over,
});
const callQ = (over: Partial<CallQuestion> = {}): CallQuestion => ({
  tool: 'shell', summary: 'rm -rf build', risk: 'risky', reason: 'deletes files', label: 'Workspace on Ana PC', timeoutMs: 120_000, signal: new AbortController().signal, ...over,
});
const tick = () => new Promise<void>((r) => setTimeout(r, 20));

describe('the consent prompt', () => {
  it('Enter is a no', async () => {
    const t = terminal();
    const p = t.ui.askConsent(consent());
    await tick();
    t.type('');
    expect(await p).toBeNull();
  });

  it('a tool set and a label give the answer; the folder\'s path is never printed', async () => {
    const t = terminal();
    const p = t.ui.askConsent(consent());
    await tick();
    t.type('2');
    await tick();
    t.type('2');
    expect(await p).toMatchObject({ labelMode: 'folder', tools: expect.arrayContaining(['file_write', 'file_edit']) });
    expect(await p).not.toMatchObject({ tools: expect.arrayContaining(['shell']) });
    expect(t.printed.join('\n')).toContain('Read and edit files');
    expect(t.printed.join('\n')).not.toContain('/home');
  });

  it('asks again for anything that is not 1, 2 or 3, and 3 is everything', async () => {
    const t = terminal();
    const p = t.ui.askConsent(consent());
    await tick();
    t.type('yes');
    await tick();
    t.type('3');
    await tick();
    t.type('');
    const a = await p;
    expect(a?.tools).toContain('shell');
    expect(a?.labelMode).toBe('device');
    expect(t.printed.join('\n')).toMatch(/Type 1, 2 or 3/);
  });

  it('--tools sets the preset y takes, marked in the list; Enter is still a no', async () => {
    const t = terminal();
    const p = t.ui.askConsent(consent({ defaults: { tools: [...PRESETS.edit.tools], labelMode: 'folder' } }));
    await tick();
    expect(t.written()).toContain('or y for 2');
    expect(t.printed.find((l) => l.includes('Read and edit files'))).toContain('(y)');
    t.type('y');
    await tick();
    t.type('');
    expect(await p).toEqual({ tools: [...PRESETS.edit.tools], labelMode: 'folder' });
    const no = terminal();
    const q = no.ui.askConsent(consent({ defaults: { tools: [...PRESETS.all.tools], labelMode: 'device' } }));
    await tick();
    no.type('');
    expect(await q).toBeNull();
  });

  it('a lapsed question reads as a no, and is taken down', async () => {
    const t = terminal();
    const ac = new AbortController();
    const p = t.ui.askConsent(consent({ signal: ac.signal }));
    await tick();
    ac.abort();
    expect(await p).toBeNull();
  });

  it('--yes-read-only answers read only without asking, and nothing more', async () => {
    const t = terminal({ yesReadOnly: true });
    const a = await t.ui.askConsent(consent());
    expect(a?.tools).toEqual(['file_list', 'file_read', 'glob', 'grep']);
    // Risky calls are still asked about.
    const p = t.ui.askCall(callQ());
    await tick();
    t.type('');
    expect(await p).toBe('deny');
  });
});

describe('the call prompt', () => {
  it('y allows, a allows all, anything else denies', async () => {
    const t = terminal();
    let p = t.ui.askCall(callQ());
    await tick();
    t.type('y');
    expect(await p).toBe('allow');
    p = t.ui.askCall(callQ());
    await tick();
    t.type('a');
    expect(await p).toBe('all');
    p = t.ui.askCall(callQ());
    await tick();
    t.type('maybe');
    expect(await p).toBe('deny');
    expect(t.printed.join('\n')).toContain('rm -rf build');
  });

  it('two questions at once are answered in turn', async () => {
    const t = terminal();
    const first = t.ui.askCall(callQ({ summary: 'first' }));
    const second = t.ui.askCall(callQ({ summary: 'second' }));
    await tick();
    expect(t.printed.join('\n')).not.toContain('second');
    t.type('y');
    expect(await first).toBe('allow');
    await tick();
    expect(t.printed.join('\n')).toContain('second');
    t.type('n');
    expect(await second).toBe('deny');
  });

  it('a question whose time ran out reads as a no', async () => {
    const t = terminal();
    const ac = new AbortController();
    const p = t.ui.askCall(callQ({ signal: ac.signal }));
    await tick();
    ac.abort();
    expect(await p).toBe('deny');
  });
});

describe('what a run shows when it ends', () => {
  it('offers an undo when it changed files, and does it on a yes', async () => {
    const undo = vi.fn(async () => ({ ok: true as const, restored: 1, removed: 1, skipped: 0 }));
    const t = terminal({ undo });
    t.ui.runEnded({ label: 'Workspace on Ana PC', changed: 2, canUndo: true, undone: false, note: null });
    await tick();
    t.type('y');
    await vi.waitFor(() => expect(undo).toHaveBeenCalledOnce());
    await t.ui.idle();
    await tick();
    expect(t.printed.join('\n')).toContain('Undone: 1 restored, 1 removed');
  });

  it('stopping takes an open undo question down, and asks no new one', async () => {
    const undo = vi.fn(async () => ({ ok: true as const, restored: 1, removed: 0, skipped: 0 }));
    const stop = new AbortController();
    const t = terminal({ undo, stopping: stop.signal });
    t.ui.runEnded({ label: 'l', changed: 1, canUndo: true, undone: false, note: null });
    await tick();
    stop.abort();
    await t.ui.idle();
    expect(undo).not.toHaveBeenCalled();
    expect(t.printed.join('\n')).toContain('/undo');
    const before = t.written();
    t.ui.runEnded({ label: 'l2', changed: 1, canUndo: true, undone: false, note: null });
    await t.ui.idle();
    expect(t.written()).toBe(before);
  });

  it('a failed undo is said, and does not throw out of serving', async () => {
    const undo = vi.fn(async () => { throw new Error('EACCES: permission denied'); });
    const t = terminal({ undo });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      t.ui.runEnded({ label: 'l', changed: 1, canUndo: true, undone: false, note: null });
      await tick();
      t.type('y');
      await vi.waitFor(() => expect(t.printed.join('\n')).toContain('The undo failed: EACCES'));
      await tick();
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it('says how to undo later on a no, and offers nothing for a run that changed nothing', async () => {
    const undo = vi.fn(async () => ({ ok: true as const, restored: 0, removed: 0, skipped: 0 }));
    const t = terminal({ undo });
    t.ui.runEnded({ label: 'l', changed: 1, canUndo: true, undone: false, note: null });
    await tick();
    t.type('');
    await t.ui.idle();
    await tick();
    expect(undo).not.toHaveBeenCalled();
    expect(t.printed.join('\n')).toContain('/undo');
    const quiet = terminal({ undo });
    quiet.ui.runEnded({ label: 'l', changed: 0, canUndo: false, undone: false, note: 'The run changed nothing.' });
    await tick();
    expect(quiet.written()).toBe('');
  });
});
