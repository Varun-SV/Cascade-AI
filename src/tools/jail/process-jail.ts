// ─────────────────────────────────────────────
//  Cascade AI — The process jail for shell, run_code and git
// ─────────────────────────────────────────────
//
//  These three run real programs, which can open any file the user can and
//  read any process's environment the user can: the file tools' protected
//  paths meant nothing to `cat .cascade/config.json` once it was approved,
//  and approval can come from a tier above rather than a person.
//
//  Each launch is wrapped in the OS's own confinement:
//
//    Linux  — bubblewrap. The filesystem is the host's, but Cascade's own
//             files and the built-in secrets are mounted over, as are
//             local-only paths unless the caller is local-only itself; the
//             command gets its own process namespace, so no other process's
//             /proc — Cascade's environment among them — is there to read;
//             and a local-only caller gets its own network namespace, with
//             nothing but loopback.
//    macOS  — sandbox-exec, with a generated profile that denies the same
//             paths, and all outbound connections for a local-only caller.
//
//  Every launch, jailed or not, gets an environment with the provider keys
//  taken out. Where there is no jailer (Windows, or a Linux without a
//  working bubblewrap), `auto` runs commands with that environment alone —
//  and refuses them to a local-only caller, whose network it cannot cut.
//  Naming a jailer outright refuses commands when that jailer is missing;
//  `off` is today's behaviour, and nothing is scrubbed.
//
//  A workspace's own `.cascadeignore` is not applied here: it commonly lists
//  `node_modules/` and `dist/`, which builds and tests have to read.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type ProcessJailMode = 'auto' | 'bwrap' | 'sandbox-exec' | 'off';
export type JailKind = 'bwrap' | 'sandbox-exec';

/** Environment variables that carry a model or search provider's key, or Cascade's own secret. */
export const SECRET_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_API_KEY',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'TOGETHER_API_KEY',
  'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'EXA_API_KEY',
  'CASCADE_DASHBOARD_SECRET',
];

/** Directories never walked for paths to hide: git's own store, and installed packages. */
const UNWALKED_DIRS = new Set(['.git', 'node_modules']);

export interface JailPolicy {
  mode: ProcessJailMode;
  workspaceRoot: string;
  /** Workspace-relative POSIX path (a directory ends in `/`) no command may see. */
  isProtected: (rel: string) => boolean;
  /** Workspace-relative POSIX path under a local-only privacy policy. */
  isLocalOnly?: (rel: string) => boolean;
  /** Directories outside the workspace to hide whole — Cascade's global one. */
  hiddenDirs: string[];
  /** Values no command's environment may carry, under whatever name. */
  secretValues: () => string[];
  log: (msg: string) => void;
  /** Which jailer this machine has; injectable for tests. */
  detect?: () => Promise<JailKind | null>;
}

export interface Launch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The jailer the launch is wrapped in, or null when it runs as it is. */
  jail: JailKind | null;
}

export type Prepared = { ok: true; launch: Launch } | { ok: false; reason: string };

/** A path to hide, and whether it is a directory (mounted over whole). */
export interface Hidden {
  path: string;
  dir: boolean;
}

export class ProcessJail {
  private warned = false;

  constructor(private readonly policy: JailPolicy) {}

  /**
   * How to launch `file args` from `cwd`: wrapped in the jail, or as it is
   * with a scrubbed environment, or not at all. `offline` is the caller being
   * local-only: nothing it knows may leave the machine.
   */
  async prepare(file: string, args: string[], opts: { cwd: string; offline: boolean }): Promise<Prepared> {
    const { mode } = this.policy;
    if (mode === 'off') {
      return { ok: true, launch: { file, args, env: { ...process.env }, cwd: opts.cwd, jail: null } };
    }
    const env = scrubEnv(process.env, this.policy.secretValues());
    const available = await (this.policy.detect ?? detectJail)();
    const kind = mode === 'auto' ? available : (available === mode ? mode : null);

    if (!kind) {
      if (mode !== 'auto') {
        return { ok: false, reason: `tools.processJail is "${mode}", which is not available on this machine, so the command was not run.` };
      }
      if (opts.offline) {
        return { ok: false, reason: 'A local-only subtask (privacy.paths) cannot run commands here: there is no process jail to keep them off the network.' };
      }
      if (!this.warned) {
        this.warned = true;
        this.policy.log('[jail] No process jail is available (bubblewrap on Linux, sandbox-exec on macOS): commands run with provider keys removed from their environment, but can read any file once approved.');
      }
      return { ok: true, launch: { file, args, env, cwd: opts.cwd, jail: null } };
    }

    const hidden = collectHidden(this.policy, opts.offline);
    if (kind === 'bwrap') {
      return { ok: true, launch: { file: 'bwrap', args: bwrapArgs(hidden, opts.offline, opts.cwd, file, args), env, cwd: opts.cwd, jail: kind } };
    }
    return {
      ok: true,
      launch: { file: 'sandbox-exec', args: ['-p', seatbeltProfile(hidden, opts.offline), file, ...args], env, cwd: opts.cwd, jail: kind },
    };
  }
}

