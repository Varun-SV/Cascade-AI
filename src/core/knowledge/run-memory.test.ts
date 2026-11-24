import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ANSWER_AGE_MS, RunMemory, callReadsOnly, commandReadsOnly, factsFrom, formatChangedFiles, formatPlannerFacts, formatRunFacts, noteWorkspaceChange, readsOf, workspaceChangeMarker, type ChangeMarker } from './run-memory.js';
import { statePath, STATE } from '../../config/project-state.js';
import { ownerToken } from '../../utils/file-lock.js';
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

  it('not about this folder when git ran somewhere else (Codex on 6c77d8f)', () => {
    const keys = (command: string) => factsFrom('shell', { command }, NOT_A_REPO, 'The project folder', true).learnt.map((f) => f.key);
    expect(keys('cd /tmp && git status')).toEqual([]);
    expect(keys('pushd ../other; git log')).toEqual([]);
    expect(keys('Set-Location C:\\x; git status')).toEqual([]);
    expect(keys('git -C ../other status')).toEqual([]);
    expect(keys('git --git-dir=/x/.git status')).toEqual([]);
    expect(keys('GIT_DIR=/x/.git git status')).toEqual([]);
    expect(factsFrom('git', { operation: 'status', args: ['--work-tree=/x'] }, NOT_A_REPO, '.', true).learnt).toEqual([]);
    // Nor does git working there say anything about this folder.
    expect(factsFrom('shell', { command: 'cd sub && git status' }, 'On branch main', 'The project folder', false).unlearnt).toEqual([]);
    // Control: the same command, here.
    expect(keys('git status')).toEqual(['git-repo:the project folder']);
    // A word that merely contains one is not one.
    expect(keys('git status --decorate')).toEqual(['git-repo:the project folder']);
  });

  it('control: an ordinary answer is no fact', () => {
    expect(factsFrom('shell', { command: 'ls' }, 'a.txt\nb.txt', '.', false).learnt).toEqual([]);
  });
});

