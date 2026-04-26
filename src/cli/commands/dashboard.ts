// ─────────────────────────────────────────────
//  Cascade AI — `cascade dashboard` Command
// ─────────────────────────────────────────────

import chalk from 'chalk';
import ora from 'ora';
import path from 'node:path';
import type { CascadeConfig } from '../../types.js';
import { DashboardServer } from '../../dashboard/server.js';
import { MemoryStore } from '../../memory/store.js';
import { CASCADE_DB_FILE, DEFAULT_DASHBOARD_PORT } from '../../constants.js';

export async function dashboardCommand(
  config: CascadeConfig,
  workspacePath = process.cwd(),
): Promise<void> {
  const port = config.dashboard.port ?? DEFAULT_DASHBOARD_PORT;
  const spin = ora({ text: `Starting dashboard on port ${port}…`, color: 'magenta' }).start();

  const store = new MemoryStore(path.join(workspacePath, CASCADE_DB_FILE));
  const server = new DashboardServer(config, store, workspacePath);
  server.watchRuntimeChanges();

  const gThis = globalThis as typeof globalThis & { cascadeDashboardServer?: DashboardServer };
  gThis.cascadeDashboardServer = server;

  // process.exit() bypasses async finally blocks, so we use the synchronous
  // 'exit' event to guarantee the SQLite store is closed before the process
  // terminates (handles both normal SIGINT and error exits).
  const onExit = () => {
    store.close();
    delete gThis.cascadeDashboardServer;
  };
  process.once('exit', onExit);

  try {
    await server.start();

    spin.succeed(chalk.green(`Dashboard running at http://localhost:${port}`));
    server.refreshRuntime('workspace');
    server.refreshRuntime('global');
    console.log(chalk.gray(`  Press Ctrl+C to stop\n`));

    // Keep alive — the global SIGINT/SIGTERM handlers in cli/index.ts will call
    // process.exit(0), which fires the 'exit' handler above to close the store.
    await new Promise(() => {});
  } catch (err) {
    // Error path: clean up manually before exiting so server is stopped gracefully.
    process.removeListener('exit', onExit);
    await server.stop().catch(() => {});
    onExit();
    spin.fail(chalk.red(`Dashboard failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
