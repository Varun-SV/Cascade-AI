// ─────────────────────────────────────────────
//  Cascade AI — Status Bar (top, full-width purple strip)
// ─────────────────────────────────────────────

import React from 'react';
import { Text, useStdout } from 'ink';
import chalk from 'chalk';
import type { Theme } from '../../../types.js';

interface StatusBarProps {
  theme: Theme;
  tierModels: { t1?: string; t2?: string; t3?: string };
  tokens: number;
  costUsd: number;
  /** USD saved by tier delegation vs. running every call on T1. */
  savedUsd?: number;
  workspacePath: string;
  isExecuting: boolean;
  activeTier?: string;
}

function StatusBarInternal({
  theme,
  tokens,
  costUsd,
  savedUsd = 0,
  isExecuting,
  activeTier,
}: StatusBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 100;

  const tierIndicator = activeTier ? ` [${activeTier}]` : '';
  const leftStr = ` ◈ CASCADE${tierIndicator} `;
  const savedStr = savedUsd > 0 ? ` · saved $${savedUsd.toFixed(4)}` : '';
  const rightStr = ` ${formatTokens(tokens)} · $${costUsd.toFixed(4)}${savedStr} ${isExecuting ? '⚡' : '·'} `;

  const gap = Math.max(0, width - leftStr.length - rightStr.length);

  // Single chalk call wrapping the full line avoids multi-Text background
  // seam/reset issues that Ink's renderer can produce in interactive mode.
  const line = chalk
    .bgHex(theme.colors.primary)
    .hex(theme.colors.background)(chalk.bold(leftStr) + ' '.repeat(gap) + rightStr);

  return <Text>{line}</Text>;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`;
  return `${n} tok`;
}

export const StatusBar = React.memo(StatusBarInternal);
