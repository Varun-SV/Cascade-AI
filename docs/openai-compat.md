# OpenAI-compatible API (`/v1`)

Design + security only. Internal — not served publicly (the user-facing copy
lives in `cloud/server/src/docs.ts`, which is what `/docs` renders).

`POST /v1/chat/completions` and `GET /v1/models` let an existing OpenAI SDK
client point `base_url` at a Cascade instance and get an orchestrated run.
Implementation: `cloud/server/src/openai-compat.ts`.

---

## 1. Why this is an adapter, not a second pipeline

The endpoint calls `runChatTurn` — the same function `chat:run` calls. Two
changes made that possible, both in `cloud/server/src/runs.ts`:

**`ChatRunDeps.socket` is `RunSocket`, not `Socket`.** All 18 socket uses in the
run pipeline are a fire-and-forget `emit` plus a pair of `on`/`off` for the
client's answers. Naming that structurally lets `HttpRunSink` stand in. A real
socket.io `Socket` satisfies the interface unchanged, so the web path is
untouched.

> `on`/`off` are typed `(...args: any[]) => void` deliberately. socket.io
> declares them as function-valued **properties**, not methods, so
> `strictFunctionTypes` checks them contravariantly and only `any` is assignable
> in both directions. A narrower parameter type makes `Socket` stop satisfying
> `RunSocket`, which defeats the point.

**`ChatRunDeps.interactive`.** Default `true`. The HTTP path passes `false`.

## 2. The interactive gates, and why `interactive: false` is the whole design

`src/core/cascade.ts` returns each gate's unattended default the moment nothing
is listening:

| gate | no-listener default | timeout WITH a listener |
|---|---|---|
| `escalation:decision-required` | `{ action: 'skip', automatic: true }` | 5 min → `timeout` |
| `context:approval-required` | `true` (proceed) | 120 s → proceed |
| `plan:approval-required` | `{ approved: true }` | 120 s → proceed |
| `mcp:approval-required` | `false` (reject) | 30 s → reject |

So an unattended caller does **not** need a new "autonomous mode" flag. It needs
to **not attach the listeners** — the SDK already spells "nobody is watching" as
`listenerCount(...) === 0`.

The failure this avoids is specific and invisible in normal use. `runs.ts`
previously attached those listeners unconditionally. An HTTP caller has no way
to send `escalation:decide`, so a run that escalated would park for the full
`ESCALATION_DECISION_TIMEOUT_MS` (5 minutes, `cascade.ts:35`) holding the
connection open, and then resolve as `timeout` — strictly worse than the `skip`
it gets for free with no listener at all. It only fires when a worker actually
escalates, which is why `openai-compat.test.ts` asserts the listener counts
directly rather than waiting to notice.

`interactive: false` skips **all four** gate listeners, including
`plan:approval-required` (which resolves inline and was already safe). Uniform
rule: unattended runs attach no gate listeners. `stream:token`, `tier:status`
and `log` are not gates and stay attached — without them the endpoint could not
stream at all.

The socket path keeps every gate interactive. The web UI depends on it.

## 3. `model` is a routing mode

| `model` | payload |
|---|---|
| `cascade` | `routingMode: 'auto'` |
| `cascade-fast` | `fastAnswer: true` |
| `cascade-quality` | `routingMode: 'quality'` |

Anything else → **404 `model_not_found`** in OpenAI's error envelope.

Not a fallback to `auto`: a request that asked for `gpt-4o` and silently got a
full orchestration has been billed for something it never asked for and has no
way to tell. An OpenAI SDK client already knows how to handle that 404.

`GET /v1/models` serves the same three so clients can discover them. The
response's `model` field echoes the routing mode the caller asked for, so the
model that *actually* served the run is reported in the `cascade` extension
block instead.

## 4. Provider credentials — the self-host gate

Resolution order, per request:

