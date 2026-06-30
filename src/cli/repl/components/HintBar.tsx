// ─────────────────────────────────────────────
//  Cascade AI — Keyboard Hint Bar
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../../../types.js';

interface HintBarProps {
  theme: Theme;
  isExecuting: boolean;
}

function HintBarInternal({ theme, isExecuting }: HintBarProps): React.ReactElement | null {
  // Hide during execution to reclaim vertical space
  if (isExecuting) return null;

  return (
    <Box paddingLeft={1}>
      <Text color={theme.colors.accent} dimColor>
        {'/ commands  ·  ↑↓ history  ·  Esc cancel  ·  Ctrl+C exit'}
      </Text>
    </Box>
  );
}

export const HintBar = React.memo(HintBarInternal);
