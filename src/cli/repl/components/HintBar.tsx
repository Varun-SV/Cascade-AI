// ─────────────────────────────────────────────
//  Cascade AI — Keyboard Hint Bar
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../../../types.js';

interface HintBarProps {
  theme: Theme;
  isExecuting: boolean;
  /** A node is picked with ↑↓ (rather than following the busiest). */
  picked?: boolean;
  /** Comms are showing in the cascade view. */
  comms?: boolean;
}

function HintBarInternal({ theme, isExecuting, picked = false, comms = false }: HintBarProps): React.ReactElement | null {
  const hint = isExecuting
    ? `↑↓ pick a node${picked ? ' · ↵ follow the busiest' : ''} · Tab ${comms ? 'hide' : 'show'} comms · Esc stop · type to queue the next ask`
    : '/ commands · /settings · /undo · ↑↓ history · Ctrl+C exit';
  return (
    <Box paddingLeft={1}>
      <Text color={theme.colors.muted} wrap="truncate-end">{hint}</Text>
    </Box>
  );
}

export const HintBar = React.memo(HintBarInternal);
