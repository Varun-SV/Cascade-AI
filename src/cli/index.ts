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
import { makeIdentityCommand } from './commands/identity.js';
import { modelsCommand } from './commands/models.js';
import { exportCommand } from './commands/export.js';
import { telemetryCommand } from './commands/telemetry.js';
import { runSetupWizard } from './setup/index.js';
import { McpClient } from '../mcp/client.js';

dotenv.config();

// Global cleanup handlers to prevent zombie MCP processes
process.on('exit', () => McpClient.killAllProcesses());
process.on('SIGINT', () => {
  McpClient.killAllProcesses();
  process.exit(0);
});
process.on('SIGTERM', () => {
  McpClient.killAllProcesses();
  process.exit(0);
});

const program = new Command();

program
  .name('cascade')
  .description('Multi-tier AI orchestration CLI')
  .version(CASCADE_VERSION, '-v, --version')
  .option('-p, --prompt <text>', 'Run a single prompt non-interactively')
  .option('-t, --theme <name>', 'Color theme', DEFAULT_THEME)
  .option('-w, --workspace <path>', 'Workspace path', process.cwd())
  .option('-i, --identity <name>', 'Identity name or ID')
  .option('--no-color', 'Disable colors')
  .action(async (options) => {
    await startRepl(options);
  });

program.addCommand(makeIdentityCommand());

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
  .option('-i, --identity <name>', 'Identity name or ID')
  .action(async (prompt: string, opts) => {
    await startRepl({ prompt, theme: opts.theme, workspace: process.cwd(), identity: opts.identity });
  });

program
  .command('models')
  .description('List available AI models for each tier')
  .option('-v, --verbose', 'Show all models per provider with pricing')
  .action(async (opts) => {
    await modelsCommand({ verbose: opts.verbose });
  });

program
  .command('telemetry [action]')
  .description('Toggle anonymous usage telemetry (on | off | status). Default: status')
  .action(async (action?: string) => {
    const normalized = (action ?? 'status').toLowerCase();
    if (normalized !== 'on' && normalized !== 'off' && normalized !== 'status') {
      console.error(chalk.red(`Unknown action: ${action}. Use: on | off | status`));
      process.exit(1);
    }
    await telemetryCommand(normalized);
  });

program
  .command('export')
  .description('Export a session conversation to Markdown or JSON')
  .option('-s, --session <id>', 'Session ID to export (default: most recent)')
  .option('-f, --format <format>', 'Output format: markdown | json', 'markdown')
  .option('-o, --output <path>', 'Output file path')
  .action(async (opts) => {
    await exportCommand({
      sessionId: opts.session,
      format: opts.format as 'markdown' | 'json',
      output: opts.output,
    });
  });

// ── Start REPL ────────────────────────────────

async function startRepl(options: {
  prompt?: string;
  theme?: string;
  workspace?: string;
  identity?: string;
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

  let config = cm.getConfig();

  // First-run detection: no providers configured → launch setup wizard
  const needsSetup =
    !config.providers?.length ||
    config.providers.every((p: { type: string; apiKey?: string }) => p.type !== 'ollama' && !p.apiKey);

  if (needsSetup) {
    console.log(chalk.magenta('  ◈ No providers configured — launching setup wizard…'));
    console.log();
    config = await runSetupWizard(workspacePath);
    await cm.updateConfig(config);
    // Reload to pick up persisted defaults
    await cm.load();
    config = cm.getConfig();
  }

  // Clear the screen before handing control to Ink.
  // Use the safe two-part sequence (erase + cursor-home) rather than the
  // destructive full reset (\x1bc) which wipes the terminal state and causes
  // Ink to render a blank screen until the next keypress / state change.
  if (process.stdout.isTTY) {
    process.stdout.write('\x1B[2J\x1B[H');
  }

  // Render ink REPL
  const { waitUntilExit } = render(
    React.createElement(Repl, {
      config,
      workspacePath,
      themeName: options.theme ?? config.theme ?? DEFAULT_THEME,
      initialPrompt: options.prompt,
      identityName: options.identity,
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
