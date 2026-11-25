// ─────────────────────────────────────────────
//  Cascade AI — Header (top, full-width strip)
// ─────────────────────────────────────────────
//
//   ◆ CASCADE · AUTO · ↺ #7      T1 opus · T2 sonnet · T3 haiku      $0.16 · 119k · 4:12
//
//  Mode and the last checkpoint on the left, the tiers' models in the
//  middle (dropped first when narrow), what the session has spent and how
//  long the run has taken on the right.

import React from 'react';
import { Text, useStdout } from 'ink';
import chalk from 'chalk';
import type { Theme } from '../../../types.js';
import { USING_PLAN_LABEL } from '../../../auth/chatgpt/constants.js';

interface StatusBarProps {
  theme: Theme;
  tierModels: { t1?: string; t2?: string; t3?: string };
  tokens: number;
  costUsd: number;
  /** USD saved by tier delegation vs. running every call on T1. */
  savedUsd?: number;
  workspacePath: string;
  isExecuting: boolean;
  activeTier?: string;
  autonomy?: 'manual' | 'auto';
  /** The number of the run's checkpoint, which /undo takes back. */
  checkpoint?: number | null;
  /** How long the current (or last) run took, in ms. */
  elapsedMs?: number;
  /**
   * Calls to a model Cascade has no price for. Their tokens are counted and their
   * cost can't be, so the cost shown is what the rest cost: "$8.51+".
   */
  unpricedCalls?: number;
  /** A tier runs on the user's ChatGPT plan: say so (the manage-usage link is in /settings and `cascade chatgpt status`). */
  usingChatGptPlan?: boolean;
}

/** "anthropic:claude-opus-4-1-20250805" → "opus-4-1"; unset → "auto". */
export function shortModel(id: string | undefined): string {
  if (!id) return 'auto';
  const name = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return name.replace(/^(claude-|models\/)/, '').replace(/-\d{8}$/, '').replace(/-(latest|preview)$/, '').slice(0, 18);
}

function StatusBarInternal({
  theme, tierModels, tokens, costUsd, savedUsd = 0, isExecuting, autonomy = 'manual', checkpoint, elapsedMs, unpricedCalls = 0, usingChatGptPlan = false,
}: StatusBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 100;

  const mode = autonomy === 'auto' ? 'AUTO' : 'ASKS FIRST';
  const left = ` ◆ CASCADE · ${mode}${checkpoint ? ` · ↺ #${checkpoint}` : ''}${usingChatGptPlan ? ` · ${USING_PLAN_LABEL}` : ''} `;
  const models = ` T1 ${shortModel(tierModels.t1)} · T2 ${shortModel(tierModels.t2)} · T3 ${shortModel(tierModels.t3)} `;
  const time = elapsedMs !== undefined && elapsedMs > 0 ? ` · ${formatClock(elapsedMs)}` : '';
  const saved = savedUsd > 0 && width >= 100 ? ` · saved $${savedUsd.toFixed(2)}` : '';
  // A "+" when some calls couldn't be priced: the total is a floor, not the spend.
  const partial = unpricedCalls > 0 ? '+' : '';
  const unpriced = unpricedCalls > 0 && width >= 110 ? ` · ${unpricedCalls} call${unpricedCalls === 1 ? '' : 's'} not priced` : '';
  const right = ` $${costUsd.toFixed(costUsd < 1 ? 3 : 2)}${partial}${unpriced} · ${formatTokens(tokens)}${saved}${time} ${isExecuting ? '⚡' : ' '} `;

  // The models go first when the line is too narrow for all three parts.
  const showModels = width - left.length - right.length - models.length >= 4;
  const middle = showModels ? models : '';
  const gaps = Math.max(0, width - left.length - middle.length - right.length);
  const gapLeft = Math.floor(gaps / 2);
  const line = chalk.bgHex(theme.colors.primary).hex(theme.colors.background)(
    chalk.bold(left) + ' '.repeat(gapLeft) + middle + ' '.repeat(gaps - gapLeft) + right,
  );
  return <Text>{line}</Text>;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k tok`;
  return `${n} tok`;
}

function formatClock(ms: number): string {
  const t = Math.round(ms / 1000);
  const m = Math.floor(t / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}:${String(t % 60).padStart(2, '0')}`;
}

export const StatusBar = React.memo(StatusBarInternal);
