import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Checkpoints } from './checkpoints.js';

let root: string;
let state: string;
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(root, p));

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  root = path.join(base, 'project');
  state = path.join(base, 'state');
  fs.mkdirSync(root);
  write('a.txt', 'one');
  write('src/b.ts', 'two');
  write('.gitignore', 'out/\n');
  write('out/build.js', 'built');
});

describe('Checkpoints', () => {
  it('undoes a run: changed files back, made ones gone, deleted ones back, ignored ones untouched', async () => {
    const cp = new Checkpoints(root, state);
    const run = await cp.begin('Refactor the thing');
    expect(run?.n).toBe(1);
    write('a.txt', 'changed');
    write('src/new/c.ts', 'made');
    fs.rmSync(path.join(root, 'src/b.ts'));
    write('out/build.js', 'rebuilt');
    const done = await cp.end(run!);
    expect(done.changed).toBe(3);

    const r = await cp.undo();
    expect(r.runs.map((x) => x.n)).toEqual([1]);
    expect(read('a.txt')).toBe('one');
    expect(read('src/b.ts')).toBe('two');
    expect(exists('src/new/c.ts')).toBe(false);
    expect(exists('src/new')).toBe(false);
    expect(read('out/build.js')).toBe('rebuilt');
    expect(cp.list()[0]!.undone).toBe(true);
    expect((await cp.undo()).runs).toEqual([]);
  });

  it('leaves a file the person changed after the run alone, unless forced', async () => {
    const cp = new Checkpoints(root, state);
    const run = (await cp.begin('x'))!;
    write('a.txt', 'by the run');
    write('src/b.ts', 'by the run');
    await cp.end(run);
    write('a.txt', 'by hand');
    const r = await cp.undo();
    expect(r.skipped).toEqual(['a.txt']);
    expect(read('a.txt')).toBe('by hand');
    expect(read('src/b.ts')).toBe('two');
  });

  it('a forced retry finishes a run whose files were left alone (Codex on 53bc237)', async () => {
    const cp = new Checkpoints(root, state);
    const run = (await cp.begin('x'))!;
    write('a.txt', 'by the run');
    await cp.end(run);
    write('a.txt', 'by hand');
    expect((await cp.undo()).skipped).toEqual(['a.txt']);
    expect(cp.list()[0]).toMatchObject({ partial: true });
    expect(cp.list()[0]!.undone).toBeFalsy();
    const forced = await cp.undo(1, true);
    expect(forced.runs.map((r) => r.n)).toEqual([1]);
    expect(read('a.txt')).toBe('one');
    expect(cp.list()[0]).toMatchObject({ undone: true });
  });

  it('several runs: each file goes back to before the first run that changed it, keeping work done between them (Codex on 53bc237)', async () => {
    const cp = new Checkpoints(root, state);
    const one = (await cp.begin('one'))!;
    write('a.txt', 'run one');
    await cp.end(one);
    write('b.txt', 'made by hand between runs');
    const two = (await cp.begin('two'))!;
    write('b.txt', 'run two');
    await cp.end(two);
    const r = await cp.undo(2);
    expect(read('a.txt')).toBe('one');
    expect(read('b.txt')).toBe('made by hand between runs');
    expect(r.removed).toEqual([]);
  });

  it('undoes the last n runs together, and leaves the project\'s own git alone', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const head = () => { try { return execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString(); } catch { return 'err'; } };
    const statusBefore = head();
    const cp = new Checkpoints(root, state);
    const one = (await cp.begin('one'))!;
    write('a.txt', 'run one');
    await cp.end(one);
    const two = (await cp.begin('two'))!;
    write('a.txt', 'run two');
    write('d.txt', 'run two made');
    await cp.end(two);
    const r = await cp.undo(2);
    expect(r.runs.map((x) => x.n)).toEqual([2, 1]);
    expect(read('a.txt')).toBe('one');
    expect(exists('d.txt')).toBe(false);
    expect(head()).toBe(statusBefore);
    expect(fs.existsSync(path.join(root, '.git', 'refs', 'cascade'))).toBe(false);
  });

  it('a run that never ended is undone against the files as they are now', async () => {
    const cp = new Checkpoints(root, state);
    await cp.begin('crashed');
    write('a.txt', 'half done');
    await cp.undo();
    expect(read('a.txt')).toBe('one');
  });

  it('says whether it records a file: not one the .gitignore leaves out, nor one outside (Codex on f8f4a10)', async () => {
    const cp = new Checkpoints(root, state);
    write('.gitignore', 'out/\nlocal-data/\n');
    expect(await cp.covers([path.join(root, 'src/b.ts'), path.join(root, 'new-file.txt')])).toBe(true);
    expect(await cp.covers([path.join(root, 'local-data/notes.txt')])).toBe(false);
    expect(await cp.covers([path.join(root, 'src/b.ts'), path.join(root, 'out/build.js')])).toBe(false);
    expect(await cp.covers([path.join(root, 'node_modules/x/index.js')])).toBe(false);
    expect(await cp.covers([path.join(path.dirname(root), 'elsewhere.txt')])).toBe(false);
  });

  it('a symlink is judged by where it points: not covered when that is outside (Codex on 806c9af)', async () => {
    const cp = new Checkpoints(root, state);
    const outsideFile = path.join(path.dirname(root), 'outside.txt');
    fs.writeFileSync(outsideFile, 'theirs');
    fs.symlinkSync(outsideFile, path.join(root, 'linked.txt'));
    fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'inside-link.txt'));
    fs.symlinkSync(path.dirname(root), path.join(root, 'up'));
    expect(await cp.covers([path.join(root, 'linked.txt')])).toBe(false);
    expect(await cp.covers([path.join(root, 'up', 'new.txt')])).toBe(false);
    expect(await cp.covers([path.join(root, 'inside-link.txt')])).toBe(true);
  });

  it('leaves alone what is inside or around a file left alone (Codex on 4daf87b)', async () => {
    write('a/original.txt', 'first');
    const cp = new Checkpoints(root, state);
    const run = (await cp.begin('x'))!;
    fs.rmSync(path.join(root, 'a'), { recursive: true });
    write('a', 'a file now');
    await cp.end(run);
    write('a', 'edited by hand');
    const r = await cp.undo();
    expect(read('a')).toBe('edited by hand');
    expect(r.skipped).toEqual(expect.arrayContaining(['a', 'a/original.txt']));
    expect(r.restored).toEqual([]);
  });

  it('a folder is covered only if nothing inside it is left out (Codex on 8c4090e)', async () => {
    const cp = new Checkpoints(root, state);
    write('.gitignore', 'dest/a.txt\n');
    write('dest/a.txt', 'kept by hand');
    write('dest/b.txt', 'tracked');
    write('clean/c.txt', 'tracked');
    expect(await cp.covers([path.join(root, 'dest')])).toBe(false);
    expect(await cp.covers([path.join(root, 'clean')])).toBe(true);
  });

  it('gives back a CRLF file byte for byte, whatever the .gitattributes says (Codex on 8c4090e)', async () => {
    write('.gitattributes', '* text=auto\n');
    fs.writeFileSync(path.join(root, 'win.txt'), 'one\r\ntwo\r\n');
    const cp = new Checkpoints(root, state);
    const run = (await cp.begin('x'))!;
    fs.writeFileSync(path.join(root, 'win.txt'), 'changed\r\n');
    await cp.end(run);
    await cp.undo();
    expect(fs.readFileSync(path.join(root, 'win.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
  });

  it('takes no checkpoint of the home folder', async () => {
    expect(await new Checkpoints(os.homedir(), state).begin('x')).toBeNull();
  });
});
