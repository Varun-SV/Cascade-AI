// ─────────────────────────────────────────────
//  Cascade AI — CLI Entry Point
// ─────────────────────────────────────────────

import { render } from 'ink';
import { Command } from 'commander';
import React from 'react';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { CASCADE_VERSION, DEFAULT_THEME } from '../constants.js';
import { ConfigManager } from '../config/index.js';
import { Repl } from './repl/index.js';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { updateCommand } from './commands/update.js';
import { dashboardCommand } from './commands/dashboard.js';

dotenv.config();

const program = new Command();

program
  .name('cascade')
  .description('Multi-tier AI orchestration CLI')
  .version(CASCADE_VERSION, '-v, --version')
  .option('-p, --prompt <text>', 'Run a single prompt non-interactively')
  .option('-t, --theme <name>', 'Color theme', DEFAULT_THEME)
  .option('-w, --workspace <path>', 'Workspace path', process.cwd())
  .option('--no-color', 'Disable colors')
  .action(async (options) => {
    await startRepl(options);
  });

program
  .command('init [path]')
  .description('Initialize Cascade in a project directory')
  .action(async (dirPath?: string) => {
    await initCommand(dirPath ?? process.cwd());
  });

program
  .command('doctor')
  .description('Check system configuration and API key availability')
  .action(async () => {
    await doctorCommand();
  });

program
  .command('update')
  .description('Update Cascade to the latest version')
  .action(async () => {
    await updateCommand();
  });

program
  .command('dashboard')
  .description('Launch the web dashboard')
  .option('-p, --port <number>', 'Port number', '4891')
  .action(async (opts) => {
    const cm = new ConfigManager(process.cwd());
    await cm.load();
    const config = cm.getConfig();
    config.dashboard.port = parseInt(opts.port, 10);
    await dashboardCommand(config, process.cwd());
  });

program
  .command('run <prompt>')
  .description('Run a single prompt and exit')
  .option('-t, --theme <name>', 'Color theme', DEFAULT_THEME)
  .action(async (prompt: string, opts) => {
    await startRepl({ prompt, theme: opts.theme, workspace: process.cwd() });
  });

// ── Start REPL ────────────────────────────────

async function startRepl(options: {
  prompt?: string;
  theme?: string;
  workspace?: string;
}): Promise<void> {
  const workspacePath = options.workspace ?? process.cwd();

  // Print banner
  printBanner();

  // Load config
  const cm = new ConfigManager(workspacePath);
  try {
    await cm.load();
  } catch (err) {
    console.error(chalk.red(`Config error: ${err instanceof Error ? err.message : String(err)}`));
    console.error(chalk.gray('Run `cascade init` to set up this directory.'));
    process.exit(1);
  }

  const config = cm.getConfig();

  // Render ink REPL
  const { waitUntilExit } = render(
    React.createElement(Repl, {
      config,
      workspacePath,
      themeName: options.theme ?? config.theme ?? DEFAULT_THEME,
      initialPrompt: options.prompt,
    }),
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
  process.exit(0);
}

function printBanner(): void {
  if (process.stdout.columns < 60) return;
  console.log();
  console.log(chalk.hex('#7C6AF7').bold('  ╔═══════════════════════════════╗'));
  console.log(chalk.hex('#7C6AF7').bold('  ║') + chalk.white.bold('  ◈ CASCADE AI') + chalk.gray(' v' + CASCADE_VERSION + '         ') + chalk.hex('#7C6AF7').bold('║'));
  console.log(chalk.hex('#7C6AF7').bold('  ║') + chalk.gray('  Multi-Tier Orchestration      ') + chalk.hex('#7C6AF7').bold('║'));
  console.log(chalk.hex('#7C6AF7').bold('  ╚═══════════════════════════════╝'));
  console.log();
}

program.parse(process.argv);
