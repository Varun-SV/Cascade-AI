// ─────────────────────────────────────────────
//  Cascade AI — Live Agent Tree Visualization
// ─────────────────────────────────────────────

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from '../../../types.js';

export interface TierNode {
  id: string;
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: 'IDLE' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';
  currentAction?: string;
  progressPct?: number;
  children?: TierNode[];
}

interface AgentTreeProps {
  root: TierNode | null;
  theme: Theme;
}

export function AgentTree({ root, theme }: AgentTreeProps): React.ReactElement | null {
  if (!root) return null;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={theme.colors.muted}>Agent Execution Tree</Text>
      <TierNodeView node={root} theme={theme} depth={0} isLast />
    </Box>
  );
}

interface TierNodeViewProps {
  node: TierNode;
  theme: Theme;
  depth: number;
  isLast: boolean;
}

function TierNodeView({ node, theme, depth, isLast }: TierNodeViewProps): React.ReactElement {
  const tierColor = node.role === 'T1'
    ? theme.colors.t1Color
    : node.role === 'T2'
      ? theme.colors.t2Color
      : theme.colors.t3Color;

  const statusIcon = getStatusIcon(node.status, theme);
  const connector = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
  const indent = '│  '.repeat(depth);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.colors.muted}>{indent}{connector}</Text>
        <Text color={tierColor} bold>[{node.role}]</Text>
        <Text> </Text>
        <Text color={theme.colors.foreground}>{node.label}</Text>
        <Text> </Text>
        {statusIcon}
        {node.currentAction && node.status === 'ACTIVE' && (
          <Text color={theme.colors.muted}> — {node.currentAction.slice(0, 50)}</Text>
        )}
        {node.progressPct !== undefined && node.status === 'ACTIVE' && (
          <Text color={theme.colors.muted}> ({node.progressPct}%)</Text>
        )}
      </Box>
      {node.children?.map((child, i) => (
        <TierNodeView
          key={child.id}
          node={child}
          theme={theme}
          depth={depth + 1}
          isLast={i === (node.children?.length ?? 0) - 1}
        />
      ))}
    </Box>
  );
}

function getStatusIcon(status: TierNode['status'], theme: Theme): React.ReactElement {
  switch (status) {
    case 'ACTIVE':
      return <><Spinner type="dots" /><Text> </Text></>;
    case 'COMPLETED':
      return <Text color={theme.colors.success}>✓</Text>;
    case 'FAILED':
      return <Text color={theme.colors.error}>✗</Text>;
    case 'ESCALATED':
      return <Text color={theme.colors.warning}>⚠</Text>;
    default:
      return <Text color={theme.colors.muted}>○</Text>;
  }
}
