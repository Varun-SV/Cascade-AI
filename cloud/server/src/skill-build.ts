// ─────────────────────────────────────────────
//  Cascade Cloud — skills written with a model's help
// ─────────────────────────────────────────────
//
//  Three socket events, each on the person's own providers (the T3 tier), each
//  saving nothing: the page shows the result, and the person keeps, edits or
//  drops it through the ordinary skill routes.
//
//  skills:draft   {providers, want}                 → {draft}
//  skills:refine  {providers, skillId, change}      → {draft, before}
//  skills:suggest {providers, conversationIds}      → {suggestions}
//  skills:suggest-estimate (same payload)           → {chats, inputTokens, outputTokens, model, costUsd}
//  skills:cancel                                    → stops this connection's job
//
//  One job at a time per person; each one's cost goes into their spend ledger.
//  Privacy: nothing about the request, the skill or the chats is logged.

import { z } from 'zod';
import {
  draftSkillPrompt, estimateBuildCostUsd, estimateSuggest, parseSkillDraft, parseSkillSuggestions,
  refineSkillPrompt, suggestSkillsPrompt, chatDigest, SUGGEST_MAX_CHATS,
  type CascadeRouter, type ProviderConfig, type SkillDraft, type SkillSuggestion,
} from '#cascade-ai';
import type { CloudStore } from './db.js';
import { ProvidersSchema } from './runs.js';
import { chatsForMemory, failureOf, memoryRouter, recordBuildSpend } from './memory-build.js';

const DraftSchema = z.object({ providers: ProvidersSchema, want: z.string().trim().min(3).max(2000) });
const RefineSchema = z.object({ providers: ProvidersSchema, skillId: z.string().min(1).max(100), change: z.string().trim().min(3).max(2000) });
const SuggestSchema = z.object({ providers: ProvidersSchema, conversationIds: z.array(z.string().min(1).max(100)).min(2).max(SUGGEST_MAX_CHATS) });

/** Room for a whole skill (instructions up to ~2,700 characters), or five suggestions. */
const DRAFT_MAX_TOKENS = 2500;
const SUGGEST_MAX_TOKENS = 5000;
/** A skill job's token allowance (the router's $5 build ceiling applies too). */
const JOB_MAX_TOKENS = 200_000;

const working = new Set<string>();

interface SkillSocket {
  on(event: string, fn: (...args: any[]) => void): unknown;
}

type Ack = ((reply: unknown) => void) | undefined;
const ackOf = (a: unknown): Ack => (typeof a === 'function' ? (a as (r: unknown) => void) : undefined);

/** A suggestion as the page shows it: the chats it came from with their titles, from the store. */
export type ShownSuggestion = Omit<SkillSuggestion, 'chats'> & { chats: Array<{ id: string; title: string | null }> };

