// ─────────────────────────────────────────────
//  Cascade Cloud Server — Run Pipeline
// ─────────────────────────────────────────────
//
// Bridges an authenticated `chat:run` socket event to a per-tenant Cascade
// run. Always uses `createCascade` — never `runCascade`, which goes through
// ConfigManager and merges the machine-global ~/.cascade-ai/credentials.json.
// On a shared multi-tenant server that would leak one user's provider keys
// into another user's run.

import { createCascade } from '#cascade-ai';
import type { Cascade, CascadeConfig, ConversationMessage, ImageAttachment, ProviderConfig } from '#cascade-ai';
import fs from 'node:fs/promises';
import type { Socket } from 'socket.io';
import { z } from 'zod';
import type { CloudEnv } from './env.js';
import type { CloudAttachment, CloudStore } from './db.js';
import { beginRun, checkDailyLimit, todayKey } from './entitlements.js';
import { getSkill } from './skills.js';
import { tenantScratchDir } from './paths.js';

export { tenantScratchDir };

const MAX_HISTORY_MESSAGES = 20;
const PROVIDER_TYPES = ['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible', 'ollama'] as const;

// A blank form field submits as '' — plain `.optional()` accepts that as a
// "defined" empty string rather than absent, and provider clients downstream
// (e.g. `new OpenAI({ apiKey: '' })`) throw on a defined-but-empty key where
// they'd happily fall back to unauthenticated on a genuinely absent one.
// Coerce '' to undefined so "left blank" always means "not set".
const optionalNonEmptyString = z.string().optional().transform((v) => (v === '' ? undefined : v));

// Keys are browser-held and travel with the run request only — never
// persisted server-side (see db.ts: no api key column anywhere).
const ChatRunPayloadSchema = z.object({
  conversationId: z.string().optional(),
  prompt: z.string().min(1).max(20_000),
  // Ids of images the client already uploaded via POST /api/uploads. Loaded
  // and ownership-checked server-side; unknown/foreign ids are ignored.
  attachmentIds: z.array(z.string()).max(4).optional(),
  // Selected prompt-preset ("skill"). Unknown ids resolve to no preset.
  skillId: optionalNonEmptyString,
  // Run-explorer controls. routingMode biases Cascade Auto; forceTier pins the
  // root tier; webSearch toggles the two hosted tools on/off for this run.
  routingMode: z.enum(['auto', 'quality', 'fast']).optional(),
  forceTier: z.enum(['auto', 'T1', 'T2', 'T3']).optional(),
  webSearch: z.boolean().optional(),
  providers: z
    .array(
      z.object({
        type: z.enum(PROVIDER_TYPES),
        label: optionalNonEmptyString,
        apiKey: optionalNonEmptyString,
        baseUrl: optionalNonEmptyString,
        deploymentName: optionalNonEmptyString,
        apiVersion: optionalNonEmptyString,
        model: optionalNonEmptyString,
      }),
    )
    .min(1)
    .max(6),
});

export type ChatRunPayload = z.infer<typeof ChatRunPayloadSchema>;

export function parseChatRunPayload(input: unknown): ChatRunPayload {
  return ChatRunPayloadSchema.parse(input);
}

export interface RunControls {
  routingMode?: 'auto' | 'quality' | 'fast';
  forceTier?: 'auto' | 'T1' | 'T2' | 'T3';
  /** When false, no tools are registered for the run at all. Default true. */
  webSearch?: boolean;
}

// Maps the UI's routing mode to Cascade Auto's bias. Cascade Auto stays ON for
// all three (per-task model selection); the bias tunes the quality↔cost knob.
const BIAS_BY_MODE: Record<string, 'balanced' | 'quality' | 'cost'> = {
  auto: 'balanced',
  quality: 'quality',
  fast: 'cost',
};

export function buildCloudConfig(
  providers: ProviderConfig[],
  maxCostPerRunUsd: number,
  controls: RunControls = {},
): Partial<CascadeConfig> {
  const webSearchOn = controls.webSearch !== false;
  return {
    providers,
    cascadeAuto: true,
    autoBias: BIAS_BY_MODE[controls.routingMode ?? 'auto'] ?? 'balanced',
    routing: { forceTier: controls.forceTier ?? 'auto' },
    tools: {
      shellAllowlist: [],
      shellBlocklist: [],
      requireApprovalFor: [],
      browserEnabled: false,
      // v1 scope: chat + safe tools only. No shell/file/git exist for a
      // hosted run — not just approval-gated, genuinely absent from the
      // registry (see src/tools/registry.ts: enabledTools allowlist). The web
      // toggle drops even these when off.
      enabledTools: webSearchOn ? ['web_search', 'web_fetch'] : [],
    },
    knowledge: { factsExtraction: false },
    telemetry: { enabled: false },
    budget: { warnAtPct: 80, maxCostPerRunUsd },
  };
}

