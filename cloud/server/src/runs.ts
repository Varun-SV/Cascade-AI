// ─────────────────────────────────────────────
//  Cascade Cloud Server — Run Pipeline
// ─────────────────────────────────────────────
//
// Bridges an authenticated `chat:run` socket event to a per-tenant Cascade
// run. Always uses `createCascade` — never `runCascade`, which goes through
// ConfigManager and merges the machine-global ~/.cascade-ai/credentials.json.
// On a shared multi-tenant server that would leak one user's provider keys
// into another user's run.

import {
  createCascade, Retriever, chunkText, embedderFromProviders,
  LLMReranker, chatCompleterFromProviders, planRetrieval, cagCharBudget,
  distillSessionFacts, buildSessionTranscript, sessionWorthRemembering,
  azureModelForDeployment, DEFAULT_CONTEXT_LIMIT, MODELS,
} from '#cascade-ai';
import type { Cascade, CascadeConfig, ConversationMessage, ImageAttachment, ProviderConfig } from '#cascade-ai';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Socket } from 'socket.io';
import { z } from 'zod';
import type { CloudEnv } from './env.js';
import { resolveRunMcpServers } from './mcp-oauth.js';
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

// Per-tier generation knobs (Advanced). Both optional; bounded so a bad client
// value can't ask for an absurd budget or an out-of-range temperature.
const TierParamSchema = z
  .object({
    maxTokens: z.number().int().positive().max(200_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .optional();

// Keys are browser-held and travel with the run request only — never
// persisted server-side (see db.ts: no api key column anywhere).
const ChatRunPayloadSchema = z.object({
  conversationId: z.string().optional(),
  prompt: z.string().min(1).max(20_000),
  // Branching: editing an existing user turn. The new (edited) user message is
  // saved as a SIBLING of this one — same parent, a fresh branch — so the
  // original prompt and its answer aren't overwritten. The server derives the
  // parent (null → a new root branch); the client only names the edited message.
  editOfMessageId: optionalNonEmptyString,
  // Branching: regenerate a reply for an existing user message. When set, no new
  // user message is created — the run re-answers that user turn and the reply is
  // saved as a sibling of the previous answer. `prompt` still carries its text.
  regenerateFromUserMessageId: optionalNonEmptyString,
  // Ids of images/documents the client already uploaded via POST /api/uploads.
  // Loaded and ownership-checked server-side; unknown/foreign ids are ignored.
  attachmentIds: z.array(z.string()).max(8).optional(),
  // Selected prompt-preset ("skill"). Unknown ids resolve to no preset.
  skillId: optionalNonEmptyString,
  // Run-explorer controls. routingMode biases Cascade Auto; forceTier pins the
  // root tier; webSearch toggles the two hosted tools on/off for this run.
  routingMode: z.enum(['auto', 'quality', 'fast']).optional(),
  forceTier: z.enum(['auto', 'T1', 'T2', 'T3']).optional(),
  // "Fast answer": bypass orchestration and reply with one mid-tier model.
  // fastAnswerModel optionally pins the model; otherwise it's auto-selected.
  fastAnswer: z.boolean().optional(),
  fastAnswerModel: optionalNonEmptyString,
  // Advanced per-tier generation parameters (developer knobs). maxTokens is a
  // per-tier output ceiling; temperature (0–2) is applied to non-deterministic
  // calls on that tier. Each field optional; omitted → SDK defaults.
  tierParams: z
    .object({
      t1: TierParamSchema,
      t2: TierParamSchema,
      t3: TierParamSchema,
    })
    .partial()
    .optional(),
  // Extended context: compact history/input that exceeds the model's window.
  // maxMultiplier caps how far past the window an input may go before truncation.
  extendedContext: z
    .object({
      enabled: z.boolean().optional(),
      maxMultiplier: z.number().min(1).max(5).optional(),
    })
    .optional(),
  // Optional complexity verdict computed on the user's device (opt-in browser
  // model). When present, the orchestrator skips its own classifier LLM call and
  // starts from this — its heuristic floors + escalation still apply as
  // guardrails. Ignored when a tier is pinned via forceTier.
  complexityHint: z.enum(['Simple', 'Moderate', 'Complex']).optional(),
  // Contribute this run's anonymous model-outcome stats to the shared learning
  // pool. Only a Pro user's `false` opts out; free users always contribute
  // (enforced server-side against the user's plan).
  shareLearning: z.boolean().optional(),
  // Hard per-run token ceiling — stops a runaway multi-agent run. Bounded so a
  // client can't ask for an absurd budget; the per-run COST cap still applies.
  maxTokensPerRun: z.number().int().min(1_000).max(2_000_000).optional(),
  // Hard per-run cost ceiling in USD (the user pays with their own keys). When
  // set, overrides the server's default safety rail. Bounded so a typo can't
  // disable the guard entirely or set an absurd ceiling.
  maxCostPerRunUsd: z.number().min(0.05).max(25).optional(),
  // Opt-in: after the run, distill the conversation into durable memories that
  // future runs will see. Off unless the user turns it on (privacy + cost).
  rememberSession: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  // Optional web-search backend the user configured (browser-held, like keys).
  // Whichever field is set is used — SearXNG → Brave → Tavily priority in the
  // tool. Absent → the tool's keyless DuckDuckGo fallback.
  webSearchConfig: z
    .object({
      searxngUrl: optionalNonEmptyString,
      braveApiKey: optionalNonEmptyString,
      tavilyApiKey: optionalNonEmptyString,
    })
    .optional(),
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

export interface WebSearchBackend {
  searxngUrl?: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
}

export interface TierParam {
  maxTokens?: number;
  temperature?: number;
}

export interface RunControls {
  routingMode?: 'auto' | 'quality' | 'fast';
  forceTier?: 'auto' | 'T1' | 'T2' | 'T3';
  /** When false, no tools are registered for the run at all. Default true. */
  webSearch?: boolean;
  /** User-configured web-search backend (browser-held). Used only when webSearch is on. */
  webSearchConfig?: WebSearchBackend;
  /** Advanced per-tier generation params (developer knobs). */
  tierParams?: { t1?: TierParam; t2?: TierParam; t3?: TierParam };
  /** Extended context: compact oversized history/input to fit the model window. */
  extendedContext?: { enabled?: boolean; maxMultiplier?: number };
  /** Where the shared model-performance stats live (→ the persistent volume). */
  perfStatsPath?: string;
  /** When false, read shared scores but don't record this run's outcomes. */
  learnFromOutcomes?: boolean;
  /** Where the live-benchmark snapshot is cached (→ the persistent volume). */
  benchmarksCacheFile?: string;
  /** Hard per-run token ceiling (overrides the SDK default). */
  maxTokensPerRun?: number;
  /** Remote MCP servers (with auth headers) to attach as tool sources. */
  mcpServers?: Array<{ name: string; url: string; headers?: Record<string, string> }>;
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
  // Only pass a backend when web search is on AND the user actually configured
  // one — otherwise leave webSearch unset so the tool uses its keyless fallback.
  const wsc = controls.webSearchConfig;
  const hasBackend = !!(wsc && (wsc.searxngUrl || wsc.braveApiKey || wsc.tavilyApiKey));
  // Advanced per-tier params → SDK tierLimits. Only include keys the client
  // actually set, so unset knobs fall through to the SDK defaults.
  const tp = controls.tierParams;
  const tierLimits = tp
    ? {
        ...(tp.t1?.maxTokens !== undefined ? { t1MaxTokens: tp.t1.maxTokens } : {}),
        ...(tp.t1?.temperature !== undefined ? { t1Temperature: tp.t1.temperature } : {}),
        ...(tp.t2?.maxTokens !== undefined ? { t2MaxTokens: tp.t2.maxTokens } : {}),
        ...(tp.t2?.temperature !== undefined ? { t2Temperature: tp.t2.temperature } : {}),
        ...(tp.t3?.maxTokens !== undefined ? { t3MaxTokens: tp.t3.maxTokens } : {}),
        ...(tp.t3?.temperature !== undefined ? { t3Temperature: tp.t3.temperature } : {}),
      }
    : undefined;
  const ec = controls.extendedContext;
  return {
    providers,
    cascadeAuto: true,
    autoBias: BIAS_BY_MODE[controls.routingMode ?? 'auto'] ?? 'balanced',
    routing: {
      forceTier: controls.forceTier ?? 'auto',
      ...(controls.perfStatsPath ? { perfStatsPath: controls.perfStatsPath } : {}),
      ...(controls.learnFromOutcomes === false ? { learnFromOutcomes: false } : {}),
    },
    ...(tierLimits && Object.keys(tierLimits).length ? { tierLimits } : {}),
    ...(ec?.enabled ? { extendedContext: { enabled: true, maxMultiplier: ec.maxMultiplier ?? 2 } } : {}),
    // Cascade Auto already fetches live public benchmark scores (benchmarks.live
    // defaults on); pointing the cache at the volume makes those scores persist
    // across requests + redeploys instead of re-fetching on every fresh Cascade.
    ...(controls.benchmarksCacheFile ? { benchmarks: { cacheFile: controls.benchmarksCacheFile } } : {}),
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
      // Remote MCP servers the user attached. Their names are pre-trusted so
      // they connect without an interactive gate (the hosted run auto-proceeds);
      // the SSRF guard + https-only check already ran at add time. MCP tools
      // register outside the enabledTools allowlist, so they're available even
      // when the web toggle is off.
      ...(controls.mcpServers?.length
        ? { mcpServers: controls.mcpServers, mcpTrusted: controls.mcpServers.map((s) => s.name) }
        : {}),
    },
    ...(webSearchOn && hasBackend
      ? { webSearch: { searxngUrl: wsc!.searxngUrl, braveApiKey: wsc!.braveApiKey, tavilyApiKey: wsc!.tavilyApiKey } }
      : {}),
    knowledge: { factsExtraction: false },
    telemetry: { enabled: false },
    // A hosted run has no shell/file tools; leaving runtime tool-creation on made
    // the worker synthesize a phantom write_file, call it, produce nothing, and
    // fail. Off — the worker delivers files via the `file:` fence instead.
    enableToolCreation: false,
    persistDynamicTools: false,
    budget: { warnAtPct: 80, maxCostPerRunUsd, ...(controls.maxTokensPerRun ? { maxTokensPerRun: controls.maxTokensPerRun } : {}) },
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

/** A document attachment resolved to plain text, ready to inject into a run. */
export interface RunDocument {
  filename: string;
  text: string;
}

// Builds the run prompt from the user's text plus any selected skill preset,
// their saved memories, and the text of any attached documents. Kept a pure
// function so it's unit-testable and so the ORIGINAL user text (not this
// augmented version) is what gets persisted.
export function buildRunPrompt(
  userPrompt: string,
  skillSystemPrompt: string | undefined,
  memories: string[],
  documents: RunDocument[] = [],
): string {
  const preamble: string[] = [];
  if (skillSystemPrompt) preamble.push(skillSystemPrompt);
  if (memories.length) {
    preamble.push(
      'Persistent facts about the user (they asked you to remember these):\n' +
        memories.map((m) => `- ${m}`).join('\n'),
    );
  }
  if (documents.length) {
    const blocks = documents.map(
      (d) => `<document filename="${d.filename.replace(/"/g, '&quot;')}">\n${d.text}\n</document>`,
    );
    preamble.push(
      `The user attached ${documents.length === 1 ? 'a document' : `${documents.length} documents`}. ` +
        'Use their contents as context for the request below:\n\n' +
        blocks.join('\n\n'),
    );
  }
  return preamble.length ? `${preamble.join('\n\n')}\n\n---\n\n${userPrompt}` : userPrompt;
}

/**
 * Steers a hosted run (no disk tools) to deliver files as downloadable blocks.
 * Deliberately contains NO fenced example — small models echoed the literal
 * example block (a phantom `report.md`) into replies to unrelated prompts —
 * and is only injected when the request actually looks file-shaped
 * (see wantsFileDelivery).
 */
export const FILE_DELIVERY_GUIDANCE =
  'File delivery: you cannot write files to disk in this environment. ONLY when the user explicitly '
  + 'asks for a file, document or export (a report, a code file, a CSV, etc.), output its FULL contents '
  + 'in a fenced code block whose info string is `file:<filename.ext>` — i.e. the opening fence line '
  + 'reads file:report.md for a file named report.md. Use one block per file with a sensible filename '
  + 'and extension; the user can download or save each one. '
  + 'For an Office/PDF document, write the SOURCE and name the block with the target extension — Cascade '
  + 'renders the real binary on download: a file:<name>.pdf block whose body is Markdown becomes a PDF; '
  + 'a file:<name>.xlsx block whose body is CSV becomes an Excel spreadsheet. For every other request, '
  + 'answer in plain prose or ordinary code blocks — never emit a file: block the user did not ask for.';

/**
 * Should this turn carry the file-delivery guidance? True when the user's own
 * text (or the active skill) plausibly asks for a file/document/export, or when
 * the previous assistant turn already delivered a `file:` block (so follow-up
 * edits like "change the title" keep the format). Reads ONLY the raw user
 * prompt + skill — never memories or the augmented prompt, which would
 * re-trigger it forever after one file-ish memory.
 */
export function wantsFileDelivery(
  userPrompt: string,
  skillSystemPrompt?: string,
  history?: Array<{ role: string; content: unknown }>,
): boolean {
  const FILEISH =
    /\b(files?|documents?|reports?|export(?:ed|able)?|csv|spreadsheet|pdf|docx?|xlsx?|markdown|download(?:able)?|save (?:it|this|that|as)|write (?:up|out|to)|deliverable)\b|\.(?:md|txt|csv|json|pdf|html?|docx?|xlsx?)\b/i;
  if (FILEISH.test(userPrompt)) return true;
  if (skillSystemPrompt && FILEISH.test(skillSystemPrompt)) return true;
  const lastAssistant = [...(history ?? [])].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant && typeof lastAssistant.content === 'string' && lastAssistant.content.includes('```file:')) {
    return true;
  }
  return false;
}

/** Passages to inject when retrieving. */
const RAG_TOP_K = 8;

/**
 * The context window (in tokens) this run can rely on, taken conservatively as
 * the smallest window among the models the user has actually pinned — Azure
 * deployments (the deployment name IS the model) and any explicit fast-answer
 * model. Unpinned cloud providers fall back to the SDK's default window. The
 * document budget is derived from this, so a big-window setup injects big docs
 * in full while a small one retrieves sooner — no fixed byte cliff.
 */
export function runContextWindowTokens(providers: ProviderConfig[], fastAnswerModel?: string): number {
  const windows: number[] = [];
  for (const p of providers) {
    if (p.type === 'azure') {
      const m = azureModelForDeployment(p);
      if (m?.contextWindow) windows.push(m.contextWindow);
    }
  }
  if (fastAnswerModel) {
    const id = fastAnswerModel.includes(':') ? fastAnswerModel.split(':').slice(1).join(':') : fastAnswerModel;
    const cw = MODELS[id]?.contextWindow;
    if (cw) windows.push(cw);
  }
  return windows.length ? Math.min(...windows) : DEFAULT_CONTEXT_LIMIT;
}

/**
 * Decide how attached documents enter the run. Small total → inject in full
 * (CAG). Large total → chunk + embed each doc (cached by attachment + embed
 * model) and inject only the passages most relevant to the prompt (RAG). Falls
 * back to full injection when there's no embeddings-capable key or retrieval
 * errors, and emits a `knowledge:retrieved` notice so the client can show what
 * happened. A fast answer is a single direct call, so docs pass through as-is.
 */
async function resolveDocuments(
  docSources: Array<{ sourceId: string; filename: string; text: string }>,
  payload: ChatRunPayload,
  store: CloudStore,
  userId: string,
  conversationId: string,
  socket: Socket,
): Promise<RunDocument[]> {
  const full = (): RunDocument[] => docSources.map((d) => ({ filename: d.filename, text: d.text }));

  // Adaptive decision: none / CAG (inject in full) / RAG (retrieve passages).
  // The CAG budget is derived from the run's real context window, so ordinary
  // documents (a 52 KB file is only ~13k tokens) are injected in full and never
  // pushed to retrieval — retrieval is reserved for corpora that genuinely
  // wouldn't fit the window.
  const totalChars = docSources.reduce((n, d) => n + d.text.length, 0);
  const windowTokens = runContextWindowTokens(payload.providers as ProviderConfig[], payload.fastAnswerModel);
  const plan = planRetrieval({
    sourceCount: docSources.length,
    totalChars,
    cagCharBudget: cagCharBudget(windowTokens),
    fastAnswer: payload.fastAnswer,
  });
  if (plan.mode !== 'rag') return full();

  const embedder = embedderFromProviders(payload.providers as ProviderConfig[]);
  if (!embedder) {
    // Only reached for a corpus too large for the window AND no embeddings-
    // capable key. We still inject the whole document — nothing is silently
    // trimmed here — so the notice reflects that honestly and points at every
    // provider that would unlock passage retrieval, not just OpenAI.
    socket.emit('knowledge:retrieved', { conversationId, mode: 'nokey', docCount: docSources.length });
    return full();
  }
  try {
    // Second stage: an LLM reranker over the fused candidates, when the user
    // has a chat-capable key. Reuses their own model; no extra key/dependency.
    const complete = chatCompleterFromProviders(payload.providers as ProviderConfig[], {
      model: payload.fastAnswerModel,
    });
    const reranker = complete ? new LLMReranker({ complete }) : undefined;

    const retriever = new Retriever(embedder, store.getVectorStore(), reranker);
    for (const d of docSources) {
      if (!retriever.isIndexed(userId, d.sourceId)) {
        await retriever.index(userId, d.sourceId, chunkText(d.text));
      }
    }
    const hits = await retriever.search(payload.prompt, {
      namespace: userId, sourceIds: docSources.map((d) => d.sourceId), k: RAG_TOP_K, candidates: 40,
    });
    if (hits.length === 0) return full();

    const nameById = new Map(docSources.map((d) => [d.sourceId, d.filename]));
    const grouped = new Map<string, string[]>();
    for (const h of hits) {
      const arr = grouped.get(h.sourceId) ?? [];
      arr.push(h.text);
      grouped.set(h.sourceId, arr);
    }
    socket.emit('knowledge:retrieved', {
      conversationId, mode: 'searched', docCount: docSources.length, passages: hits.length, reranked: !!reranker,
    });
    return [...grouped.entries()].map(([sid, passages]) => ({
      filename: nameById.get(sid) ?? 'document',
      text: passages.join('\n\n[…]\n\n'),
    }));
  } catch {
    return full();
  }
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

  // ── Branch resolution (conversation tree) ──
  // A conversation is a tree; a run appends to ONE path through it. Any client-
  // supplied branch target is looked up and confirmed to belong to THIS
  // conversation (and to be a user turn), so a foreign id can never splice
  // another chat's history into the run — anything invalid falls back to a
  // normal append at the tip.
  const ownedUserTurn = (id: string | null | undefined) => {
    if (!id) return null;
    const m = store.getMessageById(id);
    return m && m.conversationId === conversation.id && m.role === 'user' ? m : null;
  };

  // Regenerate: re-answer an existing user turn, saving the reply as a sibling of
  // the previous answer (no new user message).
  const regenUserMsg = ownedUserTurn(payload.regenerateFromUserMessageId);
  const isRegenerate = regenUserMsg !== null;
  // Edit: the new user turn becomes a sibling of the edited one (same parent).
  const editedMsg = isRegenerate ? null : ownedUserTurn(payload.editOfMessageId);

  // The message the new user turn hangs under (its parent). Regenerate stops just
  // above the re-answered turn; an edit forks from the edited turn's own parent
  // (null → a new root branch); a normal send appends at the active leaf.
  const branchParentId = isRegenerate
    ? regenUserMsg!.parentId
    : editedMsg ? editedMsg.parentId
    : conversation.activeLeafId;

  // History = the path from the root down to the branch point (excludes the
  // current user turn, which rides in as the prompt).
  const conversationHistory: ConversationMessage[] = (branchParentId ? store.getPathToMessage(branchParentId) : [])
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role as ConversationMessage['role'], content: m.content }));

  // Load the images/documents the client already uploaded (ownership-checked).
  // Foreign or missing ids are skipped silently rather than failing the run.
  // Images ride into the run as multimodal input; documents were parsed to text
  // at upload time and get injected into the prompt below.
  const images: ImageAttachment[] = [];
  const docSources: Array<{ sourceId: string; filename: string; text: string }> = [];
  const loadedAttachments: CloudAttachment[] = [];
  for (const id of payload.attachmentIds ?? []) {
    const att = store.getOwnedAttachment(id, userId);
    if (!att) continue;
    if (att.kind === 'image' && IMAGE_MIME_TYPES.has(att.mime)) {
      try {
        const bytes = await fs.readFile(att.path);
        images.push({ type: 'base64', data: bytes.toString('base64'), mimeType: att.mime as ImageAttachment['mimeType'] });
        loadedAttachments.push(att);
      } catch {
        /* file vanished from disk — skip it */
      }
    } else if (att.kind === 'document') {
      const text = store.getOwnedAttachmentText(att.id, userId);
      if (text && text.trim()) {
        docSources.push({ sourceId: att.id, filename: att.filename || 'document', text });
        loadedAttachments.push(att);
      }
    }
  }

  // CAG-or-RAG switch. Small/stable doc context is injected in full (cache-
  // augmented generation — the model reads everything). When the attached docs
  // exceed a token budget, switch to retrieval: chunk + embed each doc (cached
  // by attachment + embed model, so re-runs are free) and inject only the most
  // relevant passages for this prompt. A fast answer skips docs entirely.
  const documents: RunDocument[] = await resolveDocuments(
    docSources, payload, store, userId, conversation.id, socket,
  );

  // Persist the user's ORIGINAL text (not the skill/memory-augmented prompt) as
  // a child of the branch point, then link its attachments so the transcript
  // re-renders them on reload. On a regenerate there's no new user turn — the
  // reply attaches to the EXISTING user message being re-answered.
  const userMessage = isRegenerate
    ? regenUserMsg!
    : store.addMessage({ conversationId: conversation.id, role: 'user', content: payload.prompt, parentId: branchParentId });
  if (!isRegenerate) {
    for (const att of loadedAttachments) store.linkAttachmentToMessage(att.id, userId, userMessage.id);
  }
  if (payload.skillId !== undefined) store.setConversationSkill(conversation.id, userId, payload.skillId ?? null);

  // A skillId resolves to either a built-in preset or one of the user's own
  // custom skills (UUID ids never collide with the fixed built-in ids). Bump
  // the custom skill's usage counter so the Skills page can show "used N×".
  const builtinSkill = getSkill(payload.skillId);
  const userSkill = !builtinSkill && payload.skillId ? store.getUserSkill(payload.skillId, userId) : null;
  if (userSkill) store.incrementSkillUsage(userSkill.id, userId);
  const skillSystemPrompt = builtinSkill?.systemPrompt || userSkill?.systemPrompt || undefined;
  const memories = store.listMemories(userId).map((m) => m.content);
  // A hosted run can't write files to disk; when the request actually looks
  // file-shaped, steer it to deliver files as `file:`-tagged fenced blocks so
  // the web can turn them into downloads. Injecting this on EVERY turn made
  // small models echo the guidance as phantom files on a bare "hi".
  const fileGuidance = wantsFileDelivery(payload.prompt, skillSystemPrompt, conversationHistory)
    ? FILE_DELIVERY_GUIDANCE
    : undefined;
  const systemGuidance = [fileGuidance, skillSystemPrompt].filter(Boolean).join('\n\n');
  const runPrompt = buildRunPrompt(payload.prompt, systemGuidance, memories, documents);

  const scratchDir = tenantScratchDir(env, userId);
  // Shared learning pool: one anonymous model-outcome dataset on the same
  // durable dir as the DB (survives redeploys). Free users always contribute so
  // routing improves for everyone; a Pro user's explicit opt-out is honored.
  // The plan is read server-side so a client can't opt a free account out.
  const plan = store.getUserById(userId)?.plan ?? 'free';
  const learnFromOutcomes = plan === 'pro' ? payload.shareLearning !== false : true;
  const dataDir = path.resolve(env.DATA_DIR);
  const perfStatsPath = path.join(dataDir, 'model-perf.json');
  const benchmarksCacheFile = path.join(dataDir, 'benchmarks-cache.json');

  // Attach the user's enabled remote MCP servers (with their stored auth) as
  // tool sources for this run. A fast answer is a single direct model call with
  // no orchestration/tools, so skip MCP there.
  const mcpServers = payload.fastAnswer ? [] : await resolveRunMcpServers(store, userId, env.SESSION_SECRET);

  // The user can raise/lower the per-run cost cap (their own keys pay); fall
  // back to the server's safety-rail default when they haven't set one.
  const costCap = payload.maxCostPerRunUsd ?? env.MAX_COST_PER_RUN_USD;
  const config = buildCloudConfig(payload.providers as ProviderConfig[], costCap, {
    routingMode: payload.routingMode,
    forceTier: payload.forceTier,
    webSearch: payload.webSearch,
    webSearchConfig: payload.webSearchConfig,
    tierParams: payload.tierParams,
    extendedContext: payload.extendedContext,
    perfStatsPath,
    learnFromOutcomes,
    benchmarksCacheFile,
    maxTokensPerRun: payload.maxTokensPerRun,
    mcpServers: mcpServers.length ? mcpServers : undefined,
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
    // Surface the boardroom plan to the client (read-only), then immediately
    // approve so the hosted run proceeds. The SDK's plan gate BLOCKS for 120s
    // whenever a listener is attached and never resolved — registering this
    // listener without resolving would stall every plan-gated run. Hosted v1
    // has no risky tools to gate, so auto-proceed is the intended behaviour;
    // the client just shows what Cascade planned.
    socket.emit('plan:approval-required', { conversationId: conversation.id, ...(e as object) });
    cascade.resolvePlanApproval(true);
  };
  // Surface the SDK's own diagnostics (failed classifier, provider warnings) in
  // the server log — otherwise they vanished and a run just read "Task failed".
  const onLog = (e: unknown) => {
    const ev = e as { level?: string; message?: string };
    console.warn(`[run ${conversation.id}] ${ev.level ?? 'info'}: ${ev.message ?? ''}`);
  };
  // Extended context: forward the confirm request to the client and resolve the
  // SDK gate from the client's decision (context:decision). Also surface the
  // "compacted" notice. The decision handler is scoped to this run and removed
  // in the finally block. If the client never answers, the SDK gate times out
  // and proceeds — the run's budget cap is the real guardrail.
  const onContextApproval = (e: unknown) =>
    socket.emit('context:approval-required', { conversationId: conversation.id, ...(e as object) });
  const onCompacted = (e: unknown) =>
    socket.emit('context:compacted', { conversationId: conversation.id, ...(e as object) });
  const onContextDecision = (d: { approved?: boolean }) => cascade.resolveContextApproval(!!d?.approved);
  cascade.on('context:approval-required', onContextApproval);
  cascade.on('context:compacted', onCompacted);
  socket.on('context:decision', onContextDecision);

  cascade.on('stream:token', onToken);
  cascade.on('tier:status', onStatus);
  cascade.on('plan:approval-required', onPlan);
  cascade.on('log', onLog);

  try {
    const result = await cascade.run({
      prompt: runPrompt,
      // Routing must see the user's actual message, not the augmented prompt —
      // otherwise the prepended guidance/memories make even "hi" read Complex.
      routingPrompt: payload.prompt,
      images: images.length ? images : undefined,
      conversationHistory,
      workspacePath: scratchDir,
      // On-device complexity verdict (opt-in browser model). Lets the
      // orchestrator skip its own classifier LLM call; a pinned tier overrides
      // it, and the SDK's heuristic floors + escalation still guard against a
      // small model's miss.
      complexityHint: payload.forceTier && payload.forceTier !== 'auto' ? undefined : payload.complexityHint,
      // "Fast answer": one mid-tier model, no orchestration/tools. Overrides the
      // routing controls above (they don't apply to a single direct call).
      fastAnswer: payload.fastAnswer,
      fastAnswerModel: payload.fastAnswerModel,
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
      // Reply hangs under the user turn — a fresh answer for a normal/edited turn,
      // or a sibling of the previous answer when regenerating. This also moves the
      // conversation's active leaf onto this new branch.
      parentId: userMessage.id,
      model,
      tier,
      why: JSON.stringify(why),
      costUsd: result.usage.estimatedCostUsd,
    });
    store.incrementUsage(userId, todayKey());
    const cancelled = signal?.aborted ?? false;
    socket.emit('run:why', { conversationId: conversation.id, messageId: assistantMessage.id, ...why });
    socket.emit('session:complete', { conversationId: conversation.id, result, cancelled });

    // Opt-in session → memory: distill the conversation into durable memories the
    // user's future runs will see (they're injected via buildRunPrompt). Best-
    // effort and non-blocking; skips trivial exchanges. The user manages/prunes
    // these from the Memory panel exactly like hand-added ones.
    if (payload.rememberSession && !cancelled && sessionWorthRemembering(conversationHistory, payload.prompt, result.output)) {
      void (async () => {
        try {
          const transcript = buildSessionTranscript(conversationHistory, payload.prompt, result.output);
          const facts = await distillSessionFacts(transcript, async (p) => {
            const r = await cascade.getRouter().generate('T3', { messages: [{ role: 'user', content: p }], maxTokens: 300, temperature: 0 });
            return r.content;
          });
          const existing = new Set(store.listMemories(userId).map((m) => m.content));
          for (const f of facts) {
            const content = `${f.entity} ${f.relation} ${f.value}`.slice(0, 2000);
            if (!existing.has(content)) { store.addMemory(userId, content, 'session'); existing.add(content); }
          }
        } catch { /* best-effort — never affects the run */ }
      })();
    }
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
    cascade.off('context:approval-required', onContextApproval);
    cascade.off('context:compacted', onCompacted);
    socket.off('context:decision', onContextDecision);
    try { await cascade.close(); } catch { /* non-critical */ }
  }
}
