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
import { renameProjectCredentials } from './global-credentials.js';
import { isWithin } from '../utils/real-path.js';

/** The folder a project kept its state in before; moved out on first use (`projectStateDir`). */
export const LEGACY_STATE_DIR = '.cascade';

/** Where the machine-global folder is: `CASCADE_GLOBAL_DIR` when set (tests, portable installs), else `~/.cascade-ai`. */
export function globalDir(): string {
  const override = process.env['CASCADE_GLOBAL_DIR'];
  return override ? path.resolve(override) : path.join(os.homedir(), GLOBAL_CONFIG_DIR);
}

const named = new Map<string, string>();
/** How many of a host's runs hold each named workspace: the last to end forgets it. */
const holds = new Map<string, number>();
const prepared = new Set<string>();
const movedIn = new Map<string, string[]>();
const releasedHooks = new Set<(root: string) => void>();

/** The workspace's real path, the key its state is found by. */
function realRoot(workspacePath: string): string {
  try { return fs.realpathSync.native(workspacePath); } catch { return path.resolve(workspacePath); }
}

/**
 * Keep this workspace's state in `dir` rather than under the global folder —
 * for a host that must not write there. Applies to this process until the
 * function returned is called, once for each call here: a host calls it
 * when a run ends, so what the process keeps for each workspace follows the
 * runs in progress, not every tenant that ever ran.
 */
export function useProjectStateDir(workspacePath: string, dir: string): () => void {
  // Apart from the workspace, either way: inside it, its tools would read
  // the state folder, which holds what only a local-only subtask may see;
  // around it, the whole workspace would be taken for state and hidden.
  const root = realRoot(workspacePath);
  const at = realRoot(dir);
  if (isWithin(at, root) || isWithin(root, at)) {
    throw new Error(`A project's state folder must be apart from it: ${dir} and ${workspacePath} overlap.`);
  }
  named.set(root, path.resolve(dir));
  holds.set(root, (holds.get(root) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(root) ?? 1) - 1;
    if (left > 0) {
      holds.set(root, left);
      return;
    }
    holds.delete(root);
    const state = named.get(root);
    named.delete(root);
    if (state) {
      prepared.delete(state);
      movedIn.delete(state);
    }
    for (const hook of releasedHooks) hook(root);
  };
}

/** Called with a workspace's real path when a host's last run there ends — for what is kept per workspace elsewhere. */
export function onProjectReleased(hook: (root: string) => void): void {
  releasedHooks.add(hook);
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
      if (!chosen && !fs.existsSync(dir)) followMove(root, dir);
      else if (!chosen) setAsideForNewFolder(root, dir);
      makePrivate(chosen ? [dir] : [globalDir(), path.join(globalDir(), 'projects'), dir]);
      movedIn.set(dir, moveLegacyState(workspacePath, dir));
      if (!chosen) {
        recordIdentity(root, dir);
        moveOwnKeys(dir);
      }
    } catch {
      // Left to whatever opens it to report — and tried again on the next
      // ask, rather than taken as done for the rest of the process.
      prepared.delete(dir);
    }
  }
  return dir;
}

/** What each state folder was made for: its project's path, and what that folder is on disk. */
const IDENTITY_FILE = 'project.json';

interface ProjectIdentity {
  path: string; dev: string; ino: string; born: string;
  /** The state folder's name before the project moved, while its own keys are still filed under it. */
  keysFrom?: string;
}

/** The folder's identity on disk: device and inode, which a rename or `mv` on one disk keeps, and when it was made. */
function identityOf(root: string): Omit<ProjectIdentity, 'path'> | undefined {
  try {
    const st = fs.statSync(root, { bigint: true });
    return { dev: String(st.dev), ino: String(st.ino), born: String(st.birthtimeNs) };
  } catch {
    return undefined;
  }
}

