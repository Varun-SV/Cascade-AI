// ─────────────────────────────────────────────
//  Cascade AI — Status Bar
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Theme } from '../../../types.js';

interface StatusBarProps {
  theme: Theme;
  model: string;
  tokens: number;
  costUsd: number;
  sessionId: string;
  workspacePath: string;
  isStreaming: boolean;
}

export function StatusBar({
  theme,
  model,
  tokens,
  costUsd,
  sessionId,
  workspacePath,
  isStreaming,
}: StatusBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const width = (stdout?.columns ?? 80) - 2;

  const left = ` ◈ ${truncateModel(model)} `;
  const mid = ` [${sessionId.slice(0, 8)}] ${workspacePath.split(/[/\\]/).pop() ?? workspacePath} `;
  const right = ` ${formatTokens(tokens)} · $${costUsd.toFixed(4)} · LOAD: ${isStreaming ? '⚡' : '○'} `;
  
  const totalUsed = left.length + mid.length + right.length;
  const paddingSize = Math.max(0, width - totalUsed);
  const leftPad = ' '.repeat(Math.floor(paddingSize / 2));
  const rightPad = ' '.repeat(Math.ceil(paddingSize / 2));

  return (
    <Box
      borderStyle="single"
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.colors.border}
      paddingX={0}
      width={width + 2}
    >
      <Text backgroundColor={theme.colors.primary} color={theme.colors.background} bold>{left}</Text>
      <Text color={theme.colors.muted}>{leftPad}{mid}{rightPad}</Text>
      <Text color={theme.colors.muted}>{right}</Text>
    </Box>
  );
}

function truncateModel(name: string, max = 24): string {
  if (!name) return '';
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1)}…`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`;
  return `${n} tok`;
}