describe('what may be answered again: only commands that read (Codex on 9789d5b)', () => {
  it('reading commands, and every part of a compound one', () => {
    for (const c of ['ls -la', 'head -5 a.md', 'cat a.md | wc -l', 'rg -n hit', 'find . -name "*.ts"']) {
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

  it('not a command sent to the background with a lone & (Codex on 2abacac)', () => {
    expect(commandReadsOnly('echo ready & touch marker')).toBe(false);
    expect(commandReadsOnly('ls &')).toBe(false);
    // Control: && still joins two reads.
    expect(commandReadsOnly('ls && pwd')).toBe(true);
  });

  it('not a redirect, a substitution, or a find that runs or deletes', () => {
    for (const c of ['ls > out.txt', 'echo $(date)', 'cat `which x`', 'find . -delete', 'find . -exec rm {} ;']) {
      expect(commandReadsOnly(c), c).toBe(false);
    }
  });

  it('the git tool: never a read (see the Codex on 4b60938 tests)', () => {
    expect(callReadsOnly('git', { operation: 'log', args: ['--oneline'] })).toBe(false);
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
      run(mem, 'shell', { command: 'ls -la' }, 'a.txt', 'T3-a');
      expect(mem.reuse('shell', { command: 'ls -la' })).not.toBeNull();
      run(mem, 'shell', { command }, 'done', 'T3-b');
      expect(mem.reuse('shell', { command: 'ls -la' }), command).toBeNull();
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

describe('work the board sees no call for (Codex on 6c77d8f)', () => {
  it('no stored answer while it runs, and none from before it afterwards', () => {
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'ls' }, 'a.txt', 'T3-a');
    const done = mem.hold();
    expect(mem.reuse('shell', { command: 'ls' })).toBeNull();
    // A read that finished meanwhile is not kept either.
    run(mem, 'shell', { command: 'cat a.txt' }, 'old', 'T3-b');
    done();
    done(); // once only
    expect(mem.reuse('shell', { command: 'ls' })).toBeNull();
    expect(mem.reuse('shell', { command: 'cat a.txt' })).toBeNull();
    run(mem, 'shell', { command: 'ls' }, 'a.txt b.txt', 'T3-a');
    expect(mem.reuse('shell', { command: 'ls' })?.output).toBe('a.txt b.txt');
  });
});

describe('Codex on b2b0aba', () => {
  it("not ripgrep running a preprocessor on what it searches", () => {
    expect(commandReadsOnly('rg --pre=./pre hit input.txt')).toBe(false);
    expect(commandReadsOnly('rg --pre ./pre hit input.txt')).toBe(false);
    expect(commandReadsOnly('rg --pre-glob "*.pdf" --pre ./pre hit')).toBe(false);
    // Control: an ordinary search.
    expect(commandReadsOnly('rg -n hit input.txt')).toBe(true);
  });

  it('only the failure a fact records is shown: one saying the opposite is not', () => {
    const db = new WorldStateDB(root);
    try {
      db.upsertFact('environment', 'command jq', 'available', 'T3-old', undefined, []);
      db.upsertFact('environment', 'git repository at docs', 'present', 'T3-old', undefined, []);
      db.upsertFact('environment', 'command mdcount', 'not available', 'run:T3-old', undefined, []);
      db.upsertFact('environment', 'git repository at legacy', 'none', 'run:T3-old', undefined, []);
      expect(new RunMemory(root, db).all().map((f) => f.key).sort()).toEqual(['git-repo:legacy', 'missing:mdcount']);
    } finally { db.close(); }
  });
});

describe('Codex on 5576cfc', () => {
  it('a quoted or escaped option is the option: quotes do not hide a write', () => {
    expect(commandReadsOnly("git diff '--output=patch.diff'")).toBe(false);
    expect(commandReadsOnly('git diff "--output=patch.diff"')).toBe(false);
    expect(commandReadsOnly("find . '-delete'")).toBe(false);
    expect(commandReadsOnly('find . -del\\ete')).toBe(false);
    expect(commandReadsOnly("rg '--pre=./pre' hit")).toBe(false);
  });

  it('nor anything the shell expands where this cannot see it', () => {
    expect(commandReadsOnly('git diff $OPT')).toBe(false);
    expect(commandReadsOnly('git diff ${OPT}')).toBe(false);
    expect(commandReadsOnly('git diff {--output=a,}')).toBe(false);
  });

  it('control: quoted plain arguments still read', () => {
    expect(commandReadsOnly('grep -n "hello world" notes.md')).toBe(true);
    expect(commandReadsOnly("ls 'my folder'")).toBe(true);
  });
});

describe('Codex on 251b864: another run in the same workspace', () => {
  // Two boards on one workspace: two runs, in one process or two windows.
  it("a write made by another run makes this run's stored answers stale", () => {
    const mine = new RunMemory(root);
    const theirs = new RunMemory(root);
    run(mine, 'shell', { command: 'cat a.txt' }, 'old', 'T3-a');
    expect(mine.reuse('shell', { command: 'cat a.txt' })?.output).toBe('old');
    run(theirs, 'file_write', { path: 'a.txt', content: 'new' }, 'written', 'T3-x');
    expect(mine.reuse('shell', { command: 'cat a.txt' })).toBeNull();
    // Read again, it is kept again.
    run(mine, 'shell', { command: 'cat a.txt' }, 'new', 'T3-a');
    expect(mine.reuse('shell', { command: 'cat a.txt' })?.output).toBe('new');
  });

  it('nor is a read kept that ran while another run was changing things', () => {
    const mine = new RunMemory(root);
    const theirs = new RunMemory(root);
    const read = mine.begin('shell', { command: 'git status' });
    run(theirs, 'shell', { command: 'git commit -am x' }, 'done', 'T3-x');
    mine.observe('shell', { command: 'git status' }, 'dirty', 'T3-a', read, ok);
    expect(mine.reuse('shell', { command: 'git status' })).toBeNull();
    // …and their write still running stops anything stored before it being given.
    run(mine, 'shell', { command: 'git status' }, 'clean', 'T3-a');
    const writing = theirs.begin('shell', { command: 'touch b' });
    expect(mine.reuse('shell', { command: 'git status' })).toBeNull();
    theirs.observe('shell', { command: 'touch b' }, '', 'T3-x', writing, ok);
  });

  it("a mark that can't be read never matches, so nothing is given again", () => {
    let n = 0;
    const unreadable: ChangeMarker = { current: () => `unreadable:${++n}`, bump: () => {}, enter: () => () => {}, busy: () => false };
    const mem = new RunMemory(root, undefined, () => true, () => undefined, unreadable);
    run(mem, 'shell', { command: 'ls' }, 'a.txt', 'T3-a');
    expect(mem.reuse('shell', { command: 'ls' })).toBeNull();
  });

  it('the mark is in the state folder, and holds nothing from the workspace', () => {
    const marker = workspaceChangeMarker(root);
    const before = marker.current();
    marker.bump();
    const after = marker.current();
    expect(after).not.toBe(before);
    expect(fs.readFileSync(path.join(statePath(root, STATE.boardChanges), 'mark'), 'utf8')).toBe(after);
    expect(after).toMatch(/^[0-9a-f]+:\d+:\d+$/);
    expect(fs.existsSync(path.join(root, STATE.boardChanges))).toBe(false);
  });
});

describe('Codex on 539316f', () => {
  it('not a git command that may run a configured diff helper or textconv filter', () => {
    // `git diff` runs diff.external unless told not to, and textconv filters by default.
    expect(commandReadsOnly('git diff')).toBe(false);
    expect(commandReadsOnly('git diff --ext-diff')).toBe(false);
    expect(commandReadsOnly('git show HEAD')).toBe(false);
    expect(commandReadsOnly('git log -p')).toBe(false);
    expect(commandReadsOnly('git blame a.ts')).toBe(false);
    expect(commandReadsOnly('git cat-file --textconv HEAD:a.pdf')).toBe(false);
    expect(commandReadsOnly('git log -p --no-ext-diff --no-textconv --ext-diff')).toBe(false);
    expect(callReadsOnly('git', { operation: 'diff', args: [] })).toBe(false);
    // With both turned off, or no diff shown, it reads.
    // Nor, since 4b60938, with them turned off: no git command is a read.
    expect(commandReadsOnly('git show HEAD --no-ext-diff --no-textconv')).toBe(false);
    expect(commandReadsOnly('git log -p --no-ext-diff --no-textconv')).toBe(false);
  });

  it('`Docs` and `docs` are two folders, kept and retracted apart', () => {
    // Paths only: nothing is made, so this holds on a case-insensitive filesystem too.
    const db = new WorldStateDB(root);
    try {
      const mem = new RunMemory(root, db);
      run(mem, 'shell', { command: 'git status', cwd: 'Docs' }, NOT_A_REPO, 'T3-a', bad);
      run(mem, 'shell', { command: 'git status', cwd: 'docs' }, NOT_A_REPO, 'T3-a', bad);
      expect(mem.all().map((f) => f.key).sort()).toEqual(['git-repo:Docs', 'git-repo:docs']);
      expect(db.getFactsForEntities(['environment'])).toHaveLength(2);
      // git working in `docs` says nothing about `Docs`.
      run(mem, 'shell', { command: 'git status', cwd: 'docs' }, 'On branch main', 'T3-a');
      expect(mem.all().map((f) => f.key)).toEqual(['git-repo:Docs']);
      // The next run knows it, spelt as it is.
      const next = new RunMemory(root, db);
      expect(next.all().map((f) => [f.key, f.text.split(' ')[0]])).toEqual([['git-repo:Docs', 'Docs']]);
    } finally { db.close(); }
  });

  it('a kept spelling that does not fit its relation is not taken', () => {
    const db = new WorldStateDB(root);
    try {
      db.upsertFact('environment', 'git repository at docs', 'none (at DOCS)', 'x', undefined, []);
      expect(new RunMemory(root, db).all()).toEqual([]);
    } finally { db.close(); }
  });
});

describe('Codex on 539316f, again', () => {
  // Run B holds a fallback open (waiting on approval, say) and then writes through
  // a replacement tool the board sees no call for. Run A must not answer from
  // memory meanwhile, nor keep what it read meanwhile.
  it("another run's held fallback counts as a change under way, for every run", () => {
    const a = new RunMemory(root);
    const b = new RunMemory(root);
    run(a, 'shell', { command: 'cat a.txt' }, 'old', 'T3-a');
    const release = b.hold();
    expect(a.reuse('shell', { command: 'cat a.txt' })).toBeNull();
    run(a, 'shell', { command: 'cat a.txt' }, 'old', 'T3-a');
    expect(a.reuse('shell', { command: 'cat a.txt' })).toBeNull();
    // (B's replacement writes a.txt here, unseen.)
    release();
    expect(a.reuse('shell', { command: 'cat a.txt' })).toBeNull();
    run(a, 'shell', { command: 'cat a.txt' }, 'new', 'T3-a');
    expect(a.reuse('shell', { command: 'cat a.txt' })?.output).toBe('new');
  });

  it('a note left by a process that has ended is cleared; one that may be running is not', () => {
    const marker = workspaceChangeMarker(root);
    const active = path.join(statePath(root, STATE.boardChanges), 'active');
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, 'gone.1'), ownerToken(2 ** 22 + 12345));
    expect(marker.busy()).toBe(false);
    expect(fs.existsSync(path.join(active, 'gone.1'))).toBe(false);
    // Another host's: can't be checked, so it counts until it is old.
    fs.writeFileSync(path.join(active, 'elsewhere.1'), JSON.stringify({ host: 'another-host', ns: '', pid: 1, started: '', nonce: 'x' }));
    expect(marker.busy()).toBe(true);
    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(path.join(active, 'elsewhere.1'), old, old);
    expect(marker.busy()).toBe(false);
  });

  it("a knowledge store that can't be written never fails the call", () => {
    const failing = {
      getFactsForEntities: () => { throw new Error('SQLITE_BUSY'); },
      upsertFact: () => { throw new Error('SQLITE_READONLY'); },
      deleteFact: () => { throw new Error('SQLITE_READONLY'); },
    } as unknown as WorldStateDB;
    const mem = new RunMemory(root, failing);
    expect(() => run(mem, 'shell', { command: 'git status' }, NOT_A_REPO, 'T3-a', bad)).not.toThrow();
    // Still on the board for this run…
    expect(mem.all().map((f) => f.key)).toEqual(['git-repo:the project folder']);
    // …and `git init` working retracts it without throwing either.
    expect(() => run(mem, 'shell', { command: 'git init' }, 'Initialized empty Git repository', 'T3-a')).not.toThrow();
    expect(mem.all()).toEqual([]);
  });
});

describe('Codex on 2ea2700', () => {
  it('not ripgrep running a hostname helper, nor any command an option makes write or run', () => {
    expect(commandReadsOnly('rg --hostname-bin=./host --hyperlink-format=default --color=always hit input.txt')).toBe(false);
    expect(commandReadsOnly('rg --hostname-bin ./host hit')).toBe(false);
    expect(commandReadsOnly("rg '--hostname-bin=./host' hit")).toBe(false);
    expect(commandReadsOnly('find . -okdir rm {} ;')).toBe(false);
    expect(commandReadsOnly('tree -o out.txt')).toBe(false);
    expect(commandReadsOnly('file -C -m magic')).toBe(false);
    expect(commandReadsOnly('grep --output=x a')).toBe(false);
    // Per command: -o is only-matching to grep and rg, not an output file.
    expect(commandReadsOnly('grep -o foo a.txt')).toBe(true);
    expect(commandReadsOnly('rg -o foo')).toBe(true);
    expect(commandReadsOnly('ls -C')).toBe(true);
  });
});

describe('Codex on e3c4fe2: changes made outside any run', () => {
  it("the desktop editor's save makes stored answers stale", () => {
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cat a.txt' }, 'old', 'T3-a');
    // A path outside the workspace changes nothing…
    noteWorkspaceChange(root, path.join(os.tmpdir(), 'elsewhere', 'a.txt'));
    expect(mem.reuse('shell', { command: 'cat a.txt' })?.output).toBe('old');
    // …one inside it does.
    noteWorkspaceChange(root, path.join(root, 'a.txt'));
    expect(mem.reuse('shell', { command: 'cat a.txt' })).toBeNull();
  });

  it("an answer is given again for a minute at most: an edit made where Cascade can't see bounds itself", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const mem = new RunMemory(root);
      run(mem, 'shell', { command: 'ls -la' }, 'a.txt', 'T3-a');
      vi.setSystemTime(Date.now() + MAX_ANSWER_AGE_MS - 1_000);
      expect(mem.reuse('shell', { command: 'ls -la' })?.output).toBe('a.txt');
      vi.setSystemTime(Date.now() + 2_000);
      expect(mem.reuse('shell', { command: 'ls -la' })).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe('Codex on e3c4fe2: what stops being true, and command names as spelt', () => {
  it('a worker shown a fact is told once it stops being true', () => {
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'git status' }, NOT_A_REPO, 'T3-a', bad);
    run(mem, 'shell', { command: 'jq . a.json' }, 'Exit 127:\nbash: jq: command not found', 'T3-a', bad);
    expect(mem.unseenBy('T3-b').map((f) => f.key).sort()).toEqual(['git-repo:the project folder', 'missing:jq']);
    // Another worker makes both untrue.
    run(mem, 'shell', { command: 'git init' }, 'Initialized empty Git repository', 'T3-c');
    run(mem, 'shell', { command: 'jq . a.json' }, '{}', 'T3-c');
    const told = mem.unseenBy('T3-b');
    expect(told.every((f) => f.retracted)).toBe(true);
    expect(told.map((f) => f.text)).toEqual([
      'The project folder is a git repository now: git commands work there.',
      '`jq` runs in this machine\'s shell now: use it.',
    ]);
    expect(formatRunFacts(told)).toMatch(/^NO LONGER TRUE[\s\S]*git repository now/);
    expect(formatRunFacts(told)).not.toContain('ALREADY FOUND');
    // Once.
    expect(mem.unseenBy('T3-b')).toEqual([]);
    // A worker never shown them is told nothing.
    expect(mem.unseenBy('T3-d')).toEqual([]);
  });

  it('`JQ` failing says nothing of `jq`, now or in the next run', () => {
    const db = new WorldStateDB(root);
    try {
      const mem = new RunMemory(root, db);
      run(mem, 'shell', { command: 'JQ . a.json' }, 'Exit 127:\nbash: JQ: command not found', 'T3-a', bad);
      expect(mem.all().map((f) => f.key)).toEqual(['missing:JQ']);
      const [kept] = db.getFactsForEntities(['environment']);
      expect(kept!.relation).toMatch(/^command jq #[0-9a-f]{8}$/);
      expect(kept!.value).toBe('not available (as JQ)');
      // `jq` working doesn't retract it…
      run(mem, 'shell', { command: 'jq . a.json' }, '{}', 'T3-a');
      expect(mem.all().map((f) => f.key)).toEqual(['missing:JQ']);
      // …and the next run is told of `JQ`, spelt as it is, not of `jq`.
      expect(new RunMemory(root, db).all().map((f) => f.text.split(' ')[0])).toEqual(['`JQ`']);
      // A plain lowercase fact, as kept before, still loads.
      db.upsertFact('environment', 'command mdcount', 'not available', 'run:T3-old', undefined, []);
      expect(new RunMemory(root, db).all().map((f) => f.key).sort()).toEqual(['missing:JQ', 'missing:mdcount']);
    } finally { db.close(); }
  });
});

describe('Codex on 463c220', () => {
  // git may run the repository's core.fsmonitor hook whenever it looks at the
  // working tree: status, diff, ls-files, describe --dirty.
  it("not a git command that looks at the working tree, where a configured hook can run", () => {
    for (const c of ['git status', 'git status --short', 'git diff --no-ext-diff --no-textconv', 'git ls-files', 'git describe --dirty']) {
      expect(commandReadsOnly(c), c).toBe(false);
    }
    expect(callReadsOnly('git', { operation: 'status', args: [] })).toBe(false);
    // So it counts as a change: what was stored before it is not given again.
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cat a.txt' }, 'old', 'T3-a');
    run(mem, 'shell', { command: 'git status' }, 'On branch main', 'T3-b');
    expect(mem.reuse('shell', { command: 'cat a.txt' })).toBeNull();
    // Since 4b60938, nor does what reads only history: see below.
  });
});

describe('Codex on 4b60938', () => {
  // A signature check runs gpg.program (log.showSignature turns it on with no
  // option at all); with fsmonitor, diff helpers and textconv, configuration can
  // make any git command run a program. So none is a read.
  it('no git command is a read, and each counts as a change', () => {
    for (const c of ['git log --oneline', 'git log --show-signature -1', 'git rev-parse HEAD', 'git describe --tags', 'git cat-file -p HEAD', 'git branch', 'git remote -v', 'ls && git log']) {
      expect(commandReadsOnly(c), c).toBe(false);
    }
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cat a.txt' }, 'old', 'T3-a');
    run(mem, 'shell', { command: 'git log -1' }, 'abc', 'T3-b');
    expect(mem.reuse('shell', { command: 'cat a.txt' })).toBeNull();
    // Facts are still learnt from it.
    run(mem, 'shell', { command: 'git log -1' }, NOT_A_REPO, 'T3-b', bad);
    expect(mem.all().map((f) => f.key)).toEqual(['git-repo:the project folder']);
  });

  it('only evidence about this folder says it is a repository now', () => {
    const unlearnt = (command: string, output = 'ok', failed = false) =>
      factsFrom('shell', { command }, output, 'The project folder', failed).unlearnt;
    // Says nothing about this folder.
    expect(unlearnt('git clone https://example.test/r.git child')).toEqual([]);
    expect(unlearnt('git --version', 'git version 2.56.1')).toEqual([]);
    expect(unlearnt('git init child')).toEqual([]);
    expect(unlearnt('git diff --no-index a b')).toEqual([]);
    expect(unlearnt('git config --global user.name x')).toEqual([]);
    // A failed init or clone made nothing.
    expect(unlearnt('git init', 'fatal: cannot mkdir', true)).toEqual([]);
    // Evidence: a command that needs a repository worked here, or one was made here.
    for (const c of ['git status', 'git --no-pager log -1', 'git init', 'git init .', 'git clone https://example.test/r.git .']) {
      expect(unlearnt(c), c).toEqual(['git-repo:the project folder']);
    }
    expect(factsFrom('git', { operation: 'status', args: [] }, 'On branch main', 'The project folder', false).unlearnt).toEqual(['git-repo:the project folder']);
  });
});

describe('Codex on 784fe73', () => {
  // A local-only subtask writes a file after the board began: the file is
  // local-only from then on, and a kept fact drawn from it may no longer leave.
  it("a kept fact is checked against the privacy rules as they are when it's shown", async () => {
    const { PrivacyPaths } = await import('../privacy/paths.js');
    const db = new WorldStateDB(root);
    try {
      db.upsertFact('environment', 'command mdcount', 'not available', 'T3-old', undefined, ['setup.md']);
      db.upsertFact('environment', 'git repository at docs', 'none', 'run:T3-old', undefined, []);
      let rules = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]);
      const mem = new RunMemory(root, db, () => true, () => rules);
      expect(mem.all().map((f) => f.key).sort()).toEqual(['git-repo:docs', 'missing:mdcount']);
      // Since then, setup.md and docs/ have become local-only.
      rules = new PrivacyPaths([{ pattern: 'setup.md', policy: 'local-only' }, { pattern: 'docs/**', policy: 'local-only' }, { pattern: 'docs', policy: 'local-only' }]);
      expect(mem.unseenBy('T3-cloud')).toEqual([]);
      // Loosened again, they are shown: holding back didn't count as shown.
      rules = new PrivacyPaths([]);
      expect(mem.unseenBy('T3-cloud').map((f) => f.key).sort()).toEqual(['git-repo:docs', 'missing:mdcount']);
    } finally { db.close(); }
  });
});

describe('Codex on 4213fbf', () => {
  it("a command run with another search path says nothing of what the machine's shell has", () => {
    const keys = (command: string, out: string) => factsFrom('shell', { command }, out, '.', true).learnt.map((f) => f.key);
    expect(keys('PATH=/definitely-missing ls', 'bash: ls: command not found')).toEqual([]);
    expect(keys('env -i ls', 'env: ls: command not found')).toEqual([]);
    expect(keys('export PATH=/x && jq .', 'bash: jq: command not found')).toEqual([]);
    expect(keys('source venv/bin/activate && pytest', 'bash: pytest: command not found')).toEqual([]);
    expect(keys('. ./env.sh; pytest', 'bash: pytest: command not found')).toEqual([]);
    expect(keys('$env:Path = "C:\\x"; jq .', "The term 'jq' is not recognized as the name of a cmdlet")).toEqual([]);
    expect(keys('conda activate x && pytest', 'bash: pytest: command not found')).toEqual([]);
    // Control: the shell as it is.
    expect(keys('jq . a.json', 'bash: jq: command not found')).toEqual(['missing:jq']);
  });
});

describe('kept in the project, so the next run starts knowing', () => {
  it('only what may go to any model: privacy.paths holds for what an earlier run kept (Codex on 2abacac)', async () => {
    const { PrivacyPaths } = await import('../privacy/paths.js');
    const db = new WorldStateDB(root);
    try {
      // From elsewhere in the project's knowledge: drawn from a local-only file.
      db.upsertFact('environment', 'git repository at docs', 'none', 'T3-old', undefined, ['secret/setup.md']);
      // Named for a local-only folder, though drawn from no file.
      db.upsertFact('environment', 'git repository at secret/acquisition', 'none', 'run:T3-old', undefined, []);
      // Saved before sources were recorded.
      db.upsertFact('environment', 'git repository at legacy', 'none', 'T3-old');
      db.upsertFact('environment', 'command mdcount', 'not available', 'run:T3-old', undefined, []);
      const rules = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]);
      const mem = new RunMemory(root, db, () => true, () => rules);
      expect(mem.all().map((f) => f.key)).toEqual(['missing:mdcount']);
      // Control: with no rules, all of them.
      expect(new RunMemory(root, db).all().map((f) => f.key).sort()).toEqual(['git-repo:docs', 'git-repo:legacy', 'git-repo:secret/acquisition', 'missing:mdcount']);
      // Nor is one learnt about a local-only folder now.
      fs.mkdirSync(path.join(root, 'secret', 'acq'), { recursive: true });
      run(mem, 'shell', { command: 'git status', cwd: 'secret/acq' }, NOT_A_REPO, 'T3-a', bad);
      expect(mem.all().map((f) => f.key)).toEqual(['missing:mdcount']);
      expect(db.getFactsForEntities(['environment']).map((f) => f.relation)).not.toContain('git repository at secret/acq');
    } finally { db.close(); }
  });

  it('not while knowledge.factsExtraction is off, asked at each write (Codex on 6c77d8f)', () => {
    const db = new WorldStateDB(root);
    try {
      let keep = false;
      const mem = new RunMemory(root, db, () => keep);
      run(mem, 'shell', { command: 'git log' }, NOT_A_REPO, 'T3-a', bad);
      // Still on the board for this run…
      expect(mem.unseenBy('T3-b').map((f) => f.key)).toEqual(['git-repo:the project folder']);
      // …but not kept.
      expect(db.getFactsForEntities(['environment'])).toEqual([]);
      // Turned on mid-run: kept from then on.
      keep = true;
      run(mem, 'shell', { command: 'mdcount -w a.md' }, 'Exit 127:\nbash: mdcount: command not found', 'T3-a', bad);
      expect(db.getFactsForEntities(['environment']).map((f) => f.relation)).toEqual(['command mdcount']);
      // Off again: what is kept stays as it is.
      keep = false;
      run(mem, 'shell', { command: 'mdcount -w a.md' }, '12 a.md', 'T3-a');
      expect(db.getFactsForEntities(['environment']).map((f) => f.relation)).toEqual(['command mdcount']);
    } finally { db.close(); }
  });


  it('a fact is kept, the next run is shown it, and it is taken back out once it stops being true', () => {
    const db = new WorldStateDB(root);
    try {
      const first = new RunMemory(root, db);
      run(first, 'shell', { command: 'git log' }, NOT_A_REPO, 'T3-a', bad);
      run(first, 'shell', { command: 'mdcount -w a.md' }, 'Exit 127:\nbash: mdcount: command not found', 'T3-a', bad);
      expect(db.getFactsForEntities(['environment']).map((f) => [f.relation, f.value]).sort()).toEqual([
        ['command mdcount', 'not available'],
        ['git repository at the project folder', 'none'],
      ]);
      // Names only: nothing the tools printed is kept.
      expect(JSON.stringify(db.getFactsForEntities(['environment']))).not.toContain('fatal');

      const next = new RunMemory(root, db);
      expect(next.unseenBy('T3-x').map((f) => f.key).sort()).toEqual(['git-repo:the project folder', 'missing:mdcount']);

      // The user made a repository between runs: git simply working there says so (Codex on 9789d5b).
      run(next, 'shell', { command: 'git status' }, 'On branch main\nnothing to commit', 'T3-x');
      run(next, 'shell', { command: 'mdcount -w a.md' }, '12 a.md', 'T3-x');
      expect(db.getFactsForEntities(['environment'])).toEqual([]);
    } finally { db.close(); }
  });
});

// The user's question: a worker read a file, then something else changed it.
describe('files a worker read, changed since by someone else', () => {
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

  it('it is told once, before its next model call, and a deletion is told as one', () => {
    write('notes.md', 'one');
    write('plan.md', 'plan');
    const mem = new RunMemory(root);
    mem.noteRead('T3-a', path.join(root, 'notes.md'));
    mem.noteRead('T3-a', path.join(root, 'plan.md'));
    expect(mem.changedFor('T3-a')).toEqual([]);
    write('notes.md', 'one, then more');
    fs.rmSync(path.join(root, 'plan.md'));
    expect(mem.changedFor('T3-a')).toEqual([{ path: 'notes.md', gone: false }, { path: 'plan.md', gone: true }]);
    // Told once.
    expect(mem.changedFor('T3-a')).toEqual([]);
    // Another worker that never read it hears nothing.
    expect(mem.changedFor('T3-b')).toEqual([]);
    const note = formatChangedFiles([{ path: 'notes.md', gone: false }, { path: 'plan.md', gone: true }]);
    expect(note).toMatch(/^FILES CHANGED SINCE YOU READ THEM/);
    expect(note).toContain('- notes.md\n- plan.md (deleted)');
  });

  it("its own write is no news to it, but is to another worker that read the file", () => {
    write('notes.md', 'one');
    const mem = new RunMemory(root);
    const abs = path.join(root, 'notes.md');
    mem.noteRead('T3-a', abs);
    mem.noteRead('T3-b', abs);
    write('notes.md', 'one, edited by a');
    mem.noteWritten('T3-a', abs);
    expect(mem.changedFor('T3-a')).toEqual([]);
    expect(mem.changedFor('T3-b')).toEqual([{ path: 'notes.md', gone: false }]);
  });

  it('a file read by a command counts as read', () => {
    write('a.txt', 'alpha');
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cat a.txt' }, 'alpha', 'T3-a');
    write('a.txt', 'alpha beta');
    expect(mem.changedFor('T3-a')).toEqual([{ path: 'a.txt', gone: false }]);
  });

  it('a local-only file is named only to a worker on a private model', async () => {
    const { PrivacyPaths } = await import('../privacy/paths.js');
    write('secret/keys.md', 'k');
    write('open.md', 'o');
    const rules = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]);
    const mem = new RunMemory(root, undefined, () => true, () => rules);
    for (const w of ['T3-cloud', 'T3-local']) {
      mem.noteRead(w, path.join(root, 'secret/keys.md'));
      mem.noteRead(w, path.join(root, 'open.md'));
    }
    write('secret/keys.md', 'k2');
    write('open.md', 'o2');
    expect(mem.changedFor('T3-cloud')).toEqual([{ path: 'open.md', gone: false }]);
    expect(mem.changedFor('T3-local', true)).toEqual([{ path: 'secret/keys.md', gone: false }, { path: 'open.md', gone: false }]);
  });
});