1. A `providers` array on the request body (the OpenAI SDK's `extra_body`),
   validated by the **same Zod schema** `chat:run` uses. An API run can never
   construct a payload a socket run could not.
2. The operator's environment keys — **only when the instance has ≤ 1 account**.
3. Otherwise a 400 `no_provider_keys` naming the way out.

Rule (2) is the security-relevant one. On a single-account self-host the
operator and the caller are the same person, so their own keys are the obvious
source. The moment a second account exists, "the operator's key" pays for
someone else's runs with no per-user accounting and no way for the operator to
see it happening — so it stops, automatically and immediately. A multi-tenant
instance keeps the product's bring-your-own-key model: keys live in the caller's
browser (or on the request) and never on the server.

Evaluated **per request**, not cached: an instance that grows a second user must
stop spending the operator's keys at once, not at the next restart. The outcome
is logged once at boot (`describeProviderPolicy`) so the gate is visible rather
than inferred.

Env variable names match the CLI's own key discovery (`src/config/index.ts`) so
one `.env` serves both. At most one provider per type, which caps the list at 7
— exactly the bound `ChatRunPayloadSchema.providers` enforces.

## 5. Auth

The API key is the **native access token** the desktop/CLI flow already mints
(`auth/session.ts` → `createNativeAccessToken`). No new key system.

`requireApiKey` duplicates what `sessionMiddleware` does — same `bearerToken` +
`verifySessionToken` — for one reason: to answer in OpenAI's error envelope
(`401 invalid_api_key`), which is what an OpenAI SDK client parses. It does not
introduce a second way to authenticate.

Native access tokens are short-lived (1 h) by design, renewed with the refresh
token. `/v1` is for server-side clients: the app's CORS policy pins credentialed
requests to `WEB_ORIGIN` and does not allow the `Authorization` header
cross-origin, so a browser-side SDK is deliberately not served.

## 6. Streaming and the output reconciliation

Live deltas come from `stream:token` events with `primary: true` — the presenter
tier, i.e. the user-facing answer. Background workers interleave and are
dropped; a test asserts a non-primary token never reaches the wire.

But `result.output` is what the run returned and what was persisted, and the two
are only guaranteed equal when nothing post-processed the text. So the stream is
**reconciled** at the end (`trailingDelta`) rather than trusted:

- identical → send nothing (the common case);
- `output` extends what streamed → send the remainder;
- they diverged → send everything after the common prefix.

The last case over-sends rather than truncating, deliberately: a client that
concatenates deltas ends up with a superset of the answer instead of a silently
clipped one, and a clip is not recoverable by the caller.

The terminal usage chunk is sent **unconditionally**, not only under
`stream_options.include_usage`. Those are the run's real, billed token counts,
and a caller paying for an orchestration should not have to opt in to being told
what it cost. Unknown chunk fields are ignored by every OpenAI SDK.

## 7. Scope boundaries (v1)

- **No tool/function-calling passthrough.** Cascade's tools run server-side.
  `tools`, `functions`, `tool_choice`, `function_call` and `role: 'tool'`
  messages are rejected.
- **No `n`, `logprobs`, `presence_penalty`, `top_p`, `stop`, `seed`,
  `response_format`, `logit_bias`.** Rejected explicitly rather than ignored —
  silently dropping `n: 3` returns a response that looks successful and is
  wrong. The **no-op default** of each (`n: 1`, `top_p: 1`, penalties at `0`)
  passes through untouched: that is a wrapper filling in fields, not a request.
- **`temperature` / `max_tokens`** DO have an honest home — the per-tier
  generation knobs (`tierParams`) — applied uniformly across tiers, since one
  OpenAI-shaped value carries no per-tier intent.
- **Text only.** Images and documents go through `POST /api/uploads`; a
  non-text content part is rejected with that pointer.

## 8. Conversation state

An OpenAI client is stateless and resends its whole `messages` array each turn.
Prior turns are seeded with `store.importConversation`, so history reaches the
run through the same tree walk the web path uses and the transcript shows up in
the user's own chat list. A stateless client therefore gets one conversation per
request — the honest reading of a stateless protocol, not a bug.

`system` / `developer` turns land in the new `ChatRunPayload.systemPrompt`,
which composes with a selected skill preset. They are **not** folded into
`prompt`: routing reads the bare user text (`routingPrompt`), and a prepended
system preamble there makes even "hi" classify as Complex.

## 9. Entitlements

Unchanged and shared with the socket path — `checkDailyLimit`, `beginRun`
concurrency, the per-run cost cap. A refusal is mapped to `429 rate_limit_error`
rather than a flat 500, because it is the caller's to retry. `/v1` also carries
its own 60/min limiter, matching `/api`; the entitlement caps are the real
guard.

A client hanging up aborts the run (`res.on('close')` → `AbortController`),
exactly as a socket disconnect does — otherwise it keeps spending on an answer
nobody will read.
