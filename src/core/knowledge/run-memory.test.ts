import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunMemory, factsFrom, formatRunFacts } from './run-memory.js';
import { WorldStateDB } from './world-state.js';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-runmem-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const NOT_A_REPO = 'fatal: not a git repository (or any of the parent directories): .git';

describe('facts read from what tools answered', () => {
  it('a folder that is not a git repository', () => {
    const { learnt } = factsFrom('shell', { command: 'git status' }, NOT_A_REPO, 'The project folder');
    expect(learnt.map((f) => f.key)).toEqual(['git-repo:the project folder']);
    expect(learnt[0]!.text).toContain('is not a git repository');
  });

  it('a command the shell does not have, as bash, cmd and PowerShell say it', () => {
    const keys = (out: string) => factsFrom('shell', { command: 'x' }, out, '.').learnt.map((f) => f.key);
    expect(keys('bash: wc: command not found')).toEqual(['missing:wc']);
    expect(keys('/bin/sh: 1: file: not found')).toEqual(['missing:file']);
    expect(keys("'wc' is not recognized as an internal or external command,\r\noperable program or batch file.")).toEqual(['missing:wc']);
    expect(keys("The term 'jq' is not recognized as the name of a cmdlet, function, script file")).toEqual(['missing:jq']);
  });

  it('control: an ordinary answer is no fact', () => {
    expect(factsFrom('shell', { command: 'ls' }, 'a.txt\nb.txt', '.').learnt).toEqual([]);
  });
});

describe('one board for the whole run', () => {
  it('what one worker found, every other worker is shown once, and the finder not at all', () => {
    const mem = new RunMemory(root);
    const at = mem.begin('shell', { command: 'git status' });
    mem.observe('shell', { command: 'git status' }, NOT_A_REPO, 'T3-a', at);
    expect(mem.unseenBy('T3-a')).toEqual([]);
    const forB = mem.unseenBy('T3-b');
    expect(forB.map((f) => f.key)).toEqual(['git-repo:the project folder']);
    expect(mem.unseenBy('T3-b')).toEqual([]);
    expect(formatRunFacts(forB)).toMatch(/^ALREADY FOUND IN THIS RUN[\s\S]*not a git repository/);
  });

  it('a read-only command run again in the same folder gets the earlier answer, until something changes', () => {
    const mem = new RunMemory(root);
    const ls = { command: 'ls -la' };
    mem.observe('shell', ls, 'a.txt', 'T3-a', mem.begin('shell', ls));
    expect(mem.reuse('shell', ls)).toEqual({ output: 'a.txt', by: 'T3-a' });
    // Another folder is another command.
    expect(mem.reuse('shell', { command: 'ls -la', cwd: 'sub' })).toBeNull();
    // Something that changes things starts: no stored answer while it runs…
    const write = { path: 'b.txt', content: 'x' };
    const at = mem.begin('file_write', write);
    expect(mem.reuse('shell', ls)).toBeNull();
    // …and none from before it, once it has finished.
    mem.observe('file_write', write, 'written', 'T3-b', at);
    expect(mem.reuse('shell', ls)).toBeNull();
  });

  it('a read that finished after a change began is not kept', () => {
    const mem = new RunMemory(root);
    const ls = { command: 'ls' };
    const readAt = mem.begin('shell', ls);
    const write = { path: 'b.txt', content: 'x' };
    const writeAt = mem.begin('file_write', write);
    mem.observe('file_write', write, 'written', 'T3-b', writeAt);
    mem.observe('shell', ls, 'a.txt', 'T3-a', readAt);
    expect(mem.reuse('shell', ls)).toBeNull();
  });

  it('never gives again a command that changes things, or one whose answer moves by itself', () => {
    const mem = new RunMemory(root);
    for (const command of ['rm -rf build', 'npm install', 'date', 'ps aux']) {
      mem.observe('shell', { command }, 'out', 'T3-a', mem.begin('shell', { command }));
      expect(mem.reuse('shell', { command }), command).toBeNull();
    }
  });

  it('git status through the git tool is reused too', () => {
    const mem = new RunMemory(root);
    const st = { operation: 'status' };
    mem.observe('git', st, 'On branch main', 'T3-a', mem.begin('git', st));
    expect(mem.reuse('git', st)?.output).toBe('On branch main');
  });
});

describe('kept in the project, so the next run starts knowing', () => {
  it('a fact is kept, the next run is shown it, and git init takes it back out', () => {
    const db = new WorldStateDB(root);
    try {
      const first = new RunMemory(root, db);
      first.observe('shell', { command: 'git log' }, NOT_A_REPO, 'T3-a', first.begin('shell', { command: 'git log' }));
      first.observe('shell', { command: 'wc -w a.md' }, 'bash: wc: command not found', 'T3-a', first.begin('shell', { command: 'wc -w a.md' }));
      expect(db.getFactsForEntities(['environment']).map((f) => [f.relation, f.value]).sort()).toEqual([
        ['command wc', 'not available'],
        ['git repository at the project folder', 'none'],
      ]);
      // Names only: nothing the tools printed is kept.
      expect(JSON.stringify(db.getFactsForEntities(['environment']))).not.toContain('fatal');

      const next = new RunMemory(root, db);
      expect(next.unseenBy('T3-x').map((f) => f.key).sort()).toEqual(['git-repo:the project folder', 'missing:wc']);

      next.observe('shell', { command: 'git init' }, 'Initialized empty Git repository', 'T3-x', next.begin('shell', { command: 'git init' }));
      next.observe('shell', { command: 'wc -w a.md' }, '12 a.md', 'T3-x', next.begin('shell', { command: 'wc -w a.md' }));
      expect(db.getFactsForEntities(['environment'])).toEqual([]);
    } finally { db.close(); }
  });
});
