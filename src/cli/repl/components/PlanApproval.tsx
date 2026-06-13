// ─────────────────────────────────────────────
//  Cascade AI — Boardroom Plan Approval
// ─────────────────────────────────────────────
//
//  For Complex runs (config.planApproval = 'always'), T1's plan pauses
//  here before any T2 manager spawns: the user approves the org chart
//  and its estimated budget — the board sitting above T1.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Theme } from '../../../types.js';

export interface PlanApprovalRequest {
  taskId: string;
  plan: { sections: Array<{ sectionTitle: string; t3Subtasks?: unknown[] }> };
  t2Count: number;
  t3Count: number;
  estCostUsd: number;
}

interface PlanApprovalProps {
  request: PlanApprovalRequest;
  theme: Theme;
  onDecision: (approved: boolean) => void;
}

// Cap listed sections so the dialog never outgrows the live-area budget.
const MAX_SECTION_ROWS = 5;

export function PlanApproval({ request, theme, onDecision }: PlanApprovalProps): React.ReactElement {
  const [decided, setDecided] = useState(false);

  useInput((input, key) => {
    if (decided) return;
    if (input === 'y' || input === 'Y' || key.return) {
      setDecided(true);
      onDecision(true);
    } else if (input === 'n' || input === 'N' || key.escape) {
      setDecided(true);
      onDecision(false);
    }
  });

  const sections = request.plan.sections;
  const visible = sections.slice(0, MAX_SECTION_ROWS);
  const hidden = sections.length - visible.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.primary}
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Text color={theme.colors.primary} bold>◈ Boardroom — T1 proposes:</Text>
      {visible.map((s, i) => {
        const workers = s.t3Subtasks?.length ?? 0;
        return (
          <Box key={`${s.sectionTitle}-${i}`}>
            <Text color={theme.colors.t2Color}>  {i + 1}. </Text>
            <Text color={theme.colors.foreground} wrap="truncate-end">{s.sectionTitle}</Text>
            {workers > 0 && <Text color={theme.colors.muted}>  ({workers} worker{workers !== 1 ? 's' : ''})</Text>}
          </Box>
        );
      })}
      {hidden > 0 && <Text color={theme.colors.muted} dimColor>  … +{hidden} more sections</Text>}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          {'Will spawn '}
          <Text color={theme.colors.t2Color} bold>{request.t2Count} manager{request.t2Count !== 1 ? 's' : ''}</Text>
          {' · '}
          <Text color={theme.colors.t3Color} bold>{request.t3Count} worker{request.t3Count !== 1 ? 's' : ''}</Text>
          {' · est. '}
          <Text color={theme.colors.success} bold>${request.estCostUsd.toFixed(4)}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        {!decided ? (
          <Text>
            <Text color={theme.colors.success} bold>[y]</Text>
            <Text color={theme.colors.muted}> Approve & run  </Text>
            <Text color={theme.colors.error} bold>[n]</Text>
            <Text color={theme.colors.muted}> Reject  </Text>
            <Text color={theme.colors.muted}>[Esc] Reject · auto-approves in 2 min</Text>
          </Text>
        ) : (
          <Text color={theme.colors.muted}>Responding…</Text>
        )}
      </Box>
    </Box>
  );
}
