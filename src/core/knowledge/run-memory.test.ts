import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunMemory, callReadsOnly, commandReadsOnly, factsFrom, formatRunFacts } from './run-memory.js';
import { WorldStateDB } from './world-state.js';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-runmem-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const NOT_A_REPO = 'Exit 128:\nfatal: not a git repository (or any of the parent directories): .git';
const ok = { failed: false, publish: true };
const bad = { failed: true, publish: true };
/** One call, start to end, on `mem`. */
const run = (mem: RunMemory, tool: string, input: Record<string, unknown>, output: string, by: string, how = ok) =>
  mem.observe(tool, input, output, by, mem.begin(tool, input), how);

describe('facts read from commands that ran here and failed', () => {
  it('a folder that is not a git repository', () => {
    const { learnt } = factsFrom('shell', { command: 'git status' }, NOT_A_REPO, 'The project folder', true);
    expect(learnt.map((f) => f.key)).toEqual(['git-repo:the project folder']);
    expect(learnt[0]!.text).toContain('is not a git repository');
  });

  it('a command the shell does not have, as bash, dash, cmd and PowerShell say it', () => {
    const keys = (command: string, out: string) => factsFrom('shell', { command }, out, '.', true).learnt.map((f) => f.key);
    expect(keys('wc -w a.md', 'bash: wc: command not found')).toEqual(['missing:wc']);
    expect(keys('file a.pdf', '/bin/sh: 1: file: not found')).toEqual(['missing:file']);
    expect(keys('wc -l a', "'wc' is not recognized as an internal or external command,\r\noperable program or batch file.")).toEqual(['missing:wc']);
    expect(keys('jq . a.json', "The term 'jq' is not recognized as the name of a cmdlet, function, script file")).toEqual(['missing:jq']);
  });

  it('text that only mentions a failure is not one (Codex on 9789d5b)', () => {
    const log = 'step 3\nbash: jq: command not found\nfatal: not a git repository';
    // A file being read.
    expect(factsFrom('file_read', { path: 'build.log' }, log, '.', false).learnt).toEqual([]);
    // A command that worked and printed the log.
    expect(factsFrom('shell', { command: 'cat build.log' }, log, '.', false).learnt).toEqual([]);
    // A command that failed, but not because of jq: it never asked for jq.
    expect(factsFrom('shell', { command: 'cat build.log missing.txt' }, `Exit 1:\n${log}`, '.', true).learnt).toEqual([]);
  });

  it('control: an ordinary answer is no fact', () => {
    expect(factsFrom('shell', { command: 'ls' }, 'a.txt\nb.txt', '.', false).learnt).toEqual([]);
  });
});

describe('what may be answered again: only commands that read (Codex on 9789d5b)', () => {
  it('reading commands, and every part of a compound one', () => {
    for (const c of ['ls -la', 'git status', 'git log --oneline -5', 'cat a.md | wc -l', 'git branch', 'git remote -v', 'find . -name "*.ts"']) {
      expect(commandReadsOnly(c), c).toBe(true);
    }
  });

  it('not git config or fetch, which auto mode rates safe but which change things', () => {
    for (const c of ['git config --add test.value x', 'git fetch', 'git branch feature', 'git tag v1', 'git remote add o u']) {
      expect(commandReadsOnly(c), c).toBe(false);
    }
  });

  it('not a command whose answer moves by itself, wherever it sits', () => {
    for (const c of ['date', 'echo ready && date', 'ls; ps aux', 'cat a | sort', 'uptime']) expect(commandReadsOnly(c), c).toBe(false);
  });

  it('not a redirect, a substitution, or a find that runs or deletes', () => {
    for (const c of ['ls > out.txt', 'echo $(date)', 'cat `which x`', 'find . -delete', 'find . -exec rm {} ;']) {
      expect(commandReadsOnly(c), c).toBe(false);
    }
  });

  it('the git tool, by its operation', () => {
    expect(callReadsOnly('git', { operation: 'status' })).toBe(true);
    expect(callReadsOnly('git', { operation: 'fetch' })).toBe(false);
    expect(callReadsOnly('git', { operation: 'config', args: ['--add', 'a.b', 'c'] })).toBe(false);
  });
});

