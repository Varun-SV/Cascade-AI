// ─────────────────────────────────────────────
//  Cascade AI — `cascade dashboard` Command
// ─────────────────────────────────────────────

import chalk from 'chalk';
import ora from 'ora';
import type { CascadeConfig } from '../../types.js';
import { DashboardServer } from '../../dashboard/server.js';
import { MemoryStore } from '../../memory/store.js';
import { CASCADE_DB_FILE, DEFAULT_DASHBOARD_PORT } from '../../constants.js';
import path from 'node:path';

export async function dashboardCommand(
  config: CascadeConfig,
  workspacePath = process.cwd(),
): Promise<void> {
  const port = config.dashboard.port ?? DEFAULT_DASHBOARD_PORT;
  const spin = ora({ text: `Starting dashboard on port ${port}…`, color: 'magenta' }).start();

  try {
    const store = new MemoryStore(path.join(workspacePath, CASCADE_DB_FILE));
    const server = new DashboardServer(config, store);
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
    spin.fail(chalk.red(`Dashboard failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
