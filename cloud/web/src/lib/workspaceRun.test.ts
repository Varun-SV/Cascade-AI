import { describe, it, expect } from 'vitest';
import {
  CLOUD_ENV, OFFLINE_HINT, applyWorkspaceEvent, changedSinceReadFiles, chosenDeviceName, clearWaiting, collectChangedFiles,
  editDiff, parseWorkspaceEvent, pickerOptions, workspaceDeviceForRun, type WorkspaceEvent, type WorkspaceRunView,
} from './workspaceRun.js';

const devices = [{ id: 'd1', name: 'Work PC', online: true }, { id: 'd2', name: 'Home PC', online: false }];

describe('the environment picker', () => {
  it('lists Cloud first, then each computer, with offline ones disabled and a hint', () => {
    const opts = pickerOptions(devices, undefined);
    expect(opts.map((o) => o.label)).toEqual(['Cloud (no files)', 'Work PC', 'Home PC']);
    expect(opts[0]).toMatchObject({ value: CLOUD_ENV, disabled: false });
    expect(opts[1]).toMatchObject({ online: true, disabled: false });
    expect(opts[2]).toMatchObject({ online: false, disabled: true, sub: OFFLINE_HINT });
  });
  it('keeps a chosen computer selectable even when it has gone offline, so the choice can be undone', () => {
    expect(pickerOptions(devices, 'd2')[2]!.disabled).toBe(false);
  });
  it('sends a device only when one is chosen', () => {
    expect(workspaceDeviceForRun(undefined)).toBeUndefined();
    expect(workspaceDeviceForRun(CLOUD_ENV)).toBeUndefined();
    expect(workspaceDeviceForRun('d1')).toBe('d1');
  });
  it('names the chosen computer, or says it is unknown', () => {
    expect(chosenDeviceName(devices, 'd1')).toBe('Work PC');
    expect(chosenDeviceName(devices, 'gone')).toBe('Unknown computer');
    expect(chosenDeviceName(devices, undefined)).toBeNull();
  });
});

const attached: WorkspaceEvent = { type: 'attached', runId: 'r1', label: 'my-project', device: { id: 'd1', name: 'Work PC' } };
const call = (id: string, change: Extract<WorkspaceEvent, { type: 'call' }>['change']): WorkspaceEvent => ({ type: 'call', runId: 'r1', id, tool: `file_${change.kind}`, change });
const start = (): WorkspaceRunView => applyWorkspaceEvent(undefined, attached)!;

describe('a workspace run', () => {
  it('attaches, waits for approval, and clears the wait when the next result arrives', () => {
    let v = start();
    expect(v).toMatchObject({ label: 'my-project', status: 'attached', device: { name: 'Work PC' } });
    v = applyWorkspaceEvent(v, { type: 'waiting', runId: 'r1', tool: 'shell' })!;
    expect(v.waitingTool).toBe('shell');
    v = applyWorkspaceEvent(v, { type: 'result', runId: 'r1', id: 'x', tool: 'shell', ok: true })!;
    expect(v.waitingTool).toBeUndefined();
  });
  it('marks the chip ended on detach, and a detach clears any wait', () => {
    let v = applyWorkspaceEvent(start(), { type: 'waiting', runId: 'r1', tool: 'file_delete' })!;
    v = applyWorkspaceEvent(v, { type: 'detached', runId: 'r1', reason: 'run over' })!;
    expect(v).toMatchObject({ status: 'ended', endedReason: 'run over' });
    expect(v.waitingTool).toBeUndefined();
  });
  it('ignores events about another run, and a new attach starts a fresh view', () => {
    const v = start();
    expect(applyWorkspaceEvent(v, { type: 'waiting', runId: 'other', tool: 'shell' })).toBe(v);
    expect(applyWorkspaceEvent(undefined, { type: 'waiting', runId: 'r1', tool: 'shell' })).toBeUndefined();
    const again = applyWorkspaceEvent(v, { ...attached, runId: 'r2' })!;
    expect(again.runId).toBe('r2');
    expect(again.changes).toEqual([]);
  });
  it('clears a wait when the run ends without a detach', () => {
    const v = applyWorkspaceEvent(start(), { type: 'waiting', runId: 'r1', tool: 'shell' });
    expect(clearWaiting(v)?.waitingTool).toBeUndefined();
    expect(clearWaiting(undefined)).toBeUndefined();
  });
});

