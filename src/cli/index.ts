// ─────────────────────────────────────────────
//  Cascade AI — CLI Entry Point
// ─────────────────────────────────────────────

import { render } from 'ink';
import { Command } from 'commander';
import React from 'react';
import chalk from 'chalk';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASCADE_VERSION, DEFAULT_THEME } from '../constants.js';
import { ConfigManager } from '../config/index.js';
import { Repl } from './repl/index.js';
import { Cascade } from '../core/cascade.js';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { updateCommand } from './commands/update.js';
import { dashboardCommand } from './commands/dashboard.js';
import { makeIdentityCommand } from './commands/identity.js';
import { modelsCommand } from './commands/models.js';
import { exportCommand } from './commands/export.js';
import { linkCommand } from './commands/link.js';
import { telemetryCommand } from './commands/telemetry.js';
import { runSetupWizard } from './setup/index.js';
import { McpClient } from '../mcp/client.js';

dotenv.config();

// ── Stale-build detection ─────────────────────────────────────────────
// CASCADE_VERSION is a literal baked into the bundle at build time. When
// running from a repo checkout whose package.json has since moved on
// (pull without rebuild), the compiled dist/ silently runs old code —
// warn instead of letting users chase bugs that are already fixed.
function warnIfBuildIsStale(): void {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of ['..', '../..']) {
      const pkgPath = path.join(here, rel, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
      if (pkg.name !== 'cascade-ai') continue;
      if (pkg.version && pkg.version !== CASCADE_VERSION) {
        console.error(
          chalk.yellow(
            `⚠ Stale build: compiled output is v${CASCADE_VERSION} but the source tree is v${pkg.version}.\n` +
            `  Run: npm install && npm run build`,
          ),
        );
      }
      return;
    }
  } catch {
    // Never block startup over a version probe.
  }
}
warnIfBuildIsStale();

// ── Alternate screen buffer (--alt-screen) ───────────────────────────
// Entered before Ink renders; ALWAYS left again on exit — including
// SIGINT/SIGTERM and crashes — so the user's shell is never left inside
// the alt screen with an invisible prompt.
let altScreenActive = false;
function enterAltScreen(): void {
  if (altScreenActive || !process.stdout.isTTY) return;
  process.stdout.write('\x1b[?1049h\x1b[H');
  altScreenActive = true;
}
function leaveAltScreen(): void {
  if (!altScreenActive) return;
  process.stdout.write('\x1b[?1049l');
  altScreenActive = false;
}

// Global cleanup handlers to prevent zombie MCP processes
process.on('exit', () => {
  leaveAltScreen();
  McpClient.killAllProcesses();
});
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
  .option('--alt-screen', 'Render in the alternate screen buffer (vim-style; flicker-proof, no native scrollback)')
  .option('--no-color', 'Disable colors')
  .action(async (options) => {
    if (options.prompt) {
      await runHeadless(options.prompt, options);
    } else {
      await startRepl(options);
    }
  });

// Parse --workspace early so the identity subcommand can use the correct path.
// Commander doesn't run the main action before subcommands, so we resolve the
// workspace from argv directly rather than relying on action callbacks.
const workspaceArgIdx = process.argv.findIndex((a) => a === '-w' || a === '--workspace');
const earlyWorkspace =
  workspaceArgIdx !== -1 ? process.argv[workspaceArgIdx + 1] : process.cwd();
program.addCommand(makeIdentityCommand(earlyWorkspace));

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
  .command('link [provider]')
  .description('Reuse credentials from other AI CLIs (Claude Code, Codex, Gemini CLI, Copilot)')
  .option('--accept-risk', 'Adopt a subscription OAuth token despite the ToS warning')
  .action(async (provider: string | undefined, opts: { acceptRisk?: boolean }) => {
    await linkCommand(provider, { acceptRisk: opts.acceptRisk, workspace: process.cwd() });
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
    await runHeadless(prompt, { theme: opts.theme, workspace: process.cwd(), identity: opts.identity });
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
  altScreen?: boolean;
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

  const useAltScreen = Boolean(options.altScreen ?? config.altScreen) && process.stdout.isTTY;

  if (useAltScreen) {
    // Alt screen starts blank and isolated; the exit handler restores the
    // user's original screen even on crashes.
    enterAltScreen();
  } else if (process.stdout.isTTY) {
    // Clear the screen before handing control to Ink.
    // Use the safe two-part sequence (erase + cursor-home) rather than the
    // destructive full reset (\x1bc) which wipes the terminal state and causes
    // Ink to render a blank screen until the next keypress / state change.
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
      altScreen: useAltScreen,
    }),
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
  leaveAltScreen();
  process.exit(0);
}

// ── Headless single-prompt execution (cascade run / -p) ────────
//
// Bypasses the Ink Repl so the command works in non-TTY contexts
// (CI, pipes, scripts). Progress goes to stderr; the final answer
// goes to stdout so `cascade run "..." | jq ...` works cleanly.

async function runHeadless(prompt: string, options: {
  theme?: string;
  workspace?: string;
  identity?: string;
}): Promise<void> {
  const workspacePath = options.workspace ?? process.cwd();

  const cm = new ConfigManager(workspacePath);
  try {
    await cm.load();
  } catch (err) {
    console.error(chalk.red(`Config error: ${err instanceof Error ? err.message : String(err)}`));
    console.error(chalk.gray('Run `cascade init` to set up this directory.'));
    process.exit(1);
  }
  const config = cm.getConfig();

  const needsSetup =
    !config.providers?.length ||
    config.providers.every((p: { type: string; apiKey?: string }) => p.type !== 'ollama' && !p.apiKey);
  if (needsSetup) {
    console.error(chalk.red('No providers configured. Run `cascade init` first.'));
    process.exit(1);
  }

  const cascade = new Cascade(config, workspacePath);
  try {
    await cascade.init();
  } catch (err) {
    console.error(chalk.red(`Initialization failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  console.error(chalk.gray('  ◈ Running headlessly — tool approvals are auto-granted.'));

  // Dedup consecutive identical status lines to keep stderr tidy.
  let lastProgress = '';
  cascade.on('tier:status', (ev: { role?: string; currentAction?: string }) => {
    const action = ev?.currentAction?.trim();
    if (!action) return;
    const line = `  · ${ev.role ?? ''} ${action}`.trimEnd();
    if (line === lastProgress) return;
    lastProgress = line;
    console.error(chalk.gray(line));
  });

  try {
    const result = await cascade.run({
      prompt,
      workspacePath,
      identityId: options.identity,
      approvalCallback: async () => ({ approved: true, always: true }),
    });
    process.stdout.write(result.output.trimEnd() + '\n');
  } catch (err) {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    await cascade.close().catch(() => { /* ignore */ });
    process.exit(1);
  }

  await cascade.close().catch(() => { /* ignore */ });
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
