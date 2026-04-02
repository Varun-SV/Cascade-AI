// ─────────────────────────────────────────────
//  Cascade AI — `cascade update` Command
// ─────────────────────────────────────────────

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import ora from 'ora';
import chalk from 'chalk';
import { CASCADE_VERSION } from '../../constants.js';

const execAsync = promisify(exec);

export async function updateCommand(): Promise<void> {
  const spin = ora({ text: 'Checking for updates…', color: 'magenta' }).start();

  try {
    const { stdout } = await execAsync('npm show cascade-ai version', { timeout: 10_000 });
    const latest = stdout.trim();

    if (latest === CASCADE_VERSION) {
      spin.succeed(chalk.green(`Already up to date (v${CASCADE_VERSION})`));
      return;
    }

    spin.text = `Updating cascade-ai ${CASCADE_VERSION} → ${latest}…`;
    await execAsync('npm install -g cascade-ai@latest', { timeout: 60_000 });
    spin.succeed(chalk.green(`Updated to v${latest}! Restart your terminal.`));
  } catch (err) {
    spin.fail(chalk.red(`Update failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}
