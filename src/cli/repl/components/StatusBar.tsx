// ─────────────────────────────────────────────
//  Cascade AI — Status Bar (top, full-width purple strip)
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

function StatusBarInternal({
  theme,
  tokens,
  costUsd,
  isExecuting,
  activeTier,
}: StatusBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const tierIndicator = activeTier ? ` [${activeTier}]` : '';
  const left = ` ◈ CASCADE${tierIndicator} `;
  const right = ` ${formatTokens(tokens)} · $${costUsd.toFixed(4)} ${isExecuting ? '⚡' : '·'} `;

  // Pad the gap between left and right so the strip spans the full terminal width
  const gap = Math.max(0, width - left.length - right.length);

  return (
    <Box width={width} flexDirection="row">
      <Text backgroundColor={theme.colors.primary} color={theme.colors.background} bold>{left}</Text>
      <Text backgroundColor={theme.colors.primary} color={theme.colors.primary}>{' '.repeat(gap)}</Text>
      <Text backgroundColor={theme.colors.primary} color={theme.colors.background} dimColor>{right}</Text>
    </Box>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`;
  return `${n} tok`;
}

export const StatusBar = React.memo(StatusBarInternal);