describe('the changed-files list', () => {
  it('collects each path once, in the order first touched, from writes, edits and deletes', () => {
    let v = start();
    v = applyWorkspaceEvent(v, call('1', { kind: 'write', path: 'a.md', content: 'hello' }))!;
    v = applyWorkspaceEvent(v, call('2', { kind: 'edit', path: 'src/b.ts', oldString: 'x', newString: 'y' }))!;
    v = applyWorkspaceEvent(v, call('3', { kind: 'edit', path: 'a.md', oldString: 'hello', newString: 'hi' }))!;
    v = applyWorkspaceEvent(v, call('4', { kind: 'delete', path: 'old.txt' }))!;
    // Nothing is listed until its call has finished: a delete awaiting approval deleted nothing yet.
    expect(collectChangedFiles(v)).toEqual([]);
    for (const id of ['1', '2', '3', '4']) v = applyWorkspaceEvent(v, { type: 'result', runId: 'r1', id, tool: 'file_edit', ok: true })!;
    const files = collectChangedFiles(v);
    expect(files.map((f) => f.path)).toEqual(['a.md', 'src/b.ts', 'old.txt']);
    expect(files[0]!.ops.map((o) => o.kind)).toEqual(['write', 'edit']);
  });
  it('drops a call whose tool failed, and a file with nothing left', () => {
    let v = start();
    v = applyWorkspaceEvent(v, call('1', { kind: 'delete', path: 'keep.txt' }))!;
    v = applyWorkspaceEvent(v, { type: 'result', runId: 'r1', id: '1', tool: 'file_delete', ok: false })!;
    expect(collectChangedFiles(v)).toEqual([]);
  });
  it('does not count a repeated call twice', () => {
    let v = start();
    v = applyWorkspaceEvent(v, call('1', { kind: 'write', path: 'a', content: 'x' }))!;
    v = applyWorkspaceEvent(v, call('1', { kind: 'write', path: 'a', content: 'x' }))!;
    v = applyWorkspaceEvent(v, { type: 'result', runId: 'r1', id: '1', tool: 'file_write', ok: true })!;
    expect(collectChangedFiles(v)[0]!.ops).toHaveLength(1);
  });
  it('keeps the changed-since-read note, once, and reads the file names out of it', () => {
    const note = '[Files in the workspace changed since you read them: a.txt, b/c.ts — read them again before relying on them.]';
    let v = applyWorkspaceEvent(start(), { type: 'result', runId: 'r1', id: '1', tool: 'file_list', ok: true, note })!;
    v = applyWorkspaceEvent(v, { type: 'result', runId: 'r1', id: '2', tool: 'file_list', ok: true, note })!;
    expect(v.notes).toEqual([note]);
    expect(changedSinceReadFiles(note)).toEqual(['a.txt', 'b/c.ts']);
  });
  it('returns nothing for no view', () => { expect(collectChangedFiles(undefined)).toEqual([]); });
  it("clears only the wait of the call that finished: another worker's result leaves it showing", () => {
    let v = start();
    v = applyWorkspaceEvent(v, { type: 'waiting', runId: 'r1', tool: 'shell', worker: 'T3-a' })!;
    v = applyWorkspaceEvent(v, { type: 'waiting', runId: 'r1', tool: 'file_delete', worker: 'T3-b' })!;
    expect(v.waitingTool).toBe('shell');
    // Worker c's read finishing answers no one's question.
    v = applyWorkspaceEvent(v, { type: 'result', runId: 'r1', id: 'x', tool: 'file_read', ok: true, worker: 'T3-c' })!;
    expect(v.waitingTool).toBe('shell');
    v = applyWorkspaceEvent(v, { type: 'result', runId: 'r1', id: 'y', tool: 'shell', ok: true, worker: 'T3-a' })!;
    expect(v.waitingTool).toBe('file_delete');
    v = applyWorkspaceEvent(v, { type: 'result', runId: 'r1', id: 'z', tool: 'file_delete', ok: false, worker: 'T3-b' })!;
    expect(v.waitingTool).toBeUndefined();
    expect(v.waiting).toBeUndefined();
  });
});

describe('parseWorkspaceEvent', () => {
  it('reads the server\'s payloads and drops malformed ones', () => {
    expect(parseWorkspaceEvent('attached', { conversationId: 'c', runId: 'r1', label: 'p', device: { id: 'd', name: 'N' }, tools: ['file_read'] }))
      .toEqual({ conversationId: 'c', event: { type: 'attached', runId: 'r1', label: 'p', device: { id: 'd', name: 'N' } } });
    expect(parseWorkspaceEvent('attached', { runId: 'r1', label: 'p' })).toBeNull();
    expect(parseWorkspaceEvent('waiting', 'nope')).toBeNull();
    expect(parseWorkspaceEvent('call', { runId: 'r', id: 'i', tool: 'file_write', change: { kind: 'chmod', path: 'a' } })).toBeNull();
    expect(parseWorkspaceEvent('result', { runId: 'r', id: 'i', tool: 'shell', ok: false })?.event).toMatchObject({ ok: false });
  });
});

describe('editDiff', () => {
  it('shows the lines removed and added, with a little context', () => {
    const d = editDiff('a\nb\nold\nc\nd', 'a\nb\nnew1\nnew2\nc\nd');
    expect(d.map((l) => `${l.kind}:${l.text}`)).toEqual(['same:a', 'same:b', 'del:old', 'add:new1', 'add:new2', 'same:c', 'same:d']);
  });
  it('handles a one-line replacement and an insertion', () => {
    expect(editDiff('x', 'y').map((l) => l.kind)).toEqual(['del', 'add']);
    expect(editDiff('', 'new').map((l) => l.kind)).toEqual(['del', 'add']);
  });
});
