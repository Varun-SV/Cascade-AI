// ─────────────────────────────────────────────
//  Cascade AI — Git Tool
// ─────────────────────────────────────────────

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { globalGitConfigFiles, type Launch } from './jail/process-jail.js';
import { listGitConfig, unjailedSettings } from './git-hermetic.js';
import { resolveInWorkspace } from './utils/workspace-path.js';

/**
 * Refuse `--pathspec-from-file`, which `add`, `checkout` and `stash push`
 * take: git reads the file it names, and repeats every line that matches
 * nothing in its error — `pathspec 'machine … password …' did not match` —
 * which goes back to the model. The file is any the tool can see, and this
 * tool keeps the home credentials in view for pushing. Git accepts a long
 * option cut short while it stays unambiguous, so `--pathspec-from=` counts.
 */
function refusePathspecFile(operation: string, args: string[]): void {
  const full = '--pathspec-from-file';
  for (const arg of args) {
    if (arg === '--') return;
    const name = arg.split('=')[0]!;
    if (name.length >= '--pathspec-fr'.length && full.startsWith(name)) {
      throw new Error(`git ${operation} ${full} is not allowed: git reads that file and repeats what it holds.`);
    }
  }
}

/** Where the git tool looks for hooks: nowhere. */
const NO_HOOKS = `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`;

/**
 * Settings that keep git to the global and system configuration files there
 * were when Cascade started (see gitFor).
 */
function configAtStart(): Record<string, string> {
  if (process.platform === 'win32') return {};
  const env: Record<string, string> = {};
  const globals = globalGitConfigFiles().filter((file) => fs.existsSync(file));
  if (globals.length === 0) env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  else if (globals.length === 1) env['GIT_CONFIG_GLOBAL'] = globals[0]!;
  if (process.platform === 'linux' && !fs.existsSync('/etc/gitconfig')) env['GIT_CONFIG_NOSYSTEM'] = '1';
  return env;
}

export class GitTool extends BaseTool {
  private readonly configAtStart = configAtStart();

