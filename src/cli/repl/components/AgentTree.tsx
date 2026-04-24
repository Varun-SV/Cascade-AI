// ─────────────────────────────────────────────
//  Cascade AI — Live Agent Tree (compact, Claude Code style)
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
  scrollOffset?: number;
  maxRows?: number;
  onToggleCollapse?: (nodeId: string) => void;
}

// A flat renderable row — either the T1 header, a T2 row, or a T3 row.
type TreeRow =
  | { type: 'header'; node: TierNode; t2Count: number; t3Count: number; t2Active: number; t3Active: number }
  | { type: 't2'; node: TierNode; isLast: boolean }
  | { type: 't3'; node: TierNode; isLast: boolean; parentIsLast: boolean };

function buildRows(root: TierNode): TreeRow[] {
  const rows: TreeRow[] = [];

  const t2Count = countByRole(root, 'T2');
  const t3Count = countByRole(root, 'T3');
  const t2Active = countByRoleAndStatus(root, 'T2', 'ACTIVE');
  const t3Active = countByRoleAndStatus(root, 'T3', 'ACTIVE');

  rows.push({ type: 'header', node: root, t2Count, t3Count, t2Active, t3Active });

  const t2Nodes = root.children ?? [];
  t2Nodes.forEach((t2, t2Idx) => {
    const isLastT2 = t2Idx === t2Nodes.length - 1;
    rows.push({ type: 't2', node: t2, isLast: isLastT2 });

    const t3Nodes = (t2.children ?? []).filter(c => c.role === 'T3');
    t3Nodes.forEach((t3, t3Idx) => {
      rows.push({
        type: 't3',
        node: t3,
        isLast: t3Idx === t3Nodes.length - 1,
        parentIsLast: isLastT2,
      });
    });
  });

  return rows;
}

export function AgentTree({
  root,
  theme,
  scrollOffset = 0,
  maxRows = 10,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onToggleCollapse: _onToggleCollapse,
}: AgentTreeProps): React.ReactElement | null {
  if (!root) return null;

  const isActive = hasActiveOrFailed(root);
  if (!isActive) return null;

  const allRows = buildRows(root);
  const total = allRows.length;

  // Clamp scroll so the window never goes past the end
  const safeOffset = Math.min(Math.max(0, scrollOffset), Math.max(0, total - maxRows));
  const visibleRows = allRows.slice(safeOffset, safeOffset + maxRows);

  const aboveCount = safeOffset;
  const belowCount = Math.max(0, total - safeOffset - maxRows);

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={1} height={maxRows}>
      {aboveCount > 0 && (
        <Text color={theme.colors.muted} dimColor>  ↑ {aboveCount} more above</Text>
      )}
      {visibleRows.map((row, i) => {
        if (row.type === 'header') {
          const { node, t2Count, t3Count, t2Active, t3Active } = row;
          const headerAction = node.currentAction?.slice(0, 45) ?? '';
          const t2Label = t2Count > 0 ? ` → T2×${t2Count}` : '';
          const t3Label = t3Count > 0 ? ` → T3×${t3Count}` : '';
          const activeLabel = (t2Active + t3Active) > 0 ? ` (${t2Active + t3Active} active)` : '';
          return (
            <Box key={`header-${i}`}>
              <Text color={theme.colors.primary} bold>◈ T1{t2Label}{t3Label}</Text>
              {activeLabel ? <Text color={theme.colors.muted}>{activeLabel}</Text> : null}
              {headerAction ? <Text color={theme.colors.muted}>  {headerAction}</Text> : null}
              <Text> </Text>
              {node.status === 'ACTIVE'
                ? <><Spinner type="dots" /></>
                : node.status === 'COMPLETED'
                  ? <Text color={theme.colors.success}> ✔</Text>
                  : node.status === 'FAILED'
                    ? <Text color={theme.colors.error}> ✘</Text>
                    : null}
            </Box>
          );
        }

        if (row.type === 't2') {
          const { node, isLast } = row;
          const connector = isLast ? '└─ ' : '├─ ';
          const t3Nodes = (node.children ?? []).filter(c => c.role === 'T3');
          const t3ActiveCount = t3Nodes.filter(c => c.status === 'ACTIVE').length;
          const label = stripRolePrefix(node.label, node.role);
          const action = node.currentAction ? `  ${node.currentAction.slice(0, 38)}` : '';
          return (
            <Box key={`t2-${node.id}-${i}`}>
              <Text color={theme.colors.muted}>  {connector}</Text>
              <Text color={theme.colors.t2Color} bold>[T2]</Text>
              <Text color={theme.colors.foreground}> {label}</Text>
              {node.status === 'ACTIVE' && (
                <>
                  {action ? <Text color={theme.colors.muted}>{action}</Text> : null}
                  <Text> </Text><Spinner type="dots" />
                  {t3ActiveCount > 0 ? <Text color={theme.colors.muted}> ({t3ActiveCount} running)</Text> : null}
                </>
              )}
              {node.status === 'COMPLETED' && <Text color={theme.colors.success}> ✔</Text>}
              {node.status === 'FAILED' && <Text color={theme.colors.error}> ✘</Text>}
              {node.status === 'ESCALATED' && <Text color={theme.colors.warning}> ▲</Text>}
            </Box>
          );
        }

        if (row.type === 't3') {
          const { node, isLast, parentIsLast } = row;
          const indent = parentIsLast ? '      ' : '  │   ';
          const connector = isLast ? '└─ ' : '├─ ';
          const label = stripRolePrefix(node.label, node.role);
          const action = node.currentAction ? ` ${node.currentAction.slice(0, 42)}` : '';
          return (
            <Box key={`t3-${node.id}-${i}`}>
              <Text color={theme.colors.muted}>{indent}{connector}</Text>
              <Text color={theme.colors.t3Color}>[T3]</Text>
              <Text color={theme.colors.muted}> {label}</Text>
              {node.status === 'ACTIVE' && (
                <>
                  {action ? <Text color={theme.colors.muted}>{action}</Text> : null}
                  <Text> </Text><Spinner type="dots" />
                </>
              )}
              {node.status === 'COMPLETED' && <Text color={theme.colors.success}> ✔</Text>}
              {node.status === 'FAILED' && <Text color={theme.colors.error}> ✘</Text>}
            </Box>
          );
        }

        return null;
      })}
      {belowCount > 0 && (
        <Text color={theme.colors.muted} dimColor>  ↓ {belowCount} more below</Text>
      )}
    </Box>
  );
}

function hasActiveOrFailed(node: TierNode): boolean {
  if (node.status === 'ACTIVE' || node.status === 'FAILED') return true;
  return node.children?.some(hasActiveOrFailed) ?? false;
}

function countByRole(node: TierNode, role: TierNode['role']): number {
  const self = node.role === role ? 1 : 0;
  return self + (node.children?.reduce((a, c) => a + countByRole(c, role), 0) ?? 0);
}

function countByRoleAndStatus(node: TierNode, role: TierNode['role'], status: TierNode['status']): number {
  const self = node.role === role && node.status === status ? 1 : 0;
  return self + (node.children?.reduce((a, c) => a + countByRoleAndStatus(c, role, status), 0) ?? 0);
}

function stripRolePrefix(label: string, role: string): string {
  return label.replace(new RegExp(`^\\[${role}\\]\\s*`, 'i'), '');
}
