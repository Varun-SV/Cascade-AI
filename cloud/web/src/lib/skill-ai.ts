// Skills written with a model's help, over the socket (cloud/server/src/skill-build.ts).
// Each call runs on the person's own providers and saves nothing.

import type { ProviderConfig } from './types.js';

export interface SkillAiSocket {
  emit(event: string, payload?: unknown, ack?: (reply: any) => void): unknown;
}

export interface SkillDraft { name: string; description: string; instructions: string }
export interface SkillSuggestion extends SkillDraft { why: string; chats: Array<{ id: string; title: string | null }> }
export interface SuggestEstimate { chats: number; inputTokens: number; outputTokens: number; model: string | null; costUsd: number | null }

/** An answer, an error to show, or that it was stopped. */
export type SkillAiResult<T> = { ok: true; value: T } | { ok: false; error: string } | { ok: false; cancelled: true };

function ask<T>(socket: SkillAiSocket, event: string, payload: unknown): Promise<SkillAiResult<T>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (r: (T & { error?: undefined; cancelled?: undefined }) | { error: string } | { cancelled: true }) => {
      if (r && typeof r === 'object' && 'cancelled' in r && r.cancelled) resolve({ ok: false, cancelled: true });
      else if (r && typeof r === 'object' && 'error' in r && typeof r.error === 'string') resolve({ ok: false, error: r.error });
      else resolve({ ok: true, value: r as T });
    });
  });
}

export const draftSkill = (socket: SkillAiSocket, providers: ProviderConfig[], want: string) =>
  ask<{ draft: SkillDraft }>(socket, 'skills:draft', { providers, want });

export const refineSkill = (socket: SkillAiSocket, providers: ProviderConfig[], skillId: string, change: string) =>
  ask<{ draft: SkillDraft; before: SkillDraft }>(socket, 'skills:refine', { providers, skillId, change });

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