  readonly name = 'git';
  readonly description = 'Execute git operations: status, diff, log, add, commit, branch, push, pull.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['status', 'diff', 'log', 'add', 'commit', 'branch', 'checkout', 'push', 'pull', 'stash'],
        description: 'Git operation to perform',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments for the git operation',
      },
      cwd: { type: 'string', description: 'Working directory (defaults to current)' },
    },
    required: ['operation'],
  };

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const operation = input['operation'] as string;
    const args = (input['args'] as string[] | undefined) ?? [];
    // In the workspace: outside a repository, git diff compares any two
    // files it is given — the jail keeps the home credentials in view of
    // this tool, for pushing, and without a jail nothing is hidden at all.
    const cwd = resolveInWorkspace(this.workspaceRoot, (input['cwd'] as string | undefined) ?? '.');

    const offline = options.isOffline?.() === true;
    const { git, done, unconfined } = await this.gitFor(cwd, offline, operation);
    // The git store stays in view of this tool (gitFor), so what it shows
    // leaves out the paths the jail hides from commands: a protected or
    // local-only file's blob is as readable as the file itself.
    const exclusions = this.jail?.gitExclusions(offline) ?? [];

    try {
      switch (operation) {
        case 'status': {
          // Hidden paths left out here too: an untracked file's name is
          // one a local-only subtask may have chosen.
          const status = await git.status(exclusions.length ? ['--', ...exclusions] : []);
          return this.formatStatus(status);
        }
        case 'diff': {
          this.checkDiffOperands(args, cwd, options);
          // --no-index compares two files, which the jail itself hides when
          // they are hidden; git takes no pathspecs alongside them.
          const scoped = exclusions.length && !args.includes('--no-index')
            ? [...args, ...(args.includes('--') ? [] : ['--']), ...exclusions]
            : args;
          const diff = await git.diff(scoped);
          return diff || '(no changes)';
        }
        case 'log': {
          const log = await git.log(args.length ? { maxCount: parseInt(args[0] ?? '10', 10) } : { maxCount: 10 });
          return log.all.map((c) => `${c.hash.slice(0, 8)} ${c.date.slice(0, 10)} ${c.message}`).join('\n');
        }
        case 'add': {
          refusePathspecFile(operation, args);
          // A hidden file shows to git here as the jail shows it — empty, or
          // a folder with nothing in it — so staging it would record that in
          // place of what it holds. Hidden paths are left out.
          await git.add([...(args.length ? args : ['.']), ...(exclusions.length && !args.includes('--') ? ['--'] : []), ...exclusions]);
          return 'Staged files';
        }
        case 'commit': {
          const msg = args[0] ?? 'Cascade AI commit';
          const result = await git.commit(msg);
          return `Committed: ${result.commit}`;
        }
        case 'branch': {
          const branches = await git.branch(args);
          return branches.all.join('\n');
        }
        case 'checkout': {
          refusePathspecFile(operation, args);
          await git.checkout(args);
          return `Checked out ${args.join(' ')}`;
        }
        case 'push': {
          // The destination is asked what it has by this same jailed git.
          const lsRemote = (target: string) => git.raw(['ls-remote', '--end-of-options', target]).then((out) => out.trim(), () => null);
          const refused = await this.jail?.pushRefusal(cwd, args, offline, lsRemote);
          if (refused) throw new Error(refused);
          await git.push(args);
          return 'Pushed';
        }
        case 'pull': {
          const result = await git.pull();
          return `Pulled: ${result.summary.changes} changes`;
        }
        case 'stash': {
          // A stash records the working tree as this call sees it, hidden
          // files emptied, then resets them: stashing leaves them out, as
          // staging does. Other subcommands take no paths.
          refusePathspecFile(operation, args);
          const pushing = args.length === 0 || args[0] === 'push' || args[0]!.startsWith('-');
          const stashArgs = pushing && exclusions.length
            ? [...(args[0] === 'push' ? args : ['push', ...args]), ...(args.includes('--') ? [] : ['--']), ...exclusions]
            : args;
          await git.stash(stashArgs);
          return 'Stashed';
        }
        default:
          throw new Error(`Unknown git operation: ${operation}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Without a jail, git reads no credential helper or ssh configuration of the user's (git-hermetic.ts).
      const hint = unconfined && (operation === 'push' || operation === 'pull') && /terminal prompts disabled|could not read (username|password)|permission denied \(publickey|authentication failed/i.test(message)
        ? ' Without a process jail, git runs with no credential helper and no ~/.ssh/config: use an ssh key ssh finds by default, or set tools.processJail to "off".'
        : '';
      throw new Error(`git ${operation} failed: ${message}${hint}`);
    } finally {
      await done();
    }
  }

  /**
   * What a diff may read. With --no-index — or on its own, when a path lies
   * outside the work tree or the call is not in a repository — git diff
   * compares any two files, and this tool keeps the home credentials in view
   * for pushing. So every operand that names a file must be one in the
   * workspace that this call could read with file_read; the rest are
   * revisions or pathspecs for git to look up in the repository. --output,
   * which writes the diff to a file of the caller's choosing, is refused.
   */
  private checkDiffOperands(args: string[], cwd: string, options: ToolExecuteOptions): void {
    const mayRead = this.readGate(options);
    let options_ = true;
    for (const arg of args) {
      if (options_ && arg === '--') { options_ = false; continue; }
      if (options_ && arg.startsWith('-')) {
        if (arg === '--output' || arg.startsWith('--output=')) throw new Error('git diff --output is not allowed: it writes a file.');
        continue;
      }
      if (arg === '/dev/null') continue;
      const abs = path.resolve(cwd, arg);
      if (!fs.existsSync(abs)) continue;
      let inWorkspace: string;
      try { inWorkspace = resolveInWorkspace(this.workspaceRoot, abs); } catch {
        throw new Error(`git diff cannot compare ${arg}: it is outside the workspace.`);
      }
      if (this.isProtectedPath(inWorkspace) || !mayRead(inWorkspace)) {
        throw new Error(`git diff cannot compare ${arg}: it is protected.`);
      }
    }
  }

  /**
   * simple-git, launching git in the jail (jail/process-jail.ts). It spawns
   * the binary it is given with git's arguments, so the jail is a short
   * script that execs the jailer with git as its command — simple-git's own
   * guards against unsafe arguments still apply. The script also unsets the
   * variables the jail scrubs: simple-git refuses an environment handed to it
   * that holds EDITOR, PAGER or the like, which most shells set. Windows has
   * no jail and no /bin/sh, so git gets the scrubbed environment directly
   * (gitWithEnv). `done` removes the script, and marks what a local-only
   * caller's git changed local-only (Launch.done).
   */
  private async gitFor(cwd: string, offline: boolean, operation?: string): Promise<{ git: SimpleGit; done: () => Promise<void>; unconfined?: true }> {
    // No hooks, ever: a command could have written one — into .git/hooks, or
    // a husky folder in the workspace — for the next commit here to run with
    // the credentials this tool keeps in view.
    const plain = { git: simpleGit({ baseDir: cwd, config: [NO_HOOKS], unsafe: { allowUnsafeHooksPath: true } }), done: async () => {} };
    if (!this.jail) return plain;
    const hermetic = process.platform !== 'win32' && await this.jail.gitStoreHidden(offline)
      ? await hermeticSettings(cwd)
      : undefined;
    const prepared = await this.jail.prepare('git', ['-c', NO_HOOKS, ...(hermetic?.args ?? [])], { cwd, offline, keepGit: true, confinesItself: true });
    if (!prepared.ok) throw new Error(prepared.reason);
    const { launch } = prepared;
    if (launch.unconfined) return this.unjailedGit(cwd, launch, operation);
    if (process.platform === 'win32') return { git: gitWithEnv(cwd, launch.env, [NO_HOOKS]), done: async () => { await launch.done?.(); } };
    const unset = Object.keys(process.env).filter((name) => !(name in launch.env) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    // Global and system configuration files that were not there when Cascade
    // started are not read: commands cannot change the ones that were (the
    // jail keeps them read-only), but could make one that was not.
    const config = hermetic ? {} : this.configAtStart;
    if (!launch.jail && unset.length === 0 && !hermetic && Object.keys(config).length === 0) return plain;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-git-'));
    const script = path.join(dir, 'git');
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(script, [
      '#!/bin/sh',
      ...(unset.length ? [`unset ${unset.join(' ')}`] : []),
      ...Object.entries({ ...config, ...hermetic?.env }).map(([name, value]) => `export ${name}=${quote(value)}`),
      `exec ${[launch.file, ...launch.args].map(quote).join(' ')} "$@"`,
      '',
    ].join('\n'), { mode: 0o700 });
    const git = simpleGit({ baseDir: cwd, binary: script, unsafe: { allowUnsafeCustomBinary: true } });
    return {
      git,
      done: async () => {
        fs.rmSync(dir, { recursive: true, force: true });
        await launch.done?.();
      },
    };
  }

  /**
   * git where no jail is available: with no configuration that can start a
   * program (git-hermetic.ts), or not at all while the repository's own
   * configuration names one.
   */
  private async unjailedGit(cwd: string, launch: Launch, operation?: string): Promise<{ git: SimpleGit; done: () => Promise<void>; unconfined: true }> {
    const listed = await listGitConfig(cwd, launch.env);
    if (listed === null) {
      throw new Error('No process jail is available, and git could not list its configuration here to run without the settings that start programs (this needs git 2.26 or newer). Set tools.processJail to "off" to run git as it is.');
    }
    const settings = unjailedSettings(listed, launch.env);
    if (!settings.ok) throw new Error(settings.reason);
    if (operation === 'commit' && settings.signsCommits) {
      throw new Error('Your git configuration signs commits, which runs gpg or ssh-keygen, and without a process jail git runs no program: the commit was not made. Commit it yourself, or set tools.processJail to "off".');
    }
    return { git: gitWithEnv(cwd, settings.env, [], true), done: async () => { await launch.done?.(); }, unconfined: true };
  }

  private formatStatus(status: Awaited<ReturnType<SimpleGit['status']>>): string {
    const lines: string[] = [];
    if (status.current) lines.push(`Branch: ${status.current}`);
    if (status.staged.length) lines.push(`Staged: ${status.staged.join(', ')}`);
    if (status.modified.length) lines.push(`Modified: ${status.modified.join(', ')}`);
    if (status.not_added.length) lines.push(`Untracked: ${status.not_added.join(', ')}`);
    if (status.deleted.length) lines.push(`Deleted: ${status.deleted.join(', ')}`);
    if (status.conflicted.length) lines.push(`Conflicts: ${status.conflicted.join(', ')}`);
    return lines.join('\n') || 'Working tree clean';
  }
}

/**
 * How git runs where its store holds what commands may not see. The tool
 * keeps that store in view, and so does every program git starts — a hook,
 * a filter, a pager, an ssh ProxyCommand — with the network there. So git
 * runs only what the repository's own configuration names, which sits in
 * the store the commands cannot reach: no hooks, and none of the global or
 * system git configuration, global attributes or ssh configuration, which
 * a command can rewrite. The name and email in them carry over; they are
 * words, not programs.
 */
async function hermeticSettings(cwd: string): Promise<{ args: string[]; env: Record<string, string> }> {
  const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'core.fsmonitor=false'];
  for (const key of ['user.name', 'user.email']) {
    if (await gitConfigValue(cwd, ['--local', '--get', key])) continue;
    const value = await gitConfigValue(cwd, ['--get', key]);
    if (value) args.push('-c', `${key}=${value}`);
  }
  return {
    args,
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      // Cascade's own environment is not a command's to change; ~/.ssh/config is.
      GIT_SSH_COMMAND: process.env['GIT_SSH_COMMAND'] ?? 'ssh -F /dev/null',
    },
  };
}

/** One `git config` value in `cwd`, or '' when there is none. */
function gitConfigValue(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'config', ...args], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

/**
 * The variables simple-git (3.36) refuses in an environment handed to it,
 * each with the `unsafe` option that lets it through.
 */
const GUARDED_ENV: Record<string, string> = {
  editor: 'allowUnsafeEditor',
  git_askpass: 'allowUnsafeAskPass',
  git_config_global: 'allowUnsafeConfigPaths',
  git_config_system: 'allowUnsafeConfigPaths',
  git_config: 'allowUnsafeConfigPaths',
  git_editor: 'allowUnsafeEditor',
  git_exec_path: 'allowUnsafeConfigPaths',
  git_external_diff: 'allowUnsafeDiffExternal',
  git_pager: 'allowUnsafePager',
  git_proxy_command: 'allowUnsafeGitProxy',
  git_template_dir: 'allowUnsafeTemplateDir',
  git_sequence_editor: 'allowUnsafeEditor',
  git_ssh: 'allowUnsafeSshCommand',
  git_ssh_command: 'allowUnsafeSshCommand',
  pager: 'allowUnsafePager',
  prefix: 'allowUnsafeConfigPaths',
  ssh_askpass: 'allowUnsafeAskPass',
};

/**
 * simple-git running git with `env` as its whole environment — the scrubbed
 * one, where there is no /bin/sh to unset variables in (Windows).
 *
 * simple-git refuses an environment holding settings such as EDITOR or
 * GIT_SSH unless told it may. Those come from the user's own environment,
 * which git reads when Cascade is not involved, so each one present is let
 * through — and only those. Configuration injected through GIT_CONFIG_COUNT
 * is dropped instead: which settings it carries is not checked here.
 */
export function gitWithEnv(cwd: string, env: NodeJS.ProcessEnv, config: string[] = [], checkedEnvConfig = false): SimpleGit {
  const kept: Record<string, string> = {};
  const unsafe: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = name.toLowerCase().trim();
    if (!checkedEnvConfig && /^git_config_(count|key_\d+|value_\d+)$/.test(key)) continue;
    const category = GUARDED_ENV[key];
    if (category) unsafe[category] = true;
    kept[name] = value;
  }
  // What the environment carries was checked (git-hermetic.ts): words, and
  // the settings that turn hooks, fsmonitor and ext:: off.
  const envConfig = checkedEnvConfig
    ? { allowUnsafeConfigEnvCount: true, allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true, allowUnsafeProtocolOverride: true }
    : {};
  return simpleGit({ baseDir: cwd, unsafe: { ...unsafe, ...envConfig, ...(config.length ? { allowUnsafeHooksPath: true } : {}) }, config }).env(kept);
}

// ── Git Context Helper (injected into T1 system prompt) ──

export async function getGitContext(cwd: string): Promise<string> {
  try {
    const git = simpleGit(cwd);
    const [status, log] = await Promise.all([
      git.status(),
      git.log({ maxCount: 5 }),
    ]);

    const statusLines: string[] = [];
    if (status.current) statusLines.push(`Branch: ${status.current}`);
    if (status.staged.length) statusLines.push(`Staged: ${status.staged.join(', ')}`);
    if (status.modified.length) statusLines.push(`Modified: ${status.modified.join(', ')}`);
    if (status.not_added.length) statusLines.push(`Untracked: ${status.not_added.join(', ')}`);

    const recentCommits = log.all
      .map((c) => `  ${c.hash.slice(0, 8)} ${c.message}`)
      .join('\n');

    return `Git status:\n${statusLines.join('\n')}\n\nRecent commits:\n${recentCommits}`;
  } catch {
    return '';
  }
}
