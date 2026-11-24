import { describe, it, expect } from 'vitest';
import { MAX_CHANGE_TEXT, workspaceCallEvent, workspaceResultEvent } from './workspace-events.js';

const served = new Set(['file_read', 'file_write', 'file_edit', 'file_delete']);

describe('workspaceCallEvent', () => {
  it('carries the path and what changed for the three tools that change a file', () => {
    expect(workspaceCallEvent({ id: 'c1', toolName: 'file_edit', input: { path: 'a.ts', old_string: 'x', new_string: 'y' } }, served))
      .toEqual({ id: 'c1', tool: 'file_edit', change: { kind: 'edit', path: 'a.ts', oldString: 'x', newString: 'y' } });
    expect(workspaceCallEvent({ id: 'c2', toolName: 'file_write', input: { path: 'b.md', content: 'hi' } }, served)?.change)
      .toEqual({ kind: 'write', path: 'b.md', content: 'hi' });
    expect(workspaceCallEvent({ id: 'c3', toolName: 'file_delete', input: { path: 'c' } }, served)?.change).toEqual({ kind: 'delete', path: 'c' });
  });
  it('says nothing about reads, other tools, tools the workspace does not serve, or a call with no path', () => {
    expect(workspaceCallEvent({ id: 'c', toolName: 'file_read', input: { path: 'a' } }, served)).toBeNull();
    expect(workspaceCallEvent({ id: 'c', toolName: 'shell', input: { command: 'rm -rf x' } }, served)).toBeNull();
    expect(workspaceCallEvent({ id: 'c', toolName: 'file_write', input: { path: 'a', content: 'x' } }, new Set())).toBeNull();
    expect(workspaceCallEvent({ id: 'c', toolName: 'file_write', input: { content: 'x' } }, served)).toBeNull();
  });
  it('cuts long text and says so', () => {
    const ev = workspaceCallEvent({ id: 'c', toolName: 'file_write', input: { path: 'a', content: 'z'.repeat(MAX_CHANGE_TEXT + 5) } }, served)!;
    expect(ev.change.content).toHaveLength(MAX_CHANGE_TEXT);
    expect(ev.change.truncated).toBe(true);
  });
});

describe('workspaceResultEvent', () => {
  it('never forwards the output, only whether it worked and the changed-since-read note', () => {
    const note = '[Files in the workspace changed since you read them: out.txt — read them again before relying on them.]';
    const ev = workspaceResultEvent({ id: 'c', toolName: 'file_read', output: `SECRET body\n${note}` }, served);
    expect(ev).toEqual({ id: 'c', tool: 'file_read', ok: true, note });
    expect(JSON.stringify(ev)).not.toContain('SECRET');
  });
  it('marks a failure, and ignores tools it does not serve', () => {
    expect(workspaceResultEvent({ id: 'c', toolName: 'file_write', error: 'no' }, served)?.ok).toBe(false);
    expect(workspaceResultEvent({ id: 'c', toolName: 'web_search', output: 'x' }, new Set(['file_read']))).toBeNull();
    // The worker as the machine's waiting notice names it, so the web app clears the right one.
    expect(workspaceResultEvent({ id: 'c', toolName: 'file_write', tierId: 'T3:sub/1' }, served)?.worker).toBe('T3_sub_1');
  });
});
