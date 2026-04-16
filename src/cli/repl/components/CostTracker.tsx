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
  /** Optional per-tier cost breakdown for granular attribution. */
  costByTier?: Record<string, number>;
  /** Optional per-tier token totals. */
  tokensByTier?: Record<string, number>;
}

export function CostTracker({
  theme,
  totalTokens,
  totalCostUsd,
  callsByProvider,
  callsByTier,
  costByTier,
  tokensByTier,
}: CostTrackerProps): React.ReactElement {
  const hasTierCost = costByTier && Object.keys(costByTier).length > 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border} paddingX={2}>
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
          {Object.entries(callsByTier).map(([tier, calls]) => {
            const color = tier === 'T1'
              ? theme.colors.t1Color
              : tier === 'T2' ? theme.colors.t2Color : theme.colors.t3Color;
            const tierCost = hasTierCost ? (costByTier![tier] ?? 0) : null;
            const tierTokens = tokensByTier ? (tokensByTier[tier] ?? 0) : null;

            return (
              <Box key={tier} marginLeft={2}>
                <Box width={8}><Text color={color} bold>{tier}</Text></Box>
                <Box width={12}><Text dimColor>{calls} call{calls !== 1 ? 's' : ''}</Text></Box>
                {tierTokens !== null && (
                  <Box width={16}><Text dimColor>{tierTokens.toLocaleString()} tok</Text></Box>
                )}
                {tierCost !== null && (
                  <Text color={theme.colors.success}>${tierCost.toFixed(6)}</Text>
                )}
              </Box>
            );
          })}
          {hasTierCost && totalCostUsd > 0 && (
            <Box marginLeft={2} marginTop={1} flexDirection="column">
              <Text color={theme.colors.muted} dimColor>Cost distribution:</Text>
              {Object.entries(costByTier!).map(([tier, cost]) => {
                const pct = Math.round((cost / totalCostUsd) * 1000) / 10;
                const color = tier === 'T1'
                  ? theme.colors.t1Color
                  : tier === 'T2' ? theme.colors.t2Color : theme.colors.t3Color;
                const barLen = Math.round(pct / 5); // 20 char max bar
                const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
                return (
                  <Box key={tier} marginLeft={2}>
                    <Box width={5}><Text color={color} bold>{tier}</Text></Box>
                    <Text color={color}>{bar}</Text>
                    <Text dimColor> {pct}%</Text>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
