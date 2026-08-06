// ─────────────────────────────────────────────
//  Cascade Cloud Server — OpenAI-compatible API
// ─────────────────────────────────────────────
//
// `POST /v1/chat/completions` and `GET /v1/models`, so an existing OpenAI SDK
// client can point `base_url` at a Cascade instance and get an orchestrated
// run instead of a single model call.
//
// Two things make this a thin adapter rather than a second run pipeline:
//
//  1. It reuses `runChatTurn` verbatim. The only reason it could not before is
//     that `ChatRunDeps.socket` was typed `Socket`; it is now the structural
//     `RunSocket`, and `HttpRunSink` below is the HTTP-side implementation.
//
//  2. It runs NON-INTERACTIVELY (`interactive: false`). That is not a new
//     "autonomous mode" — the SDK already treats "no listener attached" as
//     "proceed unattended" (cascade.ts returns each gate's default the moment
//     `listenerCount(...)` is 0). The socket path attaches those listeners
//     because a human is there to answer them; an HTTP caller has no way to
//     send `escalation:decide`, and attaching a listener nobody answers parks
//     the run for the full 5-minute escalation timeout before resolving to a
//     WORSE outcome than the unattended default. See ChatRunDeps.interactive.
//
// The web/socket path's behaviour is deliberately untouched: the gates stay
// interactive there, because the UI depends on them.

import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { ProviderConfig, TokenUsage } from '#cascade-ai';
import type { CloudEnv } from './env.js';
import type { CloudStore } from './db.js';
import { bearerToken, verifySessionToken } from './auth/session.js';
import {
  parseChatRunPayload, runChatTurn, type ChatRunPayload, type ChatRunResult, type RunSocket,
} from './runs.js';

// ── Models ────────────────────────────────────

/**
 * `model` names a ROUTING MODE, not a model.
 *
 * Cascade picks a model per subtask — that is the product. Letting a caller
 * name `gpt-4o` would either be a lie (we route anyway) or would turn the
 * orchestrator off. So the three names below are the whole catalog, and they
 * map onto controls the run payload already carries.
 */
export const CASCADE_MODELS = {
  /** Full orchestration, balanced quality↔cost. The default. */
  'cascade': { routingMode: 'auto' as const },
  /** One mid-tier model, no orchestration — the "fast answer" path. */
  'cascade-fast': { fastAnswer: true as const },
  /** Full orchestration, biased to quality. */
  'cascade-quality': { routingMode: 'quality' as const },
} satisfies Record<string, Pick<ChatRunPayload, 'routingMode' | 'fastAnswer'>>;

export type CascadeModelId = keyof typeof CASCADE_MODELS;

export function isCascadeModel(model: string): model is CascadeModelId {
  return Object.prototype.hasOwnProperty.call(CASCADE_MODELS, model);
}

/**
 * The run controls a `model` name selects, or null when it names nothing we
 * serve.
 *
 * Null rather than a silent fallback to `auto` on purpose: a request that asked
 * for `gpt-4o` and got a full Cascade orchestration has been billed for
 * something it did not ask for, and the caller has no way to notice. An OpenAI
 * SDK client already knows how to handle a 404 `model_not_found`.
 */
export function runControlsForModel(model: string): Pick<ChatRunPayload, 'routingMode' | 'fastAnswer'> | null {
  return isCascadeModel(model) ? CASCADE_MODELS[model] : null;
}

// ── Errors (OpenAI's envelope) ────────────────

export interface OpenAiError {
  error: { message: string; type: string; param: string | null; code: string | null };
}

export function openAiError(
  message: string,
  type = 'invalid_request_error',
  param: string | null = null,
  code: string | null = null,
): OpenAiError {
  return { error: { message, type, param, code } };
}

// ── Request validation ────────────────────────

