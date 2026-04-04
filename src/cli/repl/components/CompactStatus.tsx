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
            <Text color={theme.colors.accent}><Spinner type="dots" /> </Text>
            <Text color={theme.colors.secondary} bold>
              {activeCount > 0 ? `${activeCount} agents active` : 'Cascade is thinking'}
            </Text>
            {currentAction && (
              <Text color={theme.colors.muted}> — {currentAction.length > 60 ? currentAction.slice(0, 57) + '...' : currentAction}</Text>
            )}
          </>
        ) : (
          <Text color={theme.colors.muted}>System Idle — Press / for commands</Text>
        )}
      </Box>
      <Box>
        <Text color={theme.colors.muted}>details: <Text color={theme.colors.accent} bold>/tree</Text></Text>
      </Box>
    </Box>
  );
}
