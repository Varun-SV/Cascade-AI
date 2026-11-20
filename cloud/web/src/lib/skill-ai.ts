// Skills written with a model's help, over the socket (cloud/server/src/skill-build.ts).
// Each call runs on the person's own providers and saves nothing.

import type { ProviderConfig } from './types.js';

export interface SkillAiSocket {
  emit(event: string, payload?: unknown, ack?: (reply: any) => void): unknown;
  on?(event: string, fn: (...args: any[]) => void): unknown;
  off?(event: string, fn: (...args: any[]) => void): unknown;
}

const DROPPED = 'The connection dropped, so this stopped. Try again.';

export interface SkillDraft { name: string; description: string; instructions: string }
export interface SkillSuggestion extends SkillDraft { why: string; chats: Array<{ id: string; title: string | null }> }
export interface SuggestEstimate { chats: number; inputTokens: number; outputTokens: number; model: string | null; costUsd: number | null }

/** An answer, an error to show, or that it was stopped. */
export type SkillAiResult<T> = { ok: true; value: T } | { ok: false; error: string } | { ok: false; cancelled: true };

/**
 * One request, settled by its answer, or by the connection dropping: the server
 * stops the job then, and its answer can't reach the next connection.
 */
function ask<T>(socket: SkillAiSocket, event: string, payload: unknown): Promise<SkillAiResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: SkillAiResult<T>) => {
      if (settled) return;
      settled = true;
      socket.off?.('disconnect', onDrop);
      resolve(r);
    };
    const onDrop = () => settle({ ok: false, error: DROPPED });
    socket.on?.('disconnect', onDrop);
    socket.emit(event, payload, (r: (T & { error?: undefined; cancelled?: undefined }) | { error: string } | { cancelled: true }) => {
      if (r && typeof r === 'object' && 'cancelled' in r && r.cancelled) settle({ ok: false, cancelled: true });
      else if (r && typeof r === 'object' && 'error' in r && typeof r.error === 'string') settle({ ok: false, error: r.error });
      else settle({ ok: true, value: r as T });
    });
  });
}

export const draftSkill = (socket: SkillAiSocket, providers: ProviderConfig[], want: string) =>
  ask<{ draft: SkillDraft }>(socket, 'skills:draft', { providers, want });

/** Changes the skill as the form holds it now (`current`), unsaved edits included. */
export const refineSkill = (socket: SkillAiSocket, providers: ProviderConfig[], skillId: string, change: string, current: SkillDraft) =>
  ask<{ draft: SkillDraft; before: SkillDraft }>(socket, 'skills:refine', { providers, skillId, change, current });

export const suggestSkills = (socket: SkillAiSocket, providers: ProviderConfig[], conversationIds: string[]) =>
  ask<{ suggestions: SkillSuggestion[] }>(socket, 'skills:suggest', { providers, conversationIds });

export const estimateSuggest = (socket: SkillAiSocket, providers: ProviderConfig[], conversationIds: string[]) =>
  ask<SuggestEstimate>(socket, 'skills:suggest-estimate', { providers, conversationIds });

export const cancelSkillAi = (socket: SkillAiSocket) => { socket.emit('skills:cancel'); };

/** "about $0.02", "under $0.01", or an unknown price said plainly. */
export function costLine(usd: number | null): string {
  if (usd === null) return 'an unknown amount (this model has no published price)';
  if (usd < 0.01) return 'under $0.01';
  return `about $${usd.toFixed(2)}`;
}
