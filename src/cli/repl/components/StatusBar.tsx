// ─────────────────────────────────────────────
//  Cascade AI — Status Bar (top, Claude Code style)
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Theme } from '../../../types.js';

interface StatusBarProps {
  theme: Theme;
  tierModels: { t1?: string; t2?: string; t3?: string };
  tokens: number;
  costUsd: number;
  workspacePath: string;
  isExecuting: boolean;
  activeTier?: string;
}

export function StatusBar({
  theme,
  tierModels,
  tokens,
  costUsd,
  workspacePath,
  isExecuting,
  activeTier,
}: StatusBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const width = (stdout?.columns ?? 80) - 2;

  const t1Label = tierModels.t1 ? truncate(tierModels.t1, 18) : 'auto';
  const folderName = workspacePath.split(/[/\\]/).pop() ?? workspacePath;
  const tierIndicator = activeTier ? ` [${activeTier}]` : '';

  const left = ` ◈ CASCADE${tierIndicator} `;
  const mid = ` ${truncate(folderName, 24)}  T1:${t1Label} `;
  const right = ` ${formatTokens(tokens)} · $${costUsd.toFixed(4)} ${isExecuting ? '⚡' : '·'} `;

  const totalUsed = left.length + mid.length + right.length;
  const gap = Math.max(0, width - totalUsed);
  const leftGap = ' '.repeat(Math.floor(gap / 2));
  const rightGap = ' '.repeat(Math.ceil(gap / 2));

  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderBottom={true}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.colors.border}
      width={width + 2}
    >
      <Text backgroundColor={theme.colors.primary} color={theme.colors.background} bold>{left}</Text>
      <Text color={theme.colors.muted}>{leftGap}{mid}{rightGap}</Text>
      <Text color={theme.colors.muted}>{right}</Text>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`;
  return `${n} tok`;
}
