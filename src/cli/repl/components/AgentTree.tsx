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
  onToggleCollapse?: (nodeId: string) => void;
}

export function AgentTree({ root, theme }: AgentTreeProps): React.ReactElement | null {
  if (!root) return null;

  // Only render when something is actually running or recently ran
  const isActive = hasActiveOrFailed(root);
  if (!isActive) return null;

  const t2Count = countByRole(root, 'T2');
  const t3Count = countByRole(root, 'T3');
  const t2Active = countByRoleAndStatus(root, 'T2', 'ACTIVE');
  const t3Active = countByRoleAndStatus(root, 'T3', 'ACTIVE');

  const headerAction = root.currentAction?.slice(0, 45) ?? '';
  const t2Label = t2Count > 0 ? ` → T2×${t2Count}` : '';
  const t3Label = t3Count > 0 ? ` → T3×${t3Count}` : '';
  const activeLabel = (t2Active + t3Active) > 0
    ? ` (${t2Active + t3Active} active)`
    : '';

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={1}>
      {/* Header line: ◈ T1 → T2×3 → T3×12  (action)  spinner */}
      <Box>
        <Text color={theme.colors.primary} bold>◈ T1{t2Label}{t3Label}</Text>
        {activeLabel ? <Text color={theme.colors.muted}>{activeLabel}</Text> : null}
        {headerAction ? <Text color={theme.colors.muted}>  {headerAction}</Text> : null}
        <Text> </Text>
        {root.status === 'ACTIVE'
          ? <><Spinner type="dots" /></>
          : root.status === 'COMPLETED'
            ? <Text color={theme.colors.success}> ✔</Text>
            : root.status === 'FAILED'
              ? <Text color={theme.colors.error}> ✘</Text>
              : null}
      </Box>

      {/* T2 rows — depth-capped, max 6 visible */}
      {root.children?.slice(0, 6).map((child, i, arr) => (
        <T2Row
          key={child.id}
          node={child}
          theme={theme}
          isLast={i === arr.length - 1}
        />
      ))}
      {(root.children?.length ?? 0) > 6 && (
        <Text color={theme.colors.muted}>  └─ …{(root.children?.length ?? 0) - 6} more sections</Text>
      )}
    </Box>
  );
}

interface T2RowProps {
  node: TierNode;
  theme: Theme;
  isLast: boolean;
}

function T2Row({ node, theme, isLast }: T2RowProps): React.ReactElement {
  const connector = isLast ? '└─ ' : '├─ ';
  const t3Nodes = (node.children ?? []).filter(c => c.role === 'T3');
  const t3ActiveCount = t3Nodes.filter(c => c.status === 'ACTIVE').length;

  const label = stripRolePrefix(node.label, node.role);
  const action = node.currentAction ? `  ${node.currentAction.slice(0, 38)}` : '';

  return (
    <Box flexDirection="column">
      <Box>
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

      {/* Render T3 workers for this T2 section */}
      {t3Nodes.map((t3, idx) => (
        <T3Row 
          key={t3.id} 
          node={t3} 
          theme={theme} 
          isLast={idx === t3Nodes.length - 1} 
          parentIsLast={isLast}
        />
      ))}
    </Box>
  );
}

interface T3RowProps {
  node: TierNode;
  theme: Theme;
  isLast: boolean;
  parentIsLast: boolean;
}

function T3Row({ node, theme, isLast, parentIsLast }: T3RowProps): React.ReactElement {
  const indent = parentIsLast ? '      ' : '  │   ';
  const connector = isLast ? '└─ ' : '├─ ';
  
  const label = stripRolePrefix(node.label, node.role);
  const action = node.currentAction ? ` ${node.currentAction.slice(0, 42)}` : '';

  return (
    <Box>
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
