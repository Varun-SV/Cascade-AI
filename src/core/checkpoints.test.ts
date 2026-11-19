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

  it('takes no checkpoint of the home folder', async () => {
    expect(await new Checkpoints(os.homedir(), state).begin('x')).toBeNull();
  });
});
