// ─────────────────────────────────────────────
//  Cascade AI — Approval Prompt
// ─────────────────────────────────────────────
//
//  One card, under the run, for one call: who asks, exactly what it would
//  do, why Cascade stopped to ask, and whether /undo could take it back.
//
//    ⚠ T3 · Web dashboard wants to run   rm -r build/
//      deletes files · /undo can put them back
//      [y] allow   [a] allow this kind for the run   [n] deny   [v] view all

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, Theme } from '../../../types.js';
import { RISK_LABELS, undoable } from '../../../core/permissions/risk.js';

interface ApprovalPromptProps {
  request: ApprovalRequest;
  theme: Theme;
  onDecision: (decision: { approved: boolean; always: boolean }) => void;
}

export interface ApprovalSummary {
  who: string;
  verb: string;
  what: string;
  /** Why it asks, in plain words. */
  why: string;
  /** What /undo can do about it. */
  undo: string;
  /** What "allow for this run" covers. */
  always: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** What the card says about a request; kept apart from the drawing so it can be tested. */
export function summarizeApproval(request: ApprovalRequest): ApprovalSummary {
  const i = request.input;
  const ctx = (request as ApprovalRequest & { escalationContext?: { subtaskContext?: string } }).escalationContext;
  const tier = request.tierId.split(/[-:]/)[0] ?? request.tierId;
  const who = ctx?.subtaskContext && ctx.subtaskContext !== 'Unknown subtask' ? `${tier} · ${oneLine(ctx.subtaskContext, 32)}` : request.tierId;
  let verb = 'wants to use';
  let what = request.toolName;
  switch (request.toolName) {
    case 'shell': verb = 'wants to run'; what = str(i['command']); break;
    case 'run_code': verb = 'wants to run code'; what = oneLine(str(i['code']), 80); break;
    case 'file_write': verb = 'wants to write'; what = str(i['path']); break;
    case 'file_edit': verb = 'wants to edit'; what = str(i['path']); break;
    case 'file_delete': verb = 'wants to delete'; what = str(i['path']); break;
    case 'git': verb = 'wants to run'; what = `git ${str(i['operation'])} ${Array.isArray(i['args']) ? (i['args'] as unknown[]).map(String).join(' ') : ''}`.trim(); break;
    case 'github': verb = 'wants to'; what = `${str(i['operation']).replace(/_/g, ' ')} on GitHub${i['repo'] ? ` (${str(i['repo'])})` : ''}`; break;
    case 'browser': verb = 'wants to'; what = `${str(i['action'])} ${str(i['url'] ?? i['selector'] ?? '')}`.trim() + ' in the browser'; break;
    default: what = `${request.toolName} ${oneLine(JSON.stringify(i), 80)}`;
  }
  const risk = request.risk;
  const why = risk?.level === 'risky' && risk.category
    ? `${RISK_LABELS[risk.category]}${risk.reason && !risk.reason.startsWith(what) ? `: ${risk.reason}` : ''}`
    : risk ? risk.reason : request.description;
  const undo = !risk ? ''
    : risk.level === 'safe' ? 'only reads'
      : risk.category === 'delete' ? '/undo can put back what the project\'s checkpoint holds (not files .gitignore leaves out)'
        : undoable(risk) ? '/undo can take it back'
          : '/undo can\'t take this back';
  const always = risk?.level === 'risky' && risk.category ? `allow "${RISK_LABELS[risk.category]}" for this run` : 'allow for this run';
  return { who, verb, what, why, undo, always };
}

export function ApprovalPrompt({ request, theme, onDecision }: ApprovalPromptProps): React.ReactElement {
  const [decided, setDecided] = useState(false);
  const [full, setFull] = useState(false);

  useInput((input, key) => {
    if (decided) return;
    if (input === 'a' || input === 'A') {
      setDecided(true);
      onDecision({ approved: true, always: true });
    } else if (input === 'y' || input === 'Y') {
      setDecided(true);
      onDecision({ approved: true, always: false });
    } else if (input === 'n' || input === 'N' || key.escape) {
      setDecided(true);
      onDecision({ approved: false, always: false });
    } else if (input === 'v' || input === 'V') {
      setFull((f) => !f);
    }
  });

  const s = summarizeApproval(request);
  const risky = request.risk ? request.risk.level === 'risky' : request.isDangerous;
  const color = risky ? theme.colors.error : theme.colors.warning;
  const cantUndo = request.risk ? !undoable(request.risk) : false;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginY={1}>
      <Text wrap="truncate-end">
        <Text color={color} bold>{risky ? '⚠ ' : '? '}</Text>
        <Text color={theme.colors.secondary} bold>{s.who}</Text>
        <Text color={theme.colors.muted}> {s.verb}  </Text>
        <Text color={theme.colors.foreground} bold>{full ? '' : oneLine(s.what, 90)}</Text>
      </Text>
      {full && (
        <Box marginLeft={2} flexDirection="column">
          <Text color={theme.colors.foreground}>{s.what}</Text>
          <Text color={theme.colors.muted}>{JSON.stringify(request.input, null, 2).slice(0, 1500)}</Text>
        </Box>
      )}
      <Text wrap="truncate-end">
        <Text color={theme.colors.muted}>  {s.why}</Text>
        {s.undo ? <Text color={cantUndo ? theme.colors.error : theme.colors.success}>{`  ·  ${s.undo}`}</Text> : null}
      </Text>
      {!decided ? (
        <Text>
          <Text>  </Text>
          <Text color={theme.colors.success} bold>[y]</Text><Text color={theme.colors.muted}> allow   </Text>
          <Text color={theme.colors.success} bold>[a]</Text><Text color={theme.colors.muted}> {s.always}   </Text>
          <Text color={theme.colors.error} bold>[n]</Text><Text color={theme.colors.muted}> deny   </Text>
          <Text color={theme.colors.primary} bold>[v]</Text><Text color={theme.colors.muted}> {full ? 'less' : 'view all'}</Text>
        </Text>
      ) : (
        <Text color={theme.colors.muted}>  Responding…</Text>
      )}
    </Box>
  );
}