// Throwing a result away is how it gets updated: the next asker runs it once,
// and that answer is stored. A read of named files is thrown away only when one
// of them changes, not whenever anything does.
describe('a read of named files is kept until one of them changes', () => {
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(root, rel), text);

  it('which commands read only the files they name', () => {
    write('a.txt', 'a');
    write('b.txt', 'b');
    fs.mkdirSync(path.join(root, 'dir'));
    const files = (command: string) => readsOf(command, root)?.map((f) => path.relative(root, f));
    expect(files('cat a.txt')).toEqual(['a.txt']);
    expect(files('head -n 5 a.txt')).toEqual(['a.txt']);
    expect(files('wc -l a.txt b.txt')).toEqual(['a.txt', 'b.txt']);
    expect(files('diff a.txt b.txt')).toEqual(['a.txt', 'b.txt']);
    expect(files('Get-Content a.txt')).toEqual(['a.txt']);
    // What is in a folder, or more than one command, or a file not there: not this rule.
    expect(files('ls')).toBeUndefined();
    expect(files('cat dir')).toBeUndefined();
    expect(files('cat *.txt')).toBeUndefined();
    expect(files('cat a.txt | wc -l')).toBeUndefined();
    expect(files('cat a.txt && cat b.txt')).toBeUndefined();
    expect(files('cat missing.txt')).toBeUndefined();
    expect(files('rg foo a.txt')).toBeUndefined();
    expect(files('Get-Content -Tail 5 a.txt')).toBeUndefined();
  });

  it('still answered after other changes and past the minute; not once the file changes', () => {
    write('a.txt', 'alpha');
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cat a.txt' }, 'alpha', 'T3-a');
    // Another worker writes something else; a minute and more goes by.
    run(mem, 'file_write', { path: 'other.txt' }, 'written', 'T3-b');
    noteWorkspaceChange(root, path.join(root, 'other.txt'));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + MAX_ANSWER_AGE_MS + 5_000);
    try {
      expect(mem.reuse('shell', { command: 'cat a.txt' })).toEqual({ output: 'alpha', by: 'T3-a' });
      // A folder listing is still thrown away by the same changes.
      run(mem, 'shell', { command: 'ls' }, 'a.txt', 'T3-a');
      run(mem, 'file_write', { path: 'third.txt' }, 'written', 'T3-b');
      expect(mem.reuse('shell', { command: 'ls' })).toBeNull();
    } finally { clock.mockRestore(); }
    // The file itself changes (by anyone, inside Cascade or out): run again.
    write('a.txt', 'alpha, edited');
    expect(mem.reuse('shell', { command: 'cat a.txt' })).toBeNull();
  });

  it('not stored if the file changed while it ran, nor answered while a change is under way', () => {
    write('a.txt', 'alpha');
    const mem = new RunMemory(root);
    const ticket = mem.begin('shell', { command: 'cat a.txt' });
    write('a.txt', 'alpha, edited meanwhile');
    mem.observe('shell', { command: 'cat a.txt' }, 'alpha', 'T3-a', ticket, ok);
    expect(mem.reuse('shell', { command: 'cat a.txt' })).toBeNull();

    run(mem, 'shell', { command: 'cat a.txt' }, 'alpha, edited meanwhile', 'T3-a');
    const writing = mem.begin('file_write', { path: 'other.txt' });
    expect(mem.reuse('shell', { command: 'cat a.txt' })).toBeNull();
    mem.observe('file_write', { path: 'other.txt' }, 'written', 'T3-b', writing, ok);
    expect(mem.reuse('shell', { command: 'cat a.txt' })).not.toBeNull();
  });
});

