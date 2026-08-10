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
import { z } from 'zod';
import type { CloudEnv } from './env.js';
import { resolveRunMcpServers } from './mcp-oauth.js';
import type { CloudAttachment, CloudStore } from './db.js';
import { beginRun, checkDailyLimit, checkPendingMediaCap, PENDING_MEDIA_TTL_MS, todayKey } from './entitlements.js';
import { getSkill } from './skills.js';
import { tenantScratchDir } from './paths.js';
import { pendingMediaDir, sweepPendingMedia } from './pending-media.js';

export { tenantScratchDir };

const MAX_HISTORY_MESSAGES = 20;
const PROVIDER_TYPES = ['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible', 'ollama'] as const;

/**
 * Types this server used to accept and no longer does. Filtered out of an
 * incoming payload rather than rejected, so a client that predates the removal
 * degrades to "that provider is ignored" instead of "nothing works".
 */
const RETIRED_PROVIDER_TYPES = new Set<string>(['github-models']);

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
  // Prior turns to persist as this conversation's history AT CREATION TIME.
  // Only read when no conversationId is given.
  //
  // This exists because a stateless caller (the OpenAI-compatible endpoint)
  // resends its whole message array every request and has no conversation to
  // point at. Seeding it here rather than in the route is deliberate:
  // runChatTurn runs checkDailyLimit + beginRun BEFORE calling this function,
  // so a request that is over its daily cap or has no concurrency slot is
  // refused without leaving a conversation and a transcript behind. Importing
  // in the route put megabytes of messages on disk for a request that then
  // returned 429 — repeatable, and invisible until storage filled up.
  seedHistory: z
    .array(z.object({
      role: z.enum(['user', 'assistant']),
      // Same per-message ceiling app.ts applies to a persisted turn, so a
      // message's size does not depend on which door it came in.
      content: z.string().min(1).max(500_000),
    }))
    .max(200)
    .optional(),
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
  // Caller-supplied system instructions. This is where an OpenAI-compatible
  // request's `system`/`developer` messages land: they steer the run exactly
  // like a skill preset does, and must NOT be folded into `prompt` — routing
  // reads the bare user text (see routingPrompt below), so prepending a system
  // preamble there would make even "hi" classify as Complex.
  systemPrompt: z.string().max(20_000).optional().transform((v) => (v === '' ? undefined : v)),
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
    .preprocess(
      // Drop provider types this build no longer supports BEFORE the enum
      // sees them. A browser tab that was already open across the rollout
      // keeps sending its in-memory list until the page is reloaded, and the
      // localStorage migration only runs in freshly loaded assets — so
      // without this, every run from that tab fails outright even when it
      // also carries a perfectly usable provider. Being liberal at a version
      // boundary is the same posture the config and sync migrations take.
      //
      // Filtering here rather than after validation matters: `.min(1)` below
      // then judges what remains, so a payload whose ONLY provider was retired
      // is still rejected — it genuinely has nothing to run with — while one
      // that also carries a usable provider proceeds on that provider alone.
      (v) => (Array.isArray(v)
        ? v.filter((p) => !RETIRED_PROVIDER_TYPES.has(String((p as { type?: unknown } | null)?.type ?? '')))
        : v),
      z
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
        // KeyVault's SELECTABLE_TYPES offers 4 single-instance cloud types
        // (anthropic, openai, gemini, openai-compatible) plus Azure, which
        // alone supports MULTIPLE deployments — each its own resource and
        // endpoint, one array entry per deployment. So the ceiling is really
        // "the singles, plus however many Azure deployments you run".
        //
        // Deliberately NOT lowered when github-models was removed. The bound
        // exists to stop an absurd payload, not to state the exact shape of a
        // maximal config, and tightening it to match today's dropdown would
        // start rejecting a config that was valid before — 4 singles plus 3
        // Azure deployments, say. A cap that shrinks under users is worse than
        // one with a little slack.
        .max(7),
    ),
});

export type ChatRunPayload = z.infer<typeof ChatRunPayloadSchema>;

export function parseChatRunPayload(input: unknown): ChatRunPayload {
  return ChatRunPayloadSchema.parse(input);
}

/**
 * What a run needs from its transport, and nothing more.
 *
 * This was `socket.io`'s `Socket`, which pinned the whole run pipeline to one
 * transport: every one of the 18 uses in this file is a fire-and-forget `emit`
 * plus a pair of `on`/`off` for the client's extended-context and escalation
 * answers. Naming that surface structurally is what lets a second caller — the
 * OpenAI-compatible HTTP endpoint, which has an SSE response rather than a
 * socket — reuse `runChatTurn` unchanged instead of forking it. A real
 * `Socket` satisfies this interface as-is, so the web path is untouched.
 */