/** The run-explorer report forwarded to the client (mirrors the desktop /why). */
export interface WhyReport {
  /** 'T1' | 'T2' | 'T3' — the tier that did the most work on this run. */
  tier: string | null;
  model: string | null;
  decisions: Array<{ at: string; kind: string; detail: string }>;
  savedUsd: number;
  savedPct: number;
  totalCostUsd: number;
  totalTokens: number;
  durationMs: number;
  costByTier: Record<string, number>;
  tokensByTier: Record<string, number>;
  /** tier → model that served it (from tier:status). */
  models: Record<string, string>;
}

export interface ChatRunResult {
  conversationId: string;
  output: string;
  costUsd: number;
  totalTokens: number;
  tier: string | null;
  model: string | null;
  savedUsd: number;
  savedPct: number;
  /** True when the user stopped the run — output is whatever completed first. */
  cancelled: boolean;
}

// Picks the tier that did the most work as the "answering" tier: the one with
// the most tokens, falling back to the most cost. Undefined for runs that never
// surfaced tier data (e.g. the conversational fast-path) — the UI then shows no
// badge rather than a fabricated one.
export function primaryTierOf(tokensByTier: Record<string, number>, costByTier: Record<string, number>): string | null {
  const rank = (m: Record<string, number>) =>
    Object.entries(m).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
  return rank(tokensByTier) ?? rank(costByTier) ?? null;
}

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Builds the run prompt from the user's text plus any selected skill preset
// and their saved memories. Kept a pure function so it's unit-testable and so
// the ORIGINAL user text (not this augmented version) is what gets persisted.
export function buildRunPrompt(userPrompt: string, skillSystemPrompt: string | undefined, memories: string[]): string {
  const preamble: string[] = [];
  if (skillSystemPrompt) preamble.push(skillSystemPrompt);
  if (memories.length) {
    preamble.push(
      'Persistent facts about the user (they asked you to remember these):\n' +
        memories.map((m) => `- ${m}`).join('\n'),
    );
  }
  return preamble.length ? `${preamble.join('\n\n')}\n\n---\n\n${userPrompt}` : userPrompt;
}

export interface ChatRunDeps {
  env: CloudEnv;
  store: CloudStore;
  userId: string;
  socket: Socket;
  /** Aborts the run mid-flight (client "Stop", or socket disconnect). */
  signal?: AbortSignal;
}

export async function runChatTurn(payload: ChatRunPayload, deps: ChatRunDeps): Promise<ChatRunResult> {
  const { env, store, userId, socket } = deps;

  // Fail fast, before touching the conversation/DB at all — a rate-limited
  // request shouldn't leave behind a user message with no reply.
  const user = store.getUserById(userId);
  const plan = user?.plan ?? 'free';
  checkDailyLimit(store, userId, plan);
  const releaseRun = beginRun(userId, plan);

  try {
    return await runChatTurnInner(payload, deps);
  } finally {
    releaseRun();
  }
}