describe('Codex on a0cb796', () => {
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(root, rel), text);

  it('not an option that makes the answer about more than the file (stat -f, tail -f)', () => {
    write('a.txt', 'a');
    const files = (command: string) => readsOf(command, root)?.map((f) => path.relative(root, f));
    expect(files('stat -f a.txt')).toBeUndefined();
    expect(files('stat -Lf a.txt')).toBeUndefined();
    expect(files('stat --file-system a.txt')).toBeUndefined();
    expect(files('tail -f a.txt')).toBeUndefined();
    expect(files('tail --follow a.txt')).toBeUndefined();
    expect(files('cat - a.txt')).toBeUndefined();
    // Control.
    expect(files('cat -n a.txt')).toEqual(['a.txt']);
    expect(files('tail --lines=3 a.txt')).toEqual(['a.txt']);
  });

  it('not quoting or escapes, which change which file the shell reads', () => {
    write('a', '1');
    write('b', '2');
    write('a b', '3');
    const files = (command: string) => readsOf(command, root)?.map((f) => path.relative(root, f));
    expect(files('cat "a b"')).toBeUndefined();
    expect(files("cat 'a b'")).toBeUndefined();
    if (process.platform !== 'win32') expect(files('cat a\\ b')).toBeUndefined();
    expect(files('cat $HOME/a')).toBeUndefined();
    expect(files('cat < a')).toBeUndefined();
    expect(files('cat a b')).toEqual(['a', 'b']);
  });

  it('a file changed while the command read it: the worker is told, as it holds the old copy', () => {
    write('a.txt', 'alpha');
    const mem = new RunMemory(root);
    const ticket = mem.begin('shell', { command: 'cat a.txt' });
    write('a.txt', 'alpha, edited meanwhile');
    mem.observe('shell', { command: 'cat a.txt' }, 'alpha', 'T3-a', ticket, ok);
    expect(mem.changedFor('T3-a')).toEqual([{ path: 'a.txt', gone: false }]);
  });

  it('a worker given a stored read is told when that file changes', () => {
    write('a.txt', 'alpha');
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cat a.txt' }, 'alpha', 'T3-a');
    expect(mem.reuse('shell', { command: 'cat a.txt' }, 'T3-b')).toEqual({ output: 'alpha', by: 'T3-a' });
    write('a.txt', 'alpha, edited');
    expect(mem.changedFor('T3-b')).toEqual([{ path: 'a.txt', gone: false }]);
  });
});

