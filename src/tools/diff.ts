// ─────────────────────────────────────────────
//  Cascade AI — Diff Viewer Tool
// ─────────────────────────────────────────────

import { createPatch, type ParsedDiff } from 'diff';
import chalk from 'chalk';

export function generateDiff(oldContent: string, newContent: string, filename = 'file'): string {
  return createPatch(filename, oldContent, newContent);
}

export function renderDiff(patch: string): string {
  const lines = patch.split('\n');
  const rendered: string[] = [];

  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      rendered.push(chalk.bold(line));
    } else if (line.startsWith('@@')) {
      rendered.push(chalk.cyan(line));
    } else if (line.startsWith('+')) {
      rendered.push(chalk.green(line));
    } else if (line.startsWith('-')) {
      rendered.push(chalk.red(line));
    } else {
      rendered.push(chalk.gray(line));
    }
  }

  return rendered.join('\n');
}

export function diffSummary(patch: string): { added: number; removed: number; files: number } {
  const lines = patch.split('\n');
  let added = 0;
  let removed = 0;
  let files = 0;

  for (const line of lines) {
    if (line.startsWith('+++')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }

  return { added, removed, files };
}
