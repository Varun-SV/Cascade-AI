// ─────────────────────────────────────────────
//  Cascade Cloud — building memories from a person's own chats
// ─────────────────────────────────────────────
//
//  The person asks for it, picks the chats, sees what it will cost, and can
//  stop it. Each chat is read once by a model (their own providers, the T3
//  tier), which may only propose a memory it can back with a quote of their
//  own words. Nothing is saved here: the candidates go back to the page, where
//  the person keeps, edits or drops each one, and only those reach the store
//  (`acceptMemories`).
//
//  Privacy: the chats leave the server only for the person's own provider, as
//  every run does. Nothing about them is logged: not a title, not a count per
//  chat, not a quote. Errors are reported by kind.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CascadeConfigSchema, CascadeRouter, MEMORY_CATEGORIES, estimateBuild, estimateBuildCostUsd, extractFromChat,
  normalizeCategory, reconcile, chatWorthReading,
  type ChatForMemory, type MemoryCandidate, type ProviderConfig, type StoredMemory,
} from '#cascade-ai';
import type { CloudMemory, CloudStore, MemoryEvidenceRow } from './db.js';
import { ProvidersSchema, buildCloudConfig } from './runs.js';
import { spendEntryFromRun } from './spend.js';

/** The most chats one build reads: the newest first. */
export const MAX_BUILD_CHATS = 300;
/** Chats read at once. */
const CONCURRENCY = 3;
/** A build's own cost ceiling, whatever the estimate said. */
export const MAX_BUILD_COST_USD = 5;

/** The person's chats, newest first, as the builder reads them: the path they chose in each. */
export function chatsForMemory(store: CloudStore, userId: string, ids?: readonly string[]): ChatForMemory[] {
  const wanted = ids ? new Set(ids) : null;
  return store.listConversations(userId, MAX_BUILD_CHATS)
    .filter((c) => !wanted || wanted.has(c.id))
    .map((c) => ({
      id: c.id,
      ...(c.title ? { title: c.title } : {}),
      messages: store.getActivePath(c.id)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, createdAt: m.createdAt })),
    }));
}

/** One row of the picker: what the page needs to choose, and nothing of what was said. */
export interface BuildChatRow {
  id: string;
  title: string | null;
  updatedAt: number;
  turns: number;
  /** Worth reading: enough said by the person to learn from. */
  worth: boolean;
}

export function buildChatRows(store: CloudStore, userId: string): BuildChatRow[] {
  const updated = new Map(store.listConversations(userId, MAX_BUILD_CHATS).map((c) => [c.id, c.updatedAt]));
  return chatsForMemory(store, userId).map((c) => ({
    id: c.id,
    title: c.title ?? null,
    updatedAt: updated.get(c.id) ?? 0,
    turns: c.messages.filter((m) => m.role === 'user').length,
    worth: chatWorthReading(c),
  }));
}

export const BuildRequestSchema = z.object({
  providers: ProvidersSchema,
  conversationIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_BUILD_CHATS),
});
export type BuildRequest = z.infer<typeof BuildRequestSchema>;

/** A router on the person's own providers, for the T3 calls a build makes. */
export async function memoryRouter(providers: ProviderConfig[]): Promise<CascadeRouter> {
  const config = CascadeConfigSchema.parse({
    ...buildCloudConfig(providers, MAX_BUILD_COST_USD, { learnFromOutcomes: false }),
    enabledTools: [],
  });
  const router = new CascadeRouter();
  await router.init(config);
  return router;
}

export interface BuildEstimate {
  chats: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  /** USD, or null when the model has no known price. */
  costUsd: number | null;
}

export function estimateFor(chats: ChatForMemory[], router: Pick<CascadeRouter, 'getModelForTier'> | null): BuildEstimate {
  const est = estimateBuild(chats);
  const model = router?.getModelForTier('T3');
  return { ...est, model: model?.id ?? null, costUsd: estimateBuildCostUsd(est, model) };
}

export interface BuildProgress { read: number; total: number; found: number }

/**
 * Reads each chat and reconciles what they say with what is kept. Stops between
 * calls, and mid-call, when `signal` fires; what was found by then is returned.
 * A chat that fails is skipped, never the build.
 */
export async function buildMemories(opts: {
  chats: ChatForMemory[];
  existing: StoredMemory[];
  generate: (prompt: string, signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
  onProgress?: (p: BuildProgress) => void;
  concurrency?: number;
}): Promise<{ candidates: MemoryCandidate[]; read: number; total: number; cancelled: boolean }> {
  const queue = opts.chats.filter(chatWorthReading);
  const total = queue.length;
  const found: MemoryCandidate[] = [];
  let read = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!opts.signal.aborted && next < queue.length) {
      const chat = queue[next++]!;
      const got = await extractFromChat(chat, (p) => opts.generate(p, opts.signal));
      if (opts.signal.aborted) return;
      found.push(...got);
      read += 1;
      opts.onProgress?.({ read, total, found: found.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? CONCURRENCY, Math.max(1, total)) }, worker));
  return { candidates: reconcile(opts.existing, found), read, total, cancelled: opts.signal.aborted };
}

/** The store's memories, as the builder compares against them. */
export function storedForBuild(memories: CloudMemory[]): StoredMemory[] {
  return memories.map((m) => ({
    id: m.id, content: m.content, category: m.category ? normalizeCategory(m.category) : null, durability: m.durability,
    evidence: m.evidence,
  }));
}

