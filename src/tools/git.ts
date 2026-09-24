// ─────────────────────────────────────────────
//  Cascade AI — Git Tool
// ─────────────────────────────────────────────

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
      done();
    }
  }

  /**
   * simple-git, launching git in the jail (jail/process-jail.ts). It spawns
   * the binary it is given with git's arguments, so the jail is a short
   * script that execs the jailer with git as its command — simple-git's own
   * guards against unsafe arguments still apply. The script also unsets the
   * variables the jail scrubs: simple-git refuses an environment handed to it
   * that holds EDITOR, PAGER or the like, which most shells set. Windows has
   * no jail and no /bin/sh, and runs git as it always did. `done` removes
   * the script.
   */
  private async gitFor(cwd: string, offline: boolean): Promise<{ git: SimpleGit; done: () => void }> {
    const plain = { git: simpleGit(cwd), done: () => {} };
    if (!this.jail) return plain;
    const prepared = await this.jail.prepare('git', [], { cwd, offline, keepGit: true });
    if (!prepared.ok) throw new Error(prepared.reason);
    if (process.platform === 'win32') return plain;
    const { launch } = prepared;
    const unset = Object.keys(process.env).filter((name) => !(name in launch.env) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    if (!launch.jail && unset.length === 0) return plain;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-git-'));
    const script = path.join(dir, 'git');
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(script, [
      '#!/bin/sh',
      ...(unset.length ? [`unset ${unset.join(' ')}`] : []),
      `exec ${[launch.file, ...launch.args].map(quote).join(' ')} "$@"`,
      '',
    ].join('\n'), { mode: 0o700 });
    const git = simpleGit({ baseDir: cwd, binary: script, unsafe: { allowUnsafeCustomBinary: true } });
    return { git, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
