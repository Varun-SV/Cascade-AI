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
  const width = stdout?.columns ?? 80;

  const left = ` cascade ${isStreaming ? '⟳' : '◈'} ${truncateModel(model)}`;
  const mid = workspacePath.split('/').pop() ?? workspacePath;
  const right = `${formatTokens(tokens)} · $${costUsd.toFixed(4)} `;
  const padding = Math.max(0, width - left.length - mid.length - right.length);
  const midPad = ' '.repeat(Math.floor(padding / 2));

  return (
    <Box
      borderStyle="single"
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.colors.border}
      paddingX={1}
      width={width}
    >
      <Text color={theme.colors.primary} bold>{left}</Text>
      <Text color={theme.colors.muted}>{midPad}{mid}{midPad}</Text>
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
