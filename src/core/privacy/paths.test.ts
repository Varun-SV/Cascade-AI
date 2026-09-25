import { describe, expect, it } from 'vitest';
import { PrivacyPaths } from './paths.js';

describe('PrivacyPaths', () => {
  const policy = new PrivacyPaths([
    { pattern: 'src/core/crypto/**', policy: 'local-only' },
    { pattern: 'secrets.json', policy: 'local-only' },
  ]);

  it('matches files under a local-only directory pattern', () => {
    expect(policy.isLocalOnly('src/core/crypto/keys.ts')).toBe(true);
    expect(policy.isLocalOnly('src/core/crypto/deep/nested/mod.ts')).toBe(true);
  });

  it('matches an exact-file pattern anywhere gitignore semantics place it', () => {
    expect(policy.isLocalOnly('secrets.json')).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(policy.isLocalOnly('src/core/router/index.ts')).toBe(false);
    expect(policy.isLocalOnly('README.md')).toBe(false);
  });

  it('normalizes leading ./ before matching', () => {
    expect(policy.isLocalOnly('./src/core/crypto/keys.ts')).toBe(true);
  });

  it('anyLocalOnly is true when at least one path matches', () => {
    expect(policy.anyLocalOnly(['README.md', 'src/core/crypto/a.ts'])).toBe(true);
    expect(policy.anyLocalOnly(['README.md', 'src/utils/net.ts'])).toBe(false);
  });

  it('is inert with no policies', () => {
    const empty = new PrivacyPaths([]);
    expect(empty.hasPolicies()).toBe(false);
    expect(empty.isLocalOnly('src/core/crypto/keys.ts')).toBe(false);
  });
});

describe('PrivacyPaths.coversFile — a file on disk, under any name it has', () => {
  it('covers a file by its path in the workspace, and one reached through a symlink', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-covers-'));
    await fs.mkdir(path.join(root, 'secret'));
    await fs.writeFile(path.join(root, 'secret', 'plan.md'), 'x');
    await fs.symlink(path.join(root, 'secret', 'plan.md'), path.join(root, 'innocent.md'));
    await fs.symlink(path.join(root, 'secret'), path.join(root, 'docs'));
    const policy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]);

    expect(policy.coversFile(path.join(root, 'secret', 'plan.md'), root)).toBe(true);
    expect(policy.coversFile(path.join(root, 'innocent.md'), root)).toBe(true);
    expect(policy.coversFile(path.join(root, 'docs', 'plan.md'), root)).toBe(true);
    expect(policy.coversFile(path.join(root, 'docs', 'not-yet-written.md'), root)).toBe(true);
    expect(policy.coversFile(path.join(root, 'README.md'), root)).toBe(false);
    // Outside the workspace no pattern speaks to it; the file tools refuse it anyway.
    expect(policy.coversFile(path.join(os.tmpdir(), 'elsewhere.md'), root)).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('covers a hard link to a local-only file, which realpath gives back as itself', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-covers-link-'));
    await fs.mkdir(path.join(root, 'secret'));
    await fs.writeFile(path.join(root, 'secret', 'plan.md'), 'x');
    await fs.writeFile(path.join(root, 'README.md'), 'y');
    const policy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]);
    expect(policy.coversFile(path.join(root, 'README.md'), root)).toBe(false);
    await fs.link(path.join(root, 'secret', 'plan.md'), path.join(root, 'plan-copy.md'));
    await fs.link(path.join(root, 'README.md'), path.join(root, 'README-copy.md'));
    expect(policy.coversFile(path.join(root, 'plan-copy.md'), root)).toBe(true);
    expect(policy.coversFile(path.join(root, 'README-copy.md'), root)).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });
});

