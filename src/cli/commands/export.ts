// ─────────────────────────────────────────────
//  Cascade AI — `cascade export` Command
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { MemoryStore } from '../../memory/store.js';
import { GLOBAL_CONFIG_DIR, GLOBAL_DB_FILE, CASCADE_DB_FILE } from '../../constants.js';
import type { Session, StoredMessage } from '../../types.js';

export interface ExportOptions {
  sessionId?: string;
  format?: 'markdown' | 'json';
  output?: string;
  last?: number;
  /** Override workspace path (defaults to cwd). */
  workspacePath?: string;
}

export async function exportCommand(options: ExportOptions = {}): Promise<void> {
  const format = options.format ?? 'markdown';
  const spin = ora({ text: 'Loading sessions…', color: 'magenta' }).start();

  let store: MemoryStore;
  try {
    // Prefer the workspace DB where sessions are actually stored (.cascade/memory.db).
    // Fall back to the global DB only if the workspace DB doesn't exist.
    const workspacePath = options.workspacePath ?? process.cwd();
    const workspaceDbPath = path.join(workspacePath, CASCADE_DB_FILE);
    const globalDbPath = path.join(os.homedir(), GLOBAL_CONFIG_DIR, GLOBAL_DB_FILE);

    // Check if file exists synchronously to pick the right DB
    let dbPath = globalDbPath;
    try {
      await fs.access(workspaceDbPath);
      dbPath = workspaceDbPath;
    } catch {
      // Workspace DB doesn't exist, fall back to global
    }

    store = new MemoryStore(dbPath);
  } catch (err) {
    spin.fail(chalk.red(`Cannot open memory store: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  try {
    let sessions: Session[];

    if (options.sessionId) {
      const session = store.getSession(options.sessionId);
      if (!session) {
        spin.fail(chalk.red(`Session "${options.sessionId}" not found.`));
        process.exit(1);
      }
      sessions = [session];
    } else {
      const limit = options.last ?? 10;
      sessions = store.listSessions(undefined, limit);
      if (sessions.length === 0) {
        spin.warn(chalk.yellow('No sessions found.'));
        return;
      }

      // No specific session requested — load the most recent one in full.
      const latest = sessions[0]!;
      const full = store.getSession(latest.id);
      sessions = full ? [full] : [];
      if (sessions.length === 0) {
        spin.fail(chalk.red('Could not load latest session.'));
        process.exit(1);
      }
    }

    const session = sessions[0]!;
    spin.text = `Exporting session "${session.title}"…`;

    const content = format === 'json'
      ? buildJsonExport(session)
      : buildMarkdownExport(session);

    const ext = format === 'json' ? '.json' : '.md';
    const safeName = session.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 60);
    const defaultFile = `cascade-export-${safeName}${ext}`;
    const outPath = options.output
      ? path.resolve(options.output)
      : path.join(process.cwd(), defaultFile);

    await fs.writeFile(outPath, content, 'utf-8');
    spin.succeed(chalk.green(`Exported to ${chalk.white(outPath)}`));

    // Print summary
    const messageCount = Array.isArray(session.messages) ? session.messages.length : 0;
    console.log();
    console.log(chalk.gray(`  Session:  ${session.title}`));
    console.log(chalk.gray(`  Messages: ${messageCount}`));
    console.log(chalk.gray(`  Format:   ${format}`));
    console.log();
  } catch (err) {
    spin.fail(chalk.red(`Export failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

// ── Formatters ────────────────────────────────

function buildMarkdownExport(session: Session): string {
  const lines: string[] = [];

  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`> **Session ID:** \`${session.id}\`  `);
  lines.push(`> **Created:** ${new Date(session.createdAt).toLocaleString()}  `);
  lines.push(`> **Updated:** ${new Date(session.updatedAt).toLocaleString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  const messages: StoredMessage[] = Array.isArray(session.messages) ? session.messages : [];

  for (const msg of messages) {
    const role = msg.role;
    if (!msg.content.trim()) continue;

    if (role === 'user') {
      lines.push(`## 👤 User`);
    } else if (role === 'assistant') {
      lines.push(`## 🤖 Assistant`);
    } else if (role === 'system') {
      lines.push(`## ⚙️ System`);
    } else {
      lines.push(`## 🔧 Tool`);
    }

    lines.push('');
    lines.push(msg.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildJsonExport(session: Session): string {
  const messages: StoredMessage[] = Array.isArray(session.messages) ? session.messages : [];
  const payload = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    workspacePath: session.workspacePath,
    messageCount: messages.length,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      tokens: m.tokens,
    })),
  };
  return JSON.stringify(payload, null, 2);
}