/** `env` without provider keys: the known names, and any variable holding a configured secret. */
export function scrubEnv(env: NodeJS.ProcessEnv, secretValues: string[]): NodeJS.ProcessEnv {
  const secrets = new Set(secretValues.filter((v) => v && v.length >= 8));
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAMES.includes(name.toUpperCase())) continue;
    if (value !== undefined && secrets.has(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Every path a command from this workspace may not see: the protected ones,
 * the local-only ones unless the caller is local-only itself, and the hidden
 * directories outside. A directory matched whole is hidden whole, and not
 * walked.
 */
export function collectHidden(policy: JailPolicy, offline: boolean): Hidden[] {
  const out: Hidden[] = [];
  let root: string;
  try { root = fs.realpathSync(policy.workspaceRoot); } catch { root = path.resolve(policy.workspaceRoot); }
  const hide = (rel: string): boolean => policy.isProtected(rel) || (!offline && !!policy.isLocalOnly?.(rel));

  const walk = (dir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (hide(`${rel}/`)) { out.push({ path: abs, dir: true }); continue; }
        if (UNWALKED_DIRS.has(entry.name)) continue;
        walk(abs, rel);
      } else if (hide(rel)) {
        // A symlink is hidden under its own name; what it points to inside
        // the workspace is judged, and hidden, where it lies.
        out.push({ path: abs, dir: false });
      }
    }
  };
  walk(root, '');

  for (const dir of policy.hiddenDirs) {
    try { if (fs.statSync(dir).isDirectory()) out.push({ path: fs.realpathSync(dir), dir: true }); } catch { /* not there */ }
  }
  return out;
}

/**
 * bubblewrap's arguments: the host as it is, the hidden paths mounted over,
 * the command's own processes. `--cap-drop ALL` matters when Cascade runs as
 * root, in a container say: bubblewrap then keeps every capability, and a
 * command could simply unmount what hides a file.
 */
export function bwrapArgs(hidden: Hidden[], offline: boolean, cwd: string, file: string, args: string[]): string[] {
  const out = [
    '--die-with-parent', '--new-session', '--unshare-pid', '--cap-drop', 'ALL',
    '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
  ];
  if (offline) out.push('--unshare-net');
  for (const h of hidden) {
    if (h.dir) out.push('--tmpfs', h.path);
    else out.push('--ro-bind', '/dev/null', h.path);
  }
  out.push('--chdir', cwd, '--', file, ...args);
  return out;
}

/** A sandbox-exec profile: everything allowed but the hidden paths, and the network for a local-only caller. */
export function seatbeltProfile(hidden: Hidden[], offline: boolean): string {
  const quote = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = ['(version 1)', '(allow default)'];
  if (hidden.length) {
    const filters = hidden.map((h) => (h.dir ? `(subpath ${quote(h.path)})` : `(literal ${quote(h.path)})`));
    lines.push(`(deny file-read* file-write* ${filters.join(' ')})`);
  }
  if (offline) lines.push('(deny network-outbound)');
  return lines.join('\n');
}

let detected: Promise<JailKind | null> | undefined;

/**
 * The jailer this machine can actually run, found once. Each is tried the way
 * it will be used — bubblewrap can be installed and still unusable, where
 * unprivileged user namespaces are switched off — and sandbox-exec is given
 * a profile of the shape a launch uses, so a profile it rejects is found now
 * rather than on every command.
 */
export function detectJail(): Promise<JailKind | null> {
  detected ??= (async () => {
    if (process.platform === 'linux') {
      const ok = await runs('bwrap', bwrapArgs([], true, '/', 'true', []));
      return ok ? 'bwrap' : null;
    }
    if (process.platform === 'darwin') {
      const probe = seatbeltProfile([{ path: '/nonexistent/cascade-probe', dir: false }, { path: '/nonexistent/cascade-dir', dir: true }], true);
      const ok = await runs('sandbox-exec', ['-p', probe, '/usr/bin/true']);
      return ok ? 'sandbox-exec' : null;
    }
    return null;
  })();
  return detected;
}

function runs(file: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000, windowsHide: true }, (err) => resolve(!err));
  });
}