describe('Codex on 6f99570', () => {
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(root, rel), text);

  it('not an option that reads other files named inside one (file -f, file -m, diff -X), nor one not known to be safe', () => {
    write('names.txt', 'a.txt\n');
    write('a.txt', 'a');
    write('b.txt', 'b');
    const files = (command: string) => readsOf(command, root)?.map((f) => path.relative(root, f));
    expect(files('file -f names.txt')).toBeUndefined();
    expect(files('file -m names.txt a.txt')).toBeUndefined();
    expect(files('diff -X names.txt a.txt b.txt')).toBeUndefined();
    expect(files('cat -Z a.txt')).toBeUndefined();
    expect(files('cat -c a.txt')).toBeUndefined();
    // Control: options that only change how the named files are shown.
    expect(files('file -b a.txt')).toEqual(['a.txt']);
    expect(files('cat -n a.txt')).toEqual(['a.txt']);
    expect(files('diff -u a.txt b.txt')).toEqual(['a.txt', 'b.txt']);
    expect(files('head -20 a.txt')).toEqual(['a.txt']);
    // A count is the next word for head and tail only: wc reads both files here.
    expect(files('wc -c a.txt b.txt')).toEqual(['a.txt', 'b.txt']);
    expect(files('head -n 1 a.txt')).toEqual(['a.txt']);
  });

  it("a local-only worker's shell read is tracked for it, though nothing goes on the board", () => {
    write('a.txt', 'alpha');
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cat a.txt' }, 'alpha', 'T3-private', { failed: false, publish: false });
    expect(mem.reuse('shell', { command: 'cat a.txt' })).toBeNull();
    write('a.txt', 'alpha, edited');
    expect(mem.changedFor('T3-private', true)).toEqual([{ path: 'a.txt', gone: false }]);
  });
});

