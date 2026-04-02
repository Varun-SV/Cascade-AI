// ─────────────────────────────────────────────
//  Cascade AI — Cost Tracker Display
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../../../types.js';

interface CostTrackerProps {
  theme: Theme;
  totalTokens: number;
  totalCostUsd: number;
  callsByProvider: Record<string, number>;
  callsByTier: Record<string, number>;
}

export function CostTracker({
  theme,
  totalTokens,
  totalCostUsd,
  callsByProvider,
  callsByTier,
}: CostTrackerProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border} paddingX={2} paddingY={1}>
      <Text color={theme.colors.primary} bold>Session Usage</Text>

      <Box marginTop={1}>
        <Box width={20}><Text color={theme.colors.muted}>Total tokens:</Text></Box>
        <Text color={theme.colors.foreground} bold>{totalTokens.toLocaleString()}</Text>
      </Box>
      <Box>
        <Box width={20}><Text color={theme.colors.muted}>Estimated cost:</Text></Box>
        <Text color={theme.colors.success} bold>${totalCostUsd.toFixed(6)}</Text>
      </Box>

      {Object.keys(callsByProvider).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.muted}>By provider:</Text>
          {Object.entries(callsByProvider).map(([p, c]) => (
            <Box key={p} marginLeft={2}>
              <Box width={20}><Text color={theme.colors.secondary}>{p}</Text></Box>
              <Text>{c} calls</Text>
            </Box>
          ))}
        </Box>
      )}

      {Object.keys(callsByTier).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.muted}>By tier:</Text>
          {Object.entries(callsByTier).map(([tier, c]) => {
            const color = tier === 'T1'
              ? theme.colors.t1Color
              : tier === 'T2' ? theme.colors.t2Color : theme.colors.t3Color;
            return (
              <Box key={tier} marginLeft={2}>
                <Box width={8}><Text color={color} bold>{tier}</Text></Box>
                <Text>{c} calls</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