/**
 * Parameters this endpoint does not implement, mapped to the value that means
 * "the caller did not actually ask for anything".
 *
 * Rejecting rather than ignoring is the point: silently dropping `n: 3` or
 * `response_format: json_object` returns a response that looks successful and
 * is wrong. But rejecting the NO-OP default would break the many wrappers that
 * fill every field in — `top_p: 1` and `presence_penalty: 0` are what a client
 * sends when it has no opinion, so those pass through untouched.
 *
 * `undefined` as the no-op value means the parameter is unsupported at any
 * value (there is no neutral `tools: []`-shaped request we can honour).
 */
const UNSUPPORTED_PARAMS: Array<{ name: string; noop?: unknown; why: string }> = [
  { name: 'n', noop: 1, why: 'Cascade produces one answer per run.' },
  { name: 'logprobs', noop: false, why: 'Cascade routes across models, so there is no single token distribution to report.' },
  { name: 'top_logprobs', why: 'Cascade routes across models, so there is no single token distribution to report.' },
  { name: 'presence_penalty', noop: 0, why: 'Sampling penalties are not forwarded to the per-subtask models.' },
  { name: 'frequency_penalty', noop: 0, why: 'Sampling penalties are not forwarded to the per-subtask models.' },
  { name: 'logit_bias', why: 'Sampling bias is not forwarded to the per-subtask models.' },
  { name: 'top_p', noop: 1, why: 'Nucleus sampling is not forwarded to the per-subtask models.' },
  { name: 'stop', why: 'Stop sequences are not forwarded to the per-subtask models.' },
  { name: 'seed', why: 'A multi-model run has no single seed to pin.' },
  { name: 'tools', why: "Cascade's tools run server-side; client tool/function calling is not supported." },
  { name: 'functions', why: "Cascade's tools run server-side; client tool/function calling is not supported." },
  { name: 'tool_choice', why: "Cascade's tools run server-side; client tool/function calling is not supported." },
  { name: 'function_call', why: "Cascade's tools run server-side; client tool/function calling is not supported." },
  { name: 'response_format', why: 'Structured-output modes are not supported yet.' },
];

/** The first unsupported parameter present at a non-no-op value, if any. */
export function findUnsupportedParam(body: Record<string, unknown>): { name: string; message: string } | null {
  for (const p of UNSUPPORTED_PARAMS) {
    if (!(p.name in body)) continue;
    const value = body[p.name];
    if (value === undefined || value === null) continue;
    if ('noop' in p && value === p.noop) continue;
    return { name: p.name, message: `'${p.name}' is not supported by this endpoint. ${p.why}` };
  }
  return null;
}

export interface ChatMessageInput {
  role: string;
  content: string;
}

export interface ParsedCompletionRequest {
  model: CascadeModelId;
  /** Concatenated `system`/`developer` turns, in order. */
  systemPrompt?: string;
  /** The user/assistant turns BEFORE the final user turn. */
  history: ChatMessageInput[];
  /** The final user turn — what this run answers. */
  prompt: string;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Caller-supplied provider credentials (`extra_body`), when present. */
  providers?: unknown;
}

/** Flattens OpenAI's string-or-parts `content` into plain text. */
function messageText(content: unknown, index: number): string | { error: string } {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown };
      if (p?.type === 'text' && typeof p.text === 'string') { out.push(p.text); continue; }
      return {
        error: `messages[${index}].content contains a '${String(p?.type)}' part. `
          + 'This endpoint accepts text only — upload images and documents via POST /api/uploads.',
      };
    }
    return out.join('');
  }
  return { error: `messages[${index}].content must be a string or an array of text parts.` };
}

/**
 * Validates an OpenAI `chat.completions` request into the pieces a Cascade run
 * needs. Returns the OpenAI error envelope (and its HTTP status) rather than
 * throwing, so every rejection leaves this one function.
 */
