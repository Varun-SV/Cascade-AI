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

export class GitTool extends BaseTool {
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
    const cwd = (input['cwd'] as string | undefined) ?? this.workspaceRoot;

    const offline = options.isOffline?.() === true;
    const { git, done } = await this.gitFor(cwd, offline);
    // The git store stays in view of this tool (gitFor), so what it shows
    // leaves out the paths the jail hides from commands: a protected or
    // local-only file's blob is as readable as the file itself.
    const exclusions = this.jail?.gitExclusions(offline) ?? [];

    try {
      switch (operation) {
        case 'status': {
          const status = await git.status();
          return this.formatStatus(status);
        }
        case 'diff': {
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
          await git.add(args.length ? args : ['.']);
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
          await git.checkout(args);
          return `Checked out ${args.join(' ')}`;
        }
        case 'push': {
          const refused = await this.jail?.pushRefusal(cwd, args, offline);
          if (refused) throw new Error(refused);
          await git.push(args);
          return 'Pushed';
        }
        case 'pull': {
          const result = await git.pull();
          return `Pulled: ${result.summary.changes} changes`;
        }
        case 'stash': {
          await git.stash(args);
          return 'Stashed';
        }
        default:
          throw new Error(`Unknown git operation: ${operation}`);
      }
    } catch (err) {
      throw new Error(`git ${operation} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await done();
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
  private async gitFor(cwd: string, offline: boolean): Promise<{ git: SimpleGit; done: () => Promise<void> }> {
    const plain = { git: simpleGit(cwd), done: async () => {} };
    if (!this.jail) return plain;
    const hermetic = process.platform !== 'win32' && await this.jail.gitStoreHidden(offline)
      ? await hermeticSettings(cwd)
      : undefined;
    const prepared = await this.jail.prepare('git', hermetic?.args ?? [], { cwd, offline, keepGit: true });
    if (!prepared.ok) throw new Error(prepared.reason);
    const { launch } = prepared;
    if (process.platform === 'win32') return { git: gitWithEnv(cwd, launch.env), done: async () => { await launch.done?.(); } };
    const unset = Object.keys(process.env).filter((name) => !(name in launch.env) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    if (!launch.jail && unset.length === 0 && !hermetic) return plain;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-git-'));
    const script = path.join(dir, 'git');
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(script, [
      '#!/bin/sh',
      ...(unset.length ? [`unset ${unset.join(' ')}`] : []),
      ...Object.entries(hermetic?.env ?? {}).map(([name, value]) => `export ${name}=${quote(value)}`),
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
export function gitWithEnv(cwd: string, env: NodeJS.ProcessEnv): SimpleGit {
  const kept: Record<string, string> = {};
  const unsafe: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = name.toLowerCase().trim();
    if (/^git_config_(count|key_\d+|value_\d+)$/.test(key)) continue;
    const category = GUARDED_ENV[key];
    if (category) unsafe[category] = true;
    kept[name] = value;
  }
  return simpleGit({ baseDir: cwd, unsafe }).env(kept);
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
