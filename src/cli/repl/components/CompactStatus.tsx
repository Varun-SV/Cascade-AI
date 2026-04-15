// ─────────────────────────────────────────────
//  Cascade AI — Compact Execution Status
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from '../../../types.js';

interface CompactStatusProps {
  theme: Theme;
  activeT2Count: number;
  activeT3Count: number;
  currentAction?: string;
  isStreaming: boolean;
}

export function CompactStatus({ theme, activeT2Count, activeT3Count, currentAction, isStreaming }: CompactStatusProps): React.ReactElement {
  const activeCount = activeT2Count + activeT3Count;
  
  return (
    <Box paddingX={1} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor={theme.colors.border}>
      <Box flexGrow={1}>
        {isStreaming || activeCount > 0 ? (
          <>
            <Text color={theme.colors.accent} bold><Spinner type="hamburger" /> </Text>
            <Text color={theme.colors.accent} bold>
              {activeCount > 0 ? `WORKING: ${activeCount} AGENTS` : 'ORCHESTRATING'}
            </Text>
            {currentAction && (
              <Text color={theme.colors.muted}> ┃ {currentAction.length > 80 ? currentAction.slice(0, 77) + '...' : currentAction}</Text>
            )}
          </>
        ) : (
          <Box>
            <Text color={theme.colors.muted}>● SYSTEM IDLE </Text>
            <Text color={theme.colors.muted}>┃ Press </Text>
            <Text color={theme.colors.accent} bold>/</Text>
            <Text color={theme.colors.muted}> for command palette</Text>
          </Box>
        )}
      </Box>
      <Box>
        <Text color={theme.colors.muted}>[<Text color={theme.colors.accent} bold>tree</Text>]</Text>
      </Box>
    </Box>
  );
}