// What a local-only subtask wrote could carry what it read, and used to be
// an ordinary workspace file the next cloud worker could open.
describe('PrivacyPaths — what a local-only subtask wrote', () => {
  it('keeps it local-only, in this process and the next', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-derived-'));
    const policy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: root });
    expect(new PrivacyPaths([], { workspaceRoot: root }).hasPolicies()).toBe(false);

    // Recorded even where a pattern covers it now: the pattern may go.
    expect(policy.addDerived(['summary.md', 'secret/notes.md', 'odd [draft]*.md'])).toEqual(['summary.md', 'secret/notes.md', 'odd [draft]*.md']);
    expect(policy.addDerived(['summary.md'])).toEqual([]);
    expect(policy.isLocalOnly('summary.md')).toBe(true);
    expect(policy.isLocalOnly('summary.md.bak')).toBe(false);
    expect(policy.coversFile(path.join(root, 'summary.md'), root)).toBe(true);

    // A later run reads the record, even with no policy configured any more.
    const next = new PrivacyPaths([], { workspaceRoot: root });
    expect(next.hasPolicies()).toBe(true);
    expect(next.isLocalOnly('summary.md')).toBe(true);
    expect(next.isLocalOnly('odd [draft]*.md')).toBe(true);
    expect(next.isLocalOnly('odd d.md')).toBe(false);
    expect(next.isLocalOnly('secret/notes.md'), 'with the pattern that covered it gone').toBe(true);

    // As patterns — for git — each names that one file and no other.
    const ignore = (await import('ignore')).default();
    ignore.add(next.localOnlyPatterns());
    expect(ignore.ignores('summary.md')).toBe(true);
    expect(ignore.ignores('odd [draft]*.md')).toBe(true);
    expect(ignore.ignores('odd d.md')).toBe(false);
    expect(ignore.ignores('sub/summary.md')).toBe(false);
    // A record made for a write that did not happen comes off, for good.
    next.removeDerived(['odd [draft]*.md']);
    expect(new PrivacyPaths([], { workspaceRoot: root }).isLocalOnly('odd [draft]*.md')).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  // A directory's name can carry as much as a file's: one a local-only
  // subtask made is recorded, and everything in it is local-only.
  it('covers what lies in a directory it made', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-derived-'));
    const policy = new PrivacyPaths([], { workspaceRoot: root });
    expect(policy.addDerived(['made/'])).toEqual(['made']);
    expect(policy.isLocalOnly('made')).toBe(true);
    expect(policy.isLocalOnly('made/')).toBe(true);
    expect(policy.isLocalOnly('made/deep/x.txt')).toBe(true);
    expect(policy.isLocalOnly('made-not/x.txt')).toBe(false);
    expect(policy.coversFile(path.join(root, 'made', 'later.txt'), root)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  // Trailing slashes came off with /\/+$/, which retries from every slash:
  // quadratic on a path made of them, and paths come from agents.
  it('reads a path of many slashes in linear time', () => {
    const policy = new PrivacyPaths();
    policy.addDerived(['made']);
    const nasty = `${'/'.repeat(100_000)}x`;
    const started = Date.now();
    expect(policy.isLocalOnly(nasty)).toBe(false);
    expect(policy.addDerived([nasty])).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // Two runs in one workspace each held their own copy of the record, and
  // the last to save replaced the other's additions with its own.
  it('keeps every run\'s records when runs share a workspace', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-derived-'));
    const a = new PrivacyPaths([], { workspaceRoot: root });
    const b = new PrivacyPaths([], { workspaceRoot: root });
    const c = new PrivacyPaths([], { workspaceRoot: root });
    expect(c.isLocalOnly('a.txt')).toBe(false);
    a.addDerived(['a.txt']);
    b.addDerived(['b.txt']);
    const later = new PrivacyPaths([], { workspaceRoot: root });
    expect(later.isLocalOnly('a.txt')).toBe(true);
    expect(later.isLocalOnly('b.txt')).toBe(true);
    // A run that started before sees another's records as they are made.
    expect(c.isLocalOnly('a.txt')).toBe(true);
    expect(c.localOnlyPatterns()).toEqual(['/a.txt', '/b.txt']);
    // Taking back one run's record leaves the other's.
    a.removeDerived(['a.txt']);
    expect(b.isLocalOnly('b.txt')).toBe(true);
    expect(new PrivacyPaths([], { workspaceRoot: root }).isLocalOnly('b.txt')).toBe(true);

    // Another process's change is seen from the next job on.
    const { statePath } = await import('../../config/project-state.js');
    const file = statePath(root, 'privacy-derived.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, paths: ['b.txt', 'other.txt'] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(c.isLocalOnly('other.txt')).toBe(true);
    // …and one made after this run last looked is kept when it saves.
    const { writeFileSync } = await import('node:fs');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(b.isLocalOnly('meanwhile.txt')).toBe(false);
    writeFileSync(file, JSON.stringify({ version: 1, paths: ['b.txt', 'meanwhile.txt', 'other.txt'] }));
    b.addDerived(['b2.txt']);
    expect(new PrivacyPaths([], { workspaceRoot: root }).isLocalOnly('meanwhile.txt')).toBe(true);
    b.removeDerived(['b2.txt']);

    // A lock left by a run that ended holding it is taken over once stale,
    // and each save lets go of its own.
    const lock = `${file}.lock`;
    await fs.writeFile(lock, '1');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    c.addDerived(['c.txt']);
    await expect(fs.stat(lock)).rejects.toThrow();
    expect(new PrivacyPaths([], { workspaceRoot: root }).localOnlyPatterns()).toEqual(['/b.txt', '/c.txt', '/meanwhile.txt', '/other.txt']);
    await fs.rm(root, { recursive: true, force: true });
  });
});

// A record cut short or edited by hand was read as no record at all: every
// file it listed was readable to cloud models again, and the next save wrote
// over it.
describe('PrivacyPaths — a record that cannot be read', () => {
  it('refuses to start from it, keeps what it read before, and saves nothing over it', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { statePath, STATE } = await import('../../config/project-state.js');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-derived-bad-')));
    const record = statePath(root, STATE.privacyDerived);
    try {
      const policy = new PrivacyPaths([], { workspaceRoot: root });
      policy.addDerived(['summary.md']);

      for (const bad of ['{"version":1,"paths":["summ', '', '{"paths":"summary.md"}']) {
        await fs.writeFile(record, bad);
        expect(() => new PrivacyPaths([], { workspaceRoot: root })).toThrow(/cannot read/);
      }
      // A run that read it before keeps what it read — and adds nothing over it.
      await new Promise((r) => setTimeout(r, 0));
      expect(policy.isLocalOnly('summary.md')).toBe(true);
      expect(() => policy.addDerived(['other.md'])).toThrow(/cannot read/);
      expect(await fs.readFile(record, 'utf8')).toBe('{"paths":"summary.md"}');
      // No record at all is no marks.
      await fs.rm(record);
      expect(new PrivacyPaths([], { workspaceRoot: root }).isLocalOnly('summary.md')).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// A name beginning with two dots was taken for a way out of the workspace:
// no policy covered `..secret.ts`, and the code index sent it to the embedder.
describe('PrivacyPaths — a file whose name begins with two dots', () => {
  it('is inside the workspace, and covered like any other', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { resolveInWorkspace } = await import('../../tools/utils/workspace-path.js');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-dots-')));
    try {
      await fs.writeFile(path.join(root, '..secret.ts'), 'x');
      const policy = new PrivacyPaths([{ pattern: '..secret.ts', policy: 'local-only' }]);
      expect(policy.coversFile(path.join(root, '..secret.ts'), root)).toBe(true);
      expect(resolveInWorkspace(root, '..secret.ts')).toBe(path.join(root, '..secret.ts'));
      expect(() => resolveInWorkspace(root, '../elsewhere.ts')).toThrow(/outside workspace/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// A backslash went into its pattern as `[\]`, which neither git nor the
// ignore matcher reads as a backslash: a derived `a\b`, once committed, was
// left out of git's exclusions and history checks.
describe.skipIf(process.platform === 'win32')('PrivacyPaths — a derived path holding a backslash', () => {
  it('is named by a pattern git and the matcher both read as that path', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const ignoreModule = await import('ignore');
    const ignore = (ignoreModule.default ?? ignoreModule) as unknown as () => { add(p: string[]): { ignores(p: string): boolean } };
    const { toPathspecs } = await import('../../tools/jail/process-jail.js');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-backslash-')));
    try {
      const policy = new PrivacyPaths([], { workspaceRoot: root });
      policy.addDerived(['a\\b']);
      const patterns = policy.localOnlyPatterns();
      expect(ignore().add(patterns).ignores('a\\b')).toBe(true);
      expect(ignore().add(patterns).ignores('a/b')).toBe(false);
      execFileSync('git', ['-C', root, 'init', '-q']);
      await fs.writeFile(path.join(root, 'a\\b'), 'x');
      execFileSync('git', ['-C', root, 'add', '-A']);
      const listed = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...toPathspecs(patterns)], { encoding: 'utf8' });
      expect(listed.split('\0').filter(Boolean)).toEqual(['a\\b']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
