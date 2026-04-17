// ─────────────────────────────────────────────
//  Cascade AI — `cascade telemetry on|off` Command
// ─────────────────────────────────────────────

import chalk from 'chalk';
import { ConfigManager } from '../../config/index.js';

type TelemetryAction = 'on' | 'off' | 'status';

export async function telemetryCommand(action: TelemetryAction): Promise<void> {
  const cm = new ConfigManager(process.cwd());
  await cm.load();
  const config = cm.getConfig();

  if (action === 'status') {
    const state = config.telemetry?.enabled ? 'ON' : 'OFF';
    console.log();
    console.log(chalk.magenta('  ◈ Cascade Telemetry'));
    console.log();
    console.log(`  Status: ${config.telemetry?.enabled ? chalk.green(state) : chalk.gray(state)}`);
    console.log(chalk.gray('  Scope:  anonymous session metadata only (no prompts/outputs)'));
    console.log();
    console.log(chalk.gray('  Toggle with:  cascade telemetry on   |   cascade telemetry off'));
    console.log();
    return;
  }

  const enabled = action === 'on';
  await cm.updateConfig({
    ...config,
    telemetry: {
      ...config.telemetry,
      enabled,
    },
  });

  console.log();
  if (enabled) {
    console.log(chalk.green(`  ✓ Telemetry enabled.`));
    console.log(chalk.gray('    Anonymous session metadata (no prompts, no outputs) will be sent.'));
  } else {
    console.log(chalk.yellow(`  ✓ Telemetry disabled.`));
    console.log(chalk.gray('    No events will be transmitted from this workspace.'));
  }
  console.log();
}
