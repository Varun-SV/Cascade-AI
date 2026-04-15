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
  onToggleCollapse?: (nodeId: string) => void;
}

export function AgentTree({ root, theme }: AgentTreeProps): React.ReactElement | null {
  if (!root) return null;

  const activeT2 = countNodes(root, (node) => node.role === 'T2' && node.status === 'ACTIVE');
  const activeT3 = countNodes(root, (node) => node.role === 'T3' && node.status === 'ACTIVE');

  return (
    <Box flexDirection="column" marginY={0} paddingX={1} borderStyle="round" borderColor={theme.colors.muted}>
      <Box justifyContent="space-between">
        <Text bold color={theme.colors.primary}>
          AGENT EXECUTION ARCHITECTURE
        </Text>
        <Box>
          <Text color={theme.colors.t2Color}>T2:{activeT2} </Text>
          <Text color={theme.colors.t3Color}>T3:{activeT3} </Text>
        </Box>
      </Box>
      <Box marginTop={0} flexDirection="column">
        <TierNodeView node={root} theme={theme} depth={0} isLast />
      </Box>
    </Box>
  );
}

interface TierNodeViewProps {
  node: TierNode;
  theme: Theme;
  depth: number;
  isLast: boolean;
}

function TierNodeView({ node, theme, depth, isLast }: TierNodeViewProps): React.ReactElement | null {
  // Smart Collapsing Logic: 
  // If the node is not active and none of its children are active/failed, 
  // we might want to hide it if we are in a "focused" view.
  // For this refactor, we'll ensure we always show ACTIVE branches.
  const hasActiveDescendant = (n: TierNode): boolean => 
    n.status === 'ACTIVE' || (n.children?.some(hasActiveDescendant) ?? false);
  
  const shouldShow = node.status === 'ACTIVE' || node.status === 'FAILED' || hasActiveDescendant(node) || depth === 0;

  if (!shouldShow) return null;

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
        <Text color={theme.colors.foreground}>{formatNodeLabel(node)}</Text>
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
      return <><Spinner type="dots" /> </>;
    case 'COMPLETED':
      return <Text color={theme.colors.success}>✔</Text>;
    case 'FAILED':
      return <Text color={theme.colors.error}>✘</Text>;
    case 'ESCALATED':
      return <Text color={theme.colors.warning}>▲</Text>;
    default:
      return <Text color={theme.colors.muted}>○</Text>;
  }
}

function formatNodeLabel(node: TierNode): string {
  const duplicatePrefix = new RegExp(`^\\[${node.role}\\]\\s+`, 'i');
  return node.label.replace(duplicatePrefix, '');
}

function countNodes(node: TierNode, predicate: (node: TierNode) => boolean): number {
  const self = predicate(node) ? 1 : 0;
  return self + (node.children?.reduce((acc, child) => acc + countNodes(child, predicate), 0) ?? 0);
}