export function parseCompletionRequest(
  input: unknown,
): { ok: true; value: ParsedCompletionRequest } | { ok: false; status: number; body: OpenAiError } {
  const body = (input ?? {}) as Record<string, unknown>;

  const model = typeof body['model'] === 'string' ? body['model'] : '';
  if (!model) {
    return { ok: false, status: 400, body: openAiError("'model' is required.", 'invalid_request_error', 'model') };
  }
  if (!isCascadeModel(model)) {
    return {
      ok: false,
      status: 404,
      body: openAiError(
        `The model '${model}' does not exist. This server serves Cascade routing modes, not individual models — `
          + `use one of: ${Object.keys(CASCADE_MODELS).join(', ')}. See GET /v1/models.`,
        'invalid_request_error',
        'model',
        'model_not_found',
      ),
    };
  }

  const unsupported = findUnsupportedParam(body);
  if (unsupported) {
    return { ok: false, status: 400, body: openAiError(unsupported.message, 'invalid_request_error', unsupported.name) };
  }

  const rawMessages = body['messages'];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, status: 400, body: openAiError("'messages' must be a non-empty array.", 'invalid_request_error', 'messages') };
  }

  const systemParts: string[] = [];
  const turns: ChatMessageInput[] = [];
  for (const [i, raw] of rawMessages.entries()) {
    const m = (raw ?? {}) as { role?: unknown; content?: unknown };
    const role = typeof m.role === 'string' ? m.role : '';
    if (role === 'tool' || role === 'function') {
      return {
        ok: false,
        status: 400,
        body: openAiError(
          `messages[${i}] has role '${role}'. Client tool/function calling is not supported — Cascade's tools run server-side.`,
          'invalid_request_error',
          'messages',
        ),
      };
    }
    if (role !== 'system' && role !== 'developer' && role !== 'user' && role !== 'assistant') {
      return { ok: false, status: 400, body: openAiError(`messages[${i}].role must be one of: system, developer, user, assistant.`, 'invalid_request_error', 'messages') };
    }
    const text = messageText(m.content, i);
    if (typeof text !== 'string') {
      return { ok: false, status: 400, body: openAiError(text.error, 'invalid_request_error', 'messages') };
    }
    if (role === 'system' || role === 'developer') { if (text) systemParts.push(text); continue; }
    turns.push({ role, content: text });
  }

  // The run answers the LAST user turn, so it has to be last. An assistant
  // message in that position is a prefill request, which this endpoint has no
  // way to honour — saying so beats answering a different question.
  const last = turns[turns.length - 1];
  if (!last || last.role !== 'user') {
    return {
      ok: false,
      status: 400,
      body: openAiError(
        "The last message must have role 'user' — this endpoint answers that turn and cannot continue an assistant prefill.",
        'invalid_request_error',
        'messages',
      ),
    };
  }
  if (!last.content.trim()) {
    return { ok: false, status: 400, body: openAiError('The last user message is empty.', 'invalid_request_error', 'messages') };
  }

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  // max_completion_tokens is the current spelling; max_tokens is the legacy one
  // every older client still sends.
  const maxTokens = num(body['max_completion_tokens']) ?? num(body['max_tokens']);
  const temperature = num(body['temperature']);
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    return { ok: false, status: 400, body: openAiError("'temperature' must be between 0 and 2.", 'invalid_request_error', 'temperature') };
  }
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    return { ok: false, status: 400, body: openAiError("'max_tokens' must be a positive integer.", 'invalid_request_error', 'max_tokens') };
  }

  return {
    ok: true,
    value: {
      model,
      ...(systemParts.length ? { systemPrompt: systemParts.join('\n\n') } : {}),
      history: turns.slice(0, -1),
      prompt: last.content,
      stream: body['stream'] === true,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(body['providers'] !== undefined ? { providers: body['providers'] } : {}),
    },
  };
}

// ── Provider keys ─────────────────────────────

/**
 * The operator's own provider credentials, read from the environment.
 *
 * Names match the CLI's env-key discovery (src/config/index.ts) so one `.env`
 * serves both. At most one entry per type, which caps the list at 7 — exactly
 * the bound `ChatRunPayloadSchema.providers` enforces.
 */
