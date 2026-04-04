// ─────────────────────────────────────────────
//  Cascade AI — Execution Timeline Panel
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../../../types.js';
import type { TierNode } from './AgentTree.js';

interface TimelinePanelProps {
  nodes: TierNode[];
  theme: Theme;
  currentIndex: number;
  onChangeIndex?: (index: number) => void;
}

export function TimelinePanel({ nodes, theme, currentIndex }: TimelinePanelProps): React.ReactElement | null {
  if (!nodes.length) return null;

  const entries = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const selected = entries[Math.min(currentIndex, entries.length - 1)] ?? entries[0];

  return (
    <Box flexDirection="column" marginTop={0}>
      <Text bold color={theme.colors.muted}>Activity Log</Text>
      <Box flexDirection="column" marginTop={0}>
        {entries.slice(-3).map((node) => (
          <Text key={node.id} color={theme.colors.accent}>
            [{node.role}] {node.label} — {node.status}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
