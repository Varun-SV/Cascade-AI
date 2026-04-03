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
  const server = new DashboardServer(config, store);

  try {
    await server.start();

    spin.succeed(chalk.green(`Dashboard running at http://localhost:${port}`));
    console.log(chalk.gray(`  Press Ctrl+C to stop\n`));

    process.on('SIGINT', async () => {
      await server.stop();
      process.exit(0);
    });

    // Keep alive
    await new Promise(() => {});
  } catch (err) {
    await server.stop().catch(() => {});
    store.close();
    spin.fail(chalk.red(`Dashboard failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
