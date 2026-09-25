// ─────────────────────────────────────────────
//  Cascade AI — Where a project's state is kept
// ─────────────────────────────────────────────
//
//  What Cascade keeps about a project — its settings, sessions, audit trail,
//  world state, code index, run checkpoints, the record of what local-only
//  subtasks wrote, and their private outputs — lives outside the project, in
//  a folder of its own under the machine-global one:
//
//    ~/.cascade-ai/projects/<folder name>-<hash of its real path>/
//
//  It used to live in the project's own `.cascade/`, where every tool and
//  command working in the project had to be kept away from it, where it
//  could be committed by accident, and where a local-only subtask's outputs
//  sat beside everything else. The project keeps only what is meant to be
//  shared: `.cascadeignore` and `CASCADE.md`. Provider keys are not kept per
//  project at all: they live in `~/.cascade-ai/credentials.json`.
//
//  A host that must not write the machine-global folder — the hosted server,
//  whose workspaces are tenants' scratch folders — names the state folder for
//  a workspace itself (`useProjectStateDir`).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GLOBAL_CONFIG_DIR } from '../constants.js';

/** The folder a project kept its state in before; moved out on first use (`projectStateDir`). */
export const LEGACY_STATE_DIR = '.cascade';

/** Where the machine-global folder is: `CASCADE_GLOBAL_DIR` when set (tests, portable installs), else `~/.cascade-ai`. */
export function globalDir(): string {
  const override = process.env['CASCADE_GLOBAL_DIR'];
  return override ? path.resolve(override) : path.join(os.homedir(), GLOBAL_CONFIG_DIR);
}

const named = new Map<string, string>();
const prepared = new Set<string>();
const movedIn = new Map<string, string[]>();

/** The workspace's real path, the key its state is found by. */
function realRoot(workspacePath: string): string {
  try { return fs.realpathSync.native(workspacePath); } catch { return path.resolve(workspacePath); }
}

/**
 * Keep this workspace's state in `dir` rather than under the global folder —
 * for a host that must not write there. Applies to this process.
 */
export function useProjectStateDir(workspacePath: string, dir: string): void {
  named.set(realRoot(workspacePath), path.resolve(dir));
}

/**
 * The folder this workspace's state is kept in. The first time a process
 * asks, it is made — readable by this user alone, as are the folders above it
 * under the global one — and a legacy `.cascade/` is moved into it, so
 * whichever part of Cascade opens it first finds what was there before.
 */
export function projectStateDir(workspacePath: string): string {
  const root = realRoot(workspacePath);
  const chosen = named.get(root);
  let dir = chosen;
  if (!dir) {
    const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
    const slug = path.basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 40) || 'project';
    dir = path.join(globalDir(), 'projects', `${slug}-${hash}`);
  }
  if (!prepared.has(dir)) {
    prepared.add(dir);
    try {
      makePrivate(chosen ? [dir] : [globalDir(), path.join(globalDir(), 'projects'), dir]);
      movedIn.set(dir, moveLegacyState(workspacePath, dir));
    } catch { /* left to whatever opens it to report */ }
  }
  return dir;
}

/**
 * Make each folder, outermost first, readable by this user alone — tightening
 * one that already exists, since `mkdir`'s mode does not.
 */
function makePrivate(dirs: string[]): void {
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') continue;
    const st = fs.statSync(dir);
    if ((st.mode & 0o077) !== 0 && st.uid === process.getuid?.()) fs.chmodSync(dir, st.mode & 0o700);
  }
}

/** A path inside the workspace's state folder. */
export function statePath(workspacePath: string, ...parts: string[]): string {
  return path.join(projectStateDir(workspacePath), ...parts);
}

/**
 * Names in the state folder. Files Cascade writes there for itself; the
 * folders `tmp` (run_code's scripts), `screenshots` (the browser's) and
 * `private` (what local-only subtasks create) are the ones tools reach.
 */
export const STATE = {
  config: 'config.json',
  memoryDb: 'memory.db',
  dashboardSecret: 'dashboard-secret',
  auditLog: 'audit.log',
  codeIndex: 'code-index.db',
  privacyDerived: 'privacy-derived.json',
  resume: 'resume',
  deadModels: 'dead-models.json',
  dynamicTools: 'dynamic-tools.json',
  gate: 'gate',
  tmp: 'tmp',
  screenshots: 'screenshots',
  private: 'private',
} as const;

/**
 * Tool paths that name a folder in the state folder rather than the
 * workspace: `@screenshots/…` for the browser's screenshots, and
 * `@private/…` for a local-only subtask's own outputs (the registry lets
 * only such a subtask use it).
 */
export const STATE_PREFIXES = { '@private': STATE.private, '@screenshots': STATE.screenshots } as const;

/** The state-folder path a tool path names, or null for a workspace path. */
export function statePathFor(workspacePath: string, input: string): string | null {
  const normalized = input.split(path.sep).join('/');
  for (const [prefix, folder] of Object.entries(STATE_PREFIXES)) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return path.join(projectStateDir(workspacePath), folder, normalized.slice(prefix.length + 1));
    }
  }
  return null;
}

/**
 * Move a project's state out of its legacy `.cascade/` folder into its state
 * folder: each entry the state folder does not have yet is moved (copied,
 * across filesystems), and the legacy folder is removed when that leaves it
 * empty. Returns what was moved since this process last asked — the first use
 * of the state folder does the move (`projectStateDir`), and this tries again
 * for anything left. The config moves as it is: `ConfigManager` takes its
 * keys out when it next loads it.
 */
export function migrateProjectState(workspacePath: string): string[] {
  const dir = projectStateDir(workspacePath);
  const moved = [...(movedIn.get(dir) ?? []), ...moveLegacyState(workspacePath, dir)];
  movedIn.delete(dir);
  return moved;
}

/** Whether the workspace's `.cascade` is a symlink, which is never followed. */
export function legacyStateIsLink(workspacePath: string): boolean {
  try { return fs.lstatSync(path.join(workspacePath, LEGACY_STATE_DIR)).isSymbolicLink(); } catch { return false; }
}

function moveLegacyState(workspacePath: string, target: string): string[] {
  const legacy = path.join(workspacePath, LEGACY_STATE_DIR);
  let entries: string[];
  try {
    // A `.cascade` that is a symlink is left alone: following it would move
    // whatever it points at — anywhere on the machine — out of its place.
    if (!fs.lstatSync(legacy).isDirectory()) return [];
    if (realRoot(legacy) === realRoot(target)) return [];
    entries = fs.readdirSync(legacy);
  } catch {
    return [];
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  for (const name of entries) {
    const from = path.join(legacy, name);
    const to = path.join(target, name);
    if (fs.existsSync(to)) continue;
    try {
      moveEntry(from, to);
      moved.push(name);
    } catch { /* left where it is; tried again next time */ }
  }
  try { if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy); } catch { /* not empty, or gone */ }
  return moved;
}

function moveEntry(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
