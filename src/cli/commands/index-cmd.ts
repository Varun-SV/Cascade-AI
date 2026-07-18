// ─────────────────────────────────────────────
//  Cascade AI — `cascade index` Command
// ─────────────────────────────────────────────
//
// Builds or refreshes the workspace code index that powers the `code_search`
// tool. Incremental: only files whose contents changed since the last run are
// re-embedded.

import chalk from 'chalk';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { ConfigManager } from '../../config/index.js';
import { CascadeIgnore } from '../../config/ignore.js';
import { WorkspaceIndex } from '../../retrieval/workspace-index.js';
import { embedderFromProviders } from '../../retrieval/embedder.js';
import { LLMReranker, chatCompleterFromProviders } from '../../retrieval/rerank.js';

export async function indexCommand(dirPath?: string): Promise<void> {
  const workspace = path.resolve(dirPath || process.cwd());
  const cm = new ConfigManager(workspace);
  await cm.load();
  const config = cm.getConfig();

  const embedder = embedderFromProviders(config.providers);
  if (!embedder) {
    console.log(chalk.red('\n  No embeddings-capable provider configured.'));
    console.log(chalk.dim('  Add an OpenAI, OpenAI-compatible, or Ollama key, then re-run `cascade index`.\n'));
    process.exitCode = 1;
    return;
  }

  const dbPath = config.codeIndex?.dbPath || path.join(workspace, '.cascade', 'code-index.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const complete = chatCompleterFromProviders(config.providers);
  const reranker = complete ? new LLMReranker({ complete }) : undefined;

  const ignore = new CascadeIgnore();
  await ignore.load(workspace);

  const index = new WorkspaceIndex({
    root: workspace,
    db,
    embedder,
    reranker,
    isIgnored: (abs) => ignore.isIgnored(abs, workspace),
  });

  console.log(chalk.magenta(`\n  ◈ Indexing ${workspace}\n`));
  let seen = 0;
  const res = await index.refresh(() => {
    seen++;
    if (seen % 10 === 0) process.stdout.write(chalk.dim(`  …embedded ${seen} changed files\r`));
  });

  console.log(
    chalk.green(`  ✓ ${res.filesIndexed} file(s) indexed`) +
      chalk.dim(` · ${res.chunks} chunks · ${res.filesUnchanged} unchanged · ${res.filesRemoved} removed`),
  );
  console.log(chalk.dim(`  Index: ${dbPath}`));
  if (!config.codeIndex?.enabled) {
    console.log(chalk.dim('  Tip: set codeIndex.enabled = true in your config to give runs the code_search tool.'));
  }
  console.log('');
  db.close();
}