export function providersFromEnv(env: CloudEnv): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  if (env.ANTHROPIC_API_KEY) providers.push({ type: 'anthropic', apiKey: env.ANTHROPIC_API_KEY });
  if (env.OPENAI_API_KEY) providers.push({ type: 'openai', apiKey: env.OPENAI_API_KEY });
  const gemini = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (gemini) providers.push({ type: 'gemini', apiKey: gemini });
  if (env.GITHUB_MODELS_TOKEN) providers.push({ type: 'github-models', apiKey: env.GITHUB_MODELS_TOKEN });
  // Azure is only usable with all three halves — a key with no endpoint or no
  // deployment names no model, and would fail discovery at run time instead of
  // being visibly absent here.
  if (env.AZURE_OPENAI_KEY && env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_DEPLOYMENT) {
    providers.push({
      type: 'azure',
      apiKey: env.AZURE_OPENAI_KEY,
      baseUrl: env.AZURE_OPENAI_ENDPOINT,
      deploymentName: env.AZURE_OPENAI_DEPLOYMENT,
      ...(env.AZURE_OPENAI_API_VERSION ? { apiVersion: env.AZURE_OPENAI_API_VERSION } : {}),
    });
  }
  if (env.OPENAI_COMPATIBLE_BASE_URL) {
    providers.push({
      type: 'openai-compatible',
      baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
      ...(env.OPENAI_COMPATIBLE_API_KEY ? { apiKey: env.OPENAI_COMPATIBLE_API_KEY } : {}),
      ...(env.OPENAI_COMPATIBLE_MODEL ? { model: env.OPENAI_COMPATIBLE_MODEL } : {}),
    });
  }
  if (env.OLLAMA_BASE_URL) providers.push({ type: 'ollama', baseUrl: env.OLLAMA_BASE_URL });
  return providers;
}

export type ProviderPolicy =
  | { mode: 'env'; providers: ProviderConfig[] }
  | { mode: 'request-only'; reason: string };

/**
 * Whether this instance's env provider keys may serve an API run.
 *
 * They may only when the instance has at most one account — i.e. it is a
 * self-host where the operator and the caller are the same person. The moment
 * a second account exists, "the operator's key" pays for someone else's run,
 * with no per-user accounting and no way for the operator to see it happening.
 * A multi-tenant instance keeps its existing bring-your-own-key model: keys are
 * held in the caller's browser (or passed on the request) and never on the
 * server.
 *
 * Evaluated per request rather than cached, because the account count is what
 * changes — an instance that grows a second user must stop spending the
 * operator's keys immediately, not at the next restart.
 */
export function providerPolicy(env: CloudEnv, store: CloudStore): ProviderPolicy {
  const envProviders = providersFromEnv(env);
  if (envProviders.length === 0) {
    return { mode: 'request-only', reason: 'no provider keys are set in the environment' };
  }
  const users = store.countUsers();
  if (users > 1) {
    return {
      mode: 'request-only',
      reason: `this instance has ${users} accounts, so the operator's environment keys are not used`,
    };
  }
  return { mode: 'env', providers: envProviders };
}

/** One-line boot diagnostic, so the gate above is visible rather than inferred. */
export function describeProviderPolicy(env: CloudEnv, store: CloudStore): string {
  const policy = providerPolicy(env, store);
  if (policy.mode === 'env') {
    const types = policy.providers.map((p) => p.type).join(', ');
    return `[openai-compat] POST /v1/chat/completions will use the environment's provider keys (${types}) — `
      + 'single-account instance. This stops automatically if a second account is created.';
  }
  return `[openai-compat] POST /v1/chat/completions requires callers to supply their own provider keys — ${policy.reason}.`;
}

// ── Streaming ─────────────────────────────────