async function runChatTurnInner(payload: ChatRunPayload, deps: ChatRunDeps): Promise<ChatRunResult> {
  const { env, store, userId, socket, signal } = deps;

  const conversation = payload.conversationId
    ? store.getConversation(payload.conversationId, userId)
    : store.createConversation(userId, payload.prompt.slice(0, 80));
  if (!conversation) throw new Error('Conversation not found');

  const conversationHistory: ConversationMessage[] = store
    .getMessages(conversation.id)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role as ConversationMessage['role'], content: m.content }));

  // Load the images the client already uploaded (ownership-checked). Foreign
  // or missing ids are skipped silently rather than failing the whole run.
  const images: ImageAttachment[] = [];
  const loadedAttachments: CloudAttachment[] = [];
  for (const id of payload.attachmentIds ?? []) {
    const att = store.getOwnedAttachment(id, userId);
    if (!att || att.kind !== 'image' || !IMAGE_MIME_TYPES.has(att.mime)) continue;
    try {
      const bytes = await fs.readFile(att.path);
      images.push({ type: 'base64', data: bytes.toString('base64'), mimeType: att.mime as ImageAttachment['mimeType'] });
      loadedAttachments.push(att);
    } catch {
      /* file vanished from disk — skip it */
    }
  }

  // Persist the user's ORIGINAL text (not the skill/memory-augmented prompt),
  // then link its attachments so the transcript re-renders them on reload.
  const userMessage = store.addMessage({ conversationId: conversation.id, role: 'user', content: payload.prompt });
  for (const att of loadedAttachments) store.linkAttachmentToMessage(att.id, userId, userMessage.id);
  if (payload.skillId !== undefined) store.setConversationSkill(conversation.id, userId, payload.skillId ?? null);

  // A skillId resolves to either a built-in preset or one of the user's own
  // custom skills (UUID ids never collide with the fixed built-in ids). Bump
  // the custom skill's usage counter so the Skills page can show "used N×".
  const builtinSkill = getSkill(payload.skillId);
  const userSkill = !builtinSkill && payload.skillId ? store.getUserSkill(payload.skillId, userId) : null;
  if (userSkill) store.incrementSkillUsage(userSkill.id, userId);
  const skillSystemPrompt = builtinSkill?.systemPrompt || userSkill?.systemPrompt || undefined;
  const memories = store.listMemories(userId).map((m) => m.content);
  const runPrompt = buildRunPrompt(payload.prompt, skillSystemPrompt, memories);

  const scratchDir = tenantScratchDir(env, userId);
  const config = buildCloudConfig(payload.providers as ProviderConfig[], env.MAX_COST_PER_RUN_USD, {
    routingMode: payload.routingMode,
    forceTier: payload.forceTier,
    webSearch: payload.webSearch,
  });
  const cascade: Cascade = createCascade(config, scratchDir);

  // Accumulate which model served each tier — the model rides on every
  // tier:status event (base.ts setServingModel), and there's no post-run
  // getter for a tier→model map, so we build it from the stream.
  const tierModels: Record<string, string> = {};

  const onToken = (e: { text: string; tierId: string; primary?: boolean }) => {
    socket.emit('stream:token', { conversationId: conversation.id, ...e });
  };
  const onStatus = (e: unknown) => {
    const ev = e as { role?: string; model?: string };
    if (ev.role && ev.model) tierModels[ev.role] = ev.model;
    socket.emit('tier:status', { conversationId: conversation.id, ...(e as object) });
  };
  const onPlan = (e: unknown) => {
    socket.emit('plan:approval-required', { conversationId: conversation.id, ...(e as object) });
  };
  // Surface the SDK's own diagnostics (failed classifier, provider warnings) in
  // the server log — otherwise they vanished and a run just read "Task failed".
  const onLog = (e: unknown) => {
    const ev = e as { level?: string; message?: string };
    console.warn(`[run ${conversation.id}] ${ev.level ?? 'info'}: ${ev.message ?? ''}`);
  };
  cascade.on('stream:token', onToken);
  cascade.on('tier:status', onStatus);
  cascade.on('plan:approval-required', onPlan);
  cascade.on('log', onLog);

  try {
    const result = await cascade.run({
      prompt: runPrompt,
      images: images.length ? images : undefined,
      conversationHistory,
      workspacePath: scratchDir,
      // When aborted, cascade.run() resolves with a partial result (it does not
      // reject) and stops all tiers at the next safe checkpoint — so a runaway
      // run can be halted from the UI instead of burning the whole budget.
      signal,
    });

    // Build the run-explorer report the same way the desktop's captureWhy does:
    // the decision trail + delegation savings + per-tier economics, all from
    // getters on the same cascade handle.
    const stats = cascade.getRouter().getStats();
    const savings = cascade.getRouter().getDelegationSavings();
    const costByTier = result.costByTier ?? stats.costByTier ?? {};
    const tokensByTier = result.tokensByTier ?? stats.tokensByTier ?? {};
    const tier = primaryTierOf(tokensByTier, costByTier);
    const model = (tier && tierModels[tier]) || null;
    const why: WhyReport = {
      tier,
      model,
      decisions: cascade.getDecisionLog(),
      savedUsd: savings.savedUsd,
      savedPct: savings.savedPct,
      totalCostUsd: stats.totalCostUsd,
      totalTokens: stats.totalTokens,
      durationMs: result.durationMs,
      costByTier,
      tokensByTier,
      models: tierModels,
    };

    const assistantMessage = store.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: result.output,
      model,
      tier,
      why: JSON.stringify(why),
      costUsd: result.usage.estimatedCostUsd,
    });
    store.incrementUsage(userId, todayKey());
    const cancelled = signal?.aborted ?? false;
    socket.emit('run:why', { conversationId: conversation.id, messageId: assistantMessage.id, ...why });
    socket.emit('session:complete', { conversationId: conversation.id, result, cancelled });
    return {
      conversationId: conversation.id,
      output: result.output,
      costUsd: result.usage.estimatedCostUsd,
      totalTokens: result.usage.totalTokens ?? 0,
      tier,
      model,
      savedUsd: savings.savedUsd,
      savedPct: savings.savedPct,
      cancelled,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log the full error (with stack) server-side — the client only gets the
    // message, but the stack is what pins a crash like the FK violation.
    console.error(`[run ${conversation.id}] failed:`, err);
    socket.emit('session:error', { conversationId: conversation.id, error: message });
    throw err;
  } finally {
    cascade.off('log', onLog);
    cascade.off('stream:token', onToken);
    cascade.off('tier:status', onStatus);
    cascade.off('plan:approval-required', onPlan);
    try { await cascade.close(); } catch { /* non-critical */ }
  }
}