describe('one board for the whole run', () => {
  it('what one worker found, every other worker is shown once, and the finder not at all', () => {
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'git status' }, NOT_A_REPO, 'T3-a', bad);
    expect(mem.unseenBy('T3-a')).toEqual([]);
    const forB = mem.unseenBy('T3-b');
    expect(forB.map((f) => f.key)).toEqual(['git-repo:the project folder']);
    expect(mem.unseenBy('T3-b')).toEqual([]);
    expect(formatRunFacts(forB)).toMatch(/^ALREADY FOUND IN THIS RUN[\s\S]*not a git repository/);
  });

  it('a read-only command run again in the same folder gets the earlier answer, until something changes', () => {
    const mem = new RunMemory(root);
    const ls = { command: 'ls -la' };
    run(mem, 'shell', ls, 'a.txt', 'T3-a');
    expect(mem.reuse('shell', ls)).toEqual({ output: 'a.txt', by: 'T3-a' });
    expect(mem.reuse('shell', { command: 'ls -la', cwd: 'sub' })).toBeNull();
    const write = { path: 'b.txt', content: 'x' };
    const at = mem.begin('file_write', write);
    expect(mem.reuse('shell', ls)).toBeNull();
    mem.observe('file_write', write, 'written', 'T3-b', at, ok);
    expect(mem.reuse('shell', ls)).toBeNull();
  });

  it('git config and git fetch clear stored answers too', () => {
    for (const command of ['git config --add test.value x', 'git fetch']) {
      const mem = new RunMemory(root);
      run(mem, 'shell', { command: 'git status' }, 'clean', 'T3-a');
      expect(mem.reuse('shell', { command: 'git status' })).not.toBeNull();
      run(mem, 'shell', { command }, 'done', 'T3-b');
      expect(mem.reuse('shell', { command: 'git status' }), command).toBeNull();
    }
  });

  it('a read that finished after a change began is not kept', () => {
    const mem = new RunMemory(root);
    const ls = { command: 'ls' };
    const readAt = mem.begin('shell', ls);
    const write = { path: 'b.txt', content: 'x' };
    const writeAt = mem.begin('file_write', write);
    mem.observe('file_write', write, 'written', 'T3-b', writeAt, ok);
    mem.observe('shell', ls, 'a.txt', 'T3-a', readAt, ok);
    expect(mem.reuse('shell', ls)).toBeNull();
  });

  it('a failed answer is not given again', () => {
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cat missing.txt' }, 'Exit 1:\ncat: missing.txt: No such file or directory', 'T3-a', bad);
    expect(mem.reuse('shell', { command: 'cat missing.txt' })).toBeNull();
  });

  it('a call that became local-only adds nothing, but still ends what it began (Codex on 9789d5b)', () => {
    const mem = new RunMemory(root);
    const diff = { operation: 'diff', args: ['secret/plan.md'] };
    run(mem, 'git', diff, 'the private diff', 'T3-local', { failed: false, publish: false });
    expect(mem.reuse('git', diff)).toBeNull();
    run(mem, 'shell', { command: 'git status' }, NOT_A_REPO, 'T3-local', { failed: true, publish: false });
    expect(mem.all()).toEqual([]);
    // A change made by such a call still clears what others stored.
    run(mem, 'shell', { command: 'ls' }, 'a.txt', 'T3-a');
    run(mem, 'file_write', { path: 'secret/x', content: 'y' }, 'written', 'T3-local', { failed: false, publish: false });
    expect(mem.reuse('shell', { command: 'ls' })).toBeNull();
  });
});

describe('kept in the project, so the next run starts knowing', () => {
  it('a fact is kept, the next run is shown it, and it is taken back out once it stops being true', () => {
    const db = new WorldStateDB(root);
    try {
      const first = new RunMemory(root, db);
      run(first, 'shell', { command: 'git log' }, NOT_A_REPO, 'T3-a', bad);
      run(first, 'shell', { command: 'wc -w a.md' }, 'Exit 127:\nbash: wc: command not found', 'T3-a', bad);
      expect(db.getFactsForEntities(['environment']).map((f) => [f.relation, f.value]).sort()).toEqual([
        ['command wc', 'not available'],
        ['git repository at the project folder', 'none'],
      ]);
      // Names only: nothing the tools printed is kept.
      expect(JSON.stringify(db.getFactsForEntities(['environment']))).not.toContain('fatal');

      const next = new RunMemory(root, db);
      expect(next.unseenBy('T3-x').map((f) => f.key).sort()).toEqual(['git-repo:the project folder', 'missing:wc']);

      // The user made a repository between runs: git simply working there says so (Codex on 9789d5b).
      run(next, 'shell', { command: 'git status' }, 'On branch main\nnothing to commit', 'T3-x');
      run(next, 'shell', { command: 'wc -w a.md' }, '12 a.md', 'T3-x');
      expect(db.getFactsForEntities(['environment'])).toEqual([]);
    } finally { db.close(); }
  });
});
