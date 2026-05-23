// ─────────────────────────────────────────────
//  Cascade AI — Setup Wizard Presentational Components
// ─────────────────────────────────────────────
//
//  Themed building blocks for the first-run wizard, matching the
//  Cascade-AI TUI design (brand header, phase tabs, field boxes).

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../../types.js';

export type SetupPhase = 'keys' | 'models' | 'complete';

const PHASES: Array<{ id: SetupPhase; label: string }> = [
  { id: 'keys', label: 'API Keys' },
  { id: 'models', label: 'Models' },
  { id: 'complete', label: 'Complete' },
];

/** Bordered brand header shown at the top of every wizard step. */
export function WelcomeHeader({ theme }: { theme: Theme }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      alignItems="center"
      borderStyle="round"
      borderColor={theme.colors.primary}
      paddingX={3}
      marginBottom={1}
    >
      <Text color={theme.colors.primary} bold>◈ Welcome to Cascade AI</Text>
      <Text color={theme.colors.muted}>Multi-tier AI orchestration CLI  ·  v0.5.3</Text>
    </Box>
  );
}

/** Three-phase progress strip: API Keys → Models → Complete. */
export function StepTabs({ theme, active }: { theme: Theme; active: SetupPhase }): React.ReactElement {
  const activeIdx = PHASES.findIndex((p) => p.id === active);
  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.colors.border}
      marginBottom={1}
    >
      {PHASES.map((p, i) => {
        const done = i < activeIdx;
        const isActive = i === activeIdx;
        const color = isActive
          ? theme.colors.primary
          : done
            ? theme.colors.success
            : theme.colors.muted;
        return (
          <Box key={p.id} marginRight={3}>
            <Text color={color} bold={isActive}>
              {done ? '✔ ' : `${i + 1}. `}
              {p.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** Standard wizard frame — brand header + phase tabs + step content. */
export function Frame({
  theme,
  phase,
  children,
}: {
  theme: Theme;
  phase: SetupPhase;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <WelcomeHeader theme={theme} />
      <StepTabs theme={theme} active={phase} />
      {children}
    </Box>
  );
}

/** Labelled, bordered input container. Border highlights when active. */
export function FieldBox({
  theme,
  label,
  tag,
  tagColor,
  active,
  children,
}: {
  theme: Theme;
  label: string;
  tag?: string;
  tagColor?: string;
  active?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.colors.foreground} bold>{label}</Text>
        {tag ? <Text color={tagColor ?? theme.colors.muted}>{'  '}{tag}</Text> : null}
      </Box>
      <Box
        borderStyle="round"
        borderColor={active ? theme.colors.primary : theme.colors.border}
        paddingX={1}
      >
        <Text color={theme.colors.primary} bold>{'▸ '}</Text>
        {children}
      </Box>
    </Box>
  );
}

/** Tier → model assignment card, colour-coded by tier. */
export function TierCard({
  theme,
  tier,
  role,
  hint,
  active,
  children,
}: {
  theme: Theme;
  tier: 'T1' | 'T2' | 'T3';
  role: string;
  hint?: string;
  active?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const tierColor =
    tier === 'T1'
      ? theme.colors.t1Color
      : tier === 'T2'
        ? theme.colors.t2Color
        : theme.colors.t3Color;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? theme.colors.primary : theme.colors.border}
      paddingX={1}
      marginBottom={0}
    >
      <Box>
        <Text color={tierColor} bold>{tier}</Text>
        <Text color={theme.colors.foreground} bold>{'  '}{role}</Text>
        {hint ? <Text color={theme.colors.muted} dimColor>{'  ·  '}{hint}</Text> : null}
      </Box>
      {children}
    </Box>
  );
}
