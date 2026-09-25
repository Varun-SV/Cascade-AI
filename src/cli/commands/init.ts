// ─────────────────────────────────────────────
//  Cascade AI — `cascade init` Command
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { createDefaultCascadeMd } from '../../config/cascade-md.js';
import { createDefaultIgnoreFile } from '../../config/ignore.js';
import { ConfigManager } from '../../config/index.js';
import { projectStateDir, statePath, STATE } from '../../config/project-state.js';
import { runSetupWizard } from '../setup/index.js';

export async function initCommand(workspacePath = process.cwd()): Promise<void> {
  const spin = ora({ text: 'Initializing Cascade project…', color: 'magenta' }).start();

  try {
    // Cascade's own files go in the project's state folder, outside it.
    await fs.mkdir(projectStateDir(workspacePath), { recursive: true });

    // Write CASCADE.md
    const mdPath = path.join(workspacePath, 'CASCADE.md');
    if (!(await fileExists(mdPath))) {
      await createDefaultCascadeMd(workspacePath);
      spin.succeed(chalk.green('Created CASCADE.md'));
    }

    // Write .cascadeignore
    const ignorePath = path.join(workspacePath, '.cascadeignore');
    if (!(await fileExists(ignorePath))) {
      await createDefaultIgnoreFile(workspacePath);
      spin.succeed(chalk.green('Created .cascadeignore'));
    }

    spin.stop();
    console.log();
    console.log(chalk.magenta('  ◈ Cascade AI — Project initialized'));
    console.log();

    // Launch interactive setup wizard to configure providers and models
    const configPath = statePath(workspacePath, STATE.config);
    if (await fileExists(configPath)) {
      console.log(chalk.yellow(`  ${configPath} already exists — launching wizard to reconfigure.`));
      console.log();
    }

    const config = await runSetupWizard(workspacePath);

    // Persist config via ConfigManager so all schema defaults are applied
    const cm = new ConfigManager(workspacePath);
    await cm.load();
    await cm.updateConfig(config);

    console.log();
    console.log(chalk.green('  ◈ Setup complete! Run `cascade` to start.'));
    console.log();
  } catch (err) {
    console.error(chalk.red(`Init failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
