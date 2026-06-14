// ─────────────────────────────────────────────
//  Cascade AI — Boardroom Plan Approval
// ─────────────────────────────────────────────
//
//  The plan pauses here before any worker spawns: the user reviews the org
//  chart (and an optional automated critique), can drop sections, add a
//  steering note to re-plan, then approve or reject — the board above T1.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Theme } from '../../../types.js';
import { SafeTextInput } from '../../components/SafeTextInput.js';

export interface PlanApprovalSection {
  sectionId?: string;
  sectionTitle: string;
  description?: string;
  t3Subtasks?: unknown[];
  dependsOn?: string[];
}

export interface PlanApprovalPlan {
  complexity?: string;
  reasoning?: string;
  sections: PlanApprovalSection[];
}

export interface PlanApprovalRequest {
  taskId: string;
  plan: PlanApprovalPlan;
  t2Count: number;
  t3Count: number;
  estCostUsd: number;
  /** Optional automated reviewer critique (planReview.autoReviewer). */
  critique?: string;
  /** Optional spawn-summary override (used by Moderate runs: "N workers · 1 root manager"). */
  summary?: string;
}

interface PlanApprovalProps {
  request: PlanApprovalRequest;
  theme: Theme;
  /** Allow dropping sections before approval. Default: true. */
  editable?: boolean;
  onDecision: (approved: boolean, note?: string, editedPlan?: PlanApprovalPlan) => void;
}

// Cap individually-listed (editable) sections so the dialog stays within the
// live-area budget; any beyond this are summarised and kept as-is.
const MAX_SECTION_ROWS = 8;

export function PlanApproval({ request, theme, editable = true, onDecision }: PlanApprovalProps): React.ReactElement {
  const [decided, setDecided] = useState(false);
  const [mode, setMode] = useState<'review' | 'note'>('review');
  const [cursor, setCursor] = useState(0);
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [noteText, setNoteText] = useState('');

  const sections = request.plan.sections;
  const visible = sections.slice(0, MAX_SECTION_ROWS);
  const hidden = sections.length - visible.length;
  const keptCount = sections.length - dropped.size;

  const finish = (approved: boolean, note?: string): void => {
    setDecided(true);
    let editedPlan: PlanApprovalPlan | undefined;
    if (approved && dropped.size > 0 && keptCount > 0) {
      editedPlan = { ...request.plan, sections: sections.filter((_, i) => !dropped.has(i)) };
    }
    onDecision(approved, note, editedPlan);
  };

  useInput((input, key) => {
    if (decided || mode === 'note') return;

    if (input === 'y' || input === 'Y' || key.return) { finish(true); return; }
    if (input === 'n' || input === 'N' || key.escape) { finish(false); return; }
    if (input === 'm' || input === 'M') { setMode('note'); return; }

    if (key.upArrow || input === 'k') { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow || input === 'j') { setCursor((c) => Math.min(visible.length - 1, c + 1)); return; }

    // 'x' toggles dropping the highlighted section (never drop the last one).
    if (editable && (input === 'x' || input === 'X')) {
      setDropped((prev) => {
        const next = new Set(prev);
        if (next.has(cursor)) next.delete(cursor);
        else if (sections.length - next.size > 1) next.add(cursor);
        return next;
      });
    }
  });

  if (mode === 'note' && !decided) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.primary} paddingX={2} paddingY={1} marginY={1}>
        <Text color={theme.colors.primary} bold>◈ Steering note — T1 will re-plan, then re-ask:</Text>
        <Box marginTop={1}>
          <Text color={theme.colors.accent}>{'> '}</Text>
          <SafeTextInput
            value={noteText}
            focus
            manageMouseReporting={false}
            onChange={setNoteText}
            onSubmit={(val) => {
              const note = val.trim();
              if (note) finish(true, note);
              else { setNoteText(''); setMode('review'); }
            }}
            placeholder="e.g. split section 2, add tests, drop the docs section…"
          />
        </Box>
        <Text color={theme.colors.muted} dimColor>  Enter submits · empty + Enter cancels</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.primary} paddingX={2} paddingY={1} marginY={1}>
      <Text color={theme.colors.primary} bold>◈ Boardroom — T1 proposes:</Text>

      {request.critique && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.accent} bold>Reviewer:</Text>
          {request.critique.split('\n').slice(0, 6).map((line, i) => (
            <Text key={i} color={theme.colors.muted} wrap="truncate-end">  {line}</Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {visible.map((s, i) => {
          const workers = s.t3Subtasks?.length ?? 0;
          const isDropped = dropped.has(i);
          const isCursor = i === cursor && !decided;
          return (
            <Box key={`${s.sectionTitle}-${i}`}>
              <Text color={isCursor ? theme.colors.accent : theme.colors.t2Color}>{isCursor ? '› ' : '  '}{i + 1}. </Text>
              <Text
                color={isDropped ? theme.colors.error : theme.colors.foreground}
                strikethrough={isDropped}
                wrap="truncate-end"
              >{s.sectionTitle}</Text>
              {workers > 0 && <Text color={theme.colors.muted}>  ({workers} worker{workers !== 1 ? 's' : ''})</Text>}
              {isDropped && <Text color={theme.colors.error}>  dropped</Text>}
            </Box>
          );
        })}
        {hidden > 0 && <Text color={theme.colors.muted} dimColor>  … +{hidden} more sections</Text>}
      </Box>

      <Box marginTop={1}>
        {request.summary ? (
          <Text color={theme.colors.muted}>{'Will spawn '}<Text color={theme.colors.foreground}>{request.summary}</Text></Text>
        ) : (
          <Text color={theme.colors.muted}>
            {'Will spawn '}
            <Text color={theme.colors.t2Color} bold>{keptCount} manager{keptCount !== 1 ? 's' : ''}</Text>
            {' · '}
            <Text color={theme.colors.t3Color} bold>{request.t3Count} worker{request.t3Count !== 1 ? 's' : ''}</Text>
            {' · est. '}
            <Text color={theme.colors.success} bold>${request.estCostUsd.toFixed(4)}</Text>
          </Text>
        )}
      </Box>

      <Box marginTop={1}>
        {!decided ? (
          <Text>
            <Text color={theme.colors.success} bold>[y]</Text>
            <Text color={theme.colors.muted}> Approve  </Text>
            <Text color={theme.colors.error} bold>[n]</Text>
            <Text color={theme.colors.muted}> Reject  </Text>
            <Text color={theme.colors.primary} bold>[m]</Text>
            <Text color={theme.colors.muted}> Note → re-plan  </Text>
            {editable && (<><Text color={theme.colors.primary} bold>[↑↓/x]</Text><Text color={theme.colors.muted}> drop section  </Text></>)}
            <Text color={theme.colors.muted}>· auto-approves in 2 min</Text>
          </Text>
        ) : (
          <Text color={theme.colors.muted}>Responding…</Text>
        )}
      </Box>
    </Box>
  );
}