/** Records what a build spent, beside the person's runs. */
export function recordBuildSpend(store: CloudStore, userId: string, router: CascadeRouter, outcome: 'answered' | 'stopped' | 'failed'): void {
  try {
    const s = router.getStats();
    if (!(s.totalCostUsd > 0) && !(s.totalTokens > 0)) return;
    store.recordSpend(spendEntryFromRun({
      id: `memories:${randomUUID()}`, userId, conversationId: null, at: Date.now(), costUsd: s.totalCostUsd,
      why: {
        totalCostUsd: s.totalCostUsd, totalTokens: s.totalTokens,
        costByModel: s.costByTierModel, tokensByModel: s.tokensByTierModel, unpricedByModel: s.untrackedByTierModel,
      },
      outcome,
    }));
  } catch {
    // The ledger must never fail the build. Not logged: the entry would say which chats.
  }
}

// ── Saving what the person kept ─────────────────

const EvidenceSchema = z.object({
  conversationId: z.string().min(1).max(100),
  quote: z.string().min(1).max(400),
  at: z.number().int().nonnegative(),
});

export const AcceptSchema = z.object({
  items: z.array(z.object({
    category: z.enum(MEMORY_CATEGORIES.map((c) => c.id) as [string, ...string[]]),
    content: z.string().trim().min(1).max(500),
    durability: z.enum(['permanent', 'volatile']),
    evidence: z.array(EvidenceSchema).min(1).max(12),
    /** The kept memory this adds to, or rewords. Absent for a new one. */
    revises: z.string().min(1).max(100).optional(),
  })).min(1).max(200),
});

/**
 * Saves what the person kept: a new memory, or more evidence (and maybe a new
 * wording) for one they already have. Evidence must name their own chats: a
 * quote can't be pinned to a chat that isn't theirs.
 */
export function acceptMemories(store: CloudStore, userId: string, input: unknown): { saved: CloudMemory[] } {
  const { items } = AcceptSchema.parse(input);
  const mine = new Set(store.listConversations(userId, Number.MAX_SAFE_INTEGER).map((c) => c.id));
  const saved: CloudMemory[] = [];
  for (const item of items) {
    const evidence: MemoryEvidenceRow[] = item.evidence.filter((e) => mine.has(e.conversationId));
    if (!evidence.length) continue;
    if (item.revises) {
      const revised = store.reviseMemory(item.revises, userId, {
        evidence, content: item.content, category: item.category, durability: item.durability,
      });
      if (revised) { saved.push(revised); continue; }
    }
    saved.push(store.addMemory(userId, item.content, item.category, item.durability, { source: 'chats', evidence }));
  }
  return { saved };
}

// ── The socket side: estimate, build, cancel ─────

/** People with a build running, on any connection: one at a time each. */
const building = new Set<string>();

interface MemorySocket {
  on(event: string, fn: (...args: any[]) => void): unknown;
  emit(event: string, payload: unknown): unknown;
}

type Ack = ((reply: unknown) => void) | undefined;

const ackOf = (a: unknown): Ack => (typeof a === 'function' ? (a as (r: unknown) => void) : undefined);

/**
 * memories:estimate {providers, conversationIds} → BuildEstimate
 * memories:build {providers, conversationIds} → progress as memories:progress, then {candidates, read, total, cancelled}
 * memories:cancel → stops this connection's build; what was found by then still comes back.
 */
export function attachMemoryBuild(
  socket: MemorySocket,
  store: CloudStore,
  userId: string,
  makeRouter: (providers: ProviderConfig[]) => Promise<CascadeRouter> = memoryRouter,
): { abort(): void } {
  let running: AbortController | null = null;

  socket.on('memories:estimate', async (payload: unknown, ack?: unknown) => {
    const reply = ackOf(ack);
    const parsed = BuildRequestSchema.safeParse(payload);
    if (!parsed.success) { reply?.({ error: 'Choose at least one chat, and add a provider in Settings.' }); return; }
    const chats = chatsForMemory(store, userId, parsed.data.conversationIds);
    let router: CascadeRouter | null = null;
    try { router = await makeRouter(parsed.data.providers as ProviderConfig[]); } catch { /* estimate without a price */ }
    reply?.(estimateFor(chats, router));
  });

  socket.on('memories:build', async (payload: unknown, ack?: unknown) => {
    const reply = ackOf(ack);
    const parsed = BuildRequestSchema.safeParse(payload);
    if (!parsed.success) { reply?.({ error: 'Choose at least one chat, and add a provider in Settings.' }); return; }
    if (building.has(userId)) { reply?.({ error: 'A build is already running. Stop it, or wait for it to finish.' }); return; }
    building.add(userId);
    const controller = new AbortController();
    running = controller;
    let router: CascadeRouter | null = null;
    let outcome: 'answered' | 'stopped' | 'failed' = 'failed';
    try {
      router = await makeRouter(parsed.data.providers as ProviderConfig[]);
      const r = router;
      const result = await buildMemories({
        chats: chatsForMemory(store, userId, parsed.data.conversationIds),
        existing: storedForBuild(store.listMemories(userId)),
        generate: async (prompt, signal) => (await r.generate('T3', {
          messages: [{ role: 'user', content: prompt }], maxTokens: 700, temperature: 0, signal,
        })).content,
        signal: controller.signal,
        onProgress: (p) => socket.emit('memories:progress', p),
      });
      outcome = result.cancelled ? 'stopped' : 'answered';
      reply?.(result);
    } catch (err) {
      // By kind only: a provider's message can quote the request.
      reply?.({ error: err instanceof Error && /key|auth|401|403/i.test(err.message)
        ? 'Your provider refused the request. Check its key in Settings.'
        : 'The build could not start. Check your providers in Settings, then try again.' });
    } finally {
      if (router) recordBuildSpend(store, userId, router, outcome);
      building.delete(userId);
      if (running === controller) running = null;
    }
  });

  socket.on('memories:cancel', () => { running?.abort(); });

  return { abort: () => running?.abort() };
}