export function attachSkillBuild(
  socket: SkillSocket,
  store: CloudStore,
  userId: string,
  makeRouter: (providers: ProviderConfig[], maxTokens?: number) => Promise<CascadeRouter> = memoryRouter,
): { abort(): void } {
  let running: AbortController | null = null;

  /** One job: a router on their providers, one T3 call, the spend recorded, failures by kind. */
  async function job<T>(providers: ProviderConfig[], reply: Ack, maxTokens: number, prompt: string, read: (raw: string) => T | null, empty: string): Promise<void> {
    if (working.has(userId)) { reply?.({ error: 'Another skill is being written. Wait for it, or stop it.' }); return; }
    working.add(userId);
    const controller = new AbortController();
    running = controller;
    let router: CascadeRouter | null = null;
    let outcome: 'answered' | 'stopped' | 'failed' = 'failed';
    try {
      router = await makeRouter(providers, JOB_MAX_TOKENS);
      const out = await router.generate('T3', { messages: [{ role: 'user', content: prompt }], maxTokens, temperature: 0.3, signal: controller.signal });
      if (controller.signal.aborted) { outcome = 'stopped'; reply?.({ cancelled: true }); return; }
      if (out.finishReason === 'length') throw new Error('The answer was cut off at its length limit.');
      const value = read(out.content);
      outcome = 'answered';
      reply?.(value === null ? { error: empty } : value);
    } catch (err) {
      if (controller.signal.aborted) { outcome = 'stopped'; reply?.({ cancelled: true }); return; }
      reply?.({ error: failureOf(err) === 'auth'
        ? 'Your provider refused the request. Check its key in Settings.'
        : 'Your provider returned an error. Try again in a moment.' });
    } finally {
      if (router) recordBuildSpend(store, userId, router, outcome, 'skills');
      working.delete(userId);
      if (running === controller) running = null;
    }
  }

  socket.on('skills:draft', async (payload: unknown, ack?: unknown) => {
    const reply = ackOf(ack);
    const p = DraftSchema.safeParse(payload);
    if (!p.success) { reply?.({ error: 'Say what the skill is for in a few words, and add a provider in Settings.' }); return; }
    await job(p.data.providers as ProviderConfig[], reply, DRAFT_MAX_TOKENS, draftSkillPrompt(p.data.want),
      (raw) => { const draft = parseSkillDraft(raw); return draft ? { draft } : null; },
      'The model did not return a usable skill. Try describing it differently.');
  });

  socket.on('skills:refine', async (payload: unknown, ack?: unknown) => {
    const reply = ackOf(ack);
    const p = RefineSchema.safeParse(payload);
    if (!p.success) { reply?.({ error: 'Say what to change in a few words, and add a provider in Settings.' }); return; }
    const skill = store.getUserSkill(p.data.skillId, userId);
    if (!skill) { reply?.({ error: 'That skill was not found.' }); return; }
    const before: SkillDraft = { name: skill.name, description: skill.description, instructions: skill.systemPrompt };
    await job(p.data.providers as ProviderConfig[], reply, DRAFT_MAX_TOKENS, refineSkillPrompt(before, p.data.change),
      (raw) => { const draft = parseSkillDraft(raw); return draft ? { draft, before } : null; },
      'The model did not return a usable skill. Try asking differently.');
  });

  const suggestInput = (ids: string[]) => {
    const chats = chatsForMemory(store, userId, ids);
    const existing = store.listUserSkills(userId).map((s) => s.name);
    return { chats, existing };
  };

  socket.on('skills:suggest-estimate', async (payload: unknown, ack?: unknown) => {
    const reply = ackOf(ack);
    const p = SuggestSchema.safeParse(payload);
    if (!p.success) { reply?.({ error: 'Choose at least two chats, and add a provider in Settings.' }); return; }
    const est = estimateSuggest(suggestInput(p.data.conversationIds).chats);
    let router: CascadeRouter | null = null;
    try { router = await makeRouter(p.data.providers as ProviderConfig[]); } catch { /* estimate without a price */ }
    const model = router?.getModelForTier('T3');
    reply?.({ ...est, model: model?.id ?? null, costUsd: estimateBuildCostUsd(est, model) });
  });

  socket.on('skills:suggest', async (payload: unknown, ack?: unknown) => {
    const reply = ackOf(ack);
    const p = SuggestSchema.safeParse(payload);
    if (!p.success) { reply?.({ error: 'Choose at least two chats, and add a provider in Settings.' }); return; }
    const { chats, existing } = suggestInput(p.data.conversationIds);
    const { text, ids } = chatDigest(chats);
    if (ids.size < 2) { reply?.({ suggestions: [] }); return; }
    const titles = new Map(chats.map((c) => [c.id, c.title ?? null]));
    await job(p.data.providers as ProviderConfig[], reply, SUGGEST_MAX_TOKENS, suggestSkillsPrompt(text, existing),
      (raw) => ({
        suggestions: parseSkillSuggestions(raw, ids, existing).map((s): ShownSuggestion => ({
          ...s, chats: s.chats.map((id) => ({ id, title: titles.get(id) ?? null })),
        })),
      }),
      '');
  });

  socket.on('skills:cancel', () => { running?.abort(); });

  return { abort: () => running?.abort() };
}

