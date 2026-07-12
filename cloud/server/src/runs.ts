// ─────────────────────────────────────────────
//  Cascade Cloud Server — Run Pipeline
// ─────────────────────────────────────────────
//
// Bridges an authenticated `chat:run` socket event to a per-tenant Cascade
// run. Always uses `createCascade` — never `runCascade`, which goes through
// ConfigManager and merges the machine-global ~/.cascade-ai/credentials.json.
// On a shared multi-tenant server that would leak one user's provider keys
// into another user's run.

import { createCascade } from 'cascade-ai';
import type { Cascade, CascadeConfig, ConversationMessage, ProviderConfig } from 'cascade-ai';
import path from 'node:path';
import type { Socket } from 'socket.io';
import { z } from 'zod';
import type { CloudEnv } from './env.js';
import type { CloudStore } from './db.js';
import { beginRun, checkDailyLimit, todayKey } from './entitlements.js';

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

export function tenantScratchDir(env: CloudEnv, userId: string): string {
  // WorldStateDB and the audit log write under <workspacePath>/.cascade/ —
  // a per-tenant directory keeps those files (and any dynamic-tool output)
  // from crossing between tenants.
  return path.join(path.resolve(env.DATA_DIR), 'tenants', userId);
}

export function buildCloudConfig(providers: ProviderConfig[], maxCostPerRunUsd: number): Partial<CascadeConfig> {
  return {
    providers,
    tools: {
      shellAllowlist: [],
      shellBlocklist: [],
      requireApprovalFor: [],
      browserEnabled: false,
      // v1 scope: chat + safe tools only. No shell/file/git exist for a
      // hosted run — not just approval-gated, genuinely absent from the
      // registry (see src/tools/registry.ts: enabledTools allowlist).
      enabledTools: ['web_search', 'web_fetch'],
    },
    knowledge: { factsExtraction: false },
    telemetry: { enabled: false },
    budget: { warnAtPct: 80, maxCostPerRunUsd },
  };
}

export interface ChatRunResult {
  conversationId: string;
  output: string;
  costUsd: number;
}

export interface ChatRunDeps {
  env: CloudEnv;
  store: CloudStore;
  userId: string;
  socket: Socket;
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
  const { env, store, userId, socket } = deps;

  const conversation = payload.conversationId
    ? store.getConversation(payload.conversationId, userId)
    : store.createConversation(userId, payload.prompt.slice(0, 80));
  if (!conversation) throw new Error('Conversation not found');

  const conversationHistory: ConversationMessage[] = store
    .getMessages(conversation.id)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role as ConversationMessage['role'], content: m.content }));

  store.addMessage({ conversationId: conversation.id, role: 'user', content: payload.prompt });

  const scratchDir = tenantScratchDir(env, userId);
  const config = buildCloudConfig(payload.providers as ProviderConfig[], env.MAX_COST_PER_RUN_USD);
  const cascade: Cascade = createCascade(config, scratchDir);

  const onToken = (e: { text: string; tierId: string; primary?: boolean }) => {
    socket.emit('stream:token', { conversationId: conversation.id, ...e });
  };
  const onStatus = (e: unknown) => {
    socket.emit('tier:status', { conversationId: conversation.id, ...(e as object) });
  };
  const onPlan = (e: unknown) => {
    socket.emit('plan:approval-required', { conversationId: conversation.id, ...(e as object) });
  };
  cascade.on('stream:token', onToken);
  cascade.on('tier:status', onStatus);
  cascade.on('plan:approval-required', onPlan);

  try {
    const result = await cascade.run({ prompt: payload.prompt, conversationHistory, workspacePath: scratchDir });
    store.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: result.output,
      costUsd: result.usage.estimatedCostUsd,
    });
    store.incrementUsage(userId, todayKey());
    socket.emit('session:complete', { conversationId: conversation.id, result });
    return { conversationId: conversation.id, output: result.output, costUsd: result.usage.estimatedCostUsd };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    socket.emit('session:error', { conversationId: conversation.id, error: message });
    throw err;
  } finally {
    cascade.off('stream:token', onToken);
    cascade.off('tier:status', onStatus);
    cascade.off('plan:approval-required', onPlan);
    try { await cascade.close(); } catch { /* non-critical */ }
  }
}
