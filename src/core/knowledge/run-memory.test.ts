import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunMemory, callReadsOnly, commandReadsOnly, factsFrom, formatRunFacts, workspaceChangeMarker, type ChangeMarker } from './run-memory.js';
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
      db.upsertFact('environment', 'command wc', 'not available', 'run:T3-old', undefined, []);
      db.upsertFact('environment', 'git repository at legacy', 'none', 'run:T3-old', undefined, []);
      expect(new RunMemory(root, db).all().map((f) => f.key).sort()).toEqual(['git-repo:legacy', 'missing:wc']);
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
    expect(commandReadsOnly('git diff --no-ext-diff --no-textconv')).toBe(true);
    expect(commandReadsOnly('git log -p --no-ext-diff --no-textconv')).toBe(true);
    expect(commandReadsOnly('git log --oneline -5')).toBe(true);
    expect(commandReadsOnly('git status')).toBe(true);
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
      db.upsertFact('environment', 'command wc', 'not available', 'run:T3-old', undefined, []);
      const rules = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]);
      const mem = new RunMemory(root, db, () => true, () => rules);
      expect(mem.all().map((f) => f.key)).toEqual(['missing:wc']);
      // Control: with no rules, all of them.
      expect(new RunMemory(root, db).all().map((f) => f.key).sort()).toEqual(['git-repo:docs', 'git-repo:legacy', 'git-repo:secret/acquisition', 'missing:wc']);
      // Nor is one learnt about a local-only folder now.
      fs.mkdirSync(path.join(root, 'secret', 'acq'), { recursive: true });
      run(mem, 'shell', { command: 'git status', cwd: 'secret/acq' }, NOT_A_REPO, 'T3-a', bad);
      expect(mem.all().map((f) => f.key)).toEqual(['missing:wc']);
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
      run(mem, 'shell', { command: 'wc -w a.md' }, 'Exit 127:\nbash: wc: command not found', 'T3-a', bad);
      expect(db.getFactsForEntities(['environment']).map((f) => f.relation)).toEqual(['command wc']);
      // Off again: what is kept stays as it is.
      keep = false;
      run(mem, 'shell', { command: 'wc -w a.md' }, '12 a.md', 'T3-a');
      expect(db.getFactsForEntities(['environment']).map((f) => f.relation)).toEqual(['command wc']);
    } finally { db.close(); }
  });


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
