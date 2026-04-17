import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { resolveInWorkspace, WorkspaceSandboxError } from './workspace-path.js';

describe('resolveInWorkspace', () => {
  const root = path.resolve(os.tmpdir(), 'cascade-sandbox-tests');

  it('accepts a file inside the workspace', () => {
    const p = resolveInWorkspace(root, 'src/index.ts');
    expect(p.startsWith(root)).toBe(true);
  });

  it('rejects relative traversal via ..', () => {
    expect(() => resolveInWorkspace(root, '../escape.txt')).toThrow(WorkspaceSandboxError);
    expect(() => resolveInWorkspace(root, 'src/../../escape.txt')).toThrow(WorkspaceSandboxError);
  });

  it('rejects absolute paths outside the workspace', () => {
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(WorkspaceSandboxError);
  });

  it('accepts absolute paths inside the workspace', () => {
    const inside = path.join(root, 'deep', 'file.ts');
    expect(resolveInWorkspace(root, inside)).toBe(path.resolve(inside));
  });

  it('rejects empty / non-string inputs', () => {
    expect(() => resolveInWorkspace(root, '')).toThrow(WorkspaceSandboxError);
    // @ts-expect-error — runtime misuse guard
    expect(() => resolveInWorkspace(root, null)).toThrow(WorkspaceSandboxError);
  });

  it('treats "." as the workspace root itself', () => {
    expect(resolveInWorkspace(root, '.')).toBe(path.resolve(root));
  });
});