describe('Codex on 87abb45', () => {
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(root, rel), text);
  const files = (command: string) => readsOf(command, root)?.map((f) => path.relative(root, f));

  it('not stat: it prints the access time, which reading the file changes', () => {
    write('a.txt', 'a');
    expect(files('stat a.txt')).toBeUndefined();
    expect(files('stat -L a.txt')).toBeUndefined();
  });

  it('not a symbolic link, whose own metadata a snapshot of its target cannot see', () => {
    write('a.txt', 'a');
    fs.symlinkSync('a.txt', path.join(root, 'link'));
    expect(files('file link')).toBeUndefined();
    expect(files('cat link')).toBeUndefined();
    expect(files('cat a.txt')).toEqual(['a.txt']);
  });

  it('type reads a file only on Windows; in a POSIX shell it looks a command up', () => {
    write('reviewtool', 'x');
    expect(files('type reviewtool')).toEqual(process.platform === 'win32' ? ['reviewtool'] : undefined);
  });
});

describe('Codex on 9d49e32', () => {
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

  it('not a relative cwd, which the shell takes against its own folder, not the project', () => {
    write('src/a.txt', 'a');
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cat a.txt', cwd: 'src' }, 'a', 'T3-a');
    // Kept only by the bounded rule: a change anywhere clears it.
    run(mem, 'file_write', { path: 'other.txt' }, 'written', 'T3-b');
    expect(mem.reuse('shell', { command: 'cat a.txt', cwd: 'src' })).toBeNull();
    // Control: an absolute cwd is where the shell runs too.
    run(mem, 'shell', { command: 'cat a.txt', cwd: path.join(root, 'src') }, 'a', 'T3-a');
    run(mem, 'file_write', { path: 'third.txt' }, 'written', 'T3-b');
    expect(mem.reuse('shell', { command: 'cat a.txt', cwd: path.join(root, 'src') })).not.toBeNull();
  });

  it('only files in the project: not /proc and the like, whose contents change unseen', () => {
    write('a.txt', 'a');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'meminfo'), 'x');
      expect(readsOf(`cat ${path.join(outside, 'meminfo')}`, root, root)).toBeNull();
      expect(readsOf('cat ../x', root, root)).toBeNull();
      expect(readsOf('cat a.txt', root, root)).toEqual([path.join(root, 'a.txt')]);
      if (fs.existsSync('/proc/meminfo')) expect(readsOf('cat /proc/meminfo', root, root)).toBeNull();
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

describe('facts checked against the machine', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['PATH']; });
  afterEach(() => { process.env['PATH'] = saved; vi.restoreAllMocks(); });
  /** A program named `name` on the search path, as installing it would put it there. */
  const install = (name: string) => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const file = path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
    fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    fs.chmodSync(file, 0o755);
    process.env['PATH'] = `${bin}${path.delimiter}${saved ?? ''}`;
  };
  const later = (ms: number) => { const t = Date.now() + ms; vi.spyOn(Date, 'now').mockReturnValue(t); };

  it('a command installed since, by a way the board never saw, is taken back', () => {
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cascadetool --x' }, 'Exit 127:\nbash: cascadetool: command not found', 'T3-a', bad);
    expect(mem.unseenBy('T3-b').map((f) => f.key)).toEqual(['missing:cascadetool']);
    install('cascadetool');
    later(3_000);
    // Both workers working from it are told, the finder and the one shown it.
    expect(mem.unseenBy('T3-a').map((f) => f.key)).toEqual(['retracted:missing:cascadetool']);
    const told = mem.unseenBy('T3-b');
    expect(told.map((f) => f.key)).toEqual(['retracted:missing:cascadetool']);
    expect(mem.all()).toEqual([]);
  });

  it('a repository made since is taken back', () => {
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'git status' }, NOT_A_REPO, 'T3-a', bad);
    expect(mem.known().map((f) => f.key)).toEqual(['git-repo:the project folder']);
    fs.mkdirSync(path.join(root, '.git'));
    later(3_000);
    expect(mem.known()).toEqual([]);
  });

  it("where the check disagreed from the start, it can't tell, and the fact stands", () => {
    // The shell's search path isn't this process's: `ls` is here, the shell said it wasn't.
    install('cascadels');
    const mem = new RunMemory(root);
    run(mem, 'shell', { command: 'cascadels' }, 'Exit 127:\nbash: cascadels: command not found', 'T3-a', bad);
    later(3_000);
    expect(mem.known().map((f) => f.key)).toEqual(['missing:cascadels']);
  });

  it('one kept by an earlier run and installed since is dropped as the next run starts, from the project too', () => {
    const db = new WorldStateDB(root);
    try {
      db.upsertFact('environment', 'command cascadejq', 'not available', 'run:T3-old', undefined, []);
      expect(new RunMemory(root, db).all().map((f) => f.key)).toEqual(['missing:cascadejq']);
      install('cascadejq');
      expect(new RunMemory(root, db).all()).toEqual([]);
      expect(db.getFactsForEntities(['environment'])).toEqual([]);
    } finally { db.close(); }
  });
});

describe('the planners (T1, T2) are told what workers found', () => {
  it('checked and privacy-filtered, without counting as shown to any worker', async () => {
    const { PrivacyPaths } = await import('../privacy/paths.js');
    const rules = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }, { pattern: 'secret', policy: 'local-only' }]);
    const mem = new RunMemory(root, undefined, () => true, () => rules);
    run(mem, 'shell', { command: 'git status' }, NOT_A_REPO, 'T3-a', bad);
    run(mem, 'shell', { command: 'cd secret && git status' }, NOT_A_REPO, 'T3-a', bad);
    run(mem, 'git', { operation: 'status', cwd: 'secret' }, NOT_A_REPO, 'T3-a', bad);
    const known = mem.known();
    expect(known.map((f) => f.key)).toEqual(['git-repo:the project folder']);
    expect(formatPlannerFacts(known)).toMatch(/^KNOWN ABOUT THIS MACHINE[^\n]*\n- The project folder is not a git repository/);
    // A worker is still told: the planner seeing it marked nothing.
    expect(mem.unseenBy('T3-b').map((f) => f.key)).toEqual(['git-repo:the project folder']);
  });
});
