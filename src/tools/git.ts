// ─────────────────────────────────────────────
//  Cascade AI — Git Tool
// ─────────────────────────────────────────────

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

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const operation = input['operation'] as string;
    const args = (input['args'] as string[] | undefined) ?? [];
    const cwd = (input['cwd'] as string | undefined) ?? this.workspaceRoot;

    const git: SimpleGit = simpleGit(cwd);

    try {
      switch (operation) {
        case 'status': {
          const status = await git.status();
          return this.formatStatus(status);
        }
        case 'diff': {
          const diff = await git.diff(args);
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
    }
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