export interface RunSocket {
  emit(event: string, payload: unknown): unknown;
  // `any[]` rather than a narrower tuple because socket.io declares `on`/`off`
  // as function-valued PROPERTIES, not methods — so strictFunctionTypes checks
  // them contravariantly and only `any` is assignable in both directions. A
  // real `Socket` has to satisfy this interface unchanged; that is the whole
  // point of naming it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): unknown;
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
  /** Registered MCP tool names the user switched off in Settings. */
  disabledTools?: string[];
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
      // Per-tool selection. Deselected tools are left UNREGISTERED rather than
      // refused at call time, so the model never sees them and can't propose a
      // tool the user has turned off.
      ...(controls.disabledTools?.length ? { disabledTools: controls.disabledTools } : {}),
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
export interface PromptMemory {
  content: string;
  durability: 'permanent' | 'volatile';
}

/**
 * Render saved memories as a small markdown document rather than one flat
 * bullet list.
 *
 * Two headings, because the two kinds want to be read differently: a permanent
 * fact ("I write Python") should be weighted the same in six months, while a
 * volatile one ("I'm migrating the billing service this week") is a snapshot
 * that may already be wrong. Flattening them together gave the model no way to
 * tell which was which, so a months-old sprint note read as durable truth.
 *
 * This is a rendering, not a storage format — the rows stay individually
 * addressable, so a stale line can be edited or deleted on its own and the
 * prompt cost stays proportional to what is actually kept.
 */
export function renderMemoryMarkdown(memories: PromptMemory[]): string {
  const permanent = memories.filter((m) => m.durability !== 'volatile');
  const volatile = memories.filter((m) => m.durability === 'volatile');
  const out: string[] = ['# What you know about this user'];
  if (permanent.length) {
    out.push('', '## Stable facts', 'These hold across conversations — treat them as durable.', '');
    out.push(...permanent.map((m) => `- ${m.content}`));
  }
  if (volatile.length) {
    out.push(
      '', '## Current context',
      'True as of recently, and liable to change. Prefer what the user says now if it conflicts.', '',
    );
    out.push(...volatile.map((m) => `- ${m.content}`));
  }
  return out.join('\n');
}

export function buildRunPrompt(
  userPrompt: string,
  skillSystemPrompt: string | undefined,
  memories: PromptMemory[],
  documents: RunDocument[] = [],
): string {
  const preamble: string[] = [];
  if (skillSystemPrompt) preamble.push(skillSystemPrompt);
  if (memories.length) {
    preamble.push(renderMemoryMarkdown(memories));
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
  + 'renders the real binary on download: a file:<name>.pdf or file:<name>.docx block whose body is Markdown '
  + 'becomes a PDF or a Word document; a file:<name>.xlsx block whose body is CSV becomes an Excel spreadsheet; '
  + 'a file:<name>.pptx block whose body is Markdown becomes a PowerPoint deck — separate slides with a --- rule '
  + 'and start each slide with a heading for its title. '
  // Before this the only advice for a data visualization was "render a table",
  // because an image model cannot be trusted with exact numbers and there was
  // nothing else. There is now: a chart: fence carries the real values into a
  // genuine PowerPoint chart object (and into a table/worksheet elsewhere), so
  // the guidance has to say it exists or the model keeps writing prose about a
  // chart that was never drawn.
  + 'For a chart, graph or any data-driven visualization inside one of those documents, write a fenced block whose '
  + 'info string is chart:bar (or chart:line, chart:pie, chart:doughnut, chart:area, chart:scatter) and whose body is '
  + 'an optional "title: ..." line followed by CSV — a header row of "<category label>,<series name>,<series name>", '
  + 'then one row per category. In a .pptx that becomes a REAL, editable chart with your exact numbers; in .docx, .xlsx '
  + 'and .pdf the same block keeps every value as a table or worksheet. Never describe a chart in prose instead of '
  + 'emitting one, and never use a generated image for data that has to be accurate. For every other request, '
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
    /\b(files?|documents?|reports?|export(?:ed|able)?|csv|spreadsheet|excel|workbook|pdf|docx?|xlsx?|pptx?|powerpoint|presentations?|slides?|deck|markdown|download(?:able)?|save (?:it|this|that|as)|write (?:up|out|to)|deliverable)\b|\.(?:md|txt|csv|json|pdf|html?|docx?|xlsx?|pptx?)\b/i;
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
  socket: RunSocket,
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
  socket: RunSocket;
  /** Aborts the run mid-flight (client "Stop", or socket disconnect). */
  signal?: AbortSignal;
  /**
   * Whether a human is on the other end who can answer the SDK's interactive
   * gates. Default true — the web/socket path, where the user really can click
   * "retry this section" or "yes, compact".
   *
   * `false` is for callers with no back-channel (the OpenAI-compatible HTTP
   * endpoint: one request, one response, no way to send `escalation:decide`).
   * It does not turn the gates off — it declines to ATTACH listeners for them,
   * which is how the SDK already spells "nobody is watching": `cascade.ts`
   * returns each gate's unattended default the moment `listenerCount(...)` is
   * zero (escalation → `skip`, context → approve, plan → approve).
   *
   * Attaching a listener that never answers is the failure mode this avoids:
   * the escalation gate then parks for ESCALATION_DECISION_TIMEOUT_MS (5 min)
   * before resolving as `timeout`, so an HTTP caller would hold a connection
   * open for five minutes to arrive somewhere strictly worse than the `skip`
   * it gets for free with no listener at all.
   */
  interactive?: boolean;
}

/** The asset the SDK hands a media sink — inferred so we don't re-declare it. */
type MediaAsset = Parameters<Parameters<Cascade['setMediaSink']>[0]>[0];

/**
 * Where generated media lands in a hosted run: the tenant's PENDING media area
 * — bytes under `tmp-media/` plus a `pending_media` row — never a permanent
 * `files` row. The SDK's default sink writes into the workspace, which is
 * meaningless here: the container is ephemeral and the user has no filesystem
 * to look at.
 *
 * Nothing here touches the storage quota, and that is the point. Generating a
 * picture is not the same as choosing to keep one: this sink used to call
 * `checkStorageQuota` + `store.addFile` the instant the tool returned, so every
 * image the user glanced at and every video the model produced unasked was
 * permanently charged against a 10 MB free plan with no way to decline. Media
 * now behaves like every other generated artifact in this product (see
 * docs/file-generation.md): free to view and download, metered only when the
 * user explicitly saves it — at which point `POST /api/files` promotes the row
 * and runs `checkStorageQuota` for real. Unsaved media self-deletes after
 * PENDING_MEDIA_TTL_MS.
 *
 * `checkPendingMediaCap` is the one refusal left, and it is a rate ceiling on
 * unmetered bytes, not quota: the plan's permanent storage is untouched.
 *
 * The returned string is what the tool reports back to the model as the image's
 * `location`, and what the model then embeds as `![alt](location)`. So it has to
 * be *fetchable*: a bare `cascade-1730000000.png` names a file nobody — not the
 * chat view, not the client-side .pptx/.docx exporter — can resolve, and the
 * picture silently disappears from the deck. It stays `/api/files/:id` even
 * while the asset is pending: that route serves saved files and pending media
 * alike, and a save keeps the id, so one URL is correct before and after the
 * user decides — no client needs to know which state it is in to render it.
 *
 * Extracted from runChatTurnInner purely so it can be tested without driving a
 * whole model run.
 */
export function buildMediaSink(deps: {
  env: CloudEnv;
  store: CloudStore;
  userId: string;
  conversationId: string;
  socket: { emit(event: string, payload: unknown): unknown };
}): (asset: MediaAsset) => Promise<string> {
  const { env, store, userId, conversationId, socket } = deps;
  return async (asset) => {
    const now = Date.now();
    // Generation is the busiest natural entry point, so it carries the
    // opportunistic sweep (the convention native-auth/mcp-oauth/handoff follow)
    // — and it has to run BEFORE the cap check, or yesterday's expired bytes
    // would refuse today's image.
    await sweepPendingMedia(env, store, now);
    const dir = pendingMediaDir(env, userId);
    const plan = store.getUserById(userId)?.plan ?? 'free';
    // Checked before writing: a video can be tens of MB and the point of a
    // ceiling is to refuse before the disk is spent.
    checkPendingMediaCap(store.sumUserPendingMediaBytes(userId, now), asset.data.length, plan);
    await fs.mkdir(dir, { recursive: true });
    const media = store.addPendingMedia({
      userId,
      conversationId,
      name: asset.filename,
      mime: asset.mimeType,
      size: asset.data.length,
      expiresAt: now + PENDING_MEDIA_TTL_MS,
    });
    await fs.writeFile(path.join(dir, media.id), asset.data);
    // Same event the saved-file path emits, with `pending: true` so a listener
    // can tell "here is a new file in your storage" from "here is something
    // that will disappear unless you keep it". A flag beats a second event
    // name: every consumer wants the same refresh, and only the badge differs.
    socket.emit('file:created', { conversationId, file: media, pending: true, expiresAt: media.expiresAt });
    // encodeURIComponent mirrors the client helper's own precaution; ids are
    // randomUUID() today, but the escaping is free and the route is not.
    return `/api/files/${encodeURIComponent(media.id)}`;
  };
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

/**
 * Creates the conversation a run without a conversationId appends to, seeding
 * it with `seedHistory` when the caller supplied prior turns.
 *
 * The re-read after `importConversation` is load-bearing, not defensive: that
 * method returns the row it captured BEFORE appending the messages, so its
 * `activeLeafId` is still null. The run hangs the new turn off
 * `conversation.activeLeafId`, so using the stale row would silently start a
 * second root branch and drop the whole seeded history from the run's context.
 */
function seedConversation(store: CloudStore, userId: string, payload: ChatRunPayload) {
  const history = payload.seedHistory;
  if (!history?.length) return store.createConversation(userId, payload.prompt.slice(0, 80));
  // The first turn names the thread better than the latest one does.
  const title = history[0]!.content.slice(0, 80);
  const seeded = store.importConversation(userId, title, null, history);
  return store.getConversation(seeded.id, userId);
}

async function runChatTurnInner(payload: ChatRunPayload, deps: ChatRunDeps): Promise<ChatRunResult> {
  const { env, store, userId, socket, signal } = deps;
  const interactive = deps.interactive !== false;

  // Reached only AFTER runChatTurn's admission guards, so nothing below is
  // persisted for a request the entitlements refused.
  const conversation = payload.conversationId
    ? store.getConversation(payload.conversationId, userId)
    : seedConversation(store, userId, payload);
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
  // A caller-supplied system prompt (the OpenAI-compatible endpoint's
  // `system`/`developer` turns) composes with a selected preset rather than
  // replacing it — the caller's instructions lead, the preset follows.
  const presetSystemPrompt = builtinSkill?.systemPrompt || userSkill?.systemPrompt || undefined;
  const skillSystemPrompt = [payload.systemPrompt, presetSystemPrompt].filter(Boolean).join('\n\n') || undefined;
  const memories = store.listMemories(userId).map((m) => ({ content: m.content, durability: m.durability }));
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
    disabledTools: payload.fastAnswer ? [] : store.listDisabledMcpTools(userId),
  });
  const cascade: Cascade = createCascade(config, scratchDir);

  cascade.setMediaSink(buildMediaSink({ env, store, userId, conversationId: conversation.id, socket }));

  // Your thumbs-up/down verdicts, folded into Auto routing as a bounded,
  // sample-size-shrunk adjustment to the public benchmark score. Read once per
  // run and closed over: routing decisions inside a run must not shift halfway
  // through because a vote landed mid-flight.
  const feedbackTotals = new Map(
    store.modelFeedbackTotals(userId).map((r) => [r.model, { good: r.good, bad: r.bad }]),
  );
  if (feedbackTotals.size) cascade.setFeedbackSource((modelId) => feedbackTotals.get(modelId));

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
  if (interactive) {
    cascade.on('context:approval-required', onContextApproval);
    cascade.on('context:compacted', onCompacted);
    socket.on('context:decision', onContextDecision);
  }

  // A section that escalated is asking a real question, and until now nobody
  // was ever asked it — the run just stopped at "needs a decision" having spent
  // a full orchestration. Unlike plan approval above (which auto-proceeds,
  // because the plan is already the model's considered proposal), this WAITS:
  // an escalation exists precisely because a worker was not confident, so
  // proceeding unattended is the option most likely to be wrong.
  const onEscalation = (e: unknown) =>
    socket.emit('escalation:decision-required', { conversationId: conversation.id, ...(e as object) });
  const onEscalationTimeout = (e: unknown) =>
    socket.emit('escalation:timeout', { conversationId: conversation.id, ...(e as object) });
  const onEscalationDecision = (d: { conversationId?: string; requestId?: string; action?: string; note?: string }) => {
    // One socket can carry several conversations; only answer for this run.
    if (d?.conversationId && d.conversationId !== conversation.id) return;
    if (d?.action === 'retry' || d?.action === 'skip' || d?.action === 'guidance') {
      // requestId picks the parked section: a Complex run dispatches sections
      // concurrently, so two can be waiting and an unkeyed answer would resolve
      // whichever happened to be first in the map.
      cascade.resolveEscalation(
        d.action,
        typeof d.note === 'string' ? d.note : undefined,
        typeof d.requestId === 'string' ? d.requestId : undefined,
      );
    }
  };
  if (interactive) {
    cascade.on('escalation:decision-required', onEscalation);
    cascade.on('escalation:timeout', onEscalationTimeout);
    socket.on('escalation:decide', onEscalationDecision);
  }

  cascade.on('stream:token', onToken);
  cascade.on('tier:status', onStatus);
  // The plan gate resolves inline (onPlan calls resolvePlanApproval(true)), so
  // it is safe either way — but a non-interactive caller has nothing to show
  // the plan TO, and "no listener" already means proceed. Skipping it keeps the
  // rule uniform: unattended runs attach no gate listeners at all.
  if (interactive) cascade.on('plan:approval-required', onPlan);
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
    cascade.off('escalation:decision-required', onEscalation);
    cascade.off('escalation:timeout', onEscalationTimeout);
    socket.off('escalation:decide', onEscalationDecision);
    try { await cascade.close(); } catch { /* non-critical */ }
  }
}