/** OpenAI's `chat.completion.chunk` envelope. */
export function streamChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** A usage-only terminal chunk (`choices: []`), the shape OpenAI streams. */
export function usageChunk(id: string, created: number, model: string, usage: unknown, extra: unknown): string {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model, choices: [], usage, cascade: extra,
  })}\n\n`;
}

/**
 * What still has to be sent so the client's assembled text matches the run's
 * authoritative `output`.
 *
 * Live tokens come from the presenter tier (`primary: true`), which is the
 * user-facing answer — but `output` is what the run actually returned and what
 * was persisted, and the two are only guaranteed equal when nothing
 * post-processed the text. So the stream is reconciled at the end instead of
 * being trusted:
 *
 *  - identical → nothing to send (the common case);
 *  - `output` extends what streamed → send the remainder;
 *  - they diverged → send everything after the common prefix. That over-sends
 *    rather than truncating, which is the right direction: a client that
 *    concatenates deltas ends up with a superset of the answer instead of a
 *    silently clipped one.
 */
export function trailingDelta(streamed: string, output: string): string {
  if (output === streamed) return '';
  if (output.startsWith(streamed)) return output.slice(streamed.length);
  let i = 0;
  while (i < streamed.length && i < output.length && streamed[i] === output[i]) i++;
  return output.slice(i);
}

/**
 * The run-pipeline transport for an HTTP caller: forwards the presenter tier's
 * tokens to a callback and captures the run's real token usage off
 * `session:complete`.
 *
 * `on`/`off` are inert. That is not an oversight — they exist on `RunSocket`
 * for the client-answer channels (`context:decision`, `escalation:decide`),
 * and an HTTP request has no such channel. The run is driven with
 * `interactive: false`, so nothing subscribes to them in the first place.
 */
export class HttpRunSink implements RunSocket {
  /** The run's real token counts, captured from `session:complete`. */
  usage: TokenUsage | null = null;

  constructor(private readonly onToken: (text: string) => void) {}

  emit(event: string, payload: unknown): unknown {
    if (event === 'stream:token') {
      const e = payload as { text?: unknown; primary?: unknown };
      // Only the presenter tier's stream is the answer; background workers
      // interleave and would corrupt the delta sequence.
      if (e.primary === true && typeof e.text === 'string') this.onToken(e.text);
      return true;
    }
    if (event === 'session:complete') {
      const p = payload as { result?: { usage?: TokenUsage } };
      if (p?.result?.usage) this.usage = p.result.usage;
      return true;
    }
    return true;
  }

  on(): unknown { return this; }
  off(): unknown { return this; }
}

/** OpenAI's `usage` block, from the run's real counts. */
export function usageBlock(usage: TokenUsage | null, result: ChatRunResult) {
  if (usage) {
    return {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    };
  }
  // Defensive: `session:complete` always carries usage on a successful run.
  // Attributing an unsplit total to completion keeps the arithmetic consistent
  // rather than reporting a total that its own parts contradict.
  return { prompt_tokens: 0, completion_tokens: result.totalTokens, total_tokens: result.totalTokens };
}

/**
 * Cascade-specific run facts, returned alongside the OpenAI fields. Unknown
 * keys are ignored by every OpenAI SDK, and this is the only way a caller can
 * see WHICH model actually served their request — the `model` field has to
 * echo the routing mode they asked for.
 */
export function cascadeExtra(result: ChatRunResult) {
  return {
    conversation_id: result.conversationId,
    tier: result.tier,
    model: result.model,
    cost_usd: result.costUsd,
    saved_usd: result.savedUsd,
    saved_pct: result.savedPct,
    cancelled: result.cancelled,
  };
}

// ── Routes ────────────────────────────────────

/**
 * Paths that parse their own (larger) JSON body. A long conversation is
 * routinely bigger than express.json()'s 100kb default, and the failure mode
 * there is an opaque 413 from a middleware the caller never asked for.
 */
export const OPENAI_COMPAT_JSON_ROUTES = ['/v1/chat/completions'];

/** Same bound as `prompt` in ChatRunPayloadSchema, restated for a clear error. */
const MAX_PROMPT_CHARS = 20_000;
/** Mirrors app.ts's MAX_MESSAGE_LEN — the ceiling on any persisted message. */
const MAX_MESSAGE_CHARS = 500_000;

export function registerOpenAiCompatRoutes(app: Express, env: CloudEnv, store: CloudStore): void {
  console.log(describeProviderPolicy(env, store));

  // Same budget as the /api limiter. A run is far more expensive than a normal
  // API call, but the per-user daily cap and per-run cost ceiling in
  // entitlements.ts are the real guards — this is the cheap outer rail.
  app.use('/v1', rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: openAiError('Rate limit reached. Slow down.', 'rate_limit_error', null, 'rate_limit_exceeded'),
  }));

  /**
   * The API key is the native access token the desktop/CLI auth flow already
   * mints (auth/session.ts) — deliberately NOT a new key system. This does the
   * same verification `sessionMiddleware` does; it exists only to answer in
   * OpenAI's error envelope, which is what an OpenAI SDK client parses.
   */
  const requireApiKey = (req: Request, res: Response, next: () => void): void => {
    const token = bearerToken(req.headers.authorization);
    const session = token ? verifySessionToken(token, env.SESSION_SECRET) : null;
    if (!session) {
      res.status(401).json(openAiError(
        'Incorrect API key provided. Sign in and use a Cascade access token as the API key.',
        'invalid_request_error', null, 'invalid_api_key',
      ));
      return;
    }
    (req as Request & { session?: { userId: string } }).session = session;
    next();
  };

  app.get('/v1/models', requireApiKey, (_req, res) => {
    const created = Math.floor(Date.now() / 1000);
    res.json({
      object: 'list',
      data: Object.keys(CASCADE_MODELS).map((id) => ({ id, object: 'model', created, owned_by: 'cascade' })),
    });
  });

  // A long conversation is routinely larger than express.json()'s 100kb
  // default — the app-level parser skips this path (OPENAI_COMPAT_JSON_ROUTES)
  // so the bound is set here, next to the route that has to justify it.
  //
  // Wrapped because body-parser's own failures otherwise reach express's
  // default handler, which answers an SDK client with an HTML error page it
  // cannot parse. Every response from /v1 has to be the OpenAI envelope,
  // including the ones this endpoint's own middleware produces.
  const parseJson = express.json({ limit: '4mb' });
  const completionsJson = (req: Request, res: Response, next: () => void): void => {
    parseJson(req, res, (err?: unknown) => {
      if (!err) { next(); return; }
      if ((err as { type?: string }).type === 'entity.too.large') {
        res.status(413).json(openAiError('The request body is too large (limit 4 MB).'));
        return;
      }
      res.status(400).json(openAiError('Could not parse the request body as JSON.'));
    });
  };

  app.post('/v1/chat/completions', requireApiKey, completionsJson, async (req, res) => {
    const userId = (req as Request & { session?: { userId: string } }).session!.userId;

    const parsed = parseCompletionRequest(req.body);
    if (!parsed.ok) { res.status(parsed.status).json(parsed.body); return; }
    const request = parsed.value;

    if (request.prompt.length > MAX_PROMPT_CHARS) {
      res.status(400).json(openAiError(
        `The last user message is ${request.prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}.`,
        'invalid_request_error', 'messages', 'context_length_exceeded',
      ));
      return;
    }

    // Provider credentials: the request's own (extra_body) if it carried them,
    // otherwise the operator's env keys when this is a single-account instance.
    const policy = providerPolicy(env, store);
    const providers = request.providers ?? (policy.mode === 'env' ? policy.providers : undefined);
    if (!providers) {
      res.status(400).json(openAiError(
        `No provider credentials are available for this run — ${(policy as { reason: string }).reason}. `
          + "Pass your own keys as a `providers` array in the request body (the OpenAI SDK's `extra_body`).",
        'invalid_request_error', 'providers', 'no_provider_keys',
      ));
      return;
    }

    // The whole request is validated by the SAME Zod schema the socket path
    // uses, so an API run can never construct a payload a socket run could not.
    let payload: ChatRunPayload;
    try {
      payload = parseChatRunPayload({
        prompt: request.prompt,
        providers,
        ...runControlsForModel(request.model),
        ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
        // temperature/max_tokens have an honest home: the per-tier generation
        // knobs. Applied uniformly across tiers, since one OpenAI-shaped value
        // carries no per-tier intent.
        ...(request.temperature !== undefined || request.maxTokens !== undefined
          ? {
              tierParams: {
                t1: tierParam(request), t2: tierParam(request), t3: tierParam(request),
              },
            }
          : {}),
      });
    } catch (err) {
      const message = err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : String(err);
      res.status(400).json(openAiError(message));
      return;
    }

    // Prior turns become a real conversation, so history reaches the run
    // through the same tree walk the web path uses — and the transcript shows
    // up in the user's own chat list rather than vanishing. A stateless client
    // that resends its whole array each turn gets one conversation per request;
    // that is the honest reading of a stateless protocol.
    if (request.history.length) {
      const convo = store.importConversation(
        userId,
        request.history[0]?.content.slice(0, 80) ?? request.prompt.slice(0, 80),
        null,
        // Same per-message ceiling POST /api/conversations/:id/turns applies, so
        // a persisted turn's size does not depend on which door it came in.
        request.history.map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) })),
      );
      payload = { ...payload, conversationId: convo.id };
    }

    const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    // A client that hangs up mid-run should stop the run, exactly as a socket
    // disconnect does — otherwise it keeps spending on an answer nobody reads.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    if (!request.stream) {
      const sink = new HttpRunSink(() => {});
      try {
        const result = await runChatTurn(payload, {
          env, store, userId, socket: sink, signal: controller.signal, interactive: false,
        });
        res.json({
          id, object: 'chat.completion', created, model: request.model,
          choices: [{ index: 0, message: { role: 'assistant', content: result.output }, finish_reason: 'stop' }],
          usage: usageBlock(sink.usage, result),
          cascade: cascadeExtra(result),
        });
      } catch (err) {
        const { status, body } = runFailure(err);
        res.status(status).json(body);
      }
      return;
    }

    // ── SSE ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Stops nginx-style reverse proxies buffering the stream into one blob.
      'X-Accel-Buffering': 'no',
    });
    res.write(streamChunk(id, created, request.model, { role: 'assistant', content: '' }));

    let streamed = '';
    const sink = new HttpRunSink((text) => {
      streamed += text;
      res.write(streamChunk(id, created, request.model, { content: text }));
    });

    try {
      const result = await runChatTurn(payload, {
        env, store, userId, socket: sink, signal: controller.signal, interactive: false,
      });
      const tail = trailingDelta(streamed, result.output);
      if (tail) res.write(streamChunk(id, created, request.model, { content: tail }));
      res.write(streamChunk(id, created, request.model, {}, 'stop'));
      // Sent unconditionally rather than only under `stream_options.include_usage`:
      // these are the run's real, billed token counts, and a caller paying for
      // an orchestration should not have to opt in to being told what it cost.
      res.write(usageChunk(id, created, request.model, usageBlock(sink.usage, result), cascadeExtra(result)));
    } catch (err) {
      // Headers are long gone, so the failure has to travel IN the stream.
      // OpenAI does the same: an error event, then the terminator.
      res.write(`data: ${JSON.stringify(runFailure(err).body)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

/** Per-tier knobs from the request's OpenAI-shaped sampling parameters. */
function tierParam(request: ParsedCompletionRequest) {
  return {
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
}

/**
 * Maps a run failure onto an OpenAI-shaped error. Entitlement refusals (daily
 * cap, concurrency) are the caller's problem to retry, so they get 429 rather
 * than a flat 500 that reads as "the server is broken".
 */
function runFailure(err: unknown): { status: number; body: OpenAiError } {
  const message = err instanceof Error ? err.message : String(err);
  if (/daily run limit|concurrent runs/i.test(message)) {
    return { status: 429, body: openAiError(message, 'rate_limit_error', null, 'rate_limit_exceeded') };
  }
  if (/conversation not found/i.test(message)) {
    return { status: 404, body: openAiError(message, 'invalid_request_error') };
  }
  return { status: 500, body: openAiError(message, 'server_error') };
}
