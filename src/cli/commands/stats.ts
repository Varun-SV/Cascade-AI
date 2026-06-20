// ─────────────────────────────────────────────
//  Cascade AI — `cascade stats` Command
// ─────────────────────────────────────────────

import chalk from 'chalk';
import { ModelPerformanceTracker } from '../../core/router/model-performance-tracker.js';

const TASK_TYPES = ['code', 'analysis', 'creative', 'data', 'mixed'] as const;

export async function statsCommand(): Promise<void> {
  const tracker = new ModelPerformanceTracker();
  await tracker.load();

  const all = tracker.getAll();
  if (all.size === 0) {
    console.log(chalk.dim('\n  No routing history yet — run some tasks first.\n'));
    return;
  }

  console.log(chalk.magenta('\n  ◈ Auto-Routing History\n'));
  console.log(chalk.dim('  Per-task-type model performance learned from past runs.\n'));

  for (const taskType of TASK_TYPES) {
    // Gather all entries for this task type
    const entries: Array<{ modelId: string; successRate: number; samples: number; avgCostUsd: number }> = [];
    for (const [key, stat] of all) {
      if (!key.endsWith(`:${taskType}`)) continue;
      const modelId = key.slice(0, -(taskType.length + 1));
      const successRate = stat.sampleCount > 0 ? stat.successCount / stat.sampleCount : 0;
      const avgCostUsd = stat.sampleCount > 0 ? stat.totalCostUsd / stat.sampleCount : 0;
      entries.push({ modelId, successRate, samples: stat.sampleCount, avgCostUsd });
    }
    if (entries.length === 0) continue;

    entries.sort((a, b) => b.successRate - a.successRate || b.samples - a.samples);

    console.log(chalk.bold(`  ${taskType.toUpperCase()}`));
    const header = `  ${'Model'.padEnd(36)} ${'Success'.padEnd(9)} ${'Samples'.padEnd(9)} Avg cost`;
    console.log(chalk.dim(header));
    console.log(chalk.dim('  ' + '─'.repeat(62)));

    for (const e of entries) {
      const pct = `${Math.round(e.successRate * 100)}%`;
      const cost = e.avgCostUsd < 0.0001 ? '<$0.0001' : `$${e.avgCostUsd.toFixed(4)}`;
      const color = e.successRate >= 0.8 ? chalk.green : e.successRate >= 0.5 ? chalk.yellow : chalk.red;
      console.log(
        `  ${e.modelId.padEnd(36)} ${color(pct.padEnd(9))} ${String(e.samples).padEnd(9)} ${chalk.dim(cost)}`,
      );
    }
    console.log();
  }

  console.log(chalk.dim('  tip: use /rate good | bad after a task to improve these scores.\n'));
}
