// ─────────────────────────────────────────────
//  Cascade AI — `cascade init` Command
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { createDefaultCascadeMd } from '../../config/cascade-md.js';
import { createDefaultIgnoreFile } from '../../config/ignore.js';
import { CascadeConfigSchema } from '../../config/schema.js';
import { CASCADE_CONFIG_FILE } from '../../constants.js';

export async function initCommand(workspacePath = process.cwd()): Promise<void> {
  const spin = ora({ text: 'Initializing Cascade project…', color: 'magenta' }).start();

  try {
    const configDir = path.join(workspacePath, '.cascade');
    await fs.mkdir(configDir, { recursive: true });

    // Write default config
    const configPath = path.join(workspacePath, CASCADE_CONFIG_FILE);
    if (!(await fileExists(configPath))) {
      const defaultConfig = CascadeConfigSchema.parse({});
      await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
      spin.succeed(chalk.green('Created .cascade/config.json'));
    } else {
      spin.warn(chalk.yellow('.cascade/config.json already exists — skipping'));
    }

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
    console.log(chalk.magenta('  ◈ Cascade initialized successfully!'));
    console.log();
    console.log(chalk.gray('  Next steps:'));
    console.log(chalk.gray('  1. Edit CASCADE.md with project-specific instructions'));
    console.log(chalk.gray('  2. Add API keys: cascade config set anthropic_key <key>'));
    console.log(chalk.gray('  3. Run: cascade'));
    console.log();
  } catch (err) {
    spin.fail(chalk.red(`Init failed: ${err instanceof Error ? err.message : String(err)}`));
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