function readIdentity(dir: string): ProjectIdentity | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, IDENTITY_FILE), 'utf-8')) as Partial<ProjectIdentity>;
    return typeof parsed.path === 'string' && typeof parsed.dev === 'string' && typeof parsed.ino === 'string'
      ? { path: parsed.path, dev: parsed.dev, ino: parsed.ino, born: String(parsed.born ?? '0'), ...(typeof parsed.keysFrom === 'string' ? { keysFrom: parsed.keysFrom } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

function sameFolder(a: Omit<ProjectIdentity, 'path'>, b: Omit<ProjectIdentity, 'path'>): boolean {
  // An inode is reused once its folder is gone: when it was made tells a new
  // folder from the old one, where the filesystem keeps that.
  return a.dev === b.dev && a.ino === b.ino && (a.born === '0' || b.born === '0' || a.born === b.born);
}

function recordIdentity(root: string, dir: string, keysFrom?: string): void {
  const now = identityOf(root);
  if (!now) return;
  const was = readIdentity(dir);
  const pending = keysFrom ?? was?.keysFrom;
  if (was && was.path === root && sameFolder(was, now) && was.keysFrom === pending) return;
  fs.writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify({ path: root, ...now, ...(pending ? { keysFrom: pending } : {}) }, null, 2), { mode: 0o600 });
}

/**
 * What stays with a path when another folder takes its place: the settings —
 * the config and its local-only rules, the record of what local-only
 * subtasks wrote (which errs towards keeping a same-named file local-only),
 * the project's own keys (filed under the folder's name) and the like. The
 * rest is what the old project did and knew — sessions, world state, the
 * audit trail, the code index, run checkpoints, private outputs — and would
 * surface in an unrelated one: it is set aside.
 */
function keptForANewFolder(): Set<string> {
  return new Set([STATE.config, STATE.privacyDerived, STATE.deadModels, STATE.dashboardSecret, STATE.gate, IDENTITY_FILE]);
}

/**
 * The folder at this path is not the one its state was made for — deleted,
 * and another made or cloned in its place: what the old one did and knew is
 * moved beside the state folder, with a notice of where.
 */
function setAsideForNewFolder(root: string, dir: string): void {
  const was = readIdentity(dir);
  const now = identityOf(root);
  if (!was || !now || was.path !== root) return;
  // By inode and when it was made, not the device: a remount can change that.
  if (was.ino === now.ino && (was.born === '0' || now.born === '0' || was.born === now.born)) return;
  const kept = keptForANewFolder();
  const entries = fs.readdirSync(dir).filter((name) => !kept.has(name));
  if (entries.length === 0) return;
  const aside = `${dir}.before-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.mkdirSync(aside, { recursive: true, mode: 0o700 });
  for (const name of entries) moveEntry(path.join(dir, name), path.join(aside, name));
  notices.set(dir, [...(notices.get(dir) ?? []), `The folder at ${root} is not the one Cascade's state for it was made for. Its settings, local-only rules and own keys carry over; what the earlier project did and knew — sessions, world state, the audit trail, the code index, run checkpoints, private outputs — was set aside in ${aside}.`]);
}

/**
 * A moved project's own keys, filed under its state folder's old name, are
 * filed under the new one — tried again each time the project is opened
 * until the credential store takes the change.
 */
function moveOwnKeys(dir: string): void {
  const record = readIdentity(dir);
  if (!record?.keysFrom) return;
  try {
    renameProjectCredentials(globalDir(), record.keysFrom, path.basename(dir));
  } catch (err) {
    notices.set(dir, [...(notices.get(dir) ?? []), `Cascade could not yet file this project's own provider keys under its new name (${err instanceof Error ? err.message : String(err)}); it tries again each time the project is opened, and until then the machine-wide keys are used.`]);
    return;
  }
  const { keysFrom: _done, ...rest } = record;
  fs.writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify(rest, null, 2), { mode: 0o600 });
}

/**
 * A project renamed or moved on its disk is still the same folder, and its
 * state follows it: the state folder made for a path that no longer holds
 * that folder, and whose folder this is, is renamed for the new path — its
 * own keys with it. A copy, or a move to another disk, is a new folder and
 * starts afresh; when state for a project of the same name is left without
 * its project, a notice says where.
 */
function followMove(root: string, dir: string): void {
  const now = identityOf(root);
  if (!now) return;
  const projects = path.dirname(dir);
  let names: string[];
  try { names = fs.readdirSync(projects); } catch { return; }
  const orphans: string[] = [];
  for (const name of names) {
    const other = path.join(projects, name);
    const was = readIdentity(other);
    if (!was || was.path === root) continue;
    const there = identityOf(was.path);
    if (there && sameFolder(there, was)) continue; // still where it was
    if (sameFolder(was, now)) {
      fs.renameSync(other, dir);
      // Its own keys follow once it is recorded where it is (moveOwnKeys).
      recordIdentity(root, dir, name);
      notices.set(dir, [...(notices.get(dir) ?? []), `Cascade found this project's state from ${was.path}, where it was before it moved, and uses it here.`]);
      return;
    }
    if (path.basename(was.path) === path.basename(root)) orphans.push(`${was.path} (${other})`);
  }
  if (orphans.length) {
    notices.set(dir, [...(notices.get(dir) ?? []), `Cascade keeps no state for this folder yet. State for a project of the same name at ${orphans.join(', ')} — which is gone — was not taken as this one's: this is not the folder that was there (a copy, or on another disk). Move that folder's contents to ${dir} to keep using it.`]);
  }
}

const notices = new Map<string, string[]>();

/** What Cascade found when it first opened this workspace's state folder, to tell the user once. */
export function stateNotices(workspacePath: string): string[] {
  const dir = projectStateDir(workspacePath);
  const found = notices.get(dir) ?? [];
  notices.delete(dir);
  return found;
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
  const root = realRoot(workspacePath);
  if (!named.has(root)) {
    // As on first use — a folder replaced, or keys still to file, since.
    setAsideForNewFolder(root, dir);
    recordIdentity(root, dir);
    moveOwnKeys(dir);
  }
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
    // Across filesystems: copied under a name of its own and renamed into
    // place whole, so a copy cut short — the process ended, the disk filled —
    // leaves no half-copied entry for the next attempt to take as moved.
    const partial = `${to}.partial-${process.pid}`;
    fs.rmSync(partial, { recursive: true, force: true });
    try {
      fs.cpSync(from, partial, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      fs.renameSync(partial, to);
    } catch (copyErr) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw copyErr;
    }
    fs.rmSync(from, { recursive: true, force: true });
  }
}
