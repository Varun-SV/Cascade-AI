# Changelog

All notable changes to Cascade AI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

<!-- One `### Added` / `### Changed` / `### Fixed` per release, not per PR.
     The release workflow copies this whole block verbatim into the GitHub
     release notes (.github/workflows/release.yml), so appending a fresh
     heading per merge ships a release page with four "Added" sections — which
     is what happened to 0.69.0. Add bullets under the existing heading.

     RENAME THIS HEADING to `## <version> - <date>` in the same commit that
     bumps package.json. The workflow matches sections by version prefix, so
     a bumped version with the heading still reading "Unreleased" matches
     nothing — which is how 0.70.0 published with an empty stub for notes. -->

## 0.75.0 - 2026-08-14

### Fixed
- **A bearer token was served in plaintext by `/api/config`.** The handler
  masked `apiKey` and nothing else, under a comment saying "Strip sensitive
  fields before sending". A provider configured with `authToken` — which both
  `cascade link` and `ANTHROPIC_AUTH_TOKEN` produce — had that credential
  returned in full to anyone who could reach the route. The redaction is now a
  single exported function covering every secret field, and is tested on its own
  rather than only through a running server, which is how the gap survived.

- **Claude subscription tokens are no longer offered as usable.** Discovery
  marked the Claude Code OAuth token `directlyUsable: true` and `cascade link
  anthropic --accept-risk` would adopt it. Anthropic's terms now state plainly
  that it "does not permit third-party developers to offer Claude.ai login or to
  route requests through Free, Pro, or Max plan credentials on behalf of their
  users", and it is refused server-side as well — so adopting one produced a
  provider that failed on its first call. The token is still *surfaced*, because
  knowing it is there and why it cannot be used beats silence, but it is no
  longer adoptable, and the warning names the policy and the alternatives
  instead of hedging with "may violate".

- **A desktop settings save threw after persisting.** `setGithubModelsKey` was
  still called when clearing the key inputs, having been removed with the rest
  of the GitHub Models provider in 0.71.0. Keys were written and then the
  handler died on an undefined function, so the UI never confirmed the save.
  This also left `app` failing to typecheck on main.

- **A provider configured with a bearer token showed as unconfigured** in every
  status surface, not just one. The dashboard route, `cascade doctor` (which
  reported "Anthropic API key — Missing" as a critical failure, and is exactly
  where `cascade link` sends you to verify), and the desktop onboarding gate all
  counted `apiKey` alone. `ConfigManager.getAuthToken()` is the companion to
  `getApiKey()`, and all three consult both now.

- **Linking a credential wiped the rest of the provider's configuration.**
  `cascade link` replaced the whole entry, so a configured `baseUrl` was lost —
  harmless while the Anthropic client ignored it, and not harmless now that it
  honours it: adopting a gateway token would have discarded the gateway and sent
  that token to `api.anthropic.com`, the one endpoint where it is not valid.
  Non-credential fields are preserved, and adopting a credential now clears the
  other kind rather than leaving a stale key beside a new token.

### Added
- **`ANTHROPIC_AUTH_TOKEN` is read from the environment.** It was the one
  documented Anthropic credential no environment path picked up, so a user
  following Anthropic's own gateway instructions got "No providers configured".

- **A gateway API key was being sent to `api.anthropic.com`.** Model discovery
  hardcoded the public host and `x-api-key`, ignoring both the configured
  endpoint and the configured auth mode — so a gateway deployment sent the
  *gateway's* credential to a host that was never meant to see it, and then
  replaced the gateway's own model catalogue with the public one, leaving
  routing free to pick models the gateway does not serve. With a bearer token
  configured it sent an empty key and always fell through to the bundled list.
  Discovery now follows the same endpoint and authentication as generation.

- **A newly entered API key could be silently ignored.** `AnthropicProvider`
  reads `authToken` in preference to `apiKey` whenever both are set, and three
  separate settings-save paths wrote the key without clearing the token it was
  replacing — so the key the user had just typed was never used, which from the
  UI is indistinguishable from the save having failed. All three now go through
  one `applyProviderApiKey()`.

- **A Claude subscription token adopted by an earlier release is now removed on
  load.** `cascade link anthropic --accept-risk` used to configure one, and this
  release cannot use it — but nothing was taking it out, so those installs kept
  a dead credential, kept skipping onboarding because something counted as
  configured, and had every request refused. It is stripped from the workspace
  config and the machine-global store, with a notice explaining why and what to
  set instead, reusing the migration path built for retired providers.
  Identification is narrow — the `sk-ant-oat` prefix, or the `credentialSource`
  `cascade link` stamped on it — so a gateway bearer is untouched, and the entry
  survives (minus the token) when it still holds a key or an endpoint. A tier
  pinned to `anthropic:<model>` is reset to Auto when the removal takes the last
  usable Anthropic entry with it, since a pin naming a provider that no longer
  exists fails the run outright rather than falling back — decided from the
  final merged provider list, because a key arriving from the machine-global
  store or the environment keeps that pin perfectly valid. The same filter runs
  on an incoming key-sync bundle: one written before this release can still
  carry the token, the incoming entry wins the provider merge, and pulling it
  would have overwritten a valid API key with a dead one — which the next launch
  would then strip, leaving the good key gone for good.

- **A gateway bearer no longer asks for the Claude OAuth beta.**
  `anthropic-beta: oauth-2025-04-20` belongs to the subscription flow this
  release makes non-adoptable; the SDK maps a bearer to `Authorization: Bearer`
  without it. Sending it to a gateway that validates beta requests is a way to
  have a perfectly valid credential rejected.

- **`ANTHROPIC_BASE_URL` now applies to an API key too**, not only a bearer. A
  key exported beside a gateway produced a provider with no endpoint, and model
  discovery then sent that gateway's key to the public host.

- **A Claude Code file holding both a token and an API key offers the key.**
  Switching authentication modes leaves the old value behind, and returning only
  the non-adoptable token made `cascade link anthropic` refuse with a usable key
  in the same file it had just read.

- **The desktop no longer hands a credential to the renderer.** `getConfig`
  returned the provider's API key across the IPC bridge, where any renderer
  script or DevTools session could read it, and the renderer used only
  `onboardingDone`, `migrationNotice` and `workspace`. It returns
  `hasCredential` now — the fact, not the secret.

- **`cascade link` no longer reports success when it changed nothing.** Azure
  adoption can decline, explaining why, and "✓ Linked" was printed over the
  explanation along with an invitation to verify it.

- **A configured gateway satisfies the bearer's routing requirement.** The
  warning tells the user to set `baseUrl` on the anthropic provider; the gate
  then checked the workspace for Azure only and refused to honour its own
  advice.

- **A bearer token could be adopted with no gateway to send it to.** It is
  issued BY a gateway and valid only AT it, so configuring one without an
  endpoint pointed the client at `api.anthropic.com` — the same credential leak
  closed above in model discovery, arriving by a different door. It is adopted
  only alongside `ANTHROPIC_BASE_URL`, or a `baseUrl` the workspace already has.

- **An Azure key was written across every configured deployment.** Azure keys
  are resource-scoped, so a key linked while deployments on other resources were
  configured would break them and overwrite the keys they already had —
  permanently, the global credential store included. The update is now confined
  to one resource: the one the credential names, or the only one present. With
  several configured and nothing to disambiguate them, `cascade link` lists them
  and changes nothing.

- **Model discovery could ask a gateway for `/v1/v1/models`.** A gateway
  `baseUrl` is commonly written with the version already in it, and the path was
  appended unconditionally — a 404 that fell silently back to the bundled
  catalogue and looked like a gateway with no models of its own.

- **`ANTHROPIC_AUTH_TOKEN` was treated as a subscription token.** It is the
  credential Anthropic documents for gateway routing, but sharing the `oauth`
  classification with the subscription tokens sent the documented `cascade link
  anthropic` down the risk-gate path and refused to persist it. Bearer
  credentials are their own kind now.

- **Linking a hosted service could mark it free.** Adopting a credential
  preserves the provider's other settings, which meant a self-hosted
  `openai-compatible` entry's `local: true` survived onto the hosted endpoint
  replacing it — and an explicit `local` outranks the URL, so every model from a
  paid service would have been priced at zero and slipped the budget caps
  entirely. The flag is dropped whenever adoption changes the endpoint, so it is
  recomputed from the new URL.

- **`config.baseUrl` now reaches the Anthropic client.** It was dropped on both
  the key and bearer paths, which made `authToken` close to useless: routing
  through an LLM gateway or corporate proxy is the sanctioned use of a bearer
  credential, and the request was going to `api.anthropic.com` regardless,
  carrying a token only the gateway had issued.

- **Credential discovery covers more of what is already in your shell.**
  `AZURE_OPENAI_KEY`, and OpenAI-compatible keys for OpenRouter, Groq, DeepSeek,
  xAI, Mistral, Together and Fireworks — each adopted together with the endpoint
  it belongs to, since a key alone would configure a provider with nowhere to
  send a request. `CLAUDE_CONFIG_DIR` is honoured when locating Claude Code's
  store.

  An Azure key is accepted when the WORKSPACE already carries the routing, not
  only when the environment repeats it — discovery sees environment variables
  alone, so a key exported beside already-configured deployments looked
  unusable.

  A fully routed Azure credential — one naming both its endpoint and its
  deployment — is added rather than refused. Requiring the endpoint to already
  exist turned away a key that carried everything needed to configure it, and a
  new deployment on a known resource silently updated the old rows instead of
  being created.

  Azure is the exception: a key alone cannot configure it — without a deployment
  name it resolves to no model at all, and without an endpoint the client falls
  back to a placeholder URL — so it is adopted only when `AZURE_OPENAI_ENDPOINT`
  and `AZURE_OPENAI_DEPLOYMENT` came with it, and the warning names whichever is
  missing. The same guard now applies to the environment injection that would
  otherwise create a routing-less Azure entry, mark the install "configured",
  skip onboarding, and fail later with "No model available for tier".

  Linking an Azure key also no longer collapses a multi-deployment setup. Azure
  is configured one entry per deployment, and adoption replaced every entry of a
  type with a single one — deleting the other deployments' names, endpoints and
  keys, from the global credential store as well. The key is filled into the
  deployments that are already there instead.

  Those services are linkable by name — `cascade link groq` — and the one you
  name is the one you get. They share a single provider type, so every one of
  them is reported rather than just the first, and matching on type alone would
  have configured whichever key sorted earliest.

- **A synced bundle could replace a working key with nothing.** The revoked
  subscription token was stripped from an incoming bundle's providers, but the
  entry itself was kept — the right call for local config, where the row still
  carries a gateway the user configured, and the wrong one here: the merge
  treats a matching incoming row as authoritative, so a row left holding only an
  endpoint overwrote a valid local API key and persisted with no credential at
  all. A row with nothing usable in it is now dropped whole.

- **An exported key and gateway are adopted as a pair.** `ANTHROPIC_API_KEY`
  filled an existing keyless entry, but `ANTHROPIC_BASE_URL` was applied with
  `??=` — so a stale configured endpoint survived and the newly exported
  credential went to a host that had not issued it.

- **An Azure key from the environment could land on the wrong resource.** Azure
  keys are resource-scoped, and `AZURE_OPENAI_KEY` was filled into the first
  keyless entry of that type regardless of which resource it was for. The entry
  is now chosen by `AZURE_OPENAI_ENDPOINT`, or by there being exactly one
  resource configured; with several and nothing to disambiguate them, no key is
  written. That mirrors what `cascade link azure` already does, which was
  otherwise scoping its own write correctly and then persisting the environment
  injection's mistake alongside it.

- **Removing a Claude subscription credential now clears the ordinary tier pin
  too.** Only `anthropic:<model>` was cleared, but the documented config shape
  and the setup wizard both write a bare model id — README's own example is
  `"t1": "claude-opus-4"` — so the common pin was left behind, pointing at a
  provider that had just been removed. The router throws on a pin it cannot
  resolve rather than falling back, so the migration meant to get an install
  working again left that tier dead.

  A bare pin is kept only when a configured provider is KNOWN to serve it —
  which, at config load, means an Azure deployment of that exact name. A gateway
  might serve `claude-sonnet-4`, since the router accepts any registered id
  whatever vendor its name suggests, but its catalogue is discovered at runtime
  and its mere presence proves nothing. Guessing wrong in that direction is the
  costlier mistake: an unresolvable pin makes the router throw on every run,
  where a cleared one costs a tier its pin and is announced. The notice names
  the model as well as the tier, so putting it back is one line.

- **The same dangling pin could arrive by sync.** `applySyncBundle` dropped the
  revoked provider and then reconciled pins with `clearRetiredPins()` alone —
  which does not cover this, because `anthropic` is not a retired provider type
  but a supported one whose credential died. The models merge lets the incoming
  pin win, so a pull from a pre-0.75 device persisted a pin naming a provider
  that was no longer there. Cleared now under the same two conditions the config
  loader applies: this pull actually removed one, and no usable Anthropic
  survives the merge.

- **A synced row holding a replacement key beside the dead token kept the key.**
  Dropping the row whole — right when it carries nothing but an endpoint — lost
  an API key stored alongside the revoked token, which is exactly the shape the
  settings-save paths fixed in this release used to produce, and exactly the
  credential the user was trying to transfer.

- **An environment Azure key now reaches every deployment on its resource.**
  Azure keys are resource-scoped and Azure is configured one entry per
  deployment, so filling only the first left the rest issuing requests with no
  credential at all — the router binds each model to its own row.

- **Azure endpoints are compared through one normalizer.** The provider strips
  trailing slashes before it builds a client, so `https://acme.openai.azure.com`
  and the same URL with one address the same service — but every comparison was
  done on the strings as typed. `cascade link` missed the existing row and
  appended a duplicate deployment while reporting success, and the router, which
  takes the first row matching a deployment name, went on using the old keyless
  one.

- **`cascade link openai-compatible` no longer guesses which service you meant.**
  They share one provider type, so with keys for several exported it adopted
  whichever came first in the discovery table and overwrote the single
  compatible entry with it. It now lists the candidates and asks for one by
  name; naming a service directly (`cascade link groq`) is unchanged.

- **An exported API key no longer moves someone else's bearer to a new host.**
  Environment injection filled a key into any entry without one — including an
  entry holding a gateway `authToken` — and moved `baseUrl` with it. The
  provider prefers `authToken` when both are set, so the exported key was
  ignored and the old gateway's token was sent to the new host. A bearer counts
  as a credential here, exactly as the bearer branch beside it already read it;
  replacing one is what the settings paths do, and they clear it when they do.

- **`ANTHROPIC_AUTH_TOKEN` finds a gateway configured in another workspace.**
  The endpoint check ran before the machine-global credential store was merged
  in, so a gateway entered once and stored globally was invisible: the bearer
  was refused for want of a gateway, and the merge then added that very
  endpoint a few lines later. The lookup reads the global store too, and the
  bearer is adopted whenever that store holds an Anthropic entry rather than
  only on a completely empty config. Refusing a bearer with no gateway anywhere
  is unchanged — sending it to `api.anthropic.com` is the case that rule exists
  for.

- **`cascade link` refuses a deployment name another Azure resource already
  uses.** A deployment name is the model id everywhere downstream, and the
  router binds an Azure model to the first row whose name matches without
  consulting the endpoint. Adding a second `prod` on a different resource
  created a row that could never be selected, while the command reported
  success and requests carried on to the other resource.

- **`ANTHROPIC_BASE_URL` travels with an exported API key through `cascade
  link`, not only through startup.** Adoption keeps whatever the credential says
  nothing about, and discovery attached the endpoint only to the bearer — so
  linking an exported key left the old gateway in place and sent the new key to
  the host that had not issued it. The environment injection cannot cover this
  case: the entry already holds a credential, so it is skipped by design.

- **`cascade link azure` accepts a key whose resource is named but whose
  deployment is not.** The configured deployments already supply that routing,
  and `AZURE_OPENAI_ENDPOINT` says which resource — but every configured
  resource was counted before narrowing, so the key was refused as ambiguous
  when nothing was in doubt. The refusal returns before the write, so nothing
  was persisted either.

- **`cascade doctor` stopped prescribing a step that cannot work.** With a
  Claude subscription token as the only credential on the machine it reported
  "1 found (0 usable) — run `cascade link` to adopt", about a credential
  `cascade link` is required to refuse. It now offers adoption only when
  something is adoptable, and otherwise points at `cascade link` for the
  explanation.

## 0.74.0 - 2026-08-11

### Fixed
- **A working Gemini API key no longer reads as no key at all.** Setting a
  Gemini key in the CLI could produce two messages that, together, said nothing
  true: `provider "gemini" is not available: availability check returned false
  (bad key, wrong endpoint/deployment, or unreachable)`, and then `No model is
  available for a fast answer — add a provider API key first` — about a key that
  was present and worked elsewhere.

  Gemini's availability probe was the only one that asked whether ONE PARTICULAR
  MODEL answered. It called `countTokens` against whichever model the router
  seeded it with, which is the first Gemini entry in the bundled catalogue
  (`gemini-2.0-flash`). A key that cannot reach that one model — retired, not
  enabled for the key's project, served on a different API version — failed the
  probe, and because everything downstream is gated on the verdict (both the
  startup model validation and the live model discovery return early for an
  "unavailable" provider) the account's real model list was never fetched. One
  unreachable model id erased the whole provider. It now asks the account-level
  question instead — the same question OpenAI's probe asks, and the same request
  discovery already makes.

  A failure that says nothing about the credentials — a rate limit, a 5xx, a DNS
  blip — no longer erases the provider either. Only an authentication status is
  treated as a verdict on the key; anything else leaves Gemini enabled and is
  logged as a warning, so a momentary blip at startup cannot cost a user their
  only provider for the rest of the session. That is the same reasoning already
  applied to Azure deployments and openai-compatible endpoints: the probe is
  advisory, and a provider that really is broken fails loudly at generate time
  with its own concrete error.

  It also no longer swallows the reason. `catch { return false }` discarded the
  only thing that would have identified the problem, leaving a three-way guess
  in its place; the API's own message ("API key not valid", "API has not been
  used in project X", "location is not supported") now reaches the log, and each
  of those points at a different fix. The router keeps what the probe reported,
  so a run that finds no usable model names the provider that failed and what it
  said, rather than telling a user with a key in hand to go and add one. An
  unresolvable pinned `fastAnswerModel` is reported first and by name, since a
  stale or mistyped pin fails even when every provider is healthy and leading
  with an unrelated provider's failure would send the user to fix a setting that
  is fine.

### Changed
- **The Gemini API key travels in a header rather than the URL.** Model
  discovery passed it as a `?key=` query parameter, which carries into proxy
  logs, error reports and shell history. It goes in `x-goog-api-key` now.

## 0.73.0 - 2026-08-11

### Fixed
- **A timed-out model call is now cancelled, not just abandoned.** Every
  provider request was time-boxed by racing it against a timer. Losing that
  race told the caller the call had failed; it did nothing to the request,
  which carried on generating and billing against the user's key with its usage
  never reported anywhere. Nothing was reading it by then either. The stream
  path made this visible — a stalled stream falls back to a non-streaming call,
  so two full submissions of the same input could be in flight and billable at
  once — but it applied to every timeout in the router, including the local
  inference path and the tool-support probe.

  Every provider already honoured an abort signal; nothing was handing them
  one. They are now given a signal that fires when the clock runs out, before
  the caller is told, so the first request is on its way down before any
  fallback starts. A caller's own signal chains in, so cancelling a run still
  aborts everything beneath it. Aborting is a request rather than a refund — a
  provider mid-completion may still charge for it — but the run stops paying
  for output nobody will read, and stops paying for it twice.

  This also removes the accounting that existed only to compensate: charging an
  estimate for the abandoned attempt, re-checking the budget before the retry,
  and holding a second reservation across it.

- **The per-run cost cap now refuses a request it cannot afford, instead of
  paying for it and stopping afterwards.** Both per-run ceilings were checked
  after a model call returned, which made them a stop rather than a
  pre-authorisation — the tokens were already bought by the time anything
  counted them. That was tolerable while a prompt could not exceed 20,000
  characters. Removing that cap in 0.72.0 made it matter: the complexity
  classifier sends the whole prompt on the very first call, so a multi-megabyte
  input to a priced model was billed in full before any ceiling looked, and no
  configured cap could give it back.

  A request whose input alone cannot fit what remains of the budget is now
  declined before it is sent, and the message names both the cap and the
  estimate — "would cost about $1.87 in input alone (~623,000 tokens), and only
  $0.50 of the per-task cap of $2.00 remains" — because "too expensive" with no
  numbers gives nobody anything to change.

  Deliberately narrow, since a false refusal is worse than a late stop. It
  counts input only: what a call returns is not knowable in advance, and
  reserving a worst-case output allowance would decline runs that would have
  finished comfortably. It judges against what remains rather than the whole
  cap. It skips a model with no usable price — an estimate cannot be made, and
  refusing on ignorance would break every local and self-hosted model the
  moment a cap was set — leaving those to the post-hoc stop as before. And it
  does nothing at all when no cap is configured.

  Tripping the ceiling now cancels work already in flight, not just work still
  queued. A parallel wave's earlier members are at the provider by the time a
  later one runs out of budget, and they carried on generating for a run whose
  output would be discarded. The router holds a per-run abort that every
  provider call chains to, so the ceiling reaches the requests that are
  running. A budget abort still reports itself as a budget failure rather than
  a cancellation — otherwise the reason the run stopped is lost on the way up.
  That signal is given room for the listeners a wave attaches to it; at Node's
  default of ten, an ordinary parallel run logged a `MaxListenersExceededWarning`
  and looked like a leak. The same applies to the two other things a wave shares
  — the per-wave abort signal T2 composes for cancel-and-respawn, and the peer
  bus every worker in a section subscribes to, whose listener count is simply
  the wave width.

- **Cancelling a T3 wave now reaches the model call that is running.** T2 aborts
  a per-wave signal to cancel and respawn a wave, and that signal reached the
  workers' tool calls but not the generation itself — only one of the five model
  calls in a worker passed it through. So a respawned wave left its predecessor
  generating and billing, stopping only at the next checkpoint. All of them pass
  it now. It is a superset of the run signal the router injects when a call
  supplies none, so nothing that was cancellable before has become less so.

- **A cancelled call no longer waits out the queue it was sitting in.** Two
  places hold a request before it is submitted — the per-provider rate-limit
  bucket and the local-inference queue — and both could hold it for a long
  time: most of a refill interval for the first, and half the inference timeout
  (150 seconds by default, at the default concurrency of one) for the second.
  Neither was watching the caller's own signal, and the local queue was
  watching no signal at all. So cancelling a run, or a manager respawning a
  wave, left those calls parked for the full window before anything noticed —
  waiting for capacity they would drop the instant they received it. Both waits
  now end as soon as any of the signals that make the call pointless fires, and
  a call that leaves the local queue this way gives up its place rather than
  taking a slot on the way out. The reservation it was holding is released too;
  previously a request that never reached a provider could shrink every later
  call's allowance for the rest of the run.

  A call already admitted when a sibling trips the ceiling no longer submits.
  The kill switch was checked when a call entered the router, but a request can
  then sit for a long time in the rate-limit bucket or the local-inference
  queue, and one member of a parallel wave can exhaust the budget while the
  others wait. Every one of them went on to spend against a run that was
  already over and whose output would be discarded. It is re-checked
  immediately before submission.

  An admitted call HOLDS its estimate against the budget until it settles.
  Checking against spent-so-far alone is a time-of-check/time-of-use hole that
  the common case walks straight into: a T2 wave launches its T3 workers
  concurrently, so every call reaches the check before any response has updated
  the total. Each would see the same untouched allowance, all would be
  admitted, and the run could bill several times the cap before the post-hoc
  stop noticed.

  The estimate also counts what the provider actually bills: serialized tool
  definitions, which Anthropic and others send in full on every native-tool
  call; an assistant turn's tool calls, which are a separate field from its
  content and are serialized back into the next request; images arriving either
  nested in a message or, for the one provider that reads that field, on the
  top-level `images` option; and dense scripts —
  CJK and emoji cost about a token per character, where the
  four-characters-per-token rule used elsewhere underestimates them fourfold,
  and an underestimate in an enforcement path is a cap that does not hold; and
  the per-turn framing every provider wraps around a message, without which a
  long history of short turns reserved about a token each.

  What gets billed is provider-specific, and the estimate now says so in one
  place instead of several. Every provider rewrites a request on the way out,
  and the differences are not small: Anthropic discards system-role history
  outright, which is where compaction puts its summary of the entire
  conversation; Gemini drops URL image attachments, folds system turns into the
  next user turn, rewrites every tool schema through a sanitiser that strips
  the metadata a large MCP schema is mostly made of, and attaches a top-level
  image twice in one particular shape of history; Anthropic and Gemini both
  ignore block content on an assistant turn entirely, and Gemini on a system
  turn; OpenAI ignores it on system and tool turns, and drops an assistant
  turn's tool calls when its content is a block array; a tool result carrying
  blocks is JSON-stringified whole by three of the four, base64 image payload
  included, so it costs its real size rather than the flat per-image rate.

  Tool definitions AND an assistant turn's historical tool calls are sized by
  the provider's own conversion function rather than a description of it. No provider sends a definition as it was given —
  OpenAI and Ollama wrap each one in a function envelope, Anthropic renames the
  schema field, Gemini rewrites the schema entirely — and the omitted envelope
  is a few tokens per tool, which a large MCP server turns into hundreds, always
  in the direction that lets a request slip a tight cap. Tool calls diverge
  further still: OpenAI serializes the argument object to a string and embeds
  that in JSON, so every quote inside is escaped twice over, while Gemini sends
  no call id at all. Those conversions are now shared with the providers
  outright, so the estimate is not a copy of what gets sent; it is the same
  function.

  A `tool_result` block sitting in a user turn is no longer charged. Every
  provider's array conversion has a branch for text and a branch for images and
  nothing else — the block is dropped by all four — but the estimator expanded
  its whole payload, so a tool-heavy history could be refused over data no
  provider ever sees. On a tool-role turn, where the array is serialized whole,
  it is still counted, because there it really is sent.

  Mixed-script input is measured by adding its parts rather than taking the
  larger one. Prose was bounded by character count and dense scripts by UTF-8
  bytes, and the guard returned whichever was bigger — so a document combining
  the two was charged for one half and nothing for the other, and adding more
  prose to a CJK-heavy prompt did not move the estimate at all until it
  overtook the dense part. Neither bound changed on its own.

  Each of those was found the same way — one at a time, in review, after the
  estimate was already wrong in production-shaped input — because the rules
  lived as one-off provider conditionals scattered through the estimator with
  nothing tying them to the code they modelled. They are now a single table
  (`core/router/wire-profile.ts`) derived by reading each serializer end to
  end, and its rows are tested by running the real serializers over a marked
  message and looking for the marker in what comes out. A provider that changes
  how it builds a request now fails a test rather than quietly biasing every
  budget decision.

  Per-run accounting is scoped to the run that asked for it. A call still in
  flight when the next task begins was charged to that task's fresh allowance,
  and if its usage pushed the total past the ceiling, the abort that followed
  cancelled the new run's work — a wave that had spent nothing — over a verdict
  about a run that was already finished. Session totals are unaffected: the
  money left the account whichever run asked for it, and a task boundary must
  not become a way to spend past the session cap.

  Token-dense ASCII — base64, hashes, minified data — is knowingly left at the
  prose rate. It tokenizes more densely than that, but the only cheap way to
  spot it is whitespace ratio, which cannot tell a payload from a long URL, a
  pasted code block, or a repeated character that compresses to almost
  nothing. Raising the rate for all of them refuses runs that would have
  completed. The residual under-count is caught by the post-call ceiling, as
  it always was.

  Images are charged a flat rate rather than sized from their bytes. Providers
  bill from decoded dimensions, so byte length misleads in both directions: a
  heavily compressed screenshot can be a few kilobytes and still be billed near
  the megapixel maximum, while a 20 MB photo is downscaled to that same
  ceiling. Sizing from bytes undercounted exactly the images that would slip a
  tight cap.

- **A long call is no longer priced at the short-call rate.** Several
  long-context models charge more past a threshold — Gemini 3.1 Pro is $2 per
  million input tokens up to 200K and $4 above it — and the pricing dataset
  carries those bands. Nothing was passing the input size in to select one, so
  the cheapest band was resolved unconditionally. That understated the preflight
  estimate for exactly the large calls it exists to catch, and, because the same
  function backs `buildTokenUsage`, it also understated the spend Cascade
  reported for those calls after the fact.

  Selecting the band means asking the pricing dataset, not the model object.
  Both the bundled catalogue and the discovery path stamp a model's price by
  resolving that dataset with no input size, which always lands on the cheapest
  band — so the stamped field is not an answer to "what will this call cost",
  and preferring it made the input size irrelevant for every model carrying a
  price, which is nearly all of them. The band is applied as a multiplier on
  whatever price the model carries rather than as a replacement, so a fresher
  rate fetched by live pricing survives instead of being silently swapped for
  the bundled one.

## 0.72.0 - 2026-08-10

### Changed
- **The 20,000-character limit on a prompt is gone.** It rejected exactly the
  inputs Cascade exists for — a pasted document, a full stack trace, a whole
  file — and it did so on every attempt, so for those messages the product
  simply did not work. `systemPrompt` loses the same cap, which a preamble
  assembled from an OpenAI-compatible request's `system`/`developer` messages
  routinely exceeds.

  A ceiling still exists, because the transport has one: socket.io is
  configured with a 2 MB frame limit. That limit fails in the worst possible
  way — an oversized frame is dropped before any handler runs, so there is no
  validation error and no acknowledgement, and the message simply never
  answers. The browser now checks the size itself, just under the boundary and
  in UTF-8 bytes rather than characters, and says how large the message is and
  what to do about it. The authoritative check runs on the encoded payload, not
  the raw text — socket.io JSON-encodes what it sends, and encoding is not
  length-preserving, so text made largely of quotes or backslashes nearly
  doubles on the wire and would otherwise sail past a raw-byte check straight
  into the silent drop.

  Spend is still bounded, but not perfectly: extended context compacts
  oversized input, and the per-run token and cost caps stop a run once they are
  exceeded. Those caps are checked after each model call returns, so a single
  very large input can carry one call past the cap before anything halts the
  run — the ceiling behaves as a stop, not as a pre-authorisation. On a priced
  large-context model a multi-megabyte prompt is the case where that gap is
  worth knowing about.

  `POST /v1/chat/completions` had its own copy of the same 20,000-character
  bound, which would have left it the one path still answering
  `context_length_exceeded` for a prompt everything else accepts. Removed; that
  route's own 4 MB body limit, with its own error, is the real bound.

### Fixed
- **A hosted run no longer fails a node for work it actually did.** Asking for
  a document could end with the run announcing a file write, producing no file
  anyone could find, and then failing the step with "Worker stalled waiting for
  artifact creation. Requesting dynamic tool generation from T2 Manager". Two
  causes, and the file usually did get written:

  Artifact verification resolved a promised filename against `process.cwd()`,
  which is the workspace only in a plain CLI run. The hosted server runs with
  its working directory at the app while the run's workspace is the tenant's
  scratch directory, and the desktop app's is the application bundle rather
  than the folder you chose. So the tool wrote `<workspace>/report.docx` and
  the check looked for `<cwd>/report.docx`, found nothing, retried, and threw.
  Verification now asks the tool registry for the root every tool was
  configured with, which is by definition where the file went.

  And `generate_document` was registered in hosted runs at all. It registers
  outside the `enabledTools` allowlist deliberately — that list guards tools
  reaching the machine, and this one only writes into the run's own workspace —
  but a hosted workspace is an ephemeral scratch directory with no route
  serving a file out of it. Its presence also made the worker *require* a file
  artifact, so a subtask naming a filename was held to a standard it could not
  meet. Hosted runs deliver files through the `file:` fence instead, which the
  browser already renders into a real .docx/.pptx/.xlsx on download.

- **A validation error now names the field it is about.** The whole message a
  user got was `String must contain at most 20000 character(s); Number must be
  less than or equal to 200000; Number must be less than or equal to 200000;
  Number must be less than or equal to 200000` — four anonymous sentences,
  three of them identical, describing constraints on none-of-them-says-which
  of about twenty fields. Zod's `issue.message` describes the constraint and
  never the path, and both the socket handler and the OpenAI-compatible
  endpoint joined messages alone. They now render the path too, so the same
  failure reads `tierParams.t1.maxTokens: Number must be less than or equal to
  200000`.

- **A per-tier token limit set too high no longer breaks every message.** The
  server caps `maxTokens` at 200,000 per tier; the Settings input was
  `min={1}` with no maximum, and the preference store accepted anything above
  zero. So a larger value saved without complaint and then failed validation
  on every single run — and because the error did not name the field, there
  was nothing connecting a chat that had stopped working to a number in a
  panel the user had no reason to suspect. The input now carries the limit and
  the store clamps to it.

  Clamping on save alone would have fixed nothing for anyone already affected:
  their value is in `localStorage` and is only ever read back, never rewritten
  unless they happen to reopen Settings and save. Redeploying the server does
  not touch it either — it is in the browser. So the value is clamped on READ
  as well, which repairs an existing one on the next page load.

- **The download buttons stop falling back to a GitHub link after a redeploy.**
  This was not a regression in the buttons; it is the designed fallback firing
  because the release lookup could not resolve. Two causes, both fixed:

  The call to GitHub's API was unauthenticated, which is limited to 60 requests
  per hour **per IP** — and a shared host's egress IP is shared with every
  other tenant on it, so the budget could be spent by traffic that has nothing
  to do with this service. A `GITHUB_API_TOKEN` (no scopes required; it reads a
  public release) raises that to 5,000/hour and makes it ours. Unset, the old
  unauthenticated behaviour is unchanged.

  And the cache was in-process only, so it could not help a process that had
  not already succeeded once. A redeploy started cold, and the 24-hour
  stale-serving window had nothing to fall back to if that first fetch failed —
  which is exactly when the fallback is most visible. The last good manifest is
  now written under `DATA_DIR` (atomically, via a temp file and rename) and
  read back at startup, so a restart begins warm. What comes off disk is
  re-validated against the same trust check a fetched manifest gets, since the
  site renders those URLs as links.

- **The handoff courier is bounded by memory, not just by record count.** The
  store capped how many pending transfers it held (5,000) but not how large
  they could be — fine while the body parser held each one under 100 KB, and no
  longer fine now that the parser accepts what the validator advertises. At the
  per-transfer ceiling that is roughly 2.5 GB retained for the full 15-minute
  expiry, on an endpoint that needs no account and whose rate limit is per-IP,
  so spreading requests across addresses walks straight past it. There is now
  an aggregate character budget alongside the record count: the two bound
  different shapes of load — many small transfers, or few enormous ones — and
  only the pair covers both.

- **Transferring a chat between devices no longer shortens it.** The handoff
  courier sliced every message at 20,000 characters — mirroring the prompt cap
  removed above — so a transferred conversation containing a pasted document
  arrived with only its opening, persisted as the whole turn, with nothing
  anywhere saying so. It now refuses a transfer it cannot carry rather than
  quietly changing what the conversation says — and both handoff routes get a
  body parser sized to what they accept, since they ran through the 100 KB
  default and would have rejected a long transfer at the middleware before any
  of that validation could speak.

- Dropped the stale `GITHUB_MODELS_TOKEN` entry from the server's
  `.env.example`, missed when the provider was removed in 0.71.0.

## 0.71.0 - 2026-08-06

### Removed
- **The GitHub Models provider is gone, because the service is.** GitHub
  [fully retired GitHub Models on 30 July 2026](https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/).
  `models.github.ai` no longer answers, so the provider could not list a single
  model or serve a single completion — it was an option in every provider
  picker that could only fail.

  Removed across all four surfaces: the SDK provider and its router, selector,
  TPM, live-data and profiler wiring; `cascade init`, `cascade doctor` and the
  REPL's model refresh; the desktop Settings and Onboarding pickers; and the
  cloud KeyVault, run payload schema and `GITHUB_MODELS_TOKEN` env var. Six
  named provider types remain.

  **If you pinned a tier to `github-models:<model>`, that pin now fails to
  resolve and names the provider** rather than silently falling through to
  something else — repoint it at a provider you have configured.

  **This removes nothing you can still reach.** Anything that speaks the
  OpenAI chat-completions format is still supported through the
  `openai-compatible` provider, which takes any base URL, makes the API key
  optional for local servers, and discovers models live from the endpoint's own
  `/models`. That covers hosted APIs (Groq, Together, Fireworks, DeepSeek,
  Mistral, OpenRouter, xAI, Perplexity, Cerebras…) and local runtimes
  (llama.cpp, LM Studio, vLLM, text-generation-webui) alike. The six named
  types are the ones with bespoke wire formats or bundled catalogs — not the
  limit of what Cascade can talk to.

  Several router behaviours that were introduced for this provider are
  genuinely generic and were kept, with their tests repointed at
  `openai-compatible`: a `provider:owner/model` pin keeps slashes in the model
  id intact, a live-discovered model stays out of Cascade Auto's scored pool
  while remaining reachable by an explicit pin, the TPM reservation is capped
  at the model's real `maxOutputTokens` rather than an uncapped per-call
  override, `getNextFallback()` widens past a dynamically-resolved pin, and
  `selectVisionModel()` finds a live-discovered vision model.

  **This is a minor bump, not a patch, and deliberately so.** Removing a member
  from the exported `ProviderType` and from the accepted `providers[].type`
  values breaks compilation for code that named it. Shipping that as 0.70.1
  would have handed it to everyone on `^0.70.0` automatically, which for a
  pre-1.0 package resolves to `>=0.70.0 <0.71.0`.

### Fixed
- **Upgrading no longer breaks an install that used the retired provider.**
  Narrowing a type is a build-time change; it does nothing to the values
  already saved on disk and in browsers, and every one of those stores is read
  back without validation. Left alone, the removal above would have been
  actively hostile to exactly the users who had adopted the provider:

  - **The CLI and desktop app would not start.** `ConfigManager.load()` hands
    the parsed `.cascade/config.json` straight to `validateConfig()`, which
    *throws* on an unknown provider type — so the CLI died at launch and the
    desktop app reported "Could not load Cascade config" with no route to
    repair, because the config manager Settings would repair through never
    finished constructing. Retired types are now stripped from the raw object
    *before* validation, and the cleaned file is written back so it happens
    once.
  - **The machine-global credential store would put it straight back.**
    `~/.cascade-ai/credentials.json` is merged in *after* validation and never
    passes through the schema at all, so cleaning only the workspace file would
    have fixed nothing for anyone whose key was stored globally — the entry
    would be gone from disk and back in memory a few lines later, on every
    load, in every workspace. It is now filtered and rewritten too.
  - **A tier pin would fail every request.** `models.t1` and friends store a
    plain `provider:model` string that survives any provider-list filter. A pin
    naming a retired provider is now cleared, returning that tier to Auto.
  - **The hosted web app could not chat at all.** The browser key vault is raw
    JSON in `localStorage`, read back with no validation and sent verbatim on
    every run — so the server's own provider enum rejected the whole payload
    until the user happened to open the vault and delete the row by hand.
    Account sync made it recurrent: a restore merged the decrypted provider
    array without filtering, reintroducing the dead entry into an
    already-cleaned vault. Both paths now strip retired types, the cleaned
    vault is persisted, and a one-time dismissible notice explains what was
    removed and what to use instead — a key silently disappearing reads as
    data loss.
  - **An encrypted account-sync blob would reintroduce it on CLI and desktop.**
    A sync blob is a snapshot of whatever the pushing device held, so one
    pushed before the retirement still carries the provider entry *and* the
    `provider:model` tier pins naming it — and nothing between the decrypt and
    the merge validated either. On the CLI that surfaced as a validation throw
    inside a `catch` written for a wrong passphrase, so `cascade sync pull`
    told the user to check a passphrase that was correct. On desktop the merged
    values were copied into the **live** config before persisting, reinstating
    the dead provider for the session and writing a file the next load had to
    repair. `applySyncBundle()` now sanitises the bundle — the one function all
    the native surfaces go through — and reports what it dropped, so both can
    say what was skipped instead of discarding it silently.

  Also fixed: `cascade sync pull` no longer reports every downstream failure as
  a decryption failure. The `try` scoped only to the decrypt now, so an apply
  error says what actually went wrong.

- **The migration itself no longer leaks credentials into the workspace.** It
  used to persist through the same `save()` that runs at the end of config
  load — by which point the in-memory config has been enriched with keys from
  the environment and from the machine-global credential store (kept `0600` in
  `~/.cascade-ai`). Serializing that enriched object wrote those secrets into
  `.cascade/config.json`, which may be `0644`, for a project that never had
  them: opening any workspace after upgrading would copy a global OpenAI key
  into it. The cleaned file is now written from the *raw* parsed config inside
  `loadConfig()`, before any enrichment happens.

  The hazard predates this release — the same late `save()` already ran for the
  MCP-rename migration — but a retirement fires for every upgrading user rather
  than on a rare name collision, which is what made it worth closing here.

  Four more edges in the same migration, all of which would have made an
  upgrade worse rather than better:
  - **A read-only config directory aborted startup.** The write is best-effort
    now, matching how credential syncing already treats an unwritable home: the
    in-memory config is clean, so the run proceeds and migrates again next
    launch.
  - **A pin written in another case survived.** `GitHub-Models:openai/gpt-4o`
    was a *valid* pin, because pin parsing lowercases the provider prefix. The
    migration compared raw case and stranded exactly those, leaving the router
    to reject the pin or misread the literal id as another provider's.
  - **Losing your only provider looked like a fresh install.** An emptied list
    made the config manager inject a keyless Ollama entry, which counts as
    "usable" without checking the daemon exists — so both the setup wizard and
    the headless no-providers guard were skipped and the run reached the router
    with no model at all.
  - **Cached models for the retired provider blocked discovery.** The REPL only
    re-discovers when its cache is empty or a day old, so leftover rows read as
    "populated" and the providers that replaced it showed zero models. They are
    purged on migration.

  The notice is also retained for a UI to display rather than only logged: the
  REPL clears the terminal immediately after loading, and the desktop emits
  from a process with nothing to draw on. Both desktop and browser sync now
  report what a pre-upgrade blob had removed from it, instead of saying only
  "Applied" — the CLI, desktop and web restore paths all explain it now, so
  none of them is the one place a key vanishes unannounced.

  **The desktop explains the migration whether or not setup reopens.** The
  notice was routed only into the onboarding screen, which appears solely when
  *nothing* usable is left — but the common case is a provider removed while
  others remain, where onboarding never opens and the one-shot notice was
  consumed and discarded. It now also shows as a dismissible bar in the normal
  app shell, so a vanished key or a reset tier pin is explained in the case
  that affects most people.

  **A rejected setup no longer closes anyway.** Refusing to mark onboarding
  complete happened in the Electron main process, while the wizard's own Redux
  state closed the screen 1.2 seconds later regardless — so the guard only took
  effect after an app restart and the live window walked into providerless
  chat. The completion decision is returned to the renderer and the wizard
  honours it, staying open with a reason when a choice leaves nothing usable.

  **Desktop onboarding can now save the keyless options it advertises.**
  `cascade:setConfig` only wrote a provider when an API key was present, so
  picking Ollama — described in the wizard as "no API key needed" — saved
  nothing, while the "setup finished" flag was written regardless. The wizard
  therefore claimed success for a run that changed nothing. Keyless types are
  saved without a key now, and completion is recorded only when the config can
  actually serve a run, so "Auto" (which maps to no provider at all) no longer
  closes setup over an empty list.

  **Stale cached models are cleared even when nothing was migrated.** The purge
  was gated on a migration having fired, which missed the person who had
  already deleted the provider from their config before upgrading: no
  migration, but the rows were still in the database, and the REPL treats any
  non-empty, non-stale cache as authoritative — so the providers they *did*
  have showed no models for a day. Rows for known retired types are now cleared
  on every load.

  **The desktop reopens setup when the migration leaves it with nothing.** Its
  "onboarding finished" flag recorded that setup was completed once; it said
  nothing about whether the provider chosen then still exists. So a desktop
  install whose only provider was GitHub Models opened straight into the app
  with no provider, no wizard, and no explanation. The flag is now combined
  with the same "is anything usable?" check the CLI makes, so setup reopens
  whenever there is nothing to run with — whatever emptied the list — and the
  migration notice is shown on that screen, next to the thing the user is being
  asked to redo.

  The notice now reaches the CLI as a startup message inside the REPL rather
  than a console line the screen clear erases a moment later, and a vault whose
  cleaned copy cannot be written back still returns the keys it just parsed —
  a refused `localStorage` write used to discard every provider for the
  session, which is a far worse outcome than migrating again next load.

  And the hosted server no longer fails a run outright because the client is
  older than it is. A browser tab left open across a deploy keeps sending its
  in-memory provider list until the page is reloaded, and the localStorage
  migration only runs in freshly loaded assets — so the narrowed enum rejected
  every run from that tab even when it also carried a working provider. The
  retired type is filtered out of the payload before validation instead. A
  request whose *only* provider was retired is still rejected: the filter runs
  before the "at least one" check, so "nothing left to run with" remains an
  error rather than becoming a silent empty run.

- **An Anthropic OAuth login no longer reads as "no providers configured".**
  `cascade link` stores an adopted subscription token in `authToken`, and the
  Anthropic provider accepts it as readily as an API key — but the shared "is
  anything usable?" check counted only `apiKey`. So an install whose single
  credential came from `cascade link` was treated as unconfigured everywhere
  that check is asked: `cascade run` aborted with "No providers configured. Run
  `cascade init` first", the REPL relaunched the setup wizard on every start,
  and the desktop app now reopened its full-screen wizard over a config that
  runs fine. A token counts as a credential.

- **A second config load no longer inherits the first one's migration.** The
  "what did this load migrate out?" flag was set but never reset, and two
  places read it as a statement about the load in progress. `startRepl()`
  reloads through the same config manager after its setup wizard, so the
  migration was announced a second time over a file that was already clean —
  and, worse, an empty provider list on that later load was read as "emptied by
  the retirement", which suppresses the keyless Ollama fallback. The same
  instance therefore behaved differently from a freshly constructed one on
  identical files. It is now reset on entry to every load.

- **A sync pull no longer claims it reset a tier pin it left alone.** Stripping
  a dead pin out of the incoming bundle is not the same as clearing it in the
  result: the merge is `{ ...config.models, ...bundle.models }`, so deleting an
  incoming key just lets the receiving device's own pin for that tier through.
  Keeping that local pin is right — it is still valid, and discarding it
  because a stale remote snapshot happened to name a dead provider for the same
  tier would be data loss caused by garbage input — but the CLI and desktop
  then announced "reset T1 to Auto" over a pin that was still in place and
  still in effect. The report is now derived from the merged result, and a pin
  that survives the merge still naming a retired provider is cleared there,
  since that one is dead whichever side it arrived from. Native-only: the
  browser's sync bundle carries no tier pins.

- **A reopened desktop setup no longer forgets your workspace.** The wizard
  started its directory field blank, which was right when it only ever ran on a
  first launch — but it now reopens on configured machines when a migration
  empties the provider list. Its first save fires from the key-verification
  step, *before* the workspace question is even shown, so the blank overwrote
  the stored directory and the next launch silently fell back to the home
  directory. The field is seeded from the existing workspace, and a blank value
  is no longer written over a saved one on either side of the IPC boundary.

## 0.70.0 - 2026-08-06

### Added
- **`POST /v1/chat/completions` — an OpenAI-compatible endpoint.** Anything that
  already talks to OpenAI can now talk to Cascade: point a client's `base_url`
  at a Cascade server's `/v1`, use a Cascade access token as the API key, and
  the official Python and JS SDKs work unchanged, streaming and not. `GET
  /v1/models` serves the catalog so clients can discover it.

  **`model` names a routing mode, not a model** — `cascade` (full orchestration,
  balanced), `cascade-fast` (one mid-tier model, no orchestration) and
  `cascade-quality` (orchestration biased to quality). Cascade picks a model per
  subtask; that is the product, so letting a caller name `gpt-4o` would either
  be a lie or would turn the orchestrator off. An unrecognised name returns a
  `404 model_not_found` in OpenAI's own error envelope rather than falling back
  to `auto`, because a request that asked for one thing and silently got billed
  for a full orchestration has no way to notice. Unsupported parameters (`n > 1`,
  `logprobs`, `tools`, `response_format`, …) are rejected for the same reason —
  though their **no-op defaults** (`n: 1`, `top_p: 1`, penalties at `0`) pass
  through untouched, since that is a wrapper filling in fields rather than a
  request. `temperature` and `max_tokens` do have an honest home and are mapped
  onto the per-tier generation knobs.

  **The endpoint runs unattended, and that required removing listeners rather
  than adding a flag.** The SDK's interactive gates already treat "nobody is
  listening" as "proceed": `cascade.ts` returns each gate's default the moment
  `listenerCount(...)` is zero — escalation resolves to `skip`, context approval
  and plan approval to proceed. The run pipeline attached those listeners
  unconditionally, which is exactly the wrong shape for an HTTP caller that has
  no way to answer them: an escalating run would hold the connection open for
  the full five-minute escalation timeout and then resolve as `timeout` —
  strictly worse than the `skip` it gets for free with nothing attached. Runs
  now take an `interactive` flag (default on, so the web UI's gates are
  untouched) and the HTTP path attaches no gate listener at all. It is invisible
  in normal use, since it only fires when a worker actually escalates, so a test
  asserts the listener counts directly instead of waiting to find out.

  **Provider keys are read from the environment only on a single-account
  instance.** On a self-host the operator and the caller are the same person, so
  the operator's own keys are the obvious source; the moment a second account
  exists that key would pay for someone else's runs with no per-user accounting,
  so it stops — automatically, per request, and logged at boot so the rule is
  visible rather than inferred. Multi-account instances keep the product's
  bring-your-own-key model, and any caller can pass keys per request through the
  SDK's `extra_body`. Either way the request is validated by the same Zod schema
  the socket path uses, so an API run can never build a payload a socket run
  could not.

  Streamed deltas come from the presenter tier and are **reconciled** against the
  run's authoritative output before the stream is allowed to end: identical ends
  normally, an answer that extends what streamed gets the remainder, and a stream
  that *diverged* terminates with an error rather than a `stop`. SSE cannot
  retract bytes already sent, so appending a correction after them would make a
  client assemble a mangled answer and read it as complete — a visible failure is
  the better outcome, and both official SDKs raise on it. Every reply carries a
  `cascade` block naming the tier and model that actually served it and what the
  routing saved; it rides the terminal frame, so cost is on every stream while
  the choices-less token-usage frame stays opt-in behind
  `stream_options.include_usage`, as the streaming shape defines it.

  Reusing the existing run pipeline needed one narrowing: `ChatRunDeps.socket`
  was typed `socket.io`'s `Socket`, though every use in the file is a
  fire-and-forget `emit` plus a pair of `on`/`off`. It is now a structural
  `RunSocket` that a real `Socket` satisfies unchanged, which is what lets the
  HTTP side supply an SSE-backed implementation instead of forking `runChatTurn`.

  A stateless caller's prior turns ride the run payload as `seedHistory` rather
  than being written by the route, so they are persisted **inside**
  `runChatTurn`'s admission boundary. `checkDailyLimit` and `beginRun` run first
  and deliberately touch nothing before they pass; seeding outside that boundary
  meant a request over its daily cap returned 429 having already written its
  whole transcript — repeatable at will, charged to nobody, and invisible until
  the disk filled.

### Fixed
- **Parsing an `Authorization: Bearer` header was quadratic in its length.**
  `/^Bearer\s+(.+)$/` reads as harmless, but `\s+` and `.+` both match a space,
  so for a value that ultimately fails to match the engine had to try every way
  of splitting a long run of spaces between them. Measured on the real header
  path: 10k spaces took 121 ms, 40k took 1.8 s, 120k took 15.9 s — and this runs
  on every authenticated request, including the unauthenticated attempts, so it
  is the one input a caller controls for free. The scheme and the token are now
  split on the first whitespace by index, which has no split to explore and is
  linear; the parse is otherwise unchanged, down to refusing a value carrying a
  newline. Found while adding the OpenAI-compatible endpoint above, which routes
  a second caller through the same function.

## 0.69.0 - 2026-08-06

### Added
- **`docker compose up` now self-hosts the web app.** There was no general path
  to run it: the only Dockerfile was Railway-specific (root user, no
  healthcheck, driven by `railway.json`), and there was no compose file and no
  `.env.example` at all — so running the web app yourself meant cloning the
  monorepo and reverse-engineering the environment from `env.ts`. A root
  `Dockerfile` (multi-stage, non-root, healthchecked against the real `/health`
  route), a `docker-compose.yml` with a named volume for the SQLite database and
  uploads, and an `.env.example` covering all 18 variables the server actually
  reads now make it one command.

  **The compose file publishes to `127.0.0.1` only, and the sign-in bypass ships
  commented out.** These two go together: a fresh self-host has no OAuth
  configured, so the documented way in is `CLOUD_DEV_BYPASS`, which
  authenticates anyone who can reach the port with no credential at all.
  Defaulting to `0.0.0.0` with that enabled would hand the whole local network a
  sign-in-as-anyone endpoint on the first `docker compose up`. Enabling it is
  now a deliberate, documented step, which also matches how Cascade already
  binds its CLI dashboard.

  **CI builds and boots the image on every pull request.** The rest of the
  workflow runs the build commands directly, which proves the code compiles but
  says nothing about whether the image the README tells people to run actually
  assembles and starts — a `COPY` pointing at a path that stopped existing would
  reach users rather than CI. The new job builds it, runs it, waits for
  `/health`, and asserts `GET /` returns the built SPA shell rather than a 404,
  since a build stage that silently skipped the web build would still pass a
  health check.
- **The task graph now leaves the SDK.** `tier:status` carries three new fields:
  `nodeId`, `dependsOn` and `waveId`. Until now the orchestrator compiled a
  typed dependency graph, executed it in waves, and then told every surface only
  who was working — never what anything waited for, nor what ran at the same
  time as what. `dependsOn` existed solely inside `src/core/orchestration/` and
  reached no client at all, so no surface could draw the structure even in
  principle.

  `nodeId` is a **separate id space from `tierId`**, and that distinction is the
  whole reason the fields are usable. `tierId` identifies a tier *instance*
  (`T2_a1b2c3d4`, minted per construction); `nodeId` identifies the *work*
  (`s1`), which is what dependency edges name. Sending `dependsOn` without it
  would have produced a graph whose every edge pointed at a node that never
  appears in the stream.

  Both `tier:status` payloads carry them — the terminal-status one and the
  progress-update one, which are built at different call sites with different
  shapes. A field on only one arrives intermittently, which is harder to consume
  than one that never arrives, so a test asserts both.

  Nothing renders a graph yet; this is the data becoming available. Consumers on
  all four surfaces (CLI tree, desktop store, cloud web activity, dashboard
  socket) now carry the fields through instead of dropping them, including the
  one transport that reconstructs the payload from positional arguments and
  silently discarded anything unnamed.

### Fixed
- **Work that was skipped is no longer reported as work that failed.** When a
  section fails, everything downstream of it is skipped rather than run into the
  same wall — that has been true since the dependency contracts shipped. What
  the user was *told*, though, was that those sections `FAILED`: the skip was
  recorded as a failure with the real explanation flattened into a prose string,
  so a single broken section made three more look broken too. Skipped work is
  now `BLOCKED`, a terminal state of its own that means "never attempted, cost
  nothing, says nothing about whether it would have worked".

  The cause is carried as data rather than prose, and by **title** rather than
  by internal id — the previous message read `Blocked by: s1`, naming a section
  the user has never seen, twice.

  Three surfaces were showing this wrongly, each differently:
  - The hosted web app matched status names by substring and `BLOCKED` matched
    none of them, so skipped sections fell through to the in-progress mark and
    sat there spinning for the rest of the session.
  - The desktop app kept its own copy of the status list, so blocked nodes
    rendered as grey "not started" and were never eligible for "clean up
    session" — they stayed on the graph permanently.
  - The CLI tree kept a third copy and simply drew nothing.

  All three now read the status vocabulary from one place, so the next addition
  is a compile error rather than a silent fallback. Blocked work is drawn muted
  and labelled *skipped*, deliberately not in the error colour.

- **A blocked section could be compiled into the final answer as though it were
  finished work.** The filter selecting sections to write up asked for
  `status !== 'FAILED'`, which was only accidentally right while FAILED was the
  only unproductive state. A never-attempted section passed it, so an empty
  summary was handed to the compile step as if a manager had written it — and a
  run whose first section failed stopped reporting failure at all, because the
  sections blocked behind it now looked like output. The three places that ask
  this question now share one predicate, stated positively: a new status has to
  opt *in* to counting as content.

### Added
- **The desktop app downloads from the site instead of from GitHub.** "Download
  desktop app" used to be a link to the releases page, which answers "I want the
  app" with twenty files: two `.dmg` builds that differ only by a CPU
  architecture the visitor is expected to know, two `.exe` files of which only
  one installs anything, and fourteen `.blockmap` and `latest*.yml` files that
  are the auto-updater's private business. Picking correctly required knowing
  more about the build system than about the product.

  The landing page now has a download section that names one file and offers it:
  the platform is detected, the size and version are shown, and the other builds
  are one disclosure away rather than a page away. On macOS the architecture is
  read from client hints where the browser provides them (Chromium) and
  otherwise defaults to Apple silicon with the Intel build offered directly
  beneath — a guess that is right most of the time and cheap to correct, rather
  than a detection that quietly hands half of Mac users the wrong file.
  Android, iOS and iPadOS get no primary button at all: their user-agent strings
  say "Linux" and "Mac OS X", and a confident button there would hand a phone a
  desktop installer. An iPad in desktop mode is the hard case — it sends the
  same user-agent a MacBook does, with no iPad token anywhere — so it is
  separated by touch points (0 on a Mac, 5 on an iPad) rather than by the
  string, which genuinely cannot tell them apart.

  Each build also gets a stable URL — `/download/mac-arm64`, `/download/win-x64`
  — that always means "the current build for this platform", so a link in a
  README or a message does not go stale when a release ships.

  The bytes still come from GitHub's CDN; `/download/:target` answers a 302
  rather than proxying. Streaming ~150 MB per click through the app server would
  put every download on the hosting egress bill and hold a connection open for
  the length of a large file transfer, which is a poor trade for hiding a
  hostname.

  The release is resolved through GitHub's API at most once every 15 minutes on
  the happy path, and at most once every 2 minutes while that API is failing —
  unauthenticated callers get 60 requests an hour, so asking per page view would
  exhaust it in a minute of real traffic. Both halves matter: a success-only TTL
  paces nothing during an outage, because it is exactly then that no successful
  fetch ever updates it, so every arriving request would try again and wait for
  its own doomed call before falling back. A previously resolved list keeps
  being served for a day if the API stays down, since release assets are
  append-only and a slightly stale list still points at files that exist. If it
  cannot be resolved at all, the section falls back to the same releases link it
  replaced.

### Changed
- **The landing page now cascades instead of just saying it does.** The old page
  described three tiers in a row of three equal, centred cards — the layout of
  any SaaS page with the word applied on top. Everything below the hero now hangs
  off a spine that runs down the page: the accent walks azure → sky → teal with
  the tiers, nodes light as each section arrives, and the tier cards step
  progressively rightward so the structure of the product is the structure of the
  page. On narrow screens the step collapses to a coloured left border, which
  keeps the hierarchy without the horizontal room.
- **The hero shows a run rather than asserting a number.** A compact diagram
  plays once: a prompt becomes a plan, fans out to three workers on different
  models, and lands with its real cost and saving. It freezes on the finished
  state — a permanently looping animation competes with the copy forever.
- **Added the three things other orchestrators hide.** Blocked work (skipped
  because an upstream failed, naming the cause and costing nothing), resume
  (finished sections that survive an interruption), and the routing rationale.
  These are the product's actual differentiators and the site mentioned none of
  them; it sold a graph, a timeline and logs, which every agent framework has.
- **`/docs` and the landing page are one design again.** Both hang their content
  off the same tier-coloured spine, and the docs page picked up the phone
  breakpoints it was missing. The two surfaces carry separate copies of the
  colour ramp — the docs page is self-contained inline CSS on purpose and cannot
  import from the web app — so a test now reads both and fails if they ever
  disagree.
- All new motion respects `prefers-reduced-motion`: the spine renders complete
  and static, the run diagram starts finished, and section reveals are skipped
  entirely rather than left waiting on an animation that never plays.

### Added
- **A section no longer runs after the section it depends on has failed.** The
  scheduler only ever knew "the upstream promise resolved", which is a different
  question from "the upstream worked" — and T1 deliberately catches worker
  errors into an ordinary `FAILED` result so one dead section cannot crash the
  run. That resolved value released the dependents anyway, so "run the
  integration tests" would start after "implement the API" had failed outright,
  fail in turn, and bill for the privilege.

  Dependents of a failed node are now skipped, transitively, and reported with
  the chain that blocked them, so a section two hops downstream explains its
  real cause rather than blaming its immediate parent. `PARTIAL` deliberately
  does not block: a degraded-but-real section can still feed the next one, and
  cancelling that work would cost more than letting it try. Blocked sections get
  a real result so review and compilation still account for them instead of them
  vanishing from the plan — and no tokens are spent on them.

  Failure awareness is opt-in per caller: a scheduler given no classifier
  behaves exactly as before, so T2's subtask waves are unchanged.

### Fixed
- **A breaker trip counted as a successful run.** The circuit-breaker path
  degrades rather than throwing, so it fell through to the same "reached the end
  normally" assignment as a clean finish. A breaker opening on the first
  operation completes no section and writes no replacement checkpoint, yet still
  deleted the claim it should have preserved.
- **A resumed run's checkpoint dropped everything it had inherited.** It saved
  only the sections THIS attempt finished, so a resume that completed one more
  section and was interrupted again settled the claim and discarded the earlier
  attempts' work — the third try re-did, and re-paid for, what two runs had
  already produced. Checkpoints are cumulative now, keyed by node id so a re-run
  section supersedes its inherited copy, and the original prompt travels forward
  rather than each resume nesting the last continuation inside a longer one.
- **Blocking was still ordered by provider latency.** Applying failures after
  the wave was not enough: parallel workers recorded them in completion order,
  so for two failed siblings converging on one node, whichever provider returned
  first became that node's sole recorded cause. Outcomes are now collected by id
  and processed in graph order, and a node blocked by several failures names all
  of them.
- **Blocked sections never reached a terminal state in the UI.** They were
  synthesized after the scheduler finished, bypassing the progress and
  tier-status lifecycle, so the Cockpit left them looking pending even though
  the final result accounted for them. They now go through the same hook as
  executed sections — advancing progress and emitting a terminal status —
  without constructing a manager or spending a token.
- **A rating could be credited to the wrong kind of work.** The model selections
  were snapshotted at run completion but the task type was not — it was read
  from `lastProfile` at rating time, which the next run has very likely already
  overwritten. Rating run A after run B started recorded A's models under B's
  task type, teaching the router that a coding model is good at creative writing
  from a rating that never said so. The type is now snapshotted with the
  selections and consumed as one immutable pair.
- **Three more paths could still lose a resume checkpoint.** `save()` swallowed
  filesystem errors and returned void, so a full disk looked identical to a
  successful write and the original claim was settled with no replacement on
  disk; it now reports whether the atomic rename actually landed. `runError ==
  null` was being read as "the run succeeded", but the cancellation and budget
  handlers null it deliberately and the breaker path never sets it, so an
  immediate interruption with no output deleted the claim it should have kept;
  normal completion is now tracked separately. And `resumeRun()` — the SDK and
  headless path — had no failed-start catch, while `run()` awaits `init()`
  before entering its own `finally`, so a failure there left the claim hidden
  until stale reclamation.
- **Two model selections never reached the rating snapshot.** `selectModel()`
  had early returns for vision routing and for the no-candidates fallback that
  skipped the recording step, so a vision-routed run had nothing to rate at all
  and a fallback choice was silently missing from the feedback meant to teach
  the router. Every exit records now.
- **Rating a run twice counted it twice.** An explicit rating is weighted 3x by
  recording three samples, so a double submit injected six — a stutter on the
  button counted as two opinions. The snapshot is consumed, making the second
  call a no-op that reports false.
- **A failed resume could still lose the work it was recovering.** The claim was
  settled unconditionally at the end of the run, but a resumed attempt that dies
  on its first provider call completes no section and produces no output, so no
  replacement checkpoint is written — and settling anyway deleted the original,
  which still held the finished sections. The claim is now released instead of
  settled unless the run succeeded or left its own checkpoint. `/continue` also
  hands the claim straight back if the run never starts, rather than leaving it
  unavailable for the full lease timeout.


- **Rating a run did nothing.** The run finalizer called `recordRunOutcome()`,
  which cleared the only map of which models a run had selected — and an explicit
  thumbs-up/down necessarily arrives *after* the run finishes. So every rating
  iterated an empty map, recorded nothing, and reported failure. The 3x-weighted
  user signal never reached the tracker at all. Selections are now handed to an
  immutable last-completed-run snapshot instead of being dropped.
- **The verification retest re-graded facts already settled.** After a failed
  self-test the correction path called `selfTest()` without the pending-criteria
  list, so it defaulted to the full acceptance set — handing the model back the
  criteria `stat` had already decided. That is exactly the "invite the model to
  overturn a fact" the deterministic ladder exists to prevent, reappearing on
  the retry path.
- **A resume checkpoint could be lost mid-recovery.** Claiming a checkpoint
  deleted it before the resumed run existed, so a crash in that window destroyed
  the only recovery record — in the mechanism whose whole purpose is surviving
  crashes. Claims are now leased: the file is hidden from other claimers but
  stays on disk, released if the resume fails to start, discarded only once the
  resumed run owns the work, and reclaimed automatically if the claiming process
  dies.
- **Video generation failed outright for any clip under 4 seconds.** Veo accepts
  4-8s and rejects anything else with `durationSeconds is out of bound`, but the
  clamp floor was 1 — so a model asking for a 2-second clip produced a
  guaranteed 400. Media is billed per attempt and therefore never retried, so
  the user got a hard, unrecoverable failure for a value Cascade itself chose to
  send. The clamp now matches the provider's real bounds.

## 0.68.0 - 2026-08-04

The orchestration series: a typed task graph and one scheduler, a deterministic
rung on the verification ladder, and durable resume. One release for the whole
series rather than a bump per step, since a bump on `main` publishes npm and
rebuilds all three desktop installers.

### Changed
- **Generated images and videos are no longer saved to your storage the moment
  they're made.** A hosted run's media sink used to call `checkStorageQuota` and
  create a permanent `files` row the instant `generate_image` / `generate_video`
  returned, so every picture the model produced — including ones nobody asked to
  keep — was irreversibly metered against a 10 MB free plan with no opt-out, and
  a video bigger than the whole plan cap failed the run outright. Media now gets
  the same deal every other generated artifact already had (see
  `docs/file-generation.md`): free to view and download, metered **only** when
  the user explicitly saves it.
  - **Pending media area** (`cloud/server/src/pending-media.ts`, new
    `pending_media` table): the bytes land in the tenant's `tmp-media/`
    directory with a row carrying an `expires_at`. It is invisible to
    `sumUserFileBytes`, so generation spends no quota at all. Server-held rather
    than browser-held because — unlike a `.pdf`/`.xlsx` export, which the
    browser re-renders from the model's own text — a generated image is real
    binary the browser never had a source for; it therefore survives a page
    refresh, so reloading mid-chat doesn't lose the picture.
  - **Save is the metered action.** `POST /api/files` — the exact route, helper
    and 413-at-cap behaviour the existing text/office "unsaved artifact" cards
    already save through — now also accepts `{ pendingMediaId }`, promoting the
    row into a real `files` row and running `checkStorageQuota` **at that
    moment**. Promotion keeps the id, so the `![alt](/api/files/:id)` the model
    already wrote into the transcript resolves before and after a save.
  - **One URL for both states.** `GET /api/files/:id` transparently serves saved
    files and still-pending media (owner- and expiry-scoped), so nothing that
    renders a transcript — the chat, the Files panel, the client-side
    `.pptx`/`.docx` exporters — has to know whether Save has been pressed.
    `DELETE /api/files/:id` likewise discards pending media.
  - **Expiry**: unsaved media is deleted (row *and* bytes) after
    `PENDING_MEDIA_TTL_MS` — 24 hours, the shortest window that still spans an
    overnight gap. Cleanup is opportunistic at the natural entry points (the
    convention the native-auth and MCP-OAuth stores already follow) *and*
    periodic — an hourly sweeper started in `index.ts`, because an asset nobody
    ever opens again would otherwise sit on the volume forever.
  - **A separate, larger allowance** (`PlanLimits.pendingMediaBytes`: 64 MB free
    / 512 MB Pro) caps unsaved media. Self-expiry bounds how long unmetered
    bytes live, not how fast they arrive; this is the rate ceiling, and it is
    not extra storage — saving still costs quota.

### Added
- **An interrupted run no longer throws away the work it already finished.**
  Resume state used to be a single in-memory field, set on exactly one path (the
  budget cap), so the two interruptions people actually hit — a crash and Ctrl-C
  — lost every completed section, and even a budget stop was lost the moment the
  process exited. The work was on disk; the knowledge of what had been done was
  not, so the next attempt re-planned and re-paid for all of it.

  Checkpoints are now written durably for all four ways a run can stop: the
  budget cap, cancellation, an unexpected error, and the provider circuit
  breaker. `/continue` picks them up across a restart, and the resumed run is
  told which sections are finished and what they produced, so the planner can
  skip them instead of inferring from "do not recreate the files" that something
  unspecified happened. Completed work is restored as fact; only the remainder
  is re-planned, so a run that stalled because the plan was wrong can still
  adapt.

  Checkpoints hold your prompt and partial output, so they are pruned to the
  five most recent and expire after seven days. Writes are atomic — a crash is
  one of the triggers, so a half-written checkpoint had to be impossible rather
  than unlikely — and a corrupt or unrecognised file is skipped rather than
  breaking the ones beside it. Failing to save a checkpoint never escalates a
  recoverable stop into a crash.


- **Acceptance criteria are now checked mechanically before a model is asked.**
  T1 specifies them as "checks a reviewer could verify mechanically (file exists
  / contains X)" and the planner writes them that way, but every one of them was
  graded solely by an LLM self-test — a worse judge of "does this file exist"
  than `stat` is, and one that will pass a criterion because the output *claims*
  the file was written. A new deterministic rung settles what can be settled by
  looking, escalates immediately when a promised file genuinely is not there
  (rather than paying for a grading call to be told so), and passes everything
  ambiguous through to the model untouched. Criteria it cannot parse with
  confidence — subjective wording, shell commands, negations, or several files
  at once — are deliberately left undecided, because deferring is always safe
  and deciding wrongly is not. Shell criteria are never executed: acceptance
  text is LLM-authored, and running it would turn a plan into a command channel.


- **`GET /api/pending-media`** — lists the generated media you haven't saved,
  with its size and expiry, so the UI can offer Save after a reload rather than
  relying on the socket event that announced it.
- **An unsaved-media card in chat** (`cloud/web/src/chat/Message.tsx`), the
  media twin of the existing file cards: a **Temporary** badge with
  "expires in 23h unless you save it", a free **Download**, and a **Save**
  button that flips to "Saved to your Cascade files". `file:created` now carries
  `pending: true` and `expiresAt` for unsaved media, so the client can tell a
  new saved file from something about to disappear.

### Fixed
- **Two different tasks could share a routing decision.** The task analyser
  cached its profile under `prompt.slice(0, 200)`, and long shared preambles are
  the norm rather than the exception — a repo header, a "you are working in X"
  block, a pasted stack trace. The second task silently inherited the first's
  profile, and that profile picks the tier and the model, so a trivial follow-up
  could be routed as research-grade work or the reverse. The key is now a digest
  of the whole prompt.
- **An under-sized plan was detected and then silently accepted.** `validatePlan`
  compared the section count against the complexity band inside an `if` with an
  empty body, and never looked at the upper bound at all. It now reports the
  mismatch instead of dropping it — and deliberately does NOT pad the plan to
  reach the floor, which the original comment proposed doing by duplicating a
  section: that bills the user twice for identical work and contradicts the
  planner's own instruction to use the fewest sections that cover the task.
- **A subtask's correction count was a boolean wearing a number's clothes.**
  `correctionAttempts` was ASSIGNED `1` at each correction site instead of
  incremented, so a worker that corrected for a missing artifact, then for
  acceptance, then for a failed self-test reported exactly the same "1" as one
  that corrected once. It is the only per-attempt signal downstream has for
  judging whether a tier is struggling, and it could not distinguish one round
  from three. It now counts.

- **Repairing a circular plan could silently corrupt the order of a valid one.**
  T1 (sections), T2 (subtasks) and the new orchestration compiler each detected
  cycles the same wrong way: run a topological pass, then treat everything it
  failed to reach as "the cycle". That set also contains every task DOWNSTREAM
  of a cycle, because a downstream task's in-degree can never fall to zero while
  its dependency is stuck. So breaking one cycle also cut the dependencies of
  innocent later tasks, which then started in the first wave — before the work
  they consume had produced anything. Nothing threw and nothing looked wrong:
  the plan really was acyclic afterwards, just executed in the wrong order, and
  the number of tasks affected grew with the length of the chain hanging off the
  cycle. Cycle detection now uses strongly connected components, so only tasks
  genuinely on a cycle are touched.

### Changed
- **One dependency scheduler instead of two.** T1's section dispatch now runs on
  the same `compileTaskGraph` + `DependencyScheduler` pair as T2's subtasks,
  replacing a hand-rolled Kahn implementation in each tier. Both are pinned by a
  parity harness that asserts wave-for-wave identical output against the previous
  algorithm across 600 generated graphs, so plan ordering is unchanged except for
  the cycle case above. T2 keeps its own execution loop — it adds workers
  mid-run, re-runs a wave after tool synthesis and short-circuits on the run
  breaker, none of which a fixed-DAG scheduler can express — but its graph
  building and cycle repair now come from the shared compiler.
- **The planner is no longer told two different subtask counts.** T2's system
  prompt asked for "2-5 subtasks" while the decomposition prompt it is paired
  with asked for "1-4 … the FEWEST that fully cover it", and T1's plan prompt
  said "2-5" against its own "use the FEWEST" rule. The model saw both, so its
  floor was simultaneously one and two; the cheaper reading pads every small
  section with a second worker that bills a real model call. All four now agree.


## 0.67.0 - 2026-08-03

### Fixed
- **Desktop/CLI could not produce a valid `.docx`, `.pptx` or `.xlsx` at all** —
  every generated Office file opened as "corrupted". The only file-writing tool
  a worker had was `file_write`, whose `execute()` is a plain
  `fs.writeFile(path, content, 'utf-8')` with no awareness of the target
  extension: ask for `report.docx` and the model, having nothing better to call,
  wrote literal Markdown into a file named `.docx`. A real Office file is a ZIP
  archive of OOXML parts, and there was no conversion step anywhere on
  desktop/CLI — the equivalent existed only in the browser
  (`cloud/web/src/lib/exporters.ts`).
  - **New `generate_document` tool** (`src/tools/generate-document.ts`): the
    model passes a target path plus the source — Markdown for `.docx`, Markdown
    slides (`---`-separated) for `.pptx`, CSV for `.xlsx` — and the tool renders
    the real OOXML archive in Node and writes the bytes. Registered wherever
    there is a genuine workspace (desktop, CLI, SDK, via `Cascade`'s
    constructor), and absent on a host with no filesystem, mirroring how
    `transcribe_audio` is gated on a file reader. `pdf_create` still owns PDFs.
  - `file_write` was deliberately **not** taught to reinterpret those
    extensions: a tool the model understands as "write these exact bytes" must
    keep meaning that, or writing already-valid `.docx` bytes through it would
    silently corrupt them.
  - **One renderer, two hosts.** The parsing and layout now live in
    `src/core/documents/` (`parseBlocks`, `stripInline`, `inlineRuns`,
    `sniffImage`, `splitSlides`/`parseSlide`, `parseDelimited`, and the
    `renderDocx`/`renderPptx`/`renderXlsx` renderers), imported by BOTH the new
    tool and `cloud/web` (through a `@cascade/documents` alias) instead of being
    copied. The module is DOM-free and Node-free: images arrive through an
    injected `loadImageBytes(url)` callback (browser `fetch` with the session
    cookie; `fs.readFile` on desktop), base64 feature-detects `Buffer` off
    `globalThis`, and docx packs via `Packer.toArrayBuffer` — the one packer
    needing neither a Node `Buffer` nor a DOM `Blob`. `cloud/web`'s exporter
    keeps only the browser-specific parts (the `/api/files/:id` fetch, Blob
    wrappers, the jsPDF layout). A docx image page-height fix had already
    landed in one copy with nothing keeping a second honest.
  - `verifyArtifacts()` now checks a promised `.docx`/`.pptx`/`.xlsx` really
    begins with the ZIP signature `PK\x03\x04`, so the original failure is
    caught rather than passing an "it's a non-empty file" check.
  - Added `docx`, `pptxgenjs` and `xlsx` to the SDK's dependencies (previously
    only in `cloud/web`); all three verified to work in plain Node and to
    survive tsup's CJS bundling for the embedded desktop backend.

### Added
- **Real charts in generated documents — a `chart:` block convention.** Asked to
  visualize data, a model previously had two options and both were bad: draw it
  with an image model (which cannot be trusted to get numbers, axes or labels
  right — there is a standing rule against it) or emit a flat Markdown table,
  which is not a chart. In practice it sometimes did neither and just described
  the chart in prose. Now it can write a fenced ` ```chart:bar ` block (also
  `chart:line`, `chart:pie`, `chart:doughnut`, `chart:area`, `chart:scatter`)
  whose body is CSV: an optional `title:` line, a `<category>,<series>,<series>`
  header row, then one row per category. CSV rather than JSON because models emit
  it far more reliably and it matches the existing `.xlsx` convention; decorated
  values (`$1,200`, `42%`, `(50)`) are coerced, and a block that cannot be parsed
  stays a visible code block rather than being silently dropped.
  - `.pptx` renders it as a **genuine, editable PowerPoint chart** via
    `pptxgenjs` `addChart` — the model's exact numbers land in the chart part's
    embedded workbook (`ppt/charts/chart1.xml`), not in a picture.
  - `.docx` renders a titled Word table of the same numbers. The `docx` library
    exposes no chart API whatsoever (a Word chart needs a DrawingML chart part
    plus an embedded workbook, which it does not model) — a documented gap, with
    the data preserved rather than dropped.
  - `.xlsx` puts each chart's data on its own worksheet as real numeric rows the
    user can chart in one click; SheetJS's community build writes cells, not
    chart objects.
  - `.pdf` renders title + table (jsPDF draws no charts).
  - Both `FILE_DELIVERY_GUIDANCE` (hosted) and `buildWorkerRules` (desktop/CLI)
    now teach the convention, replacing the old "fall back to a Markdown table"
    advice.

### Fixed (image reliability)
- **"Image insertion only worked once"** had two distinct causes, both addressed.
  - `generate_image` exists only when an OpenAI or Gemini key is configured
    (`multimodal/registry.ts`'s `CAPABILITIES`); with neither, the tool was
    simply absent and the model was never given a choice — so it wrote
    `[illustration of a cat]` and moved on. `buildWorkerRules` now states
    plainly, up front, when no image model is available this run, and points at
    `chart:` blocks for anything data-driven.
  - The existing "you MUST call generate_image" rule was being declined in
    practice. It is tightened (call it *before* writing the document, once per
    image, and the reference must stand **alone** on its line or it stays prose)
    and, more importantly, made checkable: the new `missingVisualEvidence()`
    check runs after the agent loop and, when the subtask asked for a visual but
    the output has no image reference, no `chart:` block and no
    `generate_image`/`generate_document` call, triggers one correction round
    with tools rather than shipping a paragraph about a picture that does not
    exist.
- `generate_document` reports each image reference it could *not* embed, by
  name, instead of quietly producing a picture-less deck.
- `run_code`'s guidance no longer competes for Office formats now that a
  dedicated tool produces them correctly.
## 0.66.2 - 2026-08-03

### Fixed
- **A video request wrote scripts and direction notes forever and never
  produced a video**, burning 30+ minutes of paid planning and generation calls
  with nothing to show. Three independent defects stacked into that one run;
  the creative pre-production the user liked is kept, and the pipeline now
  reliably ends in a real `generate_video` call that either completes or fails
  fast.
  - **The planner had zero visibility into generation capabilities.**
    `MultimodalRegistry.describe()` carried a doc comment claiming "the planner
    sees this", but it was called from nothing except its own test — neither
    `t1-administrator.ts` nor `t2-manager.ts` had ever been told that video is a
    single, slow, per-second-billed tool call. Added
    `describeGenerationForPlanner()` next to the capability table and wired it
    into both `buildT1SystemPrompt()` and `buildT2SystemPrompt()`, keyed on the
    tools actually registered for the run (the same predicate the rest of those
    prompts use) rather than on which providers are configured — a restricted
    host has the provider but not the tool, and advertising a capability no
    worker can reach is the exact situation `buildMediaTools` exists to prevent.
    It states that each generation tool is one ATOMIC call, quotes the unit
    price from the shared pricing dataset (only where every catalogue entry for
    that modality agrees — otherwise the unit alone, never an invented average),
    and adds the rule that actually fixes the run: a video plan must contain
    exactly ONE subtask whose deliverable is the `generate_video` call, it must
    be last on its path, and pre-production steps before it are expected and
    fine. `describe()` is unchanged and remains the user-facing inventory; its
    misleading comment was corrected.
  - **The T3 worker had a "you MUST call this tool" rule for images and none for
    video.** `KNOWN_TOOLS` — the list that decides whether ANY tool guidance
    renders at all — listed `generate_image` and omitted `generate_video`,
    `generate_speech` and `transcribe_audio`, so a worker whose only tools were
    media ones counted as "no tools registered" and was told nothing about using
    tools whatsoever. All four are now listed, and `buildWorkerRules()` gained a
    video rule mirroring the image one: call the tool (that call IS the
    deliverable), never substitute prose, a script, a storyboard or a
    `[video: …]` placeholder, call it exactly once, report the returned location
    verbatim, and report a failure rather than re-ordering the render. Unlike
    the image rule it is not scoped to a document format — the clip is the
    deliverable, not an illustration inside one — and the reference syntax is a
    plain link, since Markdown image syntax cannot embed a video.
  - **A timed-out render was handed to a retry mechanism built for a different
    problem.** The 8-minute Veo give-up classifies as `unknown`/non-systemic, so
    it fell past the fast-fail branch into `adaptiveFallback()` — which exists
    for a wrong or missing tool NAME, where a name-similar sibling plausibly
    does the same job for near-zero cost. For `generate_video` that meant a
    keyword-similar substitution (`generate_image` "recovering" a video
    request), a synthesized replacement tool, or an error string the agent loop
    answers by ordering the same 8-minute render again — each separately billed.
    `generate-media.ts`'s `runWithProviderFallback` had already settled this
    question with the alternatives in hand (systemic → one attempt per alternate
    provider; non-systemic → deliberately not retried); the worker now agrees
    with that reasoning instead of quietly re-opening it. Any
    `PROVIDER_BACKED_TOOLS` failure, systemic or not, now fails the subtask on
    the first attempt with the real reason intact. `adaptiveFallback` is scoped,
    not removed — ordinary tools still use it.
  - **The give-up message misattributed Cascade's own deadline to the provider.**
    `callProvider` wrapped it as "The model call failed on veo-…. Provider said:
    …", but the provider said nothing — it is still rendering. The timeout is now
    a `GenerationGaveUpError` that passes through unwrapped and leads with the
    outcome: "veo-3.1-generate-preview timed out after 8 minutes — no video was
    produced."
## 0.66.1 - 2026-07-30

### Fixed

- **Cloud web: a redeployed server could still serve an old cached bundle
  indefinitely.** `cloud/server`'s SPA static-file serving (`app.ts`) used
  Express's default cache headers for both `index.html` and every hashed
  Vite asset, which meant a browser tab left open across a redeploy had no
  reason to ever re-fetch anything — including features that shipped days
  earlier. This produced a real bug report: a generated PowerPoint
  "Download" saved raw Markdown text instead of a real `.pptx` binary,
  because the tab was still running JavaScript from before the Office-export
  feature existed, even though the server itself was already on the current
  build (confirmed via Railway's own deploy history) and a hard refresh
  fixed it immediately. Fixed by giving Vite's content-hashed assets a long,
  immutable `Cache-Control` (safe — a new deploy ships new hashes, never
  overwrites an old one) and forcing `index.html` — the one unhashed file,
  and the only thing that names the current build's hashes — to always
  revalidate (`Cache-Control: no-cache`) on every request, including
  client-side SPA routes served through the catch-all handler.

## 0.66.0 - 2026-07-30

### Added
- **GitHub Models desktop + cloud UI wiring** (PR 2 of 2 — the provider itself
  and its SDK/CLI/router support shipped in 0.65.0). Users can now add a
  GitHub Models PAT from the desktop app's onboarding flow and Settings
  panel, or from Cascade Cloud's KeyVault, with zero backend changes needed —
  every generic provider-key/settings code path (`cascade:updateSettings`,
  `cascade:getSettings`, `cascade:listModels`, KeyVault's `addKey()`) was
  already keyed by the raw provider-type string.
  - **Desktop** (`app/src/views/SettingsView.tsx`): a `githubModelsKey` field
    in the Providers tab, alongside Anthropic/OpenAI/Google; a `github-models`
    entry in `TIER_PROVIDERS` (`freeText: true`, matching azure/openai-compat
    /ollama — GitHub Models has no static catalog, only live discovery) so
    the per-tier model picker shows its real catalog once a key is set.
  - **Desktop onboarding** (`app/src/views/OnboardingView.tsx`): added as a
    first-run provider choice, and `app/electron/main.ts`'s `mapProvider()`
    (onboarding id → Cascade `ProviderType`) gained the matching case.
  - **Cloud web** (`cloud/web/src/lib/types.ts`, `cloud/web/src/keys/
    KeyVault.tsx`): added to `ProviderType`, `SELECTABLE_TYPES`, and the
    allowlist that renders the optional "Model" field (with an owner-prefixed
    placeholder — `openai/gpt-4o` — since a bare model id would be wrong for
    this provider's catalog).
  - **Cloud server** (`cloud/server/src/runs.ts`): added to `PROVIDER_TYPES`,
    the one place the run-payload's provider list is validated server-side —
    without it, a browser-held GitHub Models key was rejected at the Zod
    schema before ever reaching `buildCloudConfig` (which is otherwise fully
    generic, passing `providers` straight through).

## 0.65.0 - 2026-07-30

### Added
- **GitHub Models as a new BYOK provider** (`github-models`). Any user with a
  GitHub/Copilot account can point Cascade at `models.github.ai`'s multi-vendor
  catalog (OpenAI, Meta, DeepSeek, Mistral, …) using a personal fine-grained
  PAT with the `models: read` permission — no separate OpenAI/Anthropic/Gemini
  key needed. Wired into `cascade init`, `cascade doctor`, the REPL's model
  refresh and startup validation, tier pins (`t1: 'github-models:openai/gpt-4o'`),
  and live catalog re-discovery, alongside every other provider.
  - New `src/providers/github-models.ts`, extending the existing
    `OpenAIProvider` the same way azure/openai-compatible do — inference is
    genuinely OpenAI-compatible, so `generate()`/`generateStream()` are
    inherited unmodified. The catalog listing is a bespoke GitHub REST call
    (own `Accept`/`X-GitHub-Api-Version` headers, different shape from the
    OpenAI-compatible provider's `/models` endpoint), and the constructor
    corrects `isReasoningModel()`'s start-anchored regex for the catalog's
    owner-prefixed ids (`openai/o3-mini`) so the first request to an o-series
    model doesn't burn a wasted call against a ~10 RPM budget.
  - Pricing is a real, stated `$0` (`pricingUnknown: false`) — usage is bundled
    into the account's existing GitHub/Copilot plan, never billed per token —
    without setting `isLocal: true`, which would incorrectly route these calls
    onto Ollama's shared local request queue and its 300s local timeout.
  - Rate-limited by default to a conservative `TpmLimiter` budget (well under
    even the Free tier's ~10 RPM) since GitHub Models has no request-count
    limiter of its own; kept out of Cascade Auto's automatic scored routing
    (reachable only via explicit tier pin or last-resort fallback) so its $0
    price can't cause it to be aggressively fanned out into and exhaust that
    budget.
  - Fixed two provider-detection bugs found while wiring this in:
    `selector.ts`'s `resolveDynamicModel()` and `cli/repl/index.tsx`'s
    `inferProviderFromModelId()` each carried their own separate, undupli-
    cated `ProviderType` list; without adding the new provider to both, a
    `github-models:owner/model` tier pin or REPL model id would fall through
    to a same-string heuristic and silently misattribute itself to `openai`
    (matching on `gpt` inside the model id) instead of failing loudly or
    resolving correctly.
  - Desktop and cloud UI wiring (Settings, onboarding, KeyVault) is a
    follow-up PR — this ships the SDK/CLI/router support first.

### Fixed
Codex review round on the GitHub Models PR found six further gaps, all fixed:
- **A github-models-only (or fallback) config left every tier permanently
  empty.** Real catalog models were only ever registered by the background
  `refreshLiveData()` path, which fires fire-and-forget well after `init()`
  returns; `applyLivePricing()` (the only tier-refresh point on that path)
  refreshes a tier model that already exists but never fills one that was
  never set. Even reaching a discovered model via the selector's live
  "any available" fallback at `generate()` time wasn't enough — that path
  never calls `ensureProvider()`, so the call would throw `No provider for
  model ...`. Added a synchronous catalog discovery step in `init()` (mirroring
  the existing openai-compatible discovery) so a real model is registered, and
  a real provider bound, before the tier-fill loop runs.
- **`listModels()`'s empty-catalog fallback returned the construction seed as
  if it were a real model.** Every production caller constructs this provider
  with a non-callable placeholder id (`"github-models"`, `"dummy"`) — unlike
  the identical-looking pattern in `openai-compatible.ts`, where the seed can
  genuinely be a model the user typed in. Now returns `[]` instead.
- **A live-pricing refresh could silently start billing free GitHub Models
  calls as a paid model.** GitHub Models' catalog ids are the same
  owner/model spelling as real OpenRouter marketplace rows
  (`openai/gpt-4o` is both), and `resolvePricing()` has no
  `pricing-data.json` row for this provider by design — so
  `reconcilePrice()`'s "baseline unknown ⇒ accept the live quote" path would
  overwrite the deliberate, real `$0` with a paid price. `applyLivePricing()`
  now skips reconciliation for this provider entirely.
- **An explicit per-call `maxTokens` above GitHub's ~4K cap was sent
  unclamped** (`T1Administrator`'s final compilation step asks for 8,000),
  causing the API to reject the request instead of answering. The provider
  now clamps in a `generateStream()` override before delegating to the
  inherited implementation.
- **`config.rateLimits.providerTpm` — the documented escape hatch for raising
  GitHub Models' conservative default — was silently stripped by config
  validation.** `CascadeConfigSchema` never declared the field, so
  `validateConfig()` discarded it before the router's `TpmLimiter` could read
  it. Added to the schema and `CascadeConfig` type; the router's read is now a
  plain typed field access instead of an unsafe cast.
- **`cascade init`'s tier picker stored a bare catalog id for GitHub Models**
  (`openai/gpt-4o`, no provider prefix). Before the provider's live catalog is
  registered, that bare id has nothing to exact-match against and falls
  through `resolveDynamicModel()`'s heuristics, which reads the id's `/` as an
  openai-compatible path and misattributes the pin to that provider (or to
  Ollama) whenever either is also configured. Now stores
  `github-models:<catalog id>`.
- **A 429 on an explicitly pinned dynamic model (GitHub Models, an Azure
  deployment, an openai-compatible/Ollama id) had no fallback at all**, even
  when another configured provider could serve the tier — `getNextFallback()`
  returned `null` outright whenever the failed id wasn't in the tier's static
  priority chain, true for every dynamically-resolved pin. It now falls to any
  other usable model in that case, the same worst-case fallback
  `selectForTier()` already uses.

A second Codex review pass on the same PR found four more:
- **Every catalog request could 403 regardless of PAT validity.** `nodeHttpFetch`
  is a thin `node:http`/`https` wrapper with no default `User-Agent` — GitHub's
  REST API rejects any request without one. Added an explicit `User-Agent` to
  both the catalog headers and the inference client's `defaultHeaders`.
- **`supportsToolUse` was hardcoded `true` for every discovered model.** GitHub's
  multi-vendor catalog includes models that don't support function/tool
  calling; sending them a `tools` parameter they reject bypasses
  `t3-worker.ts`'s text-tool fallback (which only engages on an explicit
  `false`) and fails the call outright. Now derived per model from catalog
  capability metadata, defaulting to `false` — not positively advertised — when
  unconfirmed, since a wrong `false` only costs the slower text-tool path while
  a wrong `true` fails the request. The live smoke test now surfaces the real
  field names to settle the exact schema with certainty.
- **The catalog listing only ever fetched one page.** GitHub REST list
  endpoints are RFC 5988 paginated via a `Link` header; `listModels()` now
  follows `rel="next"` until exhausted (capped at 20 pages against a malformed
  or cyclic header), a no-op today and forward-compatible once the catalog
  grows past a page.
- **`selectVisionModel()` couldn't find a live-discovered vision model.** It
  only ever walked the static `VISION_MODEL_PRIORITY` list — the sole path any
  vision-required call resolves through, ahead of any tier model or explicit
  override — so a GitHub Models vision-capable model (no static catalog entry
  at all) was invisible to it even as the only vision-capable model actually
  available. Added the same "any other usable model" widening already used
  elsewhere as the worst-case fallback.

### Security
- **Pagination could exfiltrate the GitHub Models PAT to an arbitrary host.**
  `listModels()`'s new `Link: rel="next"` following (added in the pass above)
  took the next URL from the server-supplied header verbatim and requested it
  with the same `Authorization: Bearer <PAT>` header as the catalog itself —
  a malicious or misconfigured response pointing `rel="next"` at an external
  origin would have sent the token there. Every next URL is now resolved
  against the current page (per RFC 3986 — a relative Link value is relative
  to the request it came from) and its origin is required to match the
  catalog's before the request is made; a mismatch throws instead of
  following it. Visited-URL tracking was also added so a cyclic header stops
  on the second sighting rather than burning the full page cap on identical
  authenticated requests. Found by Codex review; fixed and verified via the
  same revert-confirm-restore cycle as every other fix in this release.

A fourth Codex review pass found two more, plus one acknowledged but
deliberately deferred:
- **`getNextFallback()`'s dynamic-model widening only fired when the failed
  model was NEVER in the static priority chain.** A mixed OpenAI + GitHub
  Models config where OpenAI's own `gpt-4o` hit a 429 (`recordFailure()`
  disables the whole provider) walked only the *remaining* static T1
  entries — all `openai`, all equally unusable — and returned `null`
  outright, even with a discovered GitHub Models model ready to serve the
  tier. The static-chain walk and the "any usable model" widening are now
  unified into one path: static entries are tried first when the failed id
  is in the chain, and the widening is reached either way once they're
  exhausted, not only when the id was never in the chain at all.
- **The advertised context window could be far larger than GitHub will
  accept.** GitHub enforces its own per-request INPUT token cap independent
  of the underlying model's real window — documented and corroborated at
  ~8,000 tokens for common Free/Pro-tier models (e.g. `gpt-4o-mini`, despite
  that model's real ~131K context elsewhere). Exposing the catalog's
  reported window (or the 128K fallback) let `getReferenceContextWindow()`'s
  compaction budget and `model-ranker.ts`'s candidate filter both believe
  far more input fit than GitHub would actually accept, so a compacted-to-fit
  prompt reached inference and was rejected instead of being compacted
  correctly up front. Every discovered model's `contextWindow` is now capped
  to this ceiling, the same treatment already given to `maxOutputTokens`.
- **Acknowledged, not fixed this round: `ModelSelector.addDynamicModel()`
  stores entries keyed only by bare `model.id`.** If two different
  dynamically-discovered providers ever reported the identical id string
  (e.g. a GitHub Models catalog entry and an OpenAI-compatible endpoint both
  happening to use the exact same owner-prefixed spelling), the
  later-registered one would silently overwrite the earlier one in
  `availableModels`, dropping one provider from selection. Real, but the
  fix — provider-qualified storage — touches the key contract every method
  on `ModelSelector` assumes (`getModelById`, the override lookup in
  `selectForTier`, `getCandidatesForTier`, `removeModel`, …), which is a
  larger, more invasive change than fits a review-response pass; a
  from-scratch dynamically-discovered id collision across two different
  providers is also a narrow edge case in practice. Left as a known,
  documented limitation for a deliberate follow-up rather than a rushed
  storage-key rewrite under review-response time pressure.

A fifth Codex review pass found a deeper variant of the same PAT-exfiltration
class fixed above, plus two more provider-id-collision/binding gaps:
- **A same-origin-or-external HTTP redirect could still exfiltrate the PAT,
  even after the `Link`-header origin check above.** That check only covers
  the header-driven pagination path; `nodeHttpFetch` (the shared `node:http`/
  `https` fetch shim several providers use) follows actual 3xx redirects on
  ANY request — including the initial catalog fetch — by replaying `init`
  (headers, so the `Authorization: Bearer <PAT>` too) verbatim on the
  followed URL regardless of origin. A malicious or misconfigured redirect,
  including an HTTPS→HTTP downgrade, would have sent the token wherever the
  `Location` header pointed. Added an opt-in `allowedRedirectOrigin` option
  to `nodeHttpFetch` (every existing caller omits it and keeps today's
  follow-anywhere behavior unchanged) and wired it into both of
  `github-models.ts`'s catalog calls (`listModels()` and `isAvailable()`).
  Verified with a genuinely separate second HTTP server standing in for an
  attacker origin — the regression test confirms the attacker server is
  never even hit, not just that its response is ignored.
- **A live capability refresh could silently reopen the GitHub input-token
  cap.** `applyLiveCapabilities()` had the same provider-id-collision
  exposure as `applyLivePricing()` (fixed in an earlier round) but without
  the matching guard: a GitHub Models catalog id is the same owner/model
  spelling as the real OpenRouter entry (`openai/gpt-4o` is both), so its
  capability lookup would replace the already-correct, capped `contextWindow`
  with the base model's much larger real window on every refresh after the
  one at discovery time. Added the identical `if (m.provider ===
  'github-models') return m;` guard already proven in `applyLivePricing()`.
- **A vision-required call could throw `No provider for model ...` for a
  live-discovered model.** `selectVisionModel()`'s widening fallback (added
  in an earlier round) can return a discovered model — e.g. GitHub Models,
  which has no static catalog entries at all — that was never bound to a
  `BaseProvider` instance by any other path: not the tier-fill winner (a
  different model can win the tier when two are discovered), not an explicit
  `options.model` override (skipped entirely when `requireVision` is set).
  `generate()`'s `requireVision` branch now calls the same `ensureProvider()`
  used everywhere else immediately after resolving the vision model.

A sixth Codex review pass found two more, both in the router's shared
generation path (not GitHub-Models-specific, though GitHub Models' tight
budgets are what surfaced them):
- **A rate-limited per-call model pin was retried against the SAME
  rate-limited model instead of the bound fallback.** When `options.model`
  (Cascade Auto's explicit per-subtask override) hits a 429, the catch block
  looks up a fallback via `failover.getFallbackModel()` and binds it — but
  then recursed into `generate()` with the SAME unchanged `options`, whose
  `options.model` still pointed at the failed model. Since
  `options.model ?? this.tierModels.get(tier)` resolves the pin first, the
  bound fallback was silently ignored and the retry re-hit the identical
  rate-limited model, looping indefinitely while burning quota rather than
  ever reaching the fallback. Now clears `options.model` before the retry
  when it matches the failed model's id — the exact fix already applied to
  the sibling model-not-found branch two rounds ago, just missing here.
- **An explicit per-call `maxTokens` above a model's own cap inflated the
  TPM reservation past what the call could ever actually consume.** The
  reservation was `options.maxTokens ?? model.maxOutputTokens`, so T1's
  8,000-token final-compilation request reserved 8,512 tokens even when
  routed to GitHub Models, whose `generateStream()` override (added earlier
  this release) silently clamps the actual request down to its real ~4K
  cap — invisible to this estimate. Against GitHub Models' 8,000-token
  default TPM bucket, that one call could reserve the entire budget instead
  of the intended ~4,512, exactly contradicting the approximation
  `DEFAULT_PROVIDER_TPM`'s own comment documents as the reason the bucket
  works at all. The reservation is now capped at `model.maxOutputTokens`
  (`Math.min(requestedTokens, model.maxOutputTokens) + 512`), provider-
  agnostic and consistent with every provider's own request-building code,
  which already treats `model.maxOutputTokens` as the authoritative ceiling.

A seventh Codex review pass found one more variant of the same "unresolved
GitHub Models pin gets the wrong caps" class:
- **A `github-models:<id>` pin resolved before the live catalog registered
  that exact id got the GENERIC synthesis defaults, not GitHub's real ones.**
  `resolveDynamicModel()`'s fallback synthesis (for a pin naming a model the
  selector hasn't seen yet — discovery hasn't run, the catalog fetch failed,
  or the response omitted this id) hands back a flat 128K context window and
  8K output cap for every provider, github-models included. Both are well
  above GitHub's real ~8K input / ~4K output per-request quota, so a long
  prompt built against the advertised 128K window bypassed compaction and
  was rejected at inference, and the TPM guard (even after this release's
  earlier cap fix) reserved far more than the call could ever consume.
  Pricing was wrong too: `withResolvedPricing()` has no dataset row for this
  provider by design, so the synthesized model came back `pricingUnknown:
  true` instead of a real $0. Added a `github-models`-specific branch (gated
  on the provider actually being configured, same as every other branch)
  that synthesizes with the real `GITHUB_MODELS_MAX_INPUT_TOKENS` /
  `GITHUB_MODELS_MAX_OUTPUT_TOKENS` constants (now exported from
  `github-models.ts`) and a real `$0`/`pricingUnknown: false`, matching what
  the live provider's own `listModels()` already produces once discovery
  completes.

An eighth Codex review pass found one more gap in that same synthesis
branch, plus a startup-time quota exhaustion bug in an unrelated but
Cascade-Auto-adjacent path:
- **The unresolved-pin synthesis added in the previous round left
  `supportsToolUse` undefined instead of `false`.** `t3-worker.ts`'s
  text-tool fallback only engages on a strict `=== false`; `undefined`
  sends native `tools` to an unverified multi-vendor catalog model, and any
  that don't support function calling reject the request outright. Set to
  `false`, matching the same default-to-false-when-unconfirmed policy
  `listModels()` already applies for a real (non-synthesized) catalog entry.
- **Startup model profiling could fire a burst of simultaneous requests
  against GitHub's real ~10 RPM budget before the user submits a single
  task.** `CascadeRouter.profileModels()` feeds every discovered model —
  github-models catalog entries included — into `ModelProfiler.profileAll()`,
  which runs the direct-LLM-query fallback (for any model OpenRouter has no
  description for) across the whole batch via `Promise.allSettled`, fully in
  parallel. Since that fallback (`queryModelDirectly`) always calls
  `router.generate('T3', …)` — resolving to whatever T3's *current* tier
  model is, not the specific catalog entry being profiled — registering N
  github-models entries at startup fired N simultaneous requests at the same
  rate-limited GitHub endpoint, a request-count burst the token-bucket TPM
  guard has no visibility into at all. `profileAll()` now skips the
  direct-query fallback for `github-models` models entirely (still allowed to
  use the free OpenRouter-description lookup, which costs GitHub nothing);
  they're recorded with empty specializations so profiling isn't re-attempted
  every session, matching the existing "don't re-attempt" cache behavior for
  every other unmatched model.

A ninth Codex review pass found a sharper variant of that same startup
profiling bug:
- **The github-models profiling guard keyed off the wrong model.** The
  previous round's fix skipped `queryModelDirectly()` only when the model
  BEING PROFILED (the loop variable) was itself `github-models` — but that
  function ignores which model was passed in and always calls
  `router.generate('T3', …)` with no override, so it actually probes
  whatever T3 currently resolves to. In a mixed-provider config with T3
  explicitly pinned to a github-models model, every OTHER unmatched catalog
  model (anthropic, openai, …) still passed the old guard and still fired a
  probe — which landed on the same pinned, rate-limited GitHub endpoint
  regardless. The guard is now computed once per `profileAll()` call from
  `router.getModelForTier('T3')?.provider === 'github-models'` — the model
  that actually receives every probe in the batch — rather than from each
  individual model being profiled.

## 0.64.0 - 2026-07-30

### Fixed
- **`generate_video` failed unrecoverably: `veo-3.1-generate-001` 404s on the
  Gemini Developer API.** That id is Vertex AI's — Cascade's video generation
  calls `generativelanguage.googleapis.com` (the Gemini Developer API), which
  has no non-preview Veo 3.1 id yet; there, the correct id is
  `veo-3.1-generate-preview`. Fixed the catalog entry and the matching
  pricing-data.json row (the `provider: "vertex"` row, which genuinely does
  use `-001`, was left untouched). `generate.ts`'s `generateVideo()` had no
  real test coverage before this — every other test file only mocked it —
  which is how the wrong id shipped unnoticed; added a full submit → poll →
  download test suite, including the exact reported error as a regression
  test. `scripts/refresh-pricing.mjs` (the generator that produces
  pricing-data.json from LiteLLM's catalog) had its own separate, unfixed
  reference to the old id — the next regen would have silently reintroduced
  the bug — so its lookup key and emitted model id were corrected too, and
  verified by actually running the generator against a real snapshot of
  LiteLLM's catalog and diffing the output byte-for-byte against the fixed
  file.

## 0.63.0 - 2026-07-29

### Fixed
Fourth round of Codex review findings on the same PR:
- **A fallback image provider's non-systemic failure still escalated the
  worker.** When the primary image provider failed systemically and the
  fallback then failed for an unrelated reason (a content refusal, a
  malformed prompt), the combined "every provider failed" error still
  carried the primary's systemic wording (e.g. "Model unavailable").
  `t3-worker.ts` always re-runs `classifyProviderError` on whatever
  `generate_image` throws, and that check matches the WHOLE message — so
  the leftover systemic phrasing from the primary's own failure still
  triggered a fast-fail even though the deciding failure (the fallback's)
  was never systemic. The fallback's own error now propagates unmixed
  in that case, so re-classifying it lands on the correct, non-systemic
  verdict.
- **A compound MCP tool name could hide a mutation behind a read-only leading
  verb.** `isReadOnlyMcpToolName` only inspected the FIRST verb, so names
  like `get_or_create_repository`, `read_and_delete_file`, and
  `fetch_then_update` were waved through as read-only despite performing
  the mutation named later in the compound action. Every token in the
  name is now checked against a mutating-verb set (exact-token matching,
  so "dataset" and "created"/"updated" don't false-positive on "set" and
  "create"/"update"), not only the leading one.
- **A Gemini image-generation safety refusal at the CANDIDATE level was
  misreported as a generic parse failure.** Only `promptFeedback.blockReason`
  (a prompt-level, pre-generation block) was checked; a refusal that stops
  generation AFTER the prompt was accepted reports on
  `candidates[0].finishReason` instead (e.g. `SAFETY`, `IMAGE_SAFETY`), with
  no `promptFeedback` at all. That fell through to a generic "no image data"
  error, misclassified as `unknown` instead of `content_filter`. Any
  candidate `finishReason` other than `STOP` is now treated as a block too.
- **Requested image dimensions were silently dropped for Gemini.** The tool's
  `size` parameter (`"1792x1024"`, `"1024x1792"`, etc. — the same values
  DALL·E accepts) was parsed but never forwarded on the
  `gemini-generate-content` path, so Gemini always rendered its default
  geometry regardless of what was asked for. Unlike OpenAI, Gemini has no
  free-form pixel size — only a named `imageConfig.aspectRatio` — so the
  requested `WxH` is now mapped to whichever of Gemini's ten supported
  ratios its numeric ratio is closest to.

## 0.62.0 - 2026-07-29

### Fixed
- **A systemic image-generation failure escalated the whole worker even
  when a second image provider was configured and could have served the
  request.** `classifyProviderError`'s `.systemic` verdict answers "would
  this fail again on the same provider+model?" — a dead key, a 404 model
  id, an exhausted quota — but `t3-worker.ts` was reading that as "the
  whole capability is gone" and fast-failing immediately, even with a
  second configured image provider sitting unused (e.g. Gemini's image
  endpoint 404ing said nothing about whether OpenAI's `dall-e-3` would
  work). `MultimodalRegistry` gained `rank()` — the same selection order
  `select()` already used, now exposed as a full list instead of just the
  head — and `generate_image` retries a systemic failure against the next
  configured, resolvable provider before giving up. Only systemic failures
  retry (a content-policy refusal or malformed prompt would plausibly fail
  the same way again, so it isn't retried), a cancelled run is never
  retried, and a single-provider account behaves exactly as before — the
  original error propagates untouched. When every configured provider is
  exhausted, the error names each one with its own message and carries the
  same `systemic` tag `web_search` already uses, so `t3-worker.ts`'s
  fast-fail still fires deterministically once there is truly nothing left
  to try.

## 0.61.0 - 2026-07-29

### Fixed
Third round of Codex review findings on the same PR:
- **The dead-model-persistence fix from 0.57.0 never actually ran.** That
  fix replaced `dead-models.ts`'s own dynamic `require('node:fs'/'node:path')`
  with static imports — correct, but its caller in `cascade.ts` had a
  separate, independent dynamic `require('node:path')` of its own,
  wrapped in a try/catch that silently swallowed the `Dynamic require of
  "path" is not supported` throw from esbuild's ESM `__require` shim
  before `fileDeadModelPersistence` was ever reached. The desktop/CLI
  build was still amnesiac end to end. Replaced with the static `path`
  import already in scope at the top of the file (never needed the
  dynamic form — a static import is exactly as synchronous as `require`
  in the router constructor's synchronous path). Added an
  `esm-safety.test.ts` static-analysis test that fails the suite if any
  non-test source file contains a dynamic `require(` outside the one
  legitimate exception (`tool-creator.ts`'s CJS `Worker({ eval: true })`
  harness, which really does run under a native `require`) — this bug
  class has now bitten twice from the same root cause.
- **The `generate_image` worker rule told the model a data-driven chart
  was fine to draw with an image model.** "Image, illustration, chart or
  other visual" lumped decorative visuals in with charts/graphs/diagrams
  that must show exact data — an image model has no mechanism to
  guarantee the numbers, axes, or labels it draws are correct, so a
  generated "chart" risks looking authoritative while being wrong. The
  rule now excludes charts from the `generate_image` mandate and points
  the model at a Markdown table instead for anything data-driven.
- **`toDocx`'s embedded-image scaling only capped width, not height.** A
  portrait image already fit the 6.5in body column at scale 1 with no
  further check, so a tall image could render far taller than the ~9in of
  printable page height between the default margins, overflowing or
  clipping in the exported Word document. The scale factor now also
  respects a page-height cap, so both dimensions are constrained the same
  way `DOCX_MAX_W` already constrained width.
- **Closing a stale-active tab could yank the view away from wherever the
  user had navigated via the Activity Bar.** The tab-close handler shipped
  in 0.60.0 checked only whether the closed tab was the tab strip's
  `activeTabId` before reassigning `view` — but the Activity Bar changes
  `view` without ever touching `activeTabId`, so a tab can stay nominally
  "active" long after the user switched to, say, Insights. Closing it then
  overwrote `view` back to whatever the next tab implied, discarding the
  user's actual navigation. Now also checks that `view` still matches what
  the tab being closed would itself display before touching it.

## 0.60.0 - 2026-07-29

### Fixed
Second round of Codex review findings on the same PR:
- **The read-only-MCP-tool check had a JavaScript regex gotcha that defeated
  it.** `isReadOnlyMcpToolName` combined a case-insensitive match with a
  `(?=[A-Z])` camelCase-boundary lookahead — but a character class is
  case-folded under the `i` flag even inside a lookahead
  (`/(?=[A-Z])/i.test('w')` is `true`), so it accepted ANY following letter
  as a "boundary," not only an uppercase one. `readwrite_file` — leading
  token `readwrite`, not `read` — passed as read-only, silently defeating
  the dangerous-by-default MCP protection from the previous round for any
  server exposing a compound name like it. Rewritten as an explicit,
  case-sensitive boundary check against the original (non-lowercased)
  string.
- **Closing the active browser tab left the browser visibly stuck on
  screen.** The previous round scoped rendering the desktop browser to
  `view === 'browser'` alone (the tab's own active-state no longer factors
  in). Closing a tab, however, only ever removed it from the tab strip —
  nothing updated `view` to match, so the native `WebContentsView` kept
  covering whatever the user expected to see next, with no tab left to
  explain why. The close handler now mirrors the tab-close reducer's own
  "select whichever tab is now to the left" logic and switches `view` to
  match, falling back to `chat` when no tabs remain.

## 0.59.0 - 2026-07-29

### Fixed
Codex review findings on the reliability/safety and image-embedding work above:
- **The MCP-tool danger fix from 0.57.0 didn't actually gate anything.**
  `McpToolWrapper.isDangerous()` returning `true` by default changed
  nothing on its own — `T3Worker.executeTool()` decides whether to pause
  for approval via `ToolRegistry.requiresApproval()`, which consulted only
  a fixed built-in name list (plus user config), never `isDangerous()`. A
  connected server's `create_repository`/`delete_repository` still ran
  with zero approval regardless of what `isDangerous()` reported.
  `requiresApproval()` now also gates on `isDangerous()`, closing the gap
  for MCP tools and for any future tool that sets `isDangerous()` without
  remembering to add itself to the static list — the exact failure mode
  that list's own comment already documented once before (`file_edit`/`git`
  shipped without approval for a time).
- **The desktop browser tab stayed mounted after switching away via the
  Activity Bar.** Every path that activates the browser tab already sets
  the app's `view` to `'browser'` in the same action, so gating on the
  tab's active state in addition to `view` was redundant for showing it —
  and harmful for hiding it again, since nothing cleared the tab's active
  state on an ordinary view switch. The native browser view kept covering
  whatever view was selected next until the tab was explicitly closed or
  reactivated. Now governed by `view` alone.
- **A web search that found zero results (not zero backends) escalated the
  whole worker.** The all-backends-exhausted path is reached both when
  every backend errors AND when every backend responds successfully with
  no matches for a narrow or misspelled query — only the former is
  systemic. Both were tagged `systemic: true`, so an ordinary "nothing
  found for this query" was treated the same as "search is completely
  unreachable" and escalated instead of letting the worker recover.
- **The unified provider-error classifier ran against every tool's errors,
  not just provider calls.** A plain filesystem `EACCES: permission
  denied` from `file_read` contains the literal words the classifier's
  auth-failure pattern matches, so an ordinary unreadable file escalated
  the whole worker instead of letting it try a different one. Now scoped
  to the tools that actually call an LLM/media provider API
  (`generate_image`, `generate_speech`, `generate_video`,
  `transcribe_audio`).
- **The image-generation worker instruction fired for every deliverable,
  including ones that can't embed the result.** Only the PowerPoint/Word
  exporters embed a Markdown image reference; PDF (and plain text)
  flatten it straight to caption text, same as the original placeholder
  bug — so a PDF request would still pay for `generate_image` with
  nothing to show for it. The instruction is now scoped to state that
  explicitly.

## 0.58.0 - 2026-07-29

### Added
- **Generated images now actually land in PowerPoint and Word exports.**
  Asking for a PPT with AI-generated images used to produce a text
  placeholder in the deck instead of a real picture, even with a working
  image-gen key — four separate gaps in the same chain, all fixed:
  - The worker was never told to call `generate_image` for a deliverable
    that needs one; `buildWorkerRules` now instructs it to, and to reference
    the result via Markdown image syntax (`![description](location)`)
    rather than writing a bracketed description in its place.
  - `generate_image`'s own returned text now spells out exactly how to
    reference the result, so the instruction above is concretely actionable.
  - The cloud media sink reported back a bare filename with no way for
    anything to fetch the bytes later; it now returns the file's real
    `/api/files/:id` path, reusing the same authenticated route the Files
    panel already downloads from.
  - The `.pptx`/`.docx` exporters (client-side, per this pipeline's
    existing "the content never leaves the browser" design) previously
    flattened every line — including a correctly-formed image reference —
    into caption text. They now detect a standalone Markdown image
    reference, fetch the bytes (same-origin, session-authenticated),
    sniff the real format and pixel dimensions from the file header, and
    embed it as an actual picture — falling back gracefully to a skipped
    image (never a broken export) if one reference 404s.
- **The internal browser is now reachable from the Command Palette and as a
  tab alongside chat**, not only via the sidebar's dedicated nav icon. A
  browser tab is a fixed singleton (the underlying view is a single native
  `WebContentsView`, not one per tab), so opening it from the palette
  activates the same tab every time rather than creating duplicates.

## 0.57.0 - 2026-07-29

### Fixed
- **A dead model was re-discovered on every single run instead of once.**
  `DeadModelStore` persists a dead verdict specifically so a burst of
  concurrent workers hitting the same 404 only pays for it once, ever — but
  the file-backed persistence used a dynamic `require('node:fs')` inside its
  own function bodies, reasoning that it "runs in the router's constructor
  path, which is synchronous." That reasoning doesn't hold: a static import
  is exactly as synchronous as a dynamic require, and in the ESM build (what
  `bin/cascade.js` actually runs), the global `require` identifier doesn't
  exist — esbuild's `__require` shim throws `Dynamic require of "fs" is not
  supported`, silently swallowed by the store's own "best-effort" try/catch.
  The file was never actually read or written, so every run started amnesiac
  and re-paid the whole concurrent-burst cost. Switched to static `node:fs`
  imports, which work correctly under both the CJS and ESM builds.

- **`gemini-2.5-flash-lite` scored exactly the same as full `gemini-2.5-flash`
  in Cascade Auto**, making the weaker, cheaper model look like the same
  quality as its full sibling and win "best value" picks it shouldn't have.
  The family-resolution regex `gemini-?2\.5-flash` has no word boundary after
  "flash" and matched `gemini-2.5-flash-lite` as a plain substring, before
  ever reaching the generic lite fallback — the exact ordering the 2.0
  generation already got right, just missing for 2.5. Added the matching
  `gemini-2.5-flash-lite` family entry and matcher, ordered before the bare
  `2.5-flash` rule.

- **`generate_image` failing outright, and other systemic tool errors
  looping for up to 15 iterations before ever surfacing.** Image generation
  is migrated off the deprecated Imagen `:predict` API (Google is shutting it
  down August 17, 2026) to `gemini-2.5-flash-image` via the standard
  `generateContent` endpoint. Separately, `classifyProviderError` — the
  deterministic, non-AI JSON/HTTP error classifier already used for chat-tier
  failover — is now also consulted at the point a tool call decides whether
  to fast-fail or retry, replacing a hand-rolled regex that recognized
  429/auth/forbidden but not 404/model-unavailable. A dead image model's 404
  now escalates immediately with the real reason instead of retrying through
  adaptive fallback first.

- **A worker with no real search results could produce a plausible but
  completely ungrounded — sometimes wildly off-topic — answer.**
  `web_search` returned a "search failed across all backends" STRING when
  every backend was down, which the agent loop treated as an ordinary
  successful result with nothing to signal that the worker had zero
  grounding. It now throws instead, tagged so it escalates the same way a
  systemic provider failure does. Separately, a worker's self-test — the
  check that catches this kind of ungrounded output before it's accepted as
  done — failed OPEN: if the grading call itself broke or its response
  didn't parse, all three checks were silently reported as passing. It now
  fails closed, triggering the same single bounded correction-and-retest
  pass an ordinary failed check gets.

- **An MCP-connected tool could take an irreversible action — create or
  delete a repository, push files, merge a PR — with zero human approval.**
  Every built-in tool of comparable risk (shell, git, file writes, the
  built-in GitHub tool) correctly self-reports as dangerous and requires
  approval; the generic MCP tool wrapper never overrode the base class's
  default of "safe." MCP tools now default to dangerous unless their name
  looks read-only by its leading verb (`list_`, `get_`, `search_`, `read_`,
  and similar) — fail-closed, matching this codebase's stated classification
  philosophy elsewhere, and reusing the existing approval-escalation pipeline
  end to end with no new UI needed. Paired with a worker-prompt reminder not
  to reach for a connected-service action unrelated to the current subtask.

## 0.56.0 - 2026-07-29

### Fixed
- **A Complex run could fail every section at once with "Cannot read
  properties of undefined (reading 'join')."** T1's execution plan — and,
  separately, a T2 manager's own re-decomposition of a section — comes back
  as JSON from an LLM call. `constraints` is declared a required `string[]`
  on both the section and each subtask in the TypeScript types, but that's a
  compile-time contract only: nothing validated it at runtime, and a larger
  plan (more sections, more subtasks — exactly the shape of a multi-section
  research/report task) made it more likely the model would simply omit the
  field for one or more entries. Every consumer downstream — T2Manager's own
  decomposition prompt, and T3Worker's system and initial prompts — called
  `.join('; ')` or `.map(...).join(...)` on it unguarded, so the first
  missing `constraints` crashed that section's T2 manager immediately, and
  because T1 dispatches every section from the same plan, a single omission
  by the model took the whole run down with the same error repeated once per
  section (and again on T1's automatic replan attempt).

  Fixed by normalizing `constraints` to `[]` at the two points where LLM
  JSON becomes plan data — `T1Administrator.validatePlan` (covers both a
  freshly generated plan and a boardroom-edited one) and `T2Manager`'s own
  section re-decomposition — instead of scattering null-checks across every
  place the field gets read.

## 0.55.0 - 2026-07-28

### Fixed
- **An escalated section now actually asks you.** "Section escalated — needs a
  decision" was a dead end: the status was emitted and nobody was ever asked for
  the decision, so a run that legitimately needed input just stopped there having
  spent a full orchestration. This is why MCP runs so reliably ended that way.

  You now get a prompt with three answers — **retry as-is**, **retry with
  guidance** (your instruction is folded into the section and it runs again), or
  **skip** (keep what the section did produce and move on). The retry is bounded
  to one attempt, so an escalation cannot loop.

  If nobody answers within 5 minutes the section **fails**, with the reason
  recorded. That direction is deliberate and differs from plan approval, which
  auto-proceeds on timeout: a plan is already the model's considered proposal,
  whereas an escalation exists precisely *because* a worker wasn't confident — so
  acting unattended is the option most likely to be wrong. A hosted run also
  holds server resources while it waits, so hanging indefinitely isn't free
  either. The countdown is shown, so the failure never looks arbitrary.

  This works on the **desktop** as well as the web. Sections in a Complex run
  are dispatched concurrently, so more than one can be waiting at once; each
  prompt is tracked separately and your answer goes to the section that asked.
  Pressing **Stop** unparks a waiting section immediately rather than leaving
  the run held until the timeout.

  A prompt raised while the desktop app was reconnecting used to be lost — the
  connection it was addressed to no longer existed, and nothing replays. Run
  events are now addressed to the session rather than to one connection, and a
  prompt the run is parked on is handed over as soon as a client subscribes. If
  genuinely nobody is there to answer, the section is skipped after half a
  minute instead of holding the run for the full five.

  The host side of that fix tracked one prompt per session, so a second section
  escalating in the same wave silently displaced the first — it lost its replay
  on reconnect and its own 30-second orphan check. Every waiting prompt is now
  tracked and replayed independently, addressed by its own request rather than
  by the session it belongs to.

  Two more gaps in the desktop rename migration below are also fixed here,
  since they touch the same code: a renamed server dropped out of
  `tools.mcpTrusted` (matched by exact name), so it silently stopped being
  trusted and either re-prompted or failed a headless run; and the hosted
  app's escalation prompt could be painted over by any of the other modals
  (API keys, Connectors, Memory…) or the tool-approval dialog, since they all
  shared one stacking layer and whichever mounted last won. The escalation
  prompt now sits strictly above every other overlay. The desktop app had the
  same class of bug on its own separate escalation modal: it sat below the
  command palette (⌘K) and the Help panel, so opening either while a run was
  parked waiting for an answer could cover the prompt entirely, with the
  section quietly running out its five-minute clock behind an unrelated
  window. It now sits above both.

  Choosing **skip** could also cause T1's own quality reviewer to reject the
  kept output and generate a correction plan that redid exactly the work you
  just chose to stop — the reviewer only ever sees the section's summary text,
  with nothing distinguishing "the pipeline fell short" from "the user decided
  this was good enough". A skipped section is now flagged through to that
  review, which is told to accept it as-is rather than treat it as a gap. That
  flag was reaching the reviewer for a skip nobody actually chose, too: when
  nothing is listening, autonomy is `auto`, or a run is aborted, the SDK
  itself resolves the escalation as a skip so the run doesn't hang — and that
  system-produced skip was being read as the same "the user reviewed this and
  accepted it" signal as a real answer, so a section nobody ever looked at
  could still slip past the corrective pass. The SDK now marks which skips are
  its own rather than a person's, and only a person's answer sets the flag.
  The dashboard server settles a gate itself in two more shapes nobody chose —
  a REST caller that never had anyone connect to answer, and a session you
  halted mid-escalation — and both now carry the same marker for the same
  reason.

  Two more escalation gaps: a REST-triggered run (`/api/run`) only ever learns
  its own new session id from the HTTP response it is itself in the middle of
  sending, so a check for "is anyone listening yet" done at that exact moment
  always found nobody — the interactive gate was silently never wired up for
  any freshly started session, no matter who subscribed a moment later. It's
  now always wired; a run nobody ever connects to is still settled quickly by
  the existing 30-second orphan check rather than waiting the SDK's full five
  minutes. And a **Moderate** run (a single root manager, no T1) where one
  worker finished while a sibling's escalation timed out reported the section
  failed but showed only the completed worker's output — the timeout reason
  went unrecorded on screen, so the answer looked complete when part of the
  task silently wasn't.

### Added
- **Choose exactly which MCP tools a run can use.** A connected server usually
  brings dozens of tools and most are irrelevant to any given workspace — but
  there was no way to see the list, let alone choose from it. Settings (desktop)
  and Connectors (web) now expand each connection into its live tool list with a
  checkbox per tool.

  A tool you switch off is left **unregistered**, not refused at call time: the
  model never sees it, so it cannot be proposed, it costs nothing in the tool
  list, and there is no refusal to explain. Selections are stored as a deny
  list, so tools a server adds later are available by default instead of frozen
  at the shape it had when you last looked. In the hosted app the list is
  per-account and per-server.

  Because a tool's registered name folds illegal characters, two servers whose
  names differ only in punctuation — `My Server` and `my-server` — produced the
  same tool prefix, so one server's tools silently overwrote the other's and a
  deny list could not tell them apart. New connections with a colliding name are
  now given a numeric suffix, and any pair already stored is separated the first
  time the account is upgraded.

  Selections travel with **Sync settings across devices**, and a sync bundle
  written before this release carries no selections at all. Reading that silence
  as "nothing is switched off" would re-enable a destructive connector tool on
  an ordinary pull, so the bundle is versioned: an older bundle leaves your
  selections alone, and only one that knows about them can change them.

  A per-tool selection for a **built-in** tool (not an MCP one — the browser's
  "read this page", a media tool) was also being swept into that sync bundle,
  even though the merge on the other end only ever treats an MCP server's own
  prefix as authoritative for anything it carries. Once a built-in denial like
  that reached a second device, there was no way to remove it again:
  re-enabling it and pushing again couldn't clear the copy already sitting on
  the other device, because nothing in the merge logic recognized it as
  something a push was allowed to override. Built-in tool selections are
  device-local by design and no longer leave the device at all.

  The same colliding-name problem existed on the desktop and the CLI's
  `cascade mcp connect`, which had no uniqueness check of its own — a config
  file could already contain the collision from a hand edit, an older CLI
  version, or `cascade mcp connect`. It's now checked and, if needed, fixed on
  every load, not gated behind a one-time migration. Two servers whose raw
  tool names collide within one connector are also disambiguated now, and the
  choice of which keeps its plain name no longer depends on which order the
  server happened to list them in — so a saved denial can't silently move to a
  different tool between two runs. Refreshing an expired OAuth token for a
  connector is also serialized against expanding that same connector's tool
  list in Settings, closing the same kind of race the account-wide fix above
  closes for the hosted app.

  `cascade mcp remove` also left a removed server's per-tool denials behind —
  they live in one flat list, not scoped to the connection — so reconnecting
  the same name later silently carried old denials into the new connection
  with nothing on screen explaining why. It now clears them on removal,
  matching what the desktop UI already did.

  Two more edges in the registered-name scheme: nothing bounded a name's
  length, and a connector name or a vendor tool name long enough — cloud
  alone accepts connector names up to 80 characters — could exceed OpenAI and
  Azure's 64-character limit on its own, failing every request that included
  the tool's definition. Long names are now shortened with a short hash of
  the original appended, so two different long names that happen to share a
  prefix still land on different registered names. Separately, when two
  colliding tool names needed suffixing AND a third, unrelated tool on the
  same server already happened to own the exact string a suffix would have
  produced, the suffix logic could still hand out that already-taken name —
  every possible name is now reserved up front, closing that gap.

  And the trust-list fix above missed one shape: two connections that are
  bit-for-bit the same name (from a hand edit, not merely a colliding one)
  share a single trust entry, and moving it onto the renamed one instead of
  granting it to both left the untouched original without trust. It's granted
  to both now. That fix itself had a gap when THREE rows collided in a mixed
  shape — two rows sharing one identical raw name, both renamed away because a
  third row collides with both by sanitizing: processing the renames one at a
  time let the first rename's own bookkeeping erase the shared name from the
  trust list before the second rename (for the same original name) ever got
  to look, so it silently granted trust to only one of the two renamed
  connections. Renames sharing an original name are now grouped and settled
  together in a single pass, so every renamed identity gets trust, not just
  whichever ran first.

- **The desktop browser now opens reliably on the first paint.** A fractional
  display-scaling factor makes the page's on-screen rectangle land on
  fractional pixel coordinates, which Electron's native view rejects — the
  later resize handler already rounded to whole pixels, but the very first
  open did not, so the tab could come up blank the one time nothing else on
  screen explains why.

- **The loading circle is now the Cascade mark.** Three arcs falling, widest at
  the top, lit in turn from T1 down to T3 — the wait shows the shape of what is
  actually happening rather than an anonymous rotation. The same geometry, held
  still, is the app's logo, so the brand and the busy state are one object
  instead of two things that resemble each other. It honours
  `prefers-reduced-motion` (the pulse stays, the travel goes).

- **A browser inside the desktop app.** Looking something up no longer means
  leaving Cascade and losing the thread of a run. It works in both directions:
  you browse, and Cascade can read the page you have open — ask about &ldquo;this
  page&rdquo; in Chat and it sees what&rsquo;s on screen, including pages behind a login
  and pages rendered entirely by JavaScript, neither of which a plain fetch can
  reach. The page is a real browser view, not an embedded frame, so the sites
  people actually look things up on aren&rsquo;t blank. Pages opened here run in
  their own session with **every web permission denied** — camera, microphone,
  location, notifications, USB. Reading a page needs none of them.

## 0.54.0 - 2026-07-28

### Fixed
- **A model that 404s is remembered, instead of being rediscovered every run.**
  One reported run showed **twelve identical**
  `gemini-2.0-flash -> gemini-2.5-flash (model not found)` failovers. The router
  already dropped a dead id from its pool, but only in memory and only *after*
  something paid a call to find out — and a T3 wave runs concurrently, so every
  worker in the wave hit the same dead id simultaneously, before any of them
  could record it. Verdicts now persist to `~/.cascade/dead-models.json` and are
  consulted *before* selection, so a dead model never enters the candidate pool
  again.

  Verdicts **expire after 7 days** rather than being permanent. That is
  deliberate: previews get promoted, quotas get granted, regions light up. A
  permanent blocklist would quietly shrink the routing pool over time with no
  way to see why a model stopped being chosen. A stale entry costs one call to
  rediscover; a permanent one costs the model forever.

- **Image generation on Gemini pointed at a model id that does not exist.**
  `gemini-3-pro-image` appears on Google's pricing page but returns 404 for
  `:predict` — Gemini's image models are called through `generateContent` with
  an image response modality, while `:predict` is the Imagen shape. Corrected to
  `imagen-4.0-generate-001`. A billing line item is not evidence of a callable
  endpoint, which is the assumption that put the wrong id there.

## 0.53.0 - 2026-07-28

### Fixed
- **An MCP server plus an OpenAI or Azure model no longer fails every request.**
  Cascade named MCP tools `mcp::<server>::<tool>`, but OpenAI and Azure validate
  tool names against `^[a-zA-Z0-9_-]+$` and reject the whole request when one
  doesn't match:

      400 Invalid 'tools[2].function.name': string does not match pattern
          '^[a-zA-Z0-9_-]+$'

  Colons are illegal, so with the GitHub connector enabled and Azure selected,
  every message failed — whatever it asked for. This is the same shape as the
  Gemini `x-mcp-header` bug fixed in 0.51.0: MCP metadata reaching a provider
  that validates what others ignore. Anthropic accepts colons, which is why it
  went unnoticed there.

  Names are now built provider-safe at the source (`mcp__<server>__<tool>`,
  with illegal characters folded), rather than patched per provider — there is
  one legal alphabet, and encoding to it once beats three sanitisers that can
  disagree. Execution never parses the name back, so the encoding is free to be
  lossy. A test now holds the *entire* registered tool surface to that alphabet,
  so the next tool with a colon or a space in its name fails in CI instead of in
  someone's chat.

- **The Azure base-model picker was missing every model added since gpt-5.**
  The cloud web app kept its own hand-copied list, which went stale the moment a
  family was added: gpt-5.4, gpt-5.4-mini and gpt-5.5 existed in routing and
  pricing but never appeared in the dropdown, so a deployment of any of them got
  scored and priced as whatever the stale list guessed instead.

  The list is now served from the SDK's own `AZURE_BASE_MODELS` via
  `/api/config`, and the SDK derives both that list and its deployment-name
  inference from one table — so the picker cannot drift from what routing
  actually knows. The web keeps a fallback array purely so the control still
  renders before the request lands.

## 0.52.0 - 2026-07-28

### Fixed
- **Image generation was never available in a hosted run.** Asking cascadeai.in
  for a picture got *"I cannot directly create images. My capabilities are
  limited to generating text"* — and the model was telling the truth. A cloud
  run sets `enabledTools: ['web_search','web_fetch']`, and 0.51.0 gated the new
  media tools on that same allowlist, so `generate_image` was never registered.

  That allowlist exists to keep shell/file/git genuinely absent from a hosted
  run — it is a blast-radius control for tools that touch the machine.
  Generation tools touch nothing: they call an API you already configured a key
  for. They now register outside it, the same way MCP tools already did. A new
  `tools.disabledTools` list is the explicit off-switch, and it reaches tools
  registered outside the allowlist too — previously there was no way to turn
  those off at all.

- **Generated media is stored properly in the cloud.** The default sink writes
  into the workspace, which is meaningless in a hosted run — the container is
  ephemeral and you have no filesystem to look at. Cloud runs now store the
  bytes as a real file row, quota-checked *before* writing, and emit a
  `file:created` event so the browser can show it.

### Added
- **Video generation (Veo).** Submit → poll → fetch, with progress reported
  while it runs: a silent two-minute wait is indistinguishable from a hang, and
  killing a working render is the likeliest consequence.

  Video is priced **per second** (~$0.40), which makes it roughly a thousand
  times the cost of an image per call and puts the model in charge of the bill
  by choosing a duration. So the price is stated in the tool description where
  the model reads *before* calling, duration is clamped to 8 seconds regardless
  of what is asked for, and the result reports the estimated cost. Cancelling
  the run stops the polling loop rather than paying out a clip nobody sees.

## 0.51.0 - 2026-07-28

### Fixed
- **Gemini + any MCP server no longer fails every single request.** Cascade
  passed a tool's JSON Schema straight to Gemini's `function_declarations`,
  which is not JSON Schema — it is a narrow OpenAPI subset that rejects unknown
  fields outright. Real MCP servers ship extensions: GitHub's annotates
  properties with `x-mcp-header`. The result was an immediate HTTP 400,
  repeated once per offending property, **before the model ever saw the
  message** — so every prompt failed identically, whether it asked for an image,
  a code review, or said "hi". Tool schemas are now converted rather than cast,
  through an allowlist of the fields Gemini documents, so the next extension
  nobody has met yet is dropped for free instead of causing the next outage.
  Non-string `enum` values (also rejected) are stringified rather than dropped,
  which keeps the constraint instead of silently widening the parameter.

- **A worker with no file tools is no longer failed for not writing a file.**
  The artifact check ran unconditionally, while the prompt side correctly
  skipped artifact instructions when no file-writing tool existed. A worker was
  told not to write files and then failed for not having written them. Because
  the check regex-matches filenames out of the subtask description, a research
  plan that merely mentioned `report.md` produced a requirement nothing could
  satisfy: the correction pass ran, the re-check failed again, and the subtask
  escalated with its perfectly good prose attached. That is the "successful node
  marked failed" case.

### Added
- **Image, speech and transcription generation.** Models that can't hold a text
  conversation were filtered out of the chat pool — correct, but it left
  Cascade unable to draw a picture with an image model sitting in the account
  whose key it already had. They are now a capability registry instead, and
  `generate_image`, `generate_speech` and `transcribe_audio` are registered
  **only for modalities your configured providers can actually serve**, so a
  tool never exists that cannot run.

  Selection works like tier routing: quality first where quality is genuinely
  known, unit price as the tiebreak, and the reason is stated. Where no
  defensible public ranking exists — image generation, today — Cascade says the
  choice was made on cost and does not imply a judgement nobody made. Prices
  come from the same audited dataset the chat tiers use.

  Two things it will not pretend to do: **video** (Veo is a long-running
  submit-poll-fetch operation and is listed as present-but-not-callable rather
  than wired to a tool that would fail), and **music** (no supported provider
  exposes a music API at all). Both are stated to the planner outright, so it
  cannot write a step that could never run.

- **Your ratings now influence Auto routing.** Thumbs-up/down adjust a model's
  public benchmark score by at most ±0.05, shrunk toward zero by sample size —
  one vote moves it by 0.005, twenty consistent votes by 0.033. Enough to break
  a near-tie, never enough to overturn a real capability gap. This is
  deliberately conservative: the data is tiny, self-selected (people rate bad
  answers far more readily than good ones), and trivially gamed. `/why` states
  the sample size alongside any adjustment.

### Changed
- The run breaker's failure threshold is now configurable via
  `budget.failureThreshold` (default 3, unchanged).

## 0.50.0 - 2026-07-28

### Fixed
- **A run no longer pays to rediscover the same dead model on every subtask.**
  When a tier's model was unreachable — expired key, wrong model id, exhausted
  quota — every worker failed the same way, each got its own retry, and the
  workers queued behind them were still scheduled. A six-subtask plan could
  spend twelve worker calls plus the full planning overhead to learn one thing:
  the key is dead. Then it apologised. Cascade now stops after three
  consecutive systemic failures against the same model and marks the remaining
  work skipped, with the reason attached.

  The threshold only counts failures that will repeat — rate limits, auth
  errors, missing models, exhausted quota. A safety refusal or an over-long
  prompt is a property of one subtask, so those are still retried normally, and
  anything unrecognised is treated as per-task rather than stopping the run.
  The count is per model, so one dead tier can't abort work a healthy tier is
  doing fine.

- **"The research and analysis process failed due to a series of system-level
  errors" now says what the error was.** The provider's own message was being
  discarded, leaving a final answer nobody could act on. A stopped run now
  leads with the real cause — the model, the failure kind, and the provider's
  verbatim text — plus what to do about it: lower the parallelism, check
  billing, re-check the key in Settings, or pick a different model.

- **A failed section no longer reports "Section complete".** The status text
  was emitted unconditionally, two lines after computing a status that may well
  have been FAILED, so a section whose every worker died still announced
  completion — and the Cockpit showed a failure badge beside the word
  "complete", because the badge and the text came from different variables.

### Added
- **Thumbs up / down on cloud replies.** Rate any assistant message; pressing
  the active thumb again withdraws the vote rather than casting the opposite
  one. Verdicts persist with the conversation and record which model earned
  them, captured at vote time because routing changes between runs. Only the
  verdict and the model are stored — never the message text.

  Worth being clear about what this is for: it shapes future routing, slowly.
  It cannot stop a run that is already failing from costing money — that is
  what the circuit breaker above does.

- **Memories can be marked "Always true" or "Current context".** Stable facts
  ("I write TypeScript") and in-flight ones ("migrating billing this sprint")
  want opposite handling: the first should carry indefinitely, the second is a
  snapshot that is probably already stale. Memories now render into the prompt
  as a small markdown document under those two headings, and the model is told
  to prefer what you say now over anything filed as current context. Existing
  memories back-fill as permanent.

## 0.49.0 - 2026-07-27

### Fixed
- **A model with no known price is no longer reported as free.** Cascade wrote
  `$0` whenever it couldn't find a price — for a model the provider had just
  started serving, for a `provider:model` override it didn't recognise, for a
  freshly released preview id. Nothing downstream could tell that `$0` apart
  from the real `$0` of a local Ollama model, so three things went wrong at
  once: your cost readout showed **$0.00 for calls that cost real money**; a
  per-run or session **cost cap could never fire** on those models, because
  their spend never reached the counter; and the value-based routing scored a
  free-looking model as maximally cost-efficient, so an unpriced model was
  *preferred* on cost grounds. Unknown prices are now tracked as unknown:
  they read **"cost not tracked"** instead of `$0.00`, they're counted
  separately from your spend total, and the router tells you when a cost budget
  is in play but a model's spend can't be counted toward it. Genuinely free
  local models still show as free, because for them the zero is real.

### Added
- **A real pricing dataset**, keyed by model **and** provider (and region), so
  the same model can cost what it actually costs on each. It records input and
  output rates per million tokens, cached-input rates, reasoning/thinking token
  rates, **long-context tiers**, batch discounts, and per-image / per-second /
  per-character / per-audio-minute rates for image, video, speech and
  transcription models. Every entry carries the currency, the date it was read,
  and the URL it came from.

  The tiers matter more than they sound: Gemini 3.1 Pro is $2/$12 per 1M up to
  a 200K-token prompt and $4/$18 above it, and GPT-5.4/5.5 step up at 272K. A
  single flat input/output pair — which is all Cascade could store before — is
  wrong on one side of that line no matter which number it keeps. So is
  pretending a model costs the same everywhere: gpt-4o-mini is $0.15/$0.60 per
  1M on OpenAI and $0.165/$0.66 on Azure, and gpt-5.4 costs 10% more on an
  Azure `us`/`eu` deployment than on a global one.

- **A local-vs-hosted toggle for `ollama` and `openai-compatible` providers.**
  Set `"local": true` on a provider to declare "this endpoint runs on hardware
  I already pay for, so inference is genuinely free"; set `"local": false` for
  a hosted endpoint. Unset, it's inferred sensibly: Ollama is local, and an
  OpenAI-compatible endpoint is local when its `baseUrl` points at
  localhost/your LAN (llama.cpp, LM Studio, vLLM) and hosted otherwise
  (Together, Groq, Fireworks). This is what lets Cascade say `$0` and mean it —
  a *hosted* endpoint with no known price now reports "cost not tracked".

- **The desktop status bar marks an incomplete total.** When a run used a model
  with no known price, the session cost reads `$0.0123+` rather than a bare
  figure, and hovering explains which spend is missing and why it doesn't count
  toward a cost budget. A confidently-rendered number is exactly how real spend
  came to be read as free.

- **`cascade models` reports where prices disagree.** When the live source
  (OpenRouter) quotes a different price than the bundled dataset, the live
  number is used — it's fresher by construction — but the mismatch is shown
  rather than silently swallowed, because it's the best available signal that
  the committed prices need a refresh. Run `node scripts/refresh-pricing.mjs`
  to update them.

### Changed
- **Bundled catalogue prices are now taken from the pricing dataset**, which
  corrects several that had drifted: Claude Opus 4.5/4.8 were priced at $15/$75
  per 1M against a published $5/$25 (3× too high), and GPT-4o at $5/$15 against
  a published $2.50/$10 (2× too high). Cost-based routing and every spend
  readout were skewed accordingly.

## 0.48.2 - 2026-07-27

### Changed
- **The weekly benchmark refresh is now driven by a scheduled Claude task, not
  a cron workflow** (first run 3 Aug 2026, then weekly). Public leaderboards
  each measure differently, so the refresh needs to research sources, normalize
  *within* each one, and judge what's comparable — which a fixed script can't
  do. It will cover every modality Cascade plans to orchestrate (text, vision,
  image/video/audio generation, embeddings) and open a PR for review. The
  GitHub workflow remains as a manual (`workflow_dispatch`) way to re-run the
  aggregator over the checked-in sources.

### Fixed
- **Desktop sign-in now survives a server redeploy.** The one-time loopback code
  (and the pending sign-in state) were held only in the server's memory, so a
  restart in the seconds between the browser finishing OAuth and the app
  redeeming its code threw the code away — the app failed with `invalid_grant`
  through no fault of the user, which is exactly what a deploy-on-merge cadence
  produces. Both artifacts are now written through to SQLite and restored on a
  miss, so an in-flight sign-in completes across a restart. They remain strictly
  single-use: the read-and-delete happens in one transaction, so a code can't be
  redeemed twice even if two requests race, and PKCE verification and expiry are
  unchanged. (Device-flow codes for the CLI are still memory-only — their records
  mutate in place, so that flow needs more than create/consume semantics.)

## 0.48.1 - 2026-07-27

### Fixed
- **Desktop sign-in now says what actually went wrong.** Signing in could leave
  the app on "Sign-in could not be completed. Please try again." while the
  browser showed success — because the browser half *had* succeeded and the
  failure was the app's follow-up code exchange, whose real error was thrown
  away. The message now distinguishes the cases that actually occur: the
  one-time code no longer being redeemable (it's single-use and short-lived, and
  a server restart mid-sign-in drops it, since codes are held in memory), the
  host answering but not as the Cascade API (a stale DNS record after a domain
  move), and being unable to reach the server at all.
- **Node version requirement now says the same thing everywhere.** The README
  (badge, install note, requirements table) advertised Node ≥ 20 while
  `package.json` `engines` requires ≥ 22 — new contributors hit a failed install
  after following the README. All now say **≥ 22**.

### Changed
- **The weekly benchmark refresh now runs Tuesday mornings** (05:00 IST) instead
  of Monday, so the PR is waiting for review at the start of the week. It still
  opens a PR only when the aggregated data actually changed.

### Added
- **`SECURITY.md`** — private disclosure policy: how to report a vulnerability
  (GitHub private advisories, never a public issue), response targets, what's in
  and out of scope, and supported versions.
- **`CONTRIBUTING.md`** — setup, the monorepo layout, the verify-before-push
  checklist, and when a change needs a version bump (SDK/CLI/desktop yes,
  cloud-only no).
- **Issue and pull-request templates** plus **`CODEOWNERS`** — structured bug
  reports (surface, version, provider/tier setup) and feature requests, with
  security reports routed to the private advisory form.

## 0.48.0 - 2026-07-22

### Fixed
- **Providers no longer offer models that can't hold a conversation.** Every
  provider's model list (`generativelanguage`/OpenAI `/v1/models`/Anthropic/
  Ollama/OpenAI-compatible) returns *all* of its models — including embeddings,
  text-to-speech, speech-to-text, image/video generation, moderation and
  legacy completion-only base models. One of those (e.g. Gemini's
  `gemini-2.5-pro-preview-tts`, which only emits AUDIO) could be discovered and
  routed to for a normal turn, failing the run with a 400. A new shared
  `isChatModel` filter (`src/providers/model-filter.ts`) is applied across all
  providers so only real text-chat models enter the router's candidate pool.
  Ollama's family allowlist also no longer includes the `nomic-embed` embedder.

## 0.47.1 - 2026-07-22

### Removed
- **Retired the standalone GitHub Pages landing.** The marketing page now lives
  inside the app as its logged-out home, so the separate `index.html` and its
  `static.yml` Pages-deploy workflow are gone — one landing page, one host. (Set
  the repo's Pages source to "None" to unpublish the old `github.io` site.)

## 0.47.0 - 2026-07-22

### Changed
- **One clean domain: `cascadeai.in`.** The hosted app, its landing page and the
  docs now all live under a single host — the app at `/`, the docs at `/docs` —
  with **no `app.` subdomain**. The CLI and desktop default cloud endpoint
  (`DEFAULT_CLOUD_URL`) now points at `https://cascadeai.in`, so freshly built
  clients talk to the one host (a local dev server is still targetable via
  `--server` / `CASCADE_CLOUD_URL` / the `cascade-cloud-url` override). The
  deploy guide (`cloud/DEPLOY.md`) and domain runbook (`docs/domain-move.md`)
  now describe the single-host setup, and the GitHub Pages `CNAME` is dropped so
  Pages no longer claims the apex.

## 0.46.4 - 2026-07-22

### Added
- **A real landing page** is now the logged-out home of the web app (replacing
  the bare sign-in card), so the apex `cascadeai.in` has a proper homepage:
  hero ("Agents that cascade"), the three-tier explainer, a feature grid, and
  sign-in (GitHub/Google) plus "Download desktop app" and "Docs" CTAs — all from
  the existing brand (cascade gradient + three-bar mark).
- **Public docs at `/docs`.** The cloud server now serves a self-contained,
  brand-styled documentation page (What is Cascade, quick start, providers &
  keys, tier routing, file exports, privacy) at `/docs`, registered ahead of the
  SPA catch-all. The page is hand-written user-facing content — the repo's
  `docs/*.md` are internal design specs and are deliberately not served publicly.
- **Domain-move runbook** (`docs/domain-move.md`) — the DNS / Railway /
  OAuth-console / env steps to bring `cascadeai.in` up as the single host. The
  app side is in place; the rest is config the account owner runs.

## 0.46.3 - 2026-07-22

### Added
- **Word and PowerPoint join PDF and Excel exports.** Ask for a report as a
  `.docx` or a deck as a `.pptx` and Cascade renders the real Office binary in
  the browser: Markdown becomes a Word document (headings, styled runs, bullet
  and numbered lists, code, quotes, tables, rules), and a Markdown deck — slides
  separated by `---`, each led by a heading — becomes a PowerPoint presentation.
  Like the PDF/Excel path, the `docx`/`pptxgenjs` libraries are lazy-loaded (own
  chunks, out of the base bundle) and everything renders client-side.

### Changed
- **Generated Office/PDF cards now have View and Save, not just Download.** The
  first cut shipped these cards as download-only; they now match text files:
  **View** previews the result (a real PDF inline in the viewer; Excel/Word/
  PowerPoint show the Markdown/CSV source that produces them), and **Save** keeps
  the actual rendered binary in your Cascade files (the metered store now accepts
  base64 binaries, and the Files panel previews a saved PDF inline and offers a
  clean download for Office formats). The composer hint no longer says file
  generation is "coming soon".

## 0.46.2 - 2026-07-22

### Added
- **Generate real PDF and Excel files from chat.** Ask for a report as a PDF or
  a table as a spreadsheet and Cascade now hands back a genuine `.pdf` or
  `.xlsx` — not just text. Because a run streams text, the model writes the
  *source* (Markdown for a PDF, CSV for a spreadsheet) in a `file:` block and
  the **browser renders the real binary on download**: a small Markdown→PDF
  layout engine produces selectable-text PDFs (headings, lists, tables, code,
  blockquotes, rules, with word-wrap and page breaks), and CSV is turned into a
  proper `.xlsx` workbook. The rendering libraries are lazy-loaded, so they only
  download the first time you export one of these formats and never enter the
  base bundle, and your content never leaves the browser. Office/PDF cards are
  download-only for now (inline preview and metered save of the binary are a
  follow-up); ordinary text files keep View + Download + Save. The hosted
  file-delivery guidance now tells the model how to target these formats, still
  only when you explicitly ask for a file.

## 0.46.1 - 2026-07-22

### Fixed
- **Reasoning models no longer leak `<think>…</think>` into the web answer.**
  Reasoning-tuned models (and local llama.cpp / gpt-oss GGUFs) emit their
  chain-of-thought as `<think>…</think>` inline in the content — the desktop
  app already split this into a collapsible block, but the **web** rendered it
  verbatim as part of the reply. The web message view now pulls reasoning out
  into a collapsed **"Thoughts"** section (labelled "Thinking…" with a pulse
  while it streams), shows only the clean answer, and copies just the answer —
  matching the desktop behaviour.

## 0.46.0 - 2026-07-22

### Fixed
- **An explicit per-tier model now actually sticks.** Pinning a specific model
  for a tier in Settings (e.g. T3 → a local `openai-compatible` GGUF) was
  silently ignored when Cascade Auto was on: the per-subtask router re-ranked
  and picked a different model (often Gemini) anyway. A pin is now authoritative
  — a tier the user set to a specific model always uses it; Auto only applies to
  tiers left on **Auto**.

### Changed
- **Cascade Auto now sees newly released models, not just the bundled catalog.**
  Auto ranked models only from a static priority list, so a model your provider
  reported live (a newer Gemini flash, say) was registered but never considered
  — Auto stayed stuck on older catalog entries. Live-discovered models a
  provider actually serves now compete in Auto ranking for the tiers that route
  to that provider. Newer **Gemini** models that aren't in the benchmark table
  yet are scored by their class (a `…-flash` scores like the current flash, a
  `…-pro` like the current pro) instead of a neutral default, so a better-value
  new model can win instead of being invisible until the catalog is hand-edited.

## 0.45.0 - 2026-07-22

### Changed
- **One unified Cascade identity across the CLI, desktop app, and web.** The
  brand is now a single system built on the product itself: intelligence flows
  down the tiers and the colour flows with it — **azure (T1) → sky (T2) → teal
  (T3)** — replacing the old violet/amber/cyan mix. A shared **cascade mark**
  (three tiers stepping down) is the favicon/app icon, and the CLI's start-up
  banner is now that mark in truecolour. Applied from each surface's token
  source: web Tailwind CSS variables, the desktop theme (light/dark/midnight),
  and the CLI's default `midnight`/`cascade` theme + `cascade models` tiers.
  The alternative desktop/CLI themes (Aurora, Ember, Tide, Bloom, Daybreak) are
  unchanged.

### Fixed
- **Dropdown menus were nearly unreadable.** Native `<select>` option lists are
  OS-drawn, and on some platforms rendered as faint, near-invisible text on a
  mismatched (often white) popup — the provider and skill pickers were the worst
  hit. Both the web and desktop apps now pin the popup's colour-scheme to the
  active theme **and** set explicit option colours, so the list is always
  legible in light and dark.

## 0.44.1 - 2026-07-22

### Fixed
- **The web app no longer overflows on mobile — the whole page used to scroll.**
  The app shell was sized with `h-screen` (`100vh`), which on mobile browsers
  includes the area behind the address/toolbar chrome, so the layout ran taller
  than the visible viewport and the composer sat below the fold — you had to
  scroll the entire UI to reach it. The shell now uses **`100dvh`** (dynamic
  viewport height) and the document itself is locked from scrolling
  (`overflow: hidden`, no overscroll), so only the message list scrolls and the
  composer stays pinned in view. Modals/drawers now cap at `dvh` too, so a tall
  dialog fits the visible screen and scrolls internally. Desktop is unchanged.

## 0.44.0 - 2026-07-22

### Added
- **One-click "Connect" for GitHub — no token to paste (cloud).** GitHub's
  hosted MCP server can't be reached by our automatic OAuth flow because GitHub
  has no Dynamic Client Registration (which is why picking GitHub previously
  dropped you into a "paste a Personal Access Token" form). New **connect
  broker**: the server runs the OAuth handshake with *our own* registered GitHub
  OAuth App, whose secret lives only on the server (`CONNECT_GITHUB_CLIENT_ID` /
  `CONNECT_GITHUB_CLIENT_SECRET`) and never touches the browser. Click **GitHub →
  GitHub's sign-in page → done**; the user-scoped token is stored encrypted and
  injected into runs through the existing MCP path. New routes
  `POST /api/connect/:provider/start` and `GET /api/connect/:provider/callback`.
  Fully **env-gated**: with no OAuth App configured the connector still shows the
  token-paste form exactly as before, so nothing breaks without setup. The
  already-one-click connectors (Notion, Linear, Sentry, Stripe, Atlassian) are
  unchanged — they self-register via DCR and never needed a broker. See
  `docs/connectors-broker.md`.

## 0.43.0 - 2026-07-22

### Fixed
- **Desktop installers are built again — the release version had drifted from
  the changelog.** The release workflow keys the desktop build off the root
  `package.json` version: it publishes a GitHub Release (and the native
  macOS/Windows/Linux installers) only when that version has no release yet.
  `package.json` had stalled at **0.20.3** (the last cut release) while this
  changelog raced ahead to 0.42.1, so several merges — including the desktop
  **cloud-backed sessions + branch navigation** feature — landed on `main`
  without ever bumping the release version, and their installers were never
  produced. Root and `app/package.json` are realigned to the changelog line at
  **0.43.0**, which cuts a fresh release and rebuilds the desktop app with all
  the accumulated desktop work packaged in. Going forward, changes that touch
  the desktop app or CLI must bump the root version so this build actually runs.
- **Release notes on the GitHub Release are populated again.** The notes
  extractor only matched the old `## [x.y.z]` changelog header shape; the
  current entries are written as `## x.y.z - date`, so recent releases fell back
  to a bare "Release vX" stub. The extractor now accepts both header shapes.

## 0.42.1 - 2026-07-21

### Fixed
- **GitHub connector no longer offers a "Sign in with OAuth" button that only
  errors.** GitHub was marked one-click OAuth in 0.42.0, but GitHub's OAuth has
  no Dynamic Client Registration, so our DCR-based flow can't self-register —
  clicking *Sign in with OAuth* returned *"This server doesn't offer OAuth
  sign-in."* GitHub is now correctly a **token** connector: picking it opens the
  form straight to its **Personal Access Token** field (with a link to create
  one). The OAuth button is now shown **only** for connectors that actually speak
  OAuth (Notion, Linear, Sentry, Stripe, Atlassian) or a Custom MCP server —
  token-only connectors show just the token field.

## 0.42.0 - 2026-07-21

### Added
- **A real connector directory — browse & one-click connect, like Claude.** The
  hosted Connectors panel used to ship three presets (GitHub + two "paste your
  own MCP URL" entries). It's now a searchable **directory of hosted remote MCP
  servers** with the endpoint baked in, so you never type a URL:
  **GitHub, Notion, Linear, Sentry, Jira & Confluence (Atlassian), Stripe,** and
  **Cloudflare Docs**. The OAuth ones are genuinely **one-click** — pick the
  connector → the provider's sign-in page → done, no token to paste (OAuth 2.1 +
  PKCE with discovery/DCR handled by our existing MCP-OAuth stack); public
  servers (Cloudflare Docs) add instantly with no auth at all. Brand badges, a
  "1-click" marker, and search make it scan at a glance. Slack/Google stay
  "bring your MCP URL" for now — there's no single public hosted endpoint to
  point at yet — and any service still works via **Custom MCP server**. New
  hosted endpoints are validated against our SSRF allowlist like every other
  connection.

## 0.41.3 - 2026-07-21

### Added
- **Desktop: cloud-backed sessions + branch navigation.** When signed in, the
  desktop now **mirrors each finished chat turn into a shared cloud conversation**
  (created lazily on the first turn), so a chat you run in the app also appears on
  web + CLI. Runs still execute **locally** (your keys + shell/file/git tools);
  only the resulting messages are stored. Best-effort — it never blocks or breaks
  a run — and opt-out via `localStorage['cascade.noCloudSync'] = '1'`.
- **Branch navigation in *Continue elsewhere → Cloud chats*.** Opening a shared
  cloud chat now shows its active path with a **`‹ i/n ›` version switcher** on any
  turn that has alternatives (edits/regenerations), a **delete** control that
  removes a message and its whole subtree, and a **"Bring this branch here"** to
  continue the selected branch locally. Backed by a new cloud write IPC surface
  (`createConversation`, `appendTurn`, `selectBranch`, `deleteMessage`,
  `renameConversation`, `deleteConversation`).

## 0.41.2 - 2026-07-21

### Added
- **CLI: cloud-backed sessions + branch management.** When you're signed in
  (`cascade login`), the interactive REPL now **mirrors each finished turn into a
  shared cloud conversation**, so a chat you run in the terminal also shows up on
  the web and desktop — same session, everywhere. Runs still execute **locally**
  (your own keys + shell/file/git tools); only the resulting messages are stored.
  It's best-effort (never blocks or breaks a run) and opt-out via
  `CASCADE_NO_CLOUD_SYNC=1`.
- **`cascade sessions` is now a full cloud-session manager**, with the message
  tree exposed for terminal branching:
  - `cascade sessions` — list your cloud chats.
  - `cascade sessions show <chat>` — print the active path, with `‹i/n›` markers
    on turns that have alternatives and a short `[id]` on every message to target.
  - `cascade sessions branch <chat> <message>` — switch to another branch (an
    edit's or regeneration's alternative).
  - `cascade sessions rm <chat> <message>` — delete a message and its whole subtree.
  - `cascade sessions rename <chat> <title>` and `cascade sessions delete <chat>`.

## 0.41.1 - 2026-07-21

### Added
- **Cloud write API — the foundation for shared sessions on desktop & CLI.** The
  `CloudClient` gained a write surface (`createConversation`, `appendTurn`,
  `selectBranch`, `deleteMessage`, `renameConversation`, `deleteConversation`) and
  the cloud server gained the matching native-authed routes (`POST
  /api/conversations`, `POST /api/conversations/:id/turns`). This lets a desktop
  or CLI client — which executes runs **locally** with your own keys and tools —
  persist each finished turn into the **shared cloud conversation tree**, so the
  same sessions (and message branching) can appear on web, desktop, and CLI. The
  append route applies the same branch resolution as hosted runs (normal / edit →
  sibling / regenerate → sibling) and is owner-scoped. No user-facing surface
  changes yet; the desktop and CLI wiring land next.

## 0.41.0 - 2026-07-21

### Added
- **Message branching in hosted chat (edit, regenerate, copy, delete).** A
  conversation is now a **tree** rather than a flat list, so you can explore
  alternatives without losing anything:
  - **Edit a prompt** → it forks a **new branch** and re-runs; your original
    prompt and its answer stay on disk.
  - **Regenerate a reply** → produces a **sibling** answer under the same prompt.
  - A **`< n/m >` navigator** appears on any turn that has siblings, stepping the
    view between the versions (switching descends to that branch's latest reply).
  - **Copy** any message, and **delete** a message to remove it **and its whole
    subtree** (the view then falls back to the nearest surviving turn).

  Under the hood: messages gained a `parent_id` and each conversation tracks an
  **active leaf**; run history follows that path up from the leaf, so only one
  branch is "live" at a time while every alternative is retained. A one-time
  migration back-fills existing chats into a single linear branch (nothing to do
  — your old conversations just work). Cloud web + server for now; desktop/CLI can
  adopt the same model later.

## 0.40.2 - 2026-07-21

### Fixed
- **"No model available for tier T1" with any Azure deployment.** Setting an Azure
  deployment whose name didn't happen to collide with a bundled catalog id (e.g.
  a `gpt-5.4-mini` or a custom name) could fail the run with *"No model available
  for tier T1"*. The deployment was only registered — and only made available to
  fill the tiers — if a startup availability *probe* succeeded, and that probe is
  a live network call that can fail for reasons that say nothing about the
  deployment (a cold start, a transient 429, a content-filtered "ping"). A single
  deployment the user explicitly configured (endpoint + key + deployment name) is
  now **trusted regardless of the probe** and registered directly, so one
  deployment correctly serves all three tiers; the probe result is now only
  advisory. A generate-time fallback also resolves any tier that was somehow left
  unfilled to the best available model instead of hard-failing. A genuinely
  unreachable deployment still fails with the provider's own concrete error at
  call time, which is far more actionable than a blanket "no model" at startup.
- **Large attached documents (~52 KB) no longer show a misleading "truncated /
  add an OpenAI key" notice.** The cache-vs-retrieve threshold for attached
  documents was a fixed 24 KB (~6k tokens), so an ordinary ~52 KB file (only
  ~13k tokens — trivially within any modern context window) was pushed to
  passage retrieval; users without an embeddings-capable key then saw *"Add an
  OpenAI-compatible key… used a truncated view"* even though the whole document
  was in fact injected. The threshold is now **derived from the run's real
  context window** (via the models the user configured) instead of a fixed byte
  cliff, so normal documents are injected in full and never routed to retrieval.
  Retrieval is now reserved for corpora that genuinely wouldn't fit the window,
  and the notice for that case is honest ("the full text was still included") and
  points at every provider that unlocks retrieval (OpenAI, an OpenAI-compatible
  endpoint, or a local Ollama) — not just OpenAI.

## 0.40.1 - 2026-07-21

### Fixed
- **The chat "Context" meter now means what it says — and survives a refresh.**
  It previously showed the *last run's* total token throughput (input + output
  summed across every tier) against a hard-coded 100k soft cap, so a heavy
  multi-agent run read "Context is getting full" regardless of the model's real
  window or your "Max tokens per run" / "Extended context" settings — and it
  vanished on reload because it was held in memory from the last run. It now
  estimates the **current conversation's** size (from its messages) against the
  **active model's real context window** (gpt-5 400k, Claude 200k, Gemini 1M, …),
  so it's accurate, matches expectations, and is recomputed from the loaded chat
  on refresh. The heavy-run figure is still shown, clearly labelled "Last run used
  ~N tok across all tiers."

## 0.40.0 - 2026-07-21

### Added
- **Rich rendering in hosted chat: Mermaid diagrams + LaTeX math.** Assistant
  replies already rendered markdown, GFM tables, and syntax-highlighted code; now
  they also render **```mermaid** fenced blocks as diagrams (lazy-loaded so the
  library stays out of the initial bundle, `securityLevel: 'strict'`, falls back
  to source on a parse error) and **LaTeX math** — `$inline$` and `$$block$$` — via
  KaTeX. Raw HTML in model output is still never rendered.
- **In-app file viewer for generated & saved files.** A new **View** button on
  every generated-file card and every saved file in the Files panel opens a preview
  that renders by type: markdown (full rich renderer — math, mermaid, code), CSV/TSV
  as a **table**, highlighted **code**, images, and **HTML/SVG in a sandboxed iframe**
  (scripts off by default, opt-in per view, never same-origin) with a source toggle.
  Download and Save-to-Cascade are available right from the viewer.

## 0.39.1 - 2026-07-21

### Fixed
- **Railway deploy unblocked: cloud image now builds on Node 22.** `Dockerfile.cloud`
  pinned `node:20-slim` (build + runtime) and the `engines` fields required Node ≥20 —
  Node 20 is now deprecated, which was stalling the Railway build queue. Bumped the
  cloud Docker image to `node:22-slim` and `engines.node` to `>=22.0.0` (CI already ran
  Node 22). No code changes; all deps support Node 22.

## 0.39.0 - 2026-07-21

### Fixed
- **A bare "hi" no longer spins up a full multi-agent run (or a phantom
  `report.md`).** In hosted chat the routing heuristics never saw your actual
  message — the file-delivery guidance and memories were prepended first, so even
  "hi" read as a long, "Complex" prompt and was handed to a real T3 worker that
  then echoed the guidance's example as a spurious file card. Now:
  - The run carries a separate **`routingPrompt`** (your real text) for the
    complexity decision + task analysis, while the model still gets the full
    context. Pure small talk ("hi", "who are you") takes the direct
    single-model path — no workers, no classifier (gated by `fastAnswer.autoSimple`,
    on by default).
  - The **file-delivery guidance is reworded** (no echo-able example fence, "do
    this ONLY when explicitly asked") and **only injected when the request
    actually looks file-shaped** (`wantsFileDelivery`), so ordinary chat never
    produces a file.
  - A terse option reply like **"3"** no longer gets mis-classified: a context-free
    on-device hint for it is ignored and the classifier reads the conversation.
- **The per-run cost cap is now yours to set.** Hosted runs were silently capped
  at a hidden **$0.50** server default that overrode your generous token limits.
  Add **"Per-run cost cap (USD)"** in Settings → Advanced (range $0.05–$25; blank =
  the $0.50 default). Clarified that per-tier "Max tokens" is a **per-call** output
  limit, not a whole-run budget.
- **You can delete chats.** Cloud web: the per-chat trash is always visible, plus
  **"Clear all chats"** (with `DELETE /api/conversations`). Desktop: the per-session
  trash is discoverable without hovering, and **Settings → Data → "Clear all chat
  history"** wipes every session.

### Added
- **History-preserving project knowledge (undo a bad fact).** The world-state fact
  store no longer destroys a value when it changes — the prior value is archived
  (still AES-256-GCM encrypted) on every overwrite, delete, clear, and cross-machine
  import. The desktop **Insights → Knowledge** tab gains a per-fact **history** view
  with **Restore**, so one noisy extraction can't permanently clobber a correct fact.
- **Distinct GPT-5 point releases in routing.** `gpt-5.5` ("Spud", the current
  SWE-bench leader at 88.7%), `gpt-5.4`, and `gpt-5.4-mini` now route as their **own**
  families with their own benchmark scores + pricing (Azure deployments too) instead
  of folding into `gpt-5` — so Cascade Auto stops treating a 5.4 deployment like a
  5.4-mini. The benchmark aggregator now defaults to **robust** mode (drops one low
  outlier when ≥3 sources cover a cell).
- **Remember chats as Memory (opt-in).** Off by default. When enabled, a finished
  chat is distilled into durable memories/facts your future runs will see — cloud
  (Settings → Privacy → "Remember chats in Memory") and desktop (Settings → Advanced
  → "Remember sessions"). Distilled facts are undoable from the Knowledge tab, and
  you prune cloud memories from the Memory panel as usual.

## 0.38.0 - 2026-07-21

### Added
- **Benchmark aggregator — conservative, multi-source routing scores.** The
  quality scores Cascade Auto routes on (`benchmark-data.json`) are now produced
  by aggregating **multiple benchmark sources** instead of a single hand-curated
  table. Each source in `scripts/benchmarks/sources/` (Artificial Analysis,
  LMArena/Chatbot Arena, public suite leaderboards) is **normalized onto a common
  0–100 quality scale**, then the **conservative (lowest) value per family/task**
  is taken across the sources that cover it — being strict about the
  quality-to-cost trade-off (SWE-bench 80 + Arena 77 → **77**).
  - **Normalization** handles incompatible native scales: a 0–100 index is used
    as-is, Elo maps through a fixed reference band, and a raw benchmark % is
    calibrated against a documented reference-max (SWE-bench Verified tops out
    ~75% even for frontier coders, so it isn't treated as "75/100").
  - **Modes**: `min` (default) or `robust` (drops one low outlier when ≥3 sources
    cover a cell). Cells no source covers keep the prior baseline, so partial
    coverage never blanks a score.
  - **Auditable**: `node scripts/refresh-benchmarks.mjs --explain` prints which
    source set each score and what every source reported. The snapshot now
    carries `gpt-5` / `gpt-5-mini` / `gpt-5-nano` families too.
  - The weekly refresh workflow re-aggregates the committed sources; editing a
    source file and pushing is enough to propose a data-only update. Design +
    the honesty rules for source data in
    [`docs/benchmark-aggregation.md`](docs/benchmark-aggregation.md).

## 0.37.0 - 2026-07-21

### Added
- **File generation & Cascade Files.** Hosted runs can now produce files you can
  **download for free** (your browser makes the file) or **save to Cascade**,
  metered by plan — plus data management (import chats & memories, delete chats).
  - **Delivery**: the worker returns a file's contents in a ```` ```file:name.ext ````
    fenced block; the web renders **file cards** with **Download** (client-side
    Blob, free, nothing stored) and **Save to Cascade files**.
  - **Storage**: saved files live on the per-tenant Railway volume, tracked in a
    new `files` table. Free = **10 MB**, Pro = **1 GB** (a generous metered cap,
    not "unlimited"). Over the cap → a 413 with a "delete or upgrade" message.
  - **Files panel**: a right-hand drawer lists saved files with a storage usage
    bar, per-file download + delete, and an upgrade prompt at the cap.
  - **Data management**: delete a chat (trash in the sidebar), and **import chats
    or memories** from an exported JSON bundle.
  - Endpoints: `GET/POST/DELETE /api/files`, `GET /api/files/:id`,
    `DELETE /api/conversations/:id`, `POST /api/memories/import`. Design +
    security in [`docs/file-generation.md`](docs/file-generation.md).

### Fixed
- **Hosted runs no longer waste turns on a phantom `write_file`.** A hosted run
  has no disk tools, but runtime **tool creation** was left on — the worker would
  synthesize a `write_file`/`dynamic_write_file`, call it, produce nothing, and
  the run failed ("execution failed to produce any output"). Tool creation is now
  disabled for hosted runs, and the worker is steered to deliver files via the
  `file:` fence instead.

## 0.36.0 - 2026-07-20

### Added
- **OAuth-based MCP connectors.** Connecting an MCP server can now run an
  **OAuth flow** (log in + authorize) instead of pasting a token — across
  **cloud web, desktop, and CLI**. Token-paste remains the fallback for servers
  without OAuth.
  - **Spec-complete, via the MCP SDK.** We drive the `@modelcontextprotocol/sdk`
    OAuth client (RFC 9728 resource discovery, RFC 8414 AS metadata, RFC 7591
    **Dynamic Client Registration**, PKCE, refresh) through a shared
    `McpOAuthProvider` — no client secret ships anywhere; PKCE proves the client.
  - **Cloud**: "Connect" in *Connectors* runs the flow (browser leg on our
    callback); tokens are **encrypted at rest** with a server key and
    auto-refreshed just-in-time before each run.
  - **Desktop / CLI**: loopback (RFC 8252) connect — `cascade mcp connect <url>`
    and a new *Connectors* tab in desktop Settings. Tokens are stored locally
    (`~/.cascade-ai/mcp-oauth/…`, `0600`) and **auto-refreshed at run time** via
    the provider (silent refresh; a dead refresh token surfaces as "reconnect").
  - New SDK exports: `McpOAuthProvider`, `connectMcpWithLoopbackOAuth`,
    `FileMcpOAuthStore`, and thin `beginMcpOAuth` / `completeMcpOAuth` /
    `discoverMcpAuthServer` / `refreshMcpToken` orchestration wrappers, plus an
    `oauthStore` field on MCP server config. Server: a `user_secrets`-style
    encrypted `oauth_json` column, a short-TTL pending-flow store, and
    `POST /api/mcp/oauth/start` + `GET /api/mcp/oauth/callback`.
  - Design + security documented in [`docs/mcp-oauth.md`](docs/mcp-oauth.md).

## 0.35.0 - 2026-07-20

### Added
- **Key sync — settings that follow your account.** Once signed in, your
  settings sync across **web · desktop · CLI**, end-to-end encrypted, with the
  server acting only as a **ciphertext relay it cannot read**. Replaces the
  Google Drive appData sync with an account-based one (no second Google grant;
  works for GitHub sign-ins too; reaches desktop + CLI).
  - **E2E crypto**: AES-256-GCM with a PBKDF2-SHA256 (210k) passphrase-derived
    key — the exact parameters the web KeyVault already uses, now ported to Node
    byte-for-byte so a blob written by one client decrypts on any other
    (covered by a cross-implementation interop test).
  - **Bundle**: LLM provider keys, web-search backend keys, MCP/connector
    tokens, and non-secret preferences. **Pull merges** — it adds/updates keys
    without wiping a device's local-only providers.
  - **Server**: a per-user `user_secrets` ciphertext envelope +
    `GET/PUT/DELETE /api/keysync` (session-scoped, size-capped). The passphrase
    never leaves the device; the server has nothing to decrypt with.
  - **Web**: an *Account sync* panel (Push / Pull) replaces the Drive panel for
    any signed-in user.
  - **CLI**: `cascade sync push` / `cascade sync pull` (hidden passphrase
    prompt), gathering/applying the local `.cascade` config.
  - **Desktop**: Push / Pull from the account surface in *Continue elsewhere*;
    the passphrase stays in the main process, and a pulled bundle applies to the
    live config so it takes effect without a restart.
  - Design + security documented in [`docs/key-sync.md`](docs/key-sync.md).

### Removed
- **Google Drive appData key sync** — superseded by the account-based sync
  above. Your keys live locally on each device, so nothing is lost; the account
  simply becomes the transfer channel.

## 0.34.0 - 2026-07-20

### Added
- **Native login — Phase 3 (desktop).** Optional sign-in to Cascade Cloud from
  the desktop app, so you can browse and continue the chats you started on the
  web — folded into the existing **Continue elsewhere** modal:
  - **Loopback OAuth** (RFC 8252) driven from the Electron **main process**: the
    system browser handles the Google/GitHub login, a one-time code lands on a
    one-shot `127.0.0.1` listener, and **PKCE** (not a secret) proves the
    client. No OAuth secret or provider token ever touches the desktop.
  - **Tokens encrypted at rest** with Electron `safeStorage` (OS keychain /
    DPAPI), falling back to a local AES-256-GCM key file (`0600`) on machines
    without a keyring. The renderer never sees a token — it talks to a narrow
    `cloud:*` IPC surface (`status` / `login` / `logout` / `sessions` /
    `messages`).
  - **Your cloud chats** tab lists your web conversations; "continue here"
    imports the transcript as a new local session via the backend's
    `/api/import`, mirroring the code-based handoff.
  - The account header shows who's signed in and how the session is protected,
    with a one-click sign-out (revokes the refresh token).
  - New shared SDK `CloudClient.runLoopbackLogin` (PKCE S256 + loopback listener
    + token exchange), reused by CLI and desktop; the session store is now
    pluggable so the desktop can inject its encrypted store. Covered by unit
    tests (loopback PKCE round-trip + state-tamper rejection) against a stub
    server.

## 0.33.0 - 2026-07-18

### Added
- **Native login — Phase 2 (CLI).** Sign in to Cascade Cloud from the terminal
  and browse the chats you started on the web:
  - `cascade login` — device-code flow (prints a short code + `/activate` URL,
    opens your browser, polls for approval). No OAuth secret; the CLI only ever
    holds a Cascade token.
  - `cascade logout` (revokes the refresh token), `cascade whoami`,
    `cascade sessions` (list) and `cascade sessions show <id>` (print a
    transcript; accepts an id prefix).
  - Access + rotating refresh token persist at `~/.cascade-ai/cloud-session.json`
    (0600); the access token auto-refreshes. Server URL via `--server` or
    `CASCADE_CLOUD_URL` (default `app.cascadeai.in`).
  - New SDK-internal `CloudClient` + cloud session store, covered by unit tests
    (device flow, refresh rotation, list/read, logout) against a stub server.

## 0.32.0 - 2026-07-18

### Added
- **Native login — Phase 1 (server).** The cloud server can now sign in the
  desktop app and CLI without any OAuth secret shipping in a native app: they
  authenticate against the server (which brokers the existing Google/GitHub
  flow), using **PKCE** instead of a client secret. Two flows — a **loopback**
  redirect for the desktop and a **device code** (`/activate`) for the CLI —
  both mint a short-lived access token plus a rotating, single-use, 60-day
  refresh token (hashed at rest). `sessionMiddleware` now also accepts
  `Authorization: Bearer`, so every existing route serves native clients
  unchanged. New: `/auth/native/:provider`, `/api/native/token`,
  `/api/native/device[/token|/approve]`, `/activate`, `/api/native/refresh`,
  `/api/native/logout`. Design + security are documented in
  [`docs/native-auth.md`](docs/native-auth.md).


### Added
- **Knowledge retrieval — Phase 4 (graph search over world-state).** A new SDK
  `GraphRetriever` does lightweight GraphRAG over the project knowledge graph
  (the existing `world-state` entity→relation→value facts): it seeds on entities
  the query names, then **expands a few hops** by following entity references
  inside fact values — the multi-hop traversal vector search can't do — and
  ranks the collected facts by query overlap. A `knowledge_graph_search` tool
  exposes it to workers for relational/multi-hop questions, registered at run
  init **once the workspace has learned facts** (so a fresh repo isn't handed an
  empty tool). This lights up the `graph` retrieval mode reserved in Phase 2,
  reusing the graph you already have — no Microsoft-GraphRAG indexing cost.
- New SDK exports: `GraphRetriever` and `GraphSearchTool`.

### Notes
- Phase 4 delivers the graph capability as a tool the orchestrator chooses to
  call (agentic routing). "Connected-source" RAG — condensing long MCP/connector
  tool outputs via retrieval — is a follow-up (4b), since it hooks the
  tool-execution path and warrants its own change.

## 0.30.0 - 2026-07-18

### Added
- **Knowledge retrieval — Phase 3 (workspace code index).** Cascade can now
  index a repository and search it by meaning + keywords. A new SDK
  `WorkspaceIndex` scans the workspace, chunks each file at
  definition boundaries (a dependency-free structural `chunkCode`), and embeds
  it into the Phase-1 hybrid store; a **content-hash manifest** makes refreshes
  **incremental** — only files whose contents changed are re-embedded. A
  `code_search` tool (opt-in via `codeIndex.enabled`) lets workers find code by
  concept during a run, using the user's own key for embeddings + reranking.
- **`cascade index [path]`** — build or refresh the workspace code index from
  the CLI (respects `.cascadeignore`, skips binaries and generated dirs).
- New SDK exports: `WorkspaceIndex`, `chunkCode`, `heuristicCodeChunker`,
  `buildManifest`/`diffManifest`/`hashContent`, and `CodeSearchTool`.

### Notes
- Phase 3 uses a **heuristic** (structural) code chunker — dependency-free,
  behind a `CodeChunker` interface. A tree-sitter AST chunker can drop in later
  for exact boundaries once its packaging is proven across the desktop build.
- The code index is opt-in and, unless `autoRefresh` is set, is only built by
  `cascade index` — so existing runs are unaffected.

## 0.29.0 - 2026-07-18

### Added
- **Knowledge retrieval — Phase 2 (reranking + adaptive routing).** Document
  RAG now runs a **second-stage reranker** over the fused candidates before
  injecting them — the biggest grounding-quality lever. The default
  `LLMReranker` does listwise reranking through the user's own chat model
  (`chatCompleterFromProviders`, OpenAI-compatible/Ollama), so it needs no ONNX
  runtime and no separate rerank key; it falls back to the fused order on any
  hiccup. A new pure `planRetrieval` decides **none / CAG / RAG** per run
  (with `graph`/`code` slots reserved for later phases), replacing the inline
  size check. The "searched N documents…" chat note now says when passages were
  reranked. New SDK exports: `LLMReranker`, `chatCompleterFromProviders`,
  `parseRankOrder`, `planRetrieval`, and a `reranker` argument on `Retriever`.

### Notes
- Reranking only runs when RAG actually fires (large attached docs) and a
  chat-capable key is present: candidates are capped (≤20) and the call is a
  single low-token, temperature-0 completion, so the cost/latency add is bounded.

## 0.28.0 - 2026-07-17

### Added
- **Knowledge retrieval — Phase 1 (document RAG).** New SDK retrieval core:
  an `Embedder` interface with an OpenAI-compatible `/v1/embeddings` client
  (works against OpenAI, OpenAI-compatible gateways, and Ollama), a
  heading/paragraph-aware `chunkText`, a SQLite-backed hybrid `VectorStore`
  (FTS5 BM25 ∪ brute-force cosine over normalized BLOB vectors), and a
  `Retriever` that fuses the two stages with Reciprocal Rank Fusion. Exposed
  from the SDK (`Retriever`, `SqliteVectorStore`, `OpenAICompatibleEmbedder`,
  `embedderFromProviders`, `chunkText`, `reciprocalRankFusion`).
- **Cloud document CAG-or-RAG switch.** Attached documents small enough to fit
  a token budget are still injected in full (cache-augmented). When they exceed
  it, each doc is chunked + embedded (cached per attachment + embed model, so
  re-runs don't re-embed) and only the passages most relevant to the prompt are
  injected. The chat surfaces a "searched N documents…" note; with no
  embeddings-capable key it falls back to the previous truncated injection and
  says so. Vectors are namespaced per user and stay in the tenant DB.

### Notes
- Phase 1 stores vectors as BLOBs with exact brute-force cosine (no native
  vector extension) — exact and instant at document-chunk scale, and swappable
  for an ANN index behind the `VectorStore` interface when the codebase index
  (a later phase) makes vector counts large.

## 0.27.0 - 2026-07-17

### Added
- **Live run activity.** The working indicator now reflects the *real* step —
  "Mapping the approach…", "Cascading: <subtask>…", "Working: <subtask>…" —
  built from live tier events instead of a fixed thinking/planning/executing
  cycle. Click it to expand a **run-activity drawer** showing the T1→T2→T3 tier
  tree with each tier's serving **model**, current subtask, and status.
- **Document upload.** Attach **PDF, Word (.docx), or text files** (txt, md,
  csv, json, …) in the composer. They're parsed to text on upload and injected
  as context for the run; documents show as a chip in the transcript. Up to
  10 MB each; extracted text is capped so one huge file can't blow the budget.
- **Remote MCP support (cloud).** Attach hosted **MCP servers** over Streamable
  HTTP (with SSE fallback) as tool sources for orchestrated runs — enabled
  servers apply to every run. https-only with an SSRF guard (private/loopback/
  metadata hosts blocked); auth tokens are stored server-side and never returned.
  The core `McpClient` now speaks remote transport in addition to stdio.
- **Connectors.** A curated layer over MCP: one-tap **GitHub** (GitHub's hosted
  MCP server + a Personal Access Token), plus **Slack** / **Google** and a
  **Custom MCP server** option (bring your own remote endpoint). Manage them in
  Settings → *Connectors & MCP* — toggle, add, or remove.

## 0.26.0 - 2026-07-17

### Added
- **Max tokens per run** (Settings → Advanced) — a hard ceiling on the total
  tokens a single run may spend across all tiers, so a runaway multi-agent run
  stops there. Blank = the default (200k); the per-run cost limit still applies
  independently.
- **Chat defaults** (Settings → Chat) — a **Default response bias** (Auto /
  Quality / Fast) and a **Web search by default** toggle that seed every new
  chat session (still overridable per chat). Fills out the Chat tab alongside
  the Fast-answer model.

## 0.25.0 - 2026-07-17

### Fixed
- **Model routing now tells Azure deployments apart and scores gpt-5 correctly.**
  Every Azure deployment used to get an identical hardcoded profile (same cost,
  no benchmark), so the *first one you added* always won regardless of which
  model it was, and gpt-5 models showed a neutral "50/100" because the benchmark
  table had no gpt-5 entries. Now each Azure deployment resolves its real **base
  model** — inferred from the deployment name, editable in the API-keys form —
  and inherits that model's real benchmark scores + pricing (base identity also
  drives the live price/benchmark fetch). Added gpt-5 / gpt-5-mini / gpt-5-nano
  to the catalog, benchmark table, and tier priorities. **Cross-provider cost
  comparison now works:** with the same model available via an Azure key and a
  direct-provider key, the cheaper one wins (cost is real on both sides).

### Changed
- **Settings is now tabbed** (General / Appearance / Chat / Advanced / Privacy)
  instead of one long scrolling column, so each pane is short and easy to scan.

## 0.24.0 - 2026-07-17

### Added
- **Cascade Auto learns from run outcomes (cloud).** The hosted orchestration now
  records per-model **success/failure, retries, cost, and context size** to a
  shared, anonymous dataset on the persistent volume, and routes away from models
  that fail — especially on large contexts — so routing gets better the more the
  product is used. **Free users always contribute; Pro users can opt out** in
  Settings → Privacy (enforced server-side by plan). No prompts or content are
  stored — only model id, task type, outcome, coarse size, and cost. Stats are
  written atomically so concurrent runs never corrupt the shared file.
- **Live benchmark scores for hosted routing.** Cascade Auto already fetches
  current public benchmark scores; the hosted server now caches them on the
  persistent volume, so live scores persist across requests and redeploys instead
  of being re-fetched on every run (falling back to the bundled table offline).

### Fixed
- **No more false "not a persistent volume" warning.** The boot storage check now
  recognizes a `DATA_DIR` explicitly pointed at the Railway volume's mount path
  (e.g. `DATA_DIR=/data` with the volume at `/data`) as persistent, instead of
  warning about data loss when data was actually being saved to the volume.

## 0.23.0 - 2026-07-16

### Added
- **Per-tier model parameters (Advanced).** Set max output tokens and sampling
  temperature per orchestration tier (T1/T2/T3) in **Settings → Advanced → Model
  parameters** (blank = the model's default). `maxTokens` is a ceiling (it lowers
  an over-large request, never raises a smaller one); `temperature` is applied
  only to non-deterministic calls, so internal classification/routing stays
  deterministic. Backed by the SDK's `tierLimits` (now with per-tier temperature)
  and a pure, tested `applyTierLimits`.
- **Extended context — process inputs larger than the model's window.** New
  opt-in setting (Advanced, off by default) that compacts an over-budget run to
  fit: conversation history that nears the window is folded into a rolling
  summary automatically, and a single oversized input is split into
  overlapping, structure-aware chunks, summarized in parallel (map), and
  recursively combined (reduce) — bounded by a **2× / 3× cap** past which the
  input is truncated. Because chunking spends extra model calls, the hosted app
  shows a **one-tap confirm** ("~N× the limit — process? ~N extra calls") before
  running it, and a notice once compaction happens. Runs inside the SDK right
  after routing (so the real model window is known), so desktop and cloud both
  benefit; the per-run budget cap remains the hard guardrail.

### Fixed
- **Cloud data survives Railway redeploys.** `DATA_DIR` now defaults to the
  attached Railway persistent volume (`RAILWAY_VOLUME_MOUNT_PATH`) when not set
  explicitly, so the SQLite DB and per-tenant uploads no longer sit on the
  ephemeral container filesystem that every redeploy wiped. Boot logs a storage
  diagnostic (and a loud warning if a deploy is still writing to ephemeral disk).

## 0.22.0 - 2026-07-16

### Changed
- **"Bold Console" redesign — one Cascade brand across every surface.** The
  hosted chat app (`cloud/web`) and the marketing landing page move onto the
  same design language already used by the desktop app and the runtime
  dashboard: **Cascade violet** as the primary brand/action colour, with the
  orchestration tiers as structural accents (**amber T1 / violet T2 / cyan
  T3**). No features were removed — this is a reskin.
  - **Light / dark / system themes** in the hosted app (Settings →
    Appearance), with a live OS listener and a no-flash pre-paint. Every colour
    resolves from a CSS variable, so the same components render correctly in
    both palettes.
  - **Density** (Cozy / Compact) and a **Simple / Advanced view** — Simple
    (default) keeps chat minimal; Advanced reveals the routing controls and a
    read-only plan surface.
  - **Read-only plan surfacing:** when Cascade produces a boardroom plan for a
    hosted run, the app now shows what it decided (tier split, estimated cost)
    in Advanced view. Hosted runs auto-proceed — the server forwards the plan
    then immediately approves it, which also fixes a latent 120s stall (the
    plan gate blocked whenever a listener was attached but never resolved).

## 0.21.0 - 2026-07-16

### Added
- **Fast answer — one quick model, no orchestration.** A new `⚡` button in the
  hosted composer (and a `fastAnswer` option on `cascade.run()`) answers with a
  single mid-tier model directly: it skips the T1 → T2 → T3 planning/worker
  machinery, registers no tools, and does no artifact verification — the fastest,
  cheapest path for quick questions and small asks. The reply still streams and is
  persisted like a normal turn. The routing controls (mode/tier/web) don't apply
  to a fast answer since it's a single direct call. Which model it uses is
  auto-picked from your validated mid-tier candidates, or you can pin one in
  **Settings → Chat → Fast answer model** (e.g. `gpt-4o-mini`). The full
  multi-agent Send path is unchanged.

## 0.20.4 - 2026-07-16

### Fixed
- **Provider model selection no longer picks a model your key can't serve.**
  After adding a Gemini / OpenAI / Anthropic key, routing could select a bundled
  catalog id the account doesn't actually have, 404 it, and then fail over
  through several models before landing on a working one — a slow, confusing
  first run. `init()` now validates the official cloud providers against their
  own model list (`listModels`) and the selector skips any bundled id the
  provider didn't confirm, preserving benchmark ordering. Discovery is cached
  per key (so the hosted server, which builds a fresh router per request,
  validates once), time-boxed, and fully best-effort — offline or on error it
  falls back to today's behaviour. The rare not-found fallover is now bounded.
- **Hosted chat runs no longer stall on "artifact creation."** A task phrased as
  producing a file (e.g. *"Determine Flare KOD Pump Specifications"*) made a
  worker try to write a file — but the hosted app has no file-writing tool, so
  it looped and returned `_(incomplete: … stalled waiting for artifact
  creation)_`. A worker now only *requires* a verified file artifact when a
  file-writing tool (`file_write` / `file_edit` / `shell`) is actually
  available; otherwise its answer is the deliverable. Desktop/CLI (which have
  those tools) are unchanged.

## Cascade Cloud 0.6.2 - 2026-07-16

### Fixed
- **Razorpay billing now tolerates copy-pasted whitespace and is easier to
  diagnose.** `billingConfig` trims the key id / secret / plan id / webhook
  secret, so a trailing space or newline picked up while pasting into the deploy
  env no longer reaches Razorpay verbatim — that was surfacing as "Authentication
  failed" (key) or "The ID provided is invalid or could not be found" (plan),
  indistinguishable from a genuinely wrong value.
- The server now logs a one-line **billing boot diagnostic** — `configured —
  mode=test keyId=… planId="…" (len N)` — using only non-secret fields (the
  secret and webhook secret are never logged), and subscribe failures log the
  same (non-secret) mode + plan id so a misconfigured deploy is obvious.

## Cascade Cloud 0.6.1 - 2026-07-16

### Fixed
- **Multi-turn chat lost its context on every follow-up.** In hosted (and CLI)
  runs, only the complexity *classifier* saw the conversation history — the
  execution tiers received the bare latest message, so a short reply like "1",
  "yes", or "make it shorter" was run as a standalone task with no memory of the
  prior turn (e.g. "Completed subtask 1. Result: 1."). Recent history is now
  threaded into the root task for Simple / Moderate / Complex runs alike, so a
  follow-up is resolved in the context of the conversation. No-op for a
  conversation's first message and for the desktop path (which already stitches
  context in via its own continuation prompt and passes no history here).

## Cascade Cloud 0.6.0 - 2026-07-15

### Added
- **Session continuation between web and desktop ("open-and-continue").** Pick
  up a chat where you left off on the other device. On either surface, open
  **Continue elsewhere**, choose **Send this chat** to get a short one-time code
  (`XXXX-XXXX`), then enter it on the other surface under **Bring a chat here** —
  the transcript comes across and you keep going.
  - The cloud acts only as a **short-lived courier**, never a shared source of
    truth: the snapshot lives in memory with a **15-minute TTL** and is never
    stored durably. The code is the only bearer secret (unambiguous alphabet, no
    O/0/I/1/L), so the courier endpoints are unauthenticated — which is what lets
    the keyless desktop app use them — with their own tighter rate limits, an
    open **non-credentialed** CORS policy (the session cookie never travels
    there), and a 404 that doesn't distinguish "unknown" from "expired".
  - **Web:** a new **Continue elsewhere** control in the chat top bar. Redeeming
    a code seeds a **new cloud conversation** from the transcript, owner-scoped
    and ready to continue in the cloud.
  - **Desktop:** the same handoff from the session sidebar and the ⌘/Ctrl-K
    command palette. Sending hands off the active session; redeeming imports the
    chat into the local backend as a new session to continue with your own keys.

## Cascade Cloud 0.5.1 - 2026-07-15

### Added
- **On-device complexity classification (opt-in) to cut token use.** When the
  in-browser model is enabled, the app now classifies a prompt's complexity
  (Simple / Moderate / Complex) locally before sending the run, and the server
  **skips its own classifier LLM call**, starting from that verdict instead. It's
  only ever a hint: the orchestrator still applies its heuristic complexity
  floors and mid-run escalation, so a tiny model under-rating real work can't
  strand it on a cheap tier — and a pinned tier or a cold/unsure classifier
  falls straight through to normal server-side classification. Runs entirely on
  the user's device (WebGPU); nothing about the prompt leaves the browser for
  this step. Shared engine with the auto-titler — one model download.
  - Core: `CascadeRunOptions.complexityHint` lets any SDK consumer supply a
    pre-computed verdict and skip the classifier round-trip (benefits desktop too).

### Fixed
- **Mobile alignment & responsiveness.** The conversation sidebar no longer
  overflows the phone drawer (which clipped the right edge of the usage meter);
  modals cap their height and scroll on short viewports instead of running
  off-screen; the Upgrade plan cards stack to one column on narrow screens; and
  the message / code-block action buttons (copy, regenerate) are now reachable on
  touch instead of being hover-only.

## Cascade Cloud 0.5.0 - 2026-07-14

### Added
- **Razorpay recurring subscriptions.** The Upgrade page (Settings → Upgrade)
  now offers a real **Pro** subscription: Subscribe opens Razorpay Checkout for
  a recurring plan; a **signature-verified webhook** (`/api/billing/webhook`,
  HMAC-SHA256 of the raw body) flips the user's plan on `subscription.charged` /
  `activated` and reverts it on `cancelled` / `halted`; a **Manage** section
  shows the status + renewal date and a **Cancel** (at cycle end). All secrets
  live only in env (`RAZORPAY_KEY_ID` / `KEY_SECRET` / `WEBHOOK_SECRET` /
  `PLAN_ID`) — with them unset, billing reports "not configured" and the page
  falls back to the plan comparison. The client only ever receives the public
  key id + subscription id.
- The Upgrade page states plainly that **the desktop app is free, always** —
  Cascade Cloud is the hosted convenience.

## 0.20.3 - 2026-07-14

### Fixed
- **Multiple Azure deployments are now spread across tiers automatically**
  (desktop + cloud). With no benchmark data for opaque deployment names, the
  router used to hand the same "first available" deployment to every tier. It
  now infers a rough capability score from each deployment name (size/cost
  keywords + version) and assigns **strongest → T1, cheapest → T3** — so a setup
  like `gpt-5.4` + `gpt-5-mini` uses the mini for cheap worker tasks and the
  full model up top, staying fully automatic (no per-run picking).

### Cloud
- **Only the answer streams now.** The hosted chat streamed every node's output
  (planning, decomposition, background workers) before the final result, which
  flashed intermediate text and read as a runaway. It now streams only the
  presenter tier's output (the actual answer) and keeps a status chip up while
  the other nodes work.
- Settings toggles no longer let the knob overflow the track.

## 0.20.2 - 2026-07-14

### Fixed
- **Azure gpt-5 / reasoning deployments now connect** (desktop + cloud). They
  reject the classic `max_tokens` and a custom `temperature`, and predate the
  old default API version — so their availability probe failed and the run
  surfaced as **"No model available for tier T1"**. Now: the default Azure API
  version is **`2024-12-01-preview`** (override still respected); the OpenAI/
  Azure request path picks **`max_completion_tokens`** (omitting temperature)
  for reasoning-family models (`o1`/`o3`/`o4`, `gpt-5*`) and, for any deployment,
  **learns from the API's own error** and retries with the right shape,
  remembering it for the rest of the run; and the Azure availability probe treats
  a parameter complaint as **reachable** (the deployment exists) instead of
  marking the whole provider down.

## Cascade Cloud 0.4.1 - 2026-07-14

### Added
- **Configurable web-search backend.** The API-keys vault gains a **Web search**
  section to pick **Brave**, **Tavily**, or a self-hosted **SearXNG** URL. The
  key/URL is held in the browser (like your provider keys) and travels with each
  run, so the composer's **Web** toggle returns real search results instead of
  the keyless DuckDuckGo fallback. Unconfigured → unchanged (keyless fallback).
  Threaded through as `config.webSearch`, which the core `web_search` tool
  already consumes.

## Cascade Cloud 0.4.0 - 2026-07-14

A consolidated Settings surface and an opt-in, fully on-device conversation
titler.

### Added
- **Settings modal** (click your name, bottom-left): Account (name / email /
  plan), an on-device auto-title toggle, a Reduce-motion appearance control, and
  quick links to Skills / Memory / API keys / Upgrade, plus Sign out. The four
  separate sidebar footer buttons are folded into it.
- **On-device auto-titling (opt-in, off by default).** When enabled and the chat
  sits idle, a small model (WebLLM / Qwen2.5-0.5B) runs **in your browser** to
  name untitled conversations — nothing leaves your device, and it works offline
  after a one-time model download. It's capability-gated (needs WebGPU + enough
  RAM) and the engine/weights load lazily, so the app bundle is unchanged for
  everyone who doesn't turn it on. Unsupported or declined → the current
  first-message titles stay. New `PATCH /api/conversations/:id/title`
  (owner-scoped; doesn't reorder the recency-sorted list).
- **Reduce motion** appearance toggle — minimizes animations (honored via CSS
  and Framer Motion).

### Fixed
- A sub-modal opened from Settings (Skills, Memory, …) now renders above
  Settings' briefly-exiting backdrop instead of behind it, so its controls stay
  clickable.

## Cascade Cloud 0.3.1 - 2026-07-14

Production reliability fixes for the hosted app — hosted runs were failing to
produce answers, and the real reasons were being swallowed.

### Fixed
- **Rate limiter crashed behind Railway's proxy.** Every request carries an
  `X-Forwarded-For` header, and `express-rate-limit` threw
  `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` because `trust proxy` was unset — so
  rate-limited API routes 500'd. The server now trusts exactly one proxy hop.
- **Gemini runs returned "Task failed to complete successfully."** The Gemini
  provider read response text via the SDK's `chunk.text` getter, which logs a
  "non-text parts" warning and can return **empty** when the response also
  carries thinking/`functionCall` parts (as gemini-2.5 models do). The empty
  content stranded the complexity classifier and the T3 self-test, cascading to
  a generic failure. The provider now reads answer text from the response parts
  directly (skipping private "thinking" parts) — warning-free and reliable.
- **Real failures are no longer hidden.** A failed complexity classifier now
  logs the concrete reason instead of a bare "classifier unavailable"; a run
  that produces no completed work returns the partial output plus the actual
  reason(s) instead of "Task failed to complete successfully."; provider
  availability-probe failures (e.g. a misconfigured Azure deployment) are logged
  with why; and the cloud server logs full run errors (with stack) and forwards
  SDK diagnostics to its output.
- **`MaxListenersExceededWarning` on cancelable runs.** A multi-tier run fans one
  `AbortSignal` out to many tier/provider calls; the per-signal listener ceiling
  is now raised so the expected listeners don't trip Node's warning.
- **Provider dropdown was unreadable.** The API-keys provider `<select>` rendered
  near-white option text on the OS's light native popup. Selects now use
  `color-scheme: dark`, so option lists render dark with legible text.

## Cascade Cloud 0.3.0 - 2026-07-14

Run-explorer features for the hosted chat app, in the shipped ink + coral-glass
style, plus two token-waste fixes. Desktop is unaffected (the core prompt change
is byte-identical for the full tool set); Cascade Cloud redeploys on merge.

### Added
- **T1/T2/T3 run explorer.** Each assistant reply shows the tier that answered
  (T1 green / T2 amber / T3 violet), the model that served it, and a `/why`
  panel with the decision trail, delegation savings, and per-tier cost — all
  from the SDK's own `getDecisionLog()` / router stats (`run:why` over the
  socket; persisted so it re-renders on reload). A "saved $X" chip appears in
  the top bar when delegating below the top tier saved money.
- **Routing controls in the composer.** A routing-mode selector
  (Auto / Quality / Fast) biases Cascade Auto's quality↔cost knob, a tier
  picker pins the root tier, and a web toggle enables `web_search`/`web_fetch`
  for a run.
- **Custom Skills.** Create/edit/delete your own prompt-preset skills
  (name, description, instructions) alongside the built-ins, with a "used N×"
  usage badge; `POST/PUT/DELETE /api/skills`, owner-scoped. A custom skill's
  instructions drive the run and bump its usage counter.
- **Memory categories & search.** Tag persistent facts with an optional
  category and filter them in the Memory panel.
- **Tier mix · today.** A compact sidebar bar showing how the day's runs split
  across T1/T2/T3 (`GET /api/tier-mix`).

### Fixed
- **Runaway runs can now be stopped.** The send button becomes a Stop button
  while a run is in flight; it aborts the run via the SDK's `AbortSignal`
  (the run resolves with its partial output, which is saved and marked
  "stopped"). A socket disconnect also aborts, so a closed tab never leaves a
  run spending tokens.
- **No more "tool hope" on hosted runs.** Hosted chat now defaults to pure
  conversation with no tools registered (flip the composer's Web toggle to
  opt in). When no tool is registered, the T3 worker prompt drops its generic
  "use tools" line and the T2 planner drops its `peer_message` hint — so the
  model is never told to reach for a capability it doesn't have. Byte-identical
  with the full desktop tool set.

## Cascade Cloud 0.2.0 - 2026-07-12

A flagship-quality rebuild of the hosted chat app (`cloud/web` + `cloud/server`),
plus one core-SDK fix that stops hosted runs wasting tokens. Desktop is
unaffected (no version bump); Cascade Cloud redeploys on merge.

### Added
- **Multimodal image input.** Attach images to a message — file picker, drag-and-drop,
  or paste. Uploads go to a per-tenant, owner-scoped store (`POST /api/uploads`, ≤4
  images/message, ≤5 MB each, jpeg/png/gif/webp only) and are passed to the run as
  `ImageAttachment`s, which every provider adapter (Anthropic/OpenAI/Gemini) already
  understands. Thumbnails re-render in the transcript on reload. (Agent-generated file
  **downloads** are deliberately deferred to a sandboxed phase 2 — the composer says so.)
- **Skills (prompt presets).** Pick a persona per chat — General, Code reviewer, Research
  analyst, Writing editor, Brainstorm partner. The selected skill's system prompt is
  prepended to the run and remembered on the conversation. `GET /api/skills` exposes the
  catalog (system-prompt text never leaves the server).
- **Persistent memory.** A Memory panel to add/edit/delete facts about yourself
  (`GET/POST/PUT/DELETE /api/memories`, per-user). Saved facts are injected into every run
  so replies stay consistent across conversations.
- **Context & usage meter.** The sidebar shows runs-used-today vs. your plan limit and a
  per-conversation context gauge, with graceful "daily limit reached" / "context getting
  full" states.
- **Rebuilt chat surface.** Borderless assistant messages with syntax-highlighted code
  blocks (copy button), per-message copy/regenerate and cost, live tier-status chips
  ("Planning… / Coordinating… / Executing…"), a pill composer, collapsible sidebar with a
  mobile drawer, and blurred modal transitions — all on a neutral-ink + warm-accent dark
  palette.

### Core (SDK)
- **Worker & planner prompts now describe only the tools that are actually registered.**
  `T3_SYSTEM_PROMPT`/`T1_SYSTEM_PROMPT` hard-coded guidance for `run_code`, `pdf_create`,
  `peer_message`, and "create a file in the workspace" regardless of the tool set. On the
  hosted server — which enables only `web_search`/`web_fetch` — the model kept calling
  tools that don't exist and burning turns on tool-not-found errors. The tool lines are now
  emitted per registered tool, so a restricted embed drops them. **The full desktop tool set
  renders every line exactly as before (byte-identical), so desktop behavior is unchanged.**

## [0.20.1] - 2026-07-12

### Fixed
- **Desktop release builds failed on every platform:** `⨯ .../.dockerignore must be under .../app/` during "Package & publish installer". `app/package.json` carried a vestigial `"cascade-ai": "*"` dependency that nothing in `app/` actually imports (the desktop process loads the core via a direct file path, dev or packaged, never the bare specifier) — npm workspaces resolved it by symlinking `app/node_modules/cascade-ai` straight back to the repo root (since the root package is itself named `cascade-ai`). electron-builder's ASAR packager walks into that symlink and computes each file's path relative to `app/`; once this release added a top-level `.dockerignore` for the new Cascade Cloud deploy config, that computation had a file (`.dockerignore`) it could no longer place under `app/`, and crashed. Removed the unused dependency, which removes the symlink entirely. `cloud/server`'s equivalent `"cascade-ai": "file:../.."` dependency (used so it always runs against the local build rather than a stale/unpublished registry version) is replaced with a `"#cascade-ai"` private subpath import pointing at a symlink generated inside `cloud/server/vendor/` — Node's `imports` field requires in-package targets, and keeping this off the npm dependency graph entirely means it can no longer influence any other workspace's resolution.

## [0.20.0] - 2026-07-12

Cascade Cloud — a hosted, ChatGPT/Claude.ai-style chat experience at
`app.cascadeai.in`, reachable from the landing page. Two new workspaces,
`cloud/server` and `cloud/web`, ship the first version of this.

### Added
- **Sign in with GitHub or Google.** Standard authorization-code OAuth (no
  passport dependency); a CSRF `state` cookie guards the callback. A
  `CLOUD_DEV_BYPASS` dev-only login shortcut is available for local testing
  and is refused outside a real deployment.
- **Bring-your-own-key chat, with keys we never persist.** Every
  provider (Anthropic, OpenAI, Gemini, Azure, OpenAI-compatible) can be
  configured in the browser's KeyVault (localStorage-only). A key travels
  with each run request and is used in-memory for that run only — it is never
  written to our database or logs (see `db.ts`: there is no API-key column
  anywhere) — `createCascade` (never `runCascade`, which would
  merge machine-global credentials) runs the T1/T2/T3 orchestration scoped
  to safe tools only (`web_search`/`web_fetch` — no shell/file/git exist for
  a hosted run, via the new `tools.enabledTools` core allowlist) and a
  per-tenant scratch directory, streaming `stream:token`/`tier:status`
  events back over an authenticated socket.
- **Google Drive key sync (opt-in).** For Google-signed-in users, keys can
  be encrypted client-side (WebCrypto AES-GCM, PBKDF2 over a
  user-chosen passphrase — never sent anywhere) and synced through the
  `drive.appdata` hidden folder via a client-side-only Google Identity
  Services consent flow. The server and Google Drive itself only ever see
  ciphertext.
- **Entitlements.** Per-plan daily run caps and concurrent-run limits (free:
  20/day, 1 concurrent), checked before a run ever touches the database, plus
  an "Upgrade" panel showing today's usage and a Pro plan comparison
  ("coming soon" — Razorpay Subscriptions is a fast-follow, not in this
  release).
- **Landing page CTA.** The hero gains a "Launch Cascade Web" button to
  `https://app.cascadeai.in`.

### Fixed
- **`.github/workflows/static.yml` was publishing the entire repository to
  GitHub Pages**, not just the landing page. It now stages `index.html` and
  a `cascadeai.in` CNAME only.

### Core (SDK)
- **`tools.enabledTools?: string[]` allowlist** (`ToolsConfig`) — the one
  true core change the whole hosted flow depends on. When set, only the
  listed built-in tools are registered at all (shell/file/git have no other
  off-switch — `requireApprovalFor` still just gates them behind a click).
  Undefined preserves the existing full-tool-set default for every other
  consumer.

## [0.19.1] - 2026-07-12

### Fixed
- **Explicit Azure deployment pins on reasoning-family models failed with "provider not available or unreachable."** `AzureOpenAIProvider.isAvailable()`'s health-check ping used `max_tokens`, which o1/o3/gpt-5.x-class reasoning deployments reject (they require `max_completion_tokens`) — unlike real generation calls, which already retry with the right parameter. That single ping failure marked the whole `azure` provider unavailable, so every explicit `azure:<deployment>` override errored even though the deployment itself worked fine. The ping now retries with `max_completion_tokens` on the same error the generation path already handles.
- **A model addressed as `"azure:<deployment>"` (or any `"provider:id"` override) lost its real pricing/context/tool-support metadata.** The selector's dynamic-model fallback always synthesized a fresh $0/generic placeholder for a `"provider:id"` override instead of checking whether a model already registered under the bare id (e.g. an Azure deployment from `azureModelForDeployment`, or a discovered Ollama/OpenAI-compatible model) — silently discarding real cost tracking and capability flags. It now prefers the already-registered model when one exists.

Routing and efficiency round: Azure deployments become real selectable models,
model pickers go live, benchmark routing turns on by default, plans become
spec-driven so small models execute reliably without token explosions, and
web search works again.

### Fixed
- **Azure "endpoint unreachable" in the Models tab.** Azure existed internally only as a placeholder model with the literal id `azure` — configured deployments never surfaced anywhere, and multi-deployment setups all bound to the first resource. Each configured deployment is now registered as its own selectable model (id = deployment name) bound to its own resource/endpoint/key, and the Models tab lists them.
- **Web search works on default installs.** With no keyed backend configured, `web_search` depended entirely on scraping DuckDuckGo Lite with a regex that only matched double-quoted attributes (DDG emits single quotes), never unwrapped DDG's `uddg` redirect URLs, and sent a bot-like User-Agent. The parser is now quote/order-tolerant, unwraps redirects, uses a browser UA, and tries `html.duckduckgo.com` before Lite. Settings → Providers gains fields for SearXNG / Brave / Tavily backends (`tools.webSearch`).
- **Small builds no longer explode into the full hierarchy.** The v0.13.2 complexity floor sent ANY "build/create X" prompt with one scale-ish noun to Complex (3-5 managers × workers) — the main reason small tasks burned 2M+ tokens. The floor is now two-stage: multi-system builds still floor to Complex; a single-deliverable build floors Simple→Moderate only (one manager).
- **Tool results are bounded in worker context.** A worker re-sends its whole accumulated context on every loop iteration (up to 15), so one unbounded file read or chatty command multiplied into a token bomb. Tool results are now capped (head+tail, explicit elision marker) before entering context.

### Added
- **Spec-driven planning (openspec-style).** T1/T2 plans now give every subtask a self-contained spec slice: `files` (the exact paths it owns), `acceptance` (1-3 mechanically checkable done-criteria), and `contextBrief` (the ONLY background the worker sees). Workers execute from their slice alone — small/local models get unambiguous, minimal-context assignments; artifact verification uses the declared files deterministically instead of regex guesses; the self-test gate checks the acceptance criteria; and planners are instructed to RIGHT-SIZE (fewest sections/workers that cover the task).
- **Benchmark-value routing ON by default.** `cascadeAuto` (live benchmark scores × live pricing, per-task model selection) was documented as the headline feature but shipped off — "Auto" was just a static priority list. Now on by default; explicit per-tier pins are unaffected, and Settings → Advanced can disable it.
- **Live model lists for every provider.** The desktop Models tab previously used live discovery only for local endpoints; Google/Anthropic/OpenAI were stuck on a hardcoded set. All providers now list their discovered models (cloud catalogs via live listing, Azure deployments, local tags) with the curated list as fallback and a Custom… option.
- **Model-per-task visibility.** Every agent node now carries the model that actually served it (including Cascade Auto per-subtask overrides): shown in the Cockpit node detail panel, plus a "Models used" section in the Why panel.

## [0.18.0] - 2026-07-08

Fixes for the three problems reported from the v0.17.0 Linux AppImage, plus
the project knowledge graph surfaced in the desktop.

### Fixed
- **API keys and Azure deployments survive app restarts — permanently.** Credentials used to live only in the per-workspace `.cascade/config.json`, so pointing the app (or CLI) at a different folder silently "forgot" every key — the AppImage "forgets everything" report. Provider credentials (keys, Azure deployments, custom endpoints) now also live in a machine-global `~/.cascade-ai/credentials.json` (chmod 600, like Claude Code's `~/.claude/.credentials.json`): saved there on every settings save (desktop Settings, onboarding, CLI wizard, web dashboard), merged into whatever workspace config loads, shared by the desktop app AND the `cascade` CLI. A workspace config that carries its own key still wins (per-project override), and removing a provider removes it globally too.
- **Insights no longer shows "Invalid or expired token".** The desktop's embedded backend runs with auth disabled, but the auth middleware still verified any Bearer token it was handed — and the renderer always sends its Electron session token (random hex, not a JWT), so every desktop REST call 401'd. With auth disabled, an unverifiable token is now treated as anonymous. This also un-breaks session-transcript loads, export, rollback, and the diff review — all silently failing before.
- **Settings panel no longer grows past the screen.** Adding Azure deployments expanded the modal unbounded (no height cap, no scrolling) until the Save button was off-screen. The panel is now capped at 86% of the window height with a scrollable content area; header, tabs, and footer stay pinned.

### Added
- **Knowledge tab (Insights).** The project knowledge graph — the world-state facts workers learn and T1 folds into planning — is now visible: a searchable entity · relation · value table with provenance, per-fact delete, and a confirm-gated clear-all, so users can see and prune what the AI remembers about their project. Endpoints: `GET /api/knowledge`, `DELETE /api/knowledge/fact`, `DELETE /api/knowledge`.

## [0.17.0] - 2026-07-08

Eight desktop features in one round — run control, insight surfaces, and
workflow speed — plus a professional landing-page download.

### Added
- **Boardroom plan review in the desktop.** The `planApproval` setting existed in desktop Settings, but no desktop UI ever rendered the paused plan — the gate silently auto-approved because the embedded server never listened for `plan:approval-required`. Runs now pause in a proper boardroom modal: T1's proposed sections (with worker counts and descriptions), the reviewer critique, complexity, and estimated cost — approve, reject, drop individual sections, or send a steering note that makes T1 re-plan and re-ask. Unanswered plans still auto-approve after 2 minutes, so a closed window can't hang a run.
- **"Why?" run inspector.** Desktop parity for the CLI's `/why`: a slide-over panel (status-bar button or palette) with the run's decision trail — complexity verdict and classifier reasoning, model per tier, failovers, escalations — plus the delegation-savings receipt and a per-tier cost split. Live via the new `run:why` broadcast, with `GET /api/sessions/:id/why` covering panels opened after the fact.
- **Diff review with per-file revert.** A new changes modal (session row or palette) lists every file a session's runs touched as before/after Monaco diffs — "before" is the same pre-run snapshot `/rollback` uses — with a one-click **revert this file**, finer-grained than the all-or-nothing session rollback. Endpoints: `GET /api/sessions/:id/changes`, `POST /api/sessions/:id/revert-file` (restorable paths are limited to the session's own snapshots).
- **Live comms feed.** Desktop `/comms`: the bottom panel is now tabbed (Terminal · Comms), with a live ticker of PeerBus traffic — peer messages, broadcasts, file locks, barrier syncs — plus your `/steer` injections, timestamped with from → to routing.
- **Insights view (new activity-bar section)** with three tabs:
  - **Costs** — spend/tokens/sessions/runs stat tiles, a 30-day spend-per-day chart (with table toggle), most-expensive-sessions list, and a today-vs-daily-budget meter, aggregated by the new `GET /api/costs`. Desktop runs now also fold their usage into session metadata — previously only CLI runs recorded cost, so app sessions showed $0 forever.
  - **Schedules** — create/pause/delete cron-scheduled prompts (`GET/POST/PUT/DELETE /api/schedules`, cron-validated) with presets; the embedded server now runs a `TaskScheduler`, so schedules actually fire while the app is open and their runs stream into the Cockpit like any other.
  - **Audit log** — browse the encrypted, hash-chained audit trail (`GET /api/audit-chain`) with expandable payloads and a one-click **Verify integrity** that walks the whole chain (`GET /api/audit/verify`).
- **Command palette (Ctrl/Cmd+K).** Fuzzy jump (fuse.js) to any view or action — new chat, settings, terminal, comms, why-panel, diff review — and to any past session, which opens in Chat with its transcript loaded.
- **Smart landing-page download.** The hero's "download the desktop app →" GitHub redirect is now a proper download button: it queries the latest release once, detects the visitor's OS (and Mac architecture), and the click directly starts the right installer — with an all-platforms menu (dmg arm64/x64, exe installer/portable, AppImage/deb/rpm/pacman) and a graceful fallback to the releases page when the API is unreachable.

## [0.16.0] - 2026-07-04

A batch of real orchestration/desktop bugs found by using the app, plus the
landing-page redesign and Azure multi-deployment desktop support.

### Fixed
- **`t3Execution: 'sequential'` didn't actually serialize multi-section plans.** It was only consulted inside a single T2 section's T3 wave (`t2-manager.ts`) — the cross-section dispatcher in `t1-administrator.ts` always ran independent sections' T2 managers (and their T3 workers) in parallel via `Promise.all`, regardless of the setting. It now branches the same way, running sections one at a time when sequential mode is set.
- **Approval prompts reappeared after a T3 worker retry, even with autonomy on.** The retry path built a bare `T3Worker` and never wired it to the run's `PermissionEscalator` (unlike the normal first-attempt path) — so a retried worker always fell back to the escalator-less legacy approval flow, which has no concept of autonomous mode. Retries are now wired identically to first attempts.
- **A user's "Always" grant didn't cover sibling workers under a different T2 section.** Grants were cached keyed by `${parentT2Id}:${toolName}`, so only a worker under the *same* T2 manager benefited. USER- and T1-level "Always" decisions are now cached task-wide, covering every section in the run — matching what the permission model always intended.
- **T1's corrective replan could re-spawn already-completed sections.** After a failed review, the correction-plan prompt carried only the reviewer's one-line critique — no record of what actually finished — so a fresh `T2Manager`/`T3Worker` set had no way to know a section was already done beyond an unverified "don't repeat successful sections" instruction. The correction prompt now includes a structured summary of every completed/partial section's title and result.
- **`cascade` kept re-launching the setup wizard after it was already configured.** The "needs setup" check only exempted `ollama` from needing an API key, but the wizard itself treats `openai-compatible` (local servers) as key-optional too — so anyone using a local-only setup got re-prompted on every run. Also hardened the wizard to reject a blank submission on a field it labels "required" instead of silently saving an incomplete, unusable provider entry.
- **Files landed in the parent of whatever folder was open in Code view.** Opening a folder there only updated the file tree/terminal — task execution stayed pinned to whatever workspace the app was onboarded with, since nothing told the running backend a different folder was now open. Opening a folder in Code view now rebinds the backend's actual execution root immediately (no restart needed).
- **Switching chats while a run was in flight could corrupt the wrong session's transcript.** The global stream/completion handlers applied every event to "whatever's currently on screen" without checking which session the event actually belonged to — so a background run finishing (or still streaming) could overwrite an unrelated session's messages and Stop-button state. Events are now matched against the session/run actually being displayed or tracked before being applied.
- **The Cockpit graph showed nodes from every past run, in every chat.** Agent nodes were a single unscoped list, never cleared. Nodes are now tagged with their session, so a new chat starts with a clean graph and a resumed chat shows only its own history — plus a **"Clean up session"** button to hide (not delete) finished nodes.

### Added
- **Azure multi-deployment desktop Settings.** The Providers tab previously exposed one Azure key + one endpoint, unlike the CLI wizard which already supported multiple deployments. Settings now has a repeating deployment editor (label, endpoint, key, deployment name, API version) — each entry is its own Azure resource, matching what `.cascade/config.json` already supported.
- **Landing page redesign.** New visual identity: the product's real T1/T2/T3 tier colors are used as structural wayfinding (a "cascade spine" for how-it-works, category-colored feature groups), a `$ ls further-capabilities/` manifest replaces the old 20-card feature grid, and the page commits to a single considered dark theme.

## [0.15.2] - 2026-07-04

### Fixed
- **Windows desktop build actually works now (v0.15.1 didn't fully fix it).** v0.15.1 removed the explicit `isolated-vm` rebuild call, but the Windows job still failed the same way — because the CI script's `-w`/`--which-module` flag doesn't restrict what `@electron/rebuild` touches. It maps to `extraModules` ("also make sure to rebuild these"), while the module walker still scans and rebuilds **every** `prod`+`optional` native dependency it finds by default — and `isolated-vm` is an optionalDependency at the repo root, so the `better-sqlite3` rebuild step walked into it and tried (and failed) to link it against Electron's V8 regardless. Switched to `-o`/`--only`, the flag that actually sets `onlyModules` and filters the rebuild list — the only one that truly scopes it. Verified by reading `@electron/rebuild`'s own module-walker source, not just retrying.

## [0.15.1] - 2026-07-04

### Fixed
- **Windows desktop build works again.** The v0.15.0 release published npm and the macOS/Linux installers, but the Windows job failed rebuilding `isolated-vm` for Electron — a structural impossibility (isolated-vm cannot link against Electron's V8 on Windows, and Electron ABIs never match its Node prebuilds), and the step's `|| echo` guard was swallowed by a Windows/Git-Bash exit-code quirk. The desktop app now **deliberately neither rebuilds nor ships isolated-vm**: inside Electron, dynamic tools use the worker sandbox (the designed, tested fallback), while CLI/npm users on plain Node keep the hard V8 isolate via prebuilds. This returns the Windows build to its known-good path permanently.

## [0.15.0] - 2026-07-03

Release-pipeline repair plus a desktop bug round and four features.

### Fixed
- **The release workflow builds again (and desktop installers with it).** v0.14.0's `import type ... from 'isolated-vm'` made COMPILATION require the optional native module; on the Node 20 publish job it didn't install (no prebuild for that ABI), the DTS build failed with TS2307, and the dependent desktop-build matrix never ran — so v0.14.0 shipped with no npm package and no installers. The addon's surface is now declared locally (structural types + a non-literal dynamic import) so the build never needs the module present — proven by building with `node_modules/isolated-vm` removed — and the publish job runs Node 22. *(Note: the empty v0.14.0 GitHub release can be deleted; v0.15.0 supersedes it.)*
- **The Stop button survives switching views.** It was gated on component-local state inside the chat panel; views unmount on section switch, so leaving Chat/Code mid-run destroyed the only way to stop the AI. Run state now lives in the store, a persistent **STOP control appears in the status bar** from any view while a run is active, Cockpit-started runs now carry a sessionId (previously they couldn't be halted at all), and a run finishing off-view no longer leaves the transcript stuck "streaming".
- **Landing page: "View on GitHub" no longer overflows narrow phones.** The nav pill shrinks below 480px and goes icon-only below 380px; `overflow-x: clip` hardens the page against horizontal panning.

### Added
- **Tool-less models are handled efficiently.** Models without native tool-calling used to get the full per-parameter tool contract re-sent on every one of up to 15 agent-loop turns; now the full contract goes out once (re-sent only if the tool list changes) and later turns get a one-line reminder. Cascade Auto also steers tool-heavy subtasks toward tool-capable models.
- **Model capability details fetcher.** The OpenRouter catalog the router already downloads for pricing now also yields **context window, native tool support, and modalities** per model; Ollama models are asked directly via `/api/show` (replacing a hardcoded family allowlist); and unknown local models (custom .gguf on llama.cpp / LM Studio) get a **one-time cached tool-call probe**. Capabilities feed the text-tool gate, the ranker, and Cascade Auto — and show as badges (TOOLS/TXT/VIS/context size) in the desktop model picker.
- **Export / import chats and memories.** Export any chat from the session sidebar, or everything (optionally with *memories* = the project knowledge graph + identities) from **Settings → Data**, as a portable JSON bundle; import merges safely — chats come in as new sessions, newer facts win, existing identities are kept, API keys are never included. Bundles are plaintext; knowledge re-encrypts with the local key on import. REST: `GET /api/export`, `POST /api/import`.
- **Settings → Advanced.** Autonomy, plan approval, approval timeout, T3 execution mode, local concurrency, inference timeouts, reflection, Cascade Auto master toggle, force-tier, live benchmarks, dynamic-tool sandbox, facts extraction, tool creation/persistence, and telemetry — each written (allowlisted + validated) to the same `.cascade/config.json` the CLI uses. Budget tab gains daily/session caps, max tokens per run, and warn-at-%.

## [0.14.0] - 2026-07-03

Two deferred v0.13 designs land: a hard sandbox for generated tools, and a
queryable project knowledge graph.

### Added
- **Hard V8 isolate sandbox for dynamic tools.** LLM-authored dynamic tools ran in a `node:worker_threads` Worker — a robustness boundary (kill timeout, memory cap) but not a security one: the generated code still saw Node globals (`process`, `require`, `process.binding`). They now run in an `isolated-vm` hard V8 isolate whose global has **no Node built-ins at all**, reaching the host only through the same escalator-gated `callTool` and SSRF-guarded `fetch` bridges. Configurable via `tools.dynamicToolSandbox` (`isolate` | `worker` | `auto`, default `auto`). `isolated-vm` is an **optional** native dependency: if it's absent or can't build on a platform, tools transparently fall back to the worker sandbox — nothing breaks. The desktop app ships it rebuilt for the Electron ABI alongside `better-sqlite3`.
- **Project knowledge graph (world-state v2).** `WorldStateDB` gains a queryable `facts(entity, relation, value, source, timestamp)` store with **upsert-and-supersede** semantics (a newer observation replaces the old one rather than appending). A cheap, best-effort extraction pass distills each worker's output into facts (gated by `knowledge.factsExtraction`, default on; respects a subtask's local-only privacy tier). T1 now folds **relevant, deduped facts** into its planning prompt instead of replaying the entire linear log — falling back to the log only when no facts have been extracted yet. The existing encrypted linear log and key handling are unchanged.

## [0.13.2] - 2026-07-03

Desktop bugfix round — the app is usable again.

### Fixed
- **The chat reply streams live again.** After v0.12.23 the transcript only rendered tokens tagged `T1`, but a Simple run has no T1 (its root is a T3) and a Moderate run's root is a T2 — so on the common local-model routes nothing streamed and the answer only appeared at the very end. The run's actual root tier is now tagged `primary` and that stream renders, whichever tier it is (T3 for Simple, T2 for Moderate, T1 for Complex). The Moderate root T2 now streams its synthesis too.
- **Tool approvals actually prompt — and files actually get created.** The dashboard ran tasks with **no approval callback**, so the escalator instantly denied every dangerous tool (file writes, shell) and a "create a file" chat request silently produced nothing. The desktop/web app now shows an **approval modal** for `permission:user-required` (tool, target, and the escalation trail), and the backend parks the blocked run until you answer over the socket. Approve → the tool runs; Deny/timeout → it doesn't, with a clear line instead of silence.
- **Sessions load on connect.** The sidebar was empty until a run finished; the app now fetches the session list on connect and on `runtime:refresh`.
- **Genuinely complex tasks reach T1.** A small local classifier that under-rates a big multi-step build (returning Moderate or a garbled verdict) no longer strands it at T2 — an explicit build+scale signal floors the route to Complex so the full T1→T2→T3 hierarchy engages. Conservative on purpose; short/ambiguous prompts stay cheap.
- **Long model names no longer overflow the dropdown.** The model picker and settings tier selectors clip long ids/`.gguf` paths with an ellipsis and stay inside the viewport/modal instead of blowing the panel out.
- **"Check for updates" is calm during a release build.** While a new desktop build is still publishing, the Updates tab showed the raw electron-updater error (missing `latest.yml`/404). It now shows a plain "You're on the latest version, or a new release is still being published — check back shortly."
- **Landing page fits phones.** A decorative hero glow (600px, centred) pushed the page ~113px past a 375px viewport; it's now clamped so there's no horizontal overflow at any phone width.

### Added
- **Dangerous tools always reach you.** T2 and T1 no longer final-approve a dangerous tool on a small model's say-so — they attach an advisory verdict (approve/deny/unsure + reason) to the request's **escalation trail** and pass it up, so the topmost engaged tier surfaces it to you. Safe/read-only tools still auto-handle; autonomous mode still gates dangerous tools.
- **Manual tier override.** A tier selector in the Cockpit (Auto / T1 / T2 / T3), backed by `routing.forceTier` in config, pins a run's root tier and skips the classifier when set.
- **Per-node monitoring.** Click a node in the Cockpit to open a detail panel showing that tier's role, status, current action, live stream, and recent peer messages.
- **Peer-communication visualization.** When two workers coordinate (`peer:message`), the AgentGraph draws a transient animated edge between them (broadcasts pulse the source outward).

## [0.13.1] - 2026-07-02

### Fixed
- **v0.13.0 now compiles and its tests pass.** The architecture drop landed with 9 TypeScript errors (a duplicate `GenerateOptions` declared in the router while also imported from types; `featureTag` missing from the real `GenerateOptions`; `costByFeature` missing from `getStats()`/`resetStats()`; an invalid cast in the model-performance tracker; a `string | Record` passed to `RedactionLayer.redact`) and 4 failing tier tests (tiers called `router.getWorldStateDB()` unconditionally, crashing any router built without one — now optional calls). Also fixed `WorldStateDB.getFormattedState()` joining entries with a literal `\n` instead of newlines.
- **The T2-critic no longer spawns an entire manager hierarchy per critique.** Reflection previously created a full `T2Manager` (which decomposed the critique into its own T3 subtasks — costing more than the work under review), and those critic-spawned workers hit the reflection step themselves: unbounded recursion whenever `reflection.enabled` was on. The critic is now a single independent call routed to the T2-tier model — a different model than the worker it grades — keeping the verdict→revise loop, capped by `maxRounds`.

### Added
- **Per-path privacy tiers.** `privacy.paths` config (gitignore syntax): a subtask touching a `local-only` pattern is forced onto private models — Ollama, or an OpenAI-compatible endpoint on a loopback/private host — with a hard error rather than a silent cloud fallback, and its raw output is withheld from T2/T1 (they see only a success/fail status line).
- **Tamper-evident audit log.** The encrypted audit DB now hash-chains every entry to its predecessor; any edited, deleted, or reordered row breaks the chain. Verify with the new `/audit` CLI command or `GET /api/audit/verify`.
- **Live steering.** `/steer <text>` (CLI), a Steer bar in the desktop Cockpit during active runs, and `POST /api/inject` (previously a dead-end broadcast nothing consumed) now deliver corrections into running T3 workers, applied at their next agent-loop step and recorded in the audit log.
- **Session rollback in the desktop.** A rollback button on each session row (with confirmation) restores every file the session's runs touched to its pre-run snapshot via the new `POST /api/sessions/:id/rollback` — desktop parity with the CLI's `/rollback`.
- **Cost-per-feature surfaced end-to-end.** `CascadeRunResult.costByFeature` is now populated and shown in the desktop chat after each run (top features by spend), alongside the CLI cost panel wiring from v0.13.0.
- **Roadmap.** `docs/ROADMAP.md` captures the deferred designs: WASM/isolate sandboxing, knowledge-graph world state, IDE extensions, multi-plan branching.

## [0.13.0] - 2026-07-02

### Added
- **v0.13 architecture drop** (merged via #103): encrypted `AuditLogger` and `WorldStateDB` (`.cascade/audit_log.db`, `.cascade/world_state.db`), `RedactionLayer` applied at the T3→T2 boundary, feature-tag cost tracking in the router + CLI cost panel, T1 planning fed by the project world state, and a desktop Stop button (`session:halt`). Stabilized in 0.13.1.

## [0.12.23] - 2026-07-02

### Fixed
- **Multi-tier runs no longer garble the chat reply.** Every tier streams tokens (T1's final answer, plus each T2/T3 worker's raw output — `<think>` blocks included), and the app appended them all into the one visible assistant message, interleaving parallel tiers into nested/duplicated thinking tags and scrambled text. The transcript now only renders T1's stream; T2/T3 models still reason internally (nothing is disabled), and their progress stays visible through the AgentGraph's live action labels.
- **Markdown tables now render.** `react-markdown` v9 needs the `remark-gfm` plugin for pipe-tables; it was never installed, so `| a | b |` showed as plain text — in chat *and* in the docs viewer, which already had table styling that could never trigger. Both now parse GFM.
- **New chats become sessions again (and desktop sessions survive restarts).** Runs started from the desktop app were never written to the store — only the CLI persisted sessions — so the sidebar only ever showed CLI runs, and deleting those left it empty forever. Both desktop run paths (socket and REST) now persist the session, its messages, and its runtime status, broadcasting the update live.
- **File-explorer New File / New Folder / Rename actually work.** They used `window.prompt()`, which Electron silently no-ops — the dialog never appeared and the action died with it. All explorer inputs now use an in-app dialog, and Delete's confirm matches. Right-clicking *empty* explorer space (previously dead) now opens a root-scoped menu.

### Added
- **Mermaid diagrams.** ```mermaid fences in chat render as live diagrams (theme-aware, lazy-loaded), falling back to a highlighted code block while streaming or on a parse error.
- **Resume a past session.** Selecting a session (sidebar, or the new picker in the Code view's chat panel) loads its stored transcript and continues the conversation — the backend folds recent history into the next run's context.
- **Open Terminal Here.** Right-click a folder (or empty explorer space) to open the integrated terminal in that directory.
- **Collapsible session list.** The sidebar collapses to a slim rail (and auto-collapses when you pick a session); the Code view drops the full sidebar entirely in favor of the chat panel's session picker.

## [0.12.22] - 2026-07-01

### Fixed
- **Chat responses through a local (OpenAI-compatible) endpoint showed every word doubled.** `src/dashboard/server.ts` delivered `stream:token`/`tier:status` to the requesting client through two overlapping paths at once — `emitToSocket(socketId, ...)` *and* `broadcast(...)` (which is `io.emit(...)`, already reaching every connected socket including that one) in the chat-UI path, and `broadcast(...)` *and* `broadcastToRoom(...)` in the REST `/api/run` path. The single client-side listener appended both deliveries, so every streamed token — and therefore every word, and a model's `<think>` tags — appeared twice. Each event is now delivered exactly once, matching the sibling handlers (`session:complete`, `session:error`, `permission:user-required`) that were already correct.
- **Chat/Code responses were never rendered as markdown.** `ChatView`'s message bubble printed `message.content` as plain text; `react-markdown` and `react-syntax-highlighter` were already installed and used in the docs viewer but never wired into chat. Assistant messages now render through `ReactMarkdown` (bold, lists, tables, syntax-highlighted code fences).
- **A model's `<think>...</think>` reasoning was shown raw and inline with the answer.** Reasoning-tuned local models (and the synthetic `<think>` wrapping already used for Anthropic/OpenAI thinking deltas) had no frontend handling at all. It's now parsed out of the message and shown in a collapsed "Thinking" toggle, separate from the answer, with a live indicator while still streaming.

### Added
- **A chat panel in the Code view.** The Code tab had no way to chat at all. A resizable panel (drag its left edge) can now be toggled from the Code view's header, showing the same conversation/session as the Chat tab — reusing a new shared `ChatPanel` component instead of a second, divergent chat implementation.

## [0.12.21] - 2026-07-01

### Fixed
- **OpenAI-compatible endpoints with no API key configured were never discovered, no matter the base URL.** Local servers (llama.cpp / LM Studio / vLLM run without `--api-key`) need no key, so the OpenAI-Compatible provider's `apiKey` is legitimately left unset — but `OpenAICompatibleProvider`'s constructor called `super(config, model)` before applying its "not-required" fallback, and the underlying `openai` SDK throws in its own constructor whenever `apiKey` is undefined and `OPENAI_API_KEY` isn't set in the environment (which it never is on a desktop install). That exception was silently swallowed everywhere the provider gets constructed — the availability check and the real model discovery — so the Models tab showed the bare "endpoint unreachable?" placeholder with no further detail, even while a direct diagnostic probe (and `curl`/a browser) reached the very same endpoint successfully. This reproduced identically for `localhost`, a LAN IP, or a hostname, since the failure had nothing to do with the network target. The constructor now passes the same fallback key into `super()` so construction never throws. Model discovery for a configured OpenAI-compatible endpoint no longer depends on a separate, redundant reachability probe succeeding first, and the Models tab now surfaces a concrete reachable-but-not-yet-listed message instead of staying silent when a probe succeeds but no models were discovered.

## [0.12.19] - 2026-06-30

### Fixed
- **OpenAI-compatible endpoints no longer read as “unreachable” when they redirect or compress `/v1/models`.** Discovery reaches local endpoints through a Node `http`/`https` fetch shim that issued a single raw request — it did not follow redirects or decompress responses. So a healthy endpoint (e.g. `http://localhost:8900/v1`) whose `/v1/models` answered with a `307`/`308` redirect (trailing-slash canonicalisation, reverse proxy, http→https) made the availability check see a non-2xx status and skip discovery entirely, and a gzip/deflate/br response body made the JSON parse throw — either way the model dropdown stayed empty and showed “endpoint unreachable?”, even though a browser/curl reached the same URL fine. The fetch shim now follows redirects (IPv4-preferring, method/body preserved for 307/308) and transparently decompresses gzip/deflate/br (SSE chat completions still stream). The Settings → Models picker now surfaces the concrete probe reason (HTTP status / 0 models / error) instead of a generic “unreachable?” when discovery comes up empty.

## [0.12.18] - 2026-06-30

### Fixed
- **OpenAI-compatible endpoints now reached via Node'''s http stack.** Live debugging showed the endpoint returns 200 to the renderer and to a child Node process (no proxy set), yet the Electron main process could not discover it through global fetch (undici) or Chromium'''s net.fetch. The OpenAI-compatible provider now performs discovery and generation over Node'''s lower-level http/https modules (a streaming-capable fetch shim), which reaches loopback servers reliably from the main process. Reverted the earlier net.fetch routing. `listModels` also returns a direct endpoint probe (status + model count) so any remaining failure is concrete.

## [0.12.17] - 2026-06-30

### Fixed
- **Local model endpoints unreachable from the app despite working in a browser.** With a system proxy or VPN present, Chromium auto-bypasses `localhost`/`127.0.0.1` but the Electron backend'''s Node `fetch` does not — so llama.cpp / Ollama / vLLM / LM Studio endpoints read as “unreachable” (empty model dropdown) even though the same URL returns 200 in a browser. The backend now routes plain-HTTP (loopback / LAN) requests through Chromium'''s network stack (`net.fetch`) — the same path the renderer uses; HTTPS cloud APIs are unchanged. (Confirmed live: `listModels` returned cloud models but no OpenAI-compatible ones, while a renderer fetch to `/v1/models` returned 200.)

## [0.12.16] - 2026-06-30

### Fixed
- **OpenAI-Compatible endpoints a browser could reach but the app couldn'''t.** Discovery now probes `/v1/models` with a tolerant direct fetch instead of the OpenAI SDK'''s typed `models.list()`, which threw on non-standard local-server payloads (llama.cpp / LM Studio return an extra `models` array and filesystem-path model ids) and surfaced as a misleading “endpoint unreachable.” The model dropdown now populates from these servers.
- **Models dropdown could never fill when a tier was pinned to a not-yet-discovered model.** `listModels` no longer aborts when a pinned tier override can'''t resolve — it returns the discovered models anyway. The real discovery error is now logged instead of swallowed.

## [0.12.15] - 2026-06-27

### Fixed
- **Local endpoints over `localhost` no longer read as “unreachable.”** Node prefers IPv6 (`::1`) for `localhost`, but local model servers (llama.cpp / Ollama / vLLM / LM Studio) bind IPv4 (`127.0.0.1`) by default — so an endpoint your browser and curl reach appeared offline from the app (empty model dropdown, “endpoint unreachable”). Cascade now forces IPv4 resolution process-wide and rewrites a literal `localhost` host to `127.0.0.1` for the OpenAI-Compatible and Ollama providers.

### Changed
- **Richer Code empty state.** With no folder open, the Code tab shows an illustrated prompt with a prominent **Open Folder** button and a **Recent folders** list instead of a single line of text.

## [0.12.14] - 2026-06-27

### Fixed
- **OpenAI-Compatible / Ollama model picker now lists the endpoint’s real models.** In Settings → Models, choosing an OpenAI-Compatible (vLLM / llama.cpp / LM Studio) or Ollama tier auto-fetches the endpoint’s `/v1/models` and offers them as a dropdown instead of requiring a hand-typed id. Picking the exact id the server reports fixes the “could not connect” caused by a typed id (e.g. a `.gguf` filename) not matching what the endpoint serves. A refresh button re-discovers on demand, a “Custom…” option keeps manual entry, and the list refreshes after Save — no backend restart needed (discovery already runs per run).

## [0.12.13] - 2026-06-27

### Added
- **Usable code editor.** The Code tab is now a working editor: **Open Folder** (browse any folder, not only a Cascade run), **Save** with `Ctrl`/`Cmd`+`S` (writes to disk, with a dirty-dot indicator), **tabs** for multiple open files, a right-click **context menu** in the file tree (new file, new folder, rename, delete-to-trash), and **search across files** (a workspace-wide text search whose results jump to the matching line). Backed by an expanded file bridge (`writeFile`, `mkdir`, `createFile`, `rename`, `delete` via OS trash, `search`).

## [0.12.12] - 2026-06-27

### Added
- **Midnight theme.** A new selectable appearance preference (Settings → Appearance) applying the deep-navy + violet "Cascade design" palette. System / Light / Dark are unchanged; Midnight is a renderer-only palette (native window chrome follows Dark) and persists across launches like the other preferences.

## [0.12.11] - 2026-06-26

### Added
- **Providers settings tab with editable endpoints.** The Settings → Providers tab now exposes an **OpenAI-Compatible** entry (API key + **Base URL**, e.g. `http://localhost:8000/v1`) so you can point Cascade at vLLM / llama.cpp / LM Studio / any OpenAI-compatible server, and an editable **Ollama endpoint** (default `http://localhost:11434`). Endpoints persist to the provider config via the `getSettings`/`updateSettings` IPC and are picked up live by the backend.

## [0.12.10] - 2026-06-26

### Fixed
- **Terminal crashed the view with "process is not defined."** `TerminalPanel` called `process.cwd()` in the renderer, where `process` doesn't exist. It now passes a safe default cwd to the PTY.
- **Chat responses showed only the latest word.** Streamed tokens are deltas, but the store *replaced* the message on each token (and both App and Chat listened, which would double an append). The store now appends, and only the global handler streams — so replies accumulate correctly.

### Changed
- **Chat model is decoupled from the tiers.** The Chat model picker now uses its own selection (`activeModel.chat`) instead of overwriting the T1 tier, so picking a chat model no longer changes your T1/T2/T3 configuration or the status bar.
- **Cockpit prompts are no longer invisible.** Sending from the cockpit now records the prompt in the shared transcript — shown inline in the cockpit and mirrored into the Chat view (with the streamed reply) — instead of clearing with no trace.

## [0.12.9] - 2026-06-26

### Fixed
- **Cockpit/chat prompts vanished silently on failure.** A run that errored before any tier spawned disappeared with no feedback because the app handled `tier:status` but not `session:error`. The app now surfaces run failures in a dismissible banner (and clears it on success), so you see *why* a run failed instead of the prompt just clearing.
- **"Check for Updates" reported the updater as unavailable in the installed app.** `electron-builder` excluded all of `node_modules` except `node-pty`, so `electron-updater` was never packaged and `require('electron-updater')` threw. The packaging now includes every production dependency (excluding only the `cascade-ai` workspace package, shipped separately as `cascade-core`).
- **Ollama was absent from the model picker** when no local models were discovered. The picker now always offers Ollama quick-picks (plus the existing free-text model id / `.gguf` field), and still prefers the live-discovered list when Ollama is running.
- **CLI/desktop didn't show model "thinking".** The Anthropic provider rendered `<think>…</think>` from `thinking_delta` events but never requested extended thinking. It now enables extended thinking for the 4.x reasoning models (Opus 4 / Sonnet 4) with the required `temperature = 1` and a safe `budget_tokens`; other models are unchanged.

## [0.12.8] - 2026-06-23

### Fixed
- **Packaged desktop app was permanently "offline" (and Settings/save/model lists all failed).** The embedded backend kept every dependency external but only `better-sqlite3` was shipped, so it crashed at the first `require('glob')` during config load and never started. The desktop now embeds a self-contained `desktop-core` bundle (all JS deps inlined; only native/optional modules stay external), so the backend actually starts. The npm CLI build is unchanged.
- **OpenAI-compatible (llama.cpp / LM Studio / vLLM) endpoints were never usable.** They have no fixed model catalog, so the provider was never detected as "available", its models couldn't be selected, and a configured local model couldn't resolve to it. The router now synthesizes a seed so these endpoint-configured providers are detected and their models discovered.
- **Local `.gguf` model mislabeled as Ollama.** With both `ollama` and `openai-compatible` configured, a configured model id with no provider prefix (e.g. `gemma-4-12b-it-Q4_K_M.gguf`, including a full `C:\…\model.gguf` path) was attributed to Ollama. Now the OpenAI-compatible endpoint's models are discovered at init for exact-id resolution, and the heuristic recognizes a `.gguf` / filesystem-path id (POSIX or Windows) as OpenAI-compatible. Ollama `family:tag` ids still resolve to Ollama. Added regression tests.
- **Trivial prompts (e.g. "who are you") triggered the full multi-agent build.** Self-identity/capability questions weren't treated as conversational, and the complexity classifier parsed only the first token of the reply — so a chatty local model's preamble fell through to `Complex`. Now such prompts short-circuit to Simple, and an unparseable classifier reply defaults to the cheap route, never `Complex`.
- **OpenAI-compatible API key was labeled "required".** Local servers need no key; the CLI setup now marks it optional (empty was already accepted).
- **Download page linked the wrong Windows file.** It surfaced whichever `.exe` came first (the portable app); it now lists the installer (recommended) and the portable separately.
- **Linux `deb`/`rpm`/`pacman` packaging failed** with "Please specify project homepage". Added the `homepage` + `license` metadata fpm requires, so the release now builds all Linux installers (and Arch `pacman`) alongside the AppImage.

### Added
- **Desktop chat model picker shows your real models.** It now lists the actual discovered models (Ollama tags, OpenAI-compatible/llama.cpp models, cloud catalog) grouped by provider, with a free-text entry to type any model id or `.gguf` path — works even when the live backend is unavailable.

## [0.12.7] - 2026-06-23

### Fixed
- **Desktop app stuck "offline" / could not chat.** The desktop Socket.IO client used the default parser while the embedded dashboard server encodes packets with `socket.io-msgpack-parser`, so the handshake never completed. The client now uses the matching parser (as the web dashboard already did).
- **Desktop Settings "Save" did nothing when the backend failed to start.** The shared Cascade config now loads independently of (and before) the dashboard server, so API keys, per-tier models, and budget always persist — even when the socket backend is unavailable. The status bar shows a tri-state (connected / reconnecting / offline · retry) with one-click backend restart.
- **Help/tour panel could not be closed.** It was anchored to the viewport and overlapped the draggable title bar, which swallowed the close click. It is now anchored to the content area and also closes via Escape or click-outside.

### Added
- **System-aware light/dark theming (desktop).** A JetBrains Fleet / Xcode-inspired palette with `System` / `Light` / `Dark` preference (follows the OS by default), persisted and applied across the app, Monaco editor, and terminal. Choose it in Settings → Appearance.
- **In-app self-update (desktop).** Settings → Updates shows the current version, a Check for Updates button, live download progress, and Restart & Install. Background auto-update on launch is retained.

### Changed
- **Cross-platform desktop installers.** The release now builds macOS `dmg` + `zip` (x64/arm64), Windows `nsis` + `portable`, Linux `AppImage` + `deb` + `rpm`, and Arch Linux `pacman`, with auto-update manifests.

## [0.12.6] - 2026-06-21

### Fixed
- **Cost & savings always showed $0.00.** Configured per-tier model overrides (and any current model id missing from the bundled catalogue, e.g. `claude-sonnet-4-6` / `claude-opus-4-8`) resolved to zero pricing, so total cost and "saved vs all-T1" both read $0. The catalogue now includes the current Claude model ids, and cost calculation falls back to catalogue pricing by model id whenever a `ModelInfo` arrives without it. Local models stay $0 as intended.
- **Workers ran sequentially even when independent.** T1 flagged two sections as "overlapping" if they shared even one keyword and then chained *all* flagged sections into a single sequential line — collapsing parallelism for tasks where most sections mention common words ("code", "test"). Overlap now only injects a duplication warning for soft overlap; it serializes a *single pair* only on strong overlap (≥3 shared keywords and ≥60% of the smaller set).
- **Dependency deadlocks.** When a worker's dependency failed or timed out it returned ESCALATED without publishing a terminal status, so each dependent then waited out the full 120s peer timeout — stacking into an apparent deadlock. Workers now publish a terminal status on dependency-wait early returns (dependents unblock immediately), and the dependency wait is bounded to 60s.

### Changed
- Added regression tests for catalogue-pricing fallback and the section-overlap heuristic.

## [0.12.5] - 2026-06-21

### Fixed
- **Desktop: API keys could not be saved from Settings.** The Settings panel saved only over the Socket.IO backend and silently no-op'd whenever that backend was offline. Saving now goes through a backend-independent Electron IPC path (`cascade:updateSettings` / `cascade:getSettings`), surfaces errors instead of failing silently, and refreshes the per-provider "key set" indicators after saving.
- **Desktop: onboarding dropped the OpenAI-compatible / Azure Base URL.** It was collected during onboarding but never persisted; it is now threaded through `setConfig`.
- **CLI: wrong `--version` and a spurious "Stale build" warning on every run.** `CASCADE_VERSION` was a hardcoded literal that had drifted from `package.json`; it is now injected from `package.json` at build time, so the compiled bundle's version can no longer drift.

### Changed
- **Build: externalize optional native modules.** `tsup` now marks `keytar` and `node-notifier` as `external`, so the bundle (also shipped as the desktop `cascade-core`) builds even when those optional native binaries are absent.

## [0.12.4] - 2026-06-21

### Added
- **Per-tier provider + model selection (CLI & desktop).** Each tier (T1/T2/T3) can now bind to a specific provider *and* model, with `Auto` letting routing pick. The desktop Settings → Models tab gained a provider dropdown beside each tier's model picker, and the CLI gained `cascade models set <tier> <provider:model|auto>` / `cascade models unset <tier>`. Both write to the same workspace config, so the choices are shared. Routing already understood the `provider:model` override syntax; `auto` is now treated as "no override" everywhere.
- **In-app animated tour.** The Help panel's *Watch* tab no longer shows a "Tutorial video coming soon" placeholder — it plays a self-contained, auto-advancing animated walkthrough (`AnimatedTour`) driven by each context's existing tour steps, with play/pause, prev/next, restart, and a progress bar. A rendered HyperFrames video still takes precedence once a `VIDEO_ID` is populated.

### Fixed
- **Chat could not send in the packaged app.** The desktop `main.ts` constructed `DashboardServer` with the wrong arguments (`{ port, token }` instead of `(config, store, workspacePath)`), so the backend threw on startup, the Socket.IO connection was never established, and the send button stayed permanently disabled. The backend is now wired correctly through `ConfigManager`/`MemoryStore` on a private loopback port.
- **Packaged backend missing its database engine.** `better-sqlite3` (kept external by tsup, as native modules can't be bundled) was never shipped, so the backend crashed on launch. It's now copied into the core's resource `node_modules` (with `bindings`/`file-uri-to-path`) and rebuilt for the Electron ABI in CI.
- **Onboarding re-appeared on every launch.** `electron-store` was never installed/bundled, so `require('electron-store')` always threw and fell back to an in-memory map wiped on each launch — `onboarding_done` never persisted. Replaced it with a dependency-free JSON file in `userData`.
- **Settings → Save did nothing.** The backend mutated config only in memory and never wrote it back; the modal also never pre-loaded existing values. `config:update` now persists to the workspace config file, and the panel pre-fills current per-tier models, budget, and which providers already have a key (keys are never echoed back).
- **Provider keys never reached the backend.** Onboarding/Settings keys were written to the system keychain (also unbundled) while the backend read the Cascade config — a dead end. Keys now flow into the shared workspace config the backend actually uses, with `google → gemini` and `groq → openai-compatible` mapped correctly.

## [0.12.3] - 2026-06-21

### Fixed
- **Windows desktop build failure (VS 18 / 2026).** The `windows-latest` GitHub Actions runner now resolves to the `win25-vs2026` image which ships Visual Studio 18 (2026). Both `node-gyp` and `@electron/node-gyp` only recognise VS major versions 15–17 (2017–2022); VS 18 returns `versionYear: undefined` and the build aborts with "could not find VS 2017 or newer". Pinned the Windows matrix entry to `windows-2022` which ships VS 17 (2022) and is fully supported by all current node-gyp/node-pty toolchains.

## [0.12.2] - 2026-06-21

### Fixed
- **Windows desktop build failure.** The `node-pty` rebuild failed because `@electron/rebuild@3.6.x` (and electron-builder's bundled copy) depend on `node-gyp@9.4.1`, which can no longer detect Visual Studio 2022 on the CI runner ("Could not find any Visual Studio installation to use"). Upgraded `@electron/rebuild` to `^3.7.2`, which uses the Electron-maintained `@electron/node-gyp` fork with current VS 2022 detection, and set `npmRebuild: false` in `electron-builder.yml` so packaging reuses the binary from the explicit rebuild step instead of recompiling it with electron-builder's older bundled `node-gyp`.

## [0.12.1] - 2026-06-21

### Fixed
- **node-pty crash in packaged app.** Moved `node-pty` from `devDependencies` to `dependencies`, added `asarUnpack` for `**/*.node` and `node_modules/node-pty/**` in `electron-builder.yml`, and added an `@electron/rebuild` step in the `build-desktop` CI job so the native binary is compiled for the target Electron ABI before packaging.
- **Chat view gets no response.** The frontend emitted `cascade:run` over Socket.IO but the backend had no listener. Added `onCascadeRun` + `emitToSocket` to `DashboardSocket` and wired a full Cascade run in `DashboardServer` that streams tokens back to the originating socket and emits `session:complete`.
- **ModelPicker dropdown clips above the window.** Changed `bottom: '100%'` → `top: '100%'` so the list opens downward from the header. Added `maxHeight: 280` + `overflow-y: auto` so all models are reachable. Fixed `ChatView` which was passing `tier="t1"` (non-existent prop) instead of the correct `value` / `onChange` pair; added `setActiveModelT1` Redux action so model selection persists to the store.
- **Expanded provider + model lists.** Onboarding now shows 7 providers: Auto (Smart Routing), OpenAI, Anthropic, Google Gemini, Groq, OpenAI-Compatible (Azure / Mistral / LM Studio / Together…), and Ollama. Auto and Ollama skip the API key step; OpenAI-Compatible shows a Base URL field; the provider list is scrollable so the card never overflows. `ModelPicker` gained Auto, GPT o1/o3-mini, Llama 3.3 70B (Groq), and Mixtral 8×7B (Groq) entries.

## [0.12.0] - 2026-06-20

### Added
- **Session sidebar.** A 240px panel between the activity bar and main content shows the live session history pulled from the backend via the `runtime:update` Socket.IO event. Each row displays a status dot (green for ACTIVE), session title, latest prompt preview, and a relative timestamp. Clicking a row emits `leave:session` + `join:session` to switch context; hovering reveals a delete button that calls `DELETE /api/sessions/:id`.
- **Tab bar.** A 35px strip above the main content tracks open files (Code view) and active sessions as typed tabs. Tabs have type-specific icons (`FileCode` for files, `Cpu` for sessions), a dirty-state indicator (•), and a close button (×). Clicking switches the active tab; the view routes accordingly.
- **First-run onboarding.** When no provider API key is configured (`cascade:getConfig` returns `onboardingDone: false`), the app renders a full-screen onboarding flow: welcome / provider selection (OpenAI · Anthropic · Google · Groq · Ollama) / API key entry with visibility toggle / workspace directory picker / done animation. Keys are written to the system keychain via `keytar`; the workspace is persisted in `electron-store`. A new `cascade:setConfig` IPC handler + `selectDirectory` dialog are added to `main.ts` and `preload.ts`.
- **◈ logo mark.** The title bar brand mark changed from a solid "C" square to the ◈ (U+25C8) symbol, matching the Claude Design reference.

### Changed
- **Catppuccin Macchiato-inspired palette.** All design tokens shifted to a deeper, bluer palette: `--bg-base #06080f`, `--bg-surface #0f1117`, `--bg-raised #131520`, borders `#1a1d2e`, text `#cdd6f4` (lavender), accent violet `#7c6af7`, T2 lightened to `#b87fff`, T3 deepened to `#00d4e8`, success green `#22d47a`. All 31 components read `var(--…)`, so the palette propagates automatically.
- **Title bar** height 40px → 38px; background updated to `--bg-surface`; Windows titleBarOverlay updated to match.
- **Activity bar** width 52px → 48px; active indicator rail 3px → 2px; button chip 40×40px → 32×28px; inactive icon color dimmed to `--text-dim`.
- **Status bar** height 24px → 22px; background `#0b0d15`; connection dot uses new `--success` color.
- **Cockpit.** Agent graph background replaced with a CSS dot-grid (`radial-gradient` at 22px spacing); header shrunk to 35px; task input bar height set to 50px with `#0f1117` background.
- **Agent graph** tier colors updated: T2 `#b87fff`, T3 `#00d4e8`; node fill `#131520`; edge and progress bar colors updated accordingly.

## [0.11.1] - 2026-06-20

### Added
- **Branded app icon.** Replaced the placeholder with a 1024×1024 "cascade-C" monogram — five stacked bars cascading violet (`#8b7cf9`) → cyan (`#3ec9d6`) on a deep charcoal (`#0a0a0d`) background, matching the app's design tokens. The icon is generated deterministically by `app/build-icon.cjs` (pure Node, no deps) via `npm run gen:icon -w app`, and `electron-builder.yml` now sets explicit `mac.icon` / `win.icon` (alongside `linux.icon`) so every platform installer carries the mark.
- **Custom title bar.** The window is now frameless (`titleBarStyle: hidden` / `hiddenInset`) with a themed, draggable title strip drawn in the renderer (`TitleBar.tsx`) carrying the Cascade brand mark, name, and a live connection dot. Native window controls are themed to the dark palette via `titleBarOverlay` on Windows/Linux and inset traffic lights on macOS.

### Fixed
- **Removed the unstyled native menu bar.** The default OS `File / Edit / View / Window / Help` menu bar clashed with the dark UI. It's now hidden (`autoHideMenuBar`), with a role-based application menu kept only so standard keyboard shortcuts (copy/paste/undo, reload, devtools, zoom, quit) keep working.
- **No more endless "Reconnecting to Cascade backend…" banner.** When the embedded backend fails to start in a packaged build, `main.ts` left `backendPort` set, so the renderer retried a dead port forever. It now resets `backendPort`/`authToken` so the app shows a clean offline state. The `extraResources` filter also now includes `**/*.node`, so the bundled `keytar` native addon ships in the installer — a likely cause of the backend failing to load.

## [0.11.0] - 2026-06-20

### Changed
- **Desktop app deep redesign.** Reworked the Electron app's visual identity around an evolved, dark-mode-first design-token system in `app/index.html` — a cooler layered neutral ramp, a primary violet + secondary cyan accent, per-tier identity colors (T1 amber · T2 violet · T3 cyan), semantic success/warn/danger/info tokens, an elevation + radius scale, and refined focus, selection, and scrollbar styling. Every view reads these tokens, so the new palette propagates consistently across Cockpit, Chat, Code, Settings, and the help panel.
- **View-by-view polish.** Tier-colored agent graph nodes with live status dots and progress bars, a tier legend and richer empty states in the Cockpit, refined chat message bubbles with a streaming cursor, gradient send/save actions with hover affordances, an explorer header in the Code view, a blurred settings modal, and lucide-icon thumbs for session rating. No orchestration, socket, IPC, or routing logic changed — presentation only.

### Fixed
- **Landing page now scales on mobile.** The marketing `index.html` no longer overflows on phones: the 4-column complexity table scrolls horizontally inside a wrapper instead of crushing, a new sub-480px breakpoint stacks the hero/CTA/download buttons full-width, reduces hero padding and headline sizes, reflows the T3 worker grid to two columns, and tightens card and table padding. Hero eyebrow version string refreshed to the current release.

## [0.10.4] - 2026-06-20

### Fixed
- **Desktop installers now attach to the GitHub Release.** The `build-desktop` job built the DMG/EXE/AppImage correctly on every runner, but each upload was skipped with `existing type not compatible with publishing type (existingType=release publishingType=draft)`. The release job publishes a non-draft GitHub Release, while `electron-builder` defaults to `releaseType: draft` and refuses to publish into a mismatched existing release. Setting `releaseType: release` in `app/electron-builder.yml` makes the installers and `latest*.yml` auto-update metadata attach to the release as intended.

## [0.10.3] - 2026-06-20

### Fixed
- **Release pipeline lockfile.** `electron-updater` was added to `app/package.json` in v0.10.2 but `package-lock.json` was not regenerated, causing `npm ci` to fail in CI. Lockfile updated so `npm ci` resolves all transitive deps cleanly.

## [0.10.2] - 2026-06-20

### Added
- **Adaptive learned routing.** Cascade Auto now tracks which models perform best per task type in `~/.cascade/model-perf.json` — a file that survives updates and grows over time. Explicit user ratings via `/rate good|bad` CLI command (or thumbs-up/down in the desktop app) carry 3× weight vs. auto-detected outcomes, letting the routing graph learn fast from real feedback.
- **`cascade stats` command.** Prints a per-task-type model ranking table from accumulated routing history. Shows success rate, sample count, and average cost so you can see exactly what the router has learned.
- **Desktop auto-updater.** The Electron app now checks for new GitHub releases on startup via `electron-updater` and shows a system notification when an update is available or downloaded.
- **Settings panel.** Gear icon in the activity bar opens a modal with three tabs: API Keys (Anthropic / OpenAI / Google), Model Defaults (T1/T2/T3 per-tier dropdowns), and Budget & Bias (max cost per run, routing bias radio).
- **Reconnection status banner.** An amber strip appears at the top of the main area when the desktop app loses its backend connection, replacing silent failures with a clear visual cue.
- **React error boundary.** Uncaught render errors now show a recovery screen with the error message and a Reload button instead of a blank white page.

## [0.10.1] - 2026-06-20

### Fixed
- **Desktop-app release pipeline.** The 0.10.0 release workflow failed at `npm ci` because the
  new `app` workspace pulled in `react-joyride`, whose React 15–18 peer range conflicts with
  React 19. Replaced `react-joyride` with a built-in, dependency-free walkthrough overlay
  (removing the React 19 `findDOMNode` runtime risk at the same time), regenerated the lockfile
  to include the `app` workspace, and wired `electron-builder` into the `build-desktop` job with
  auto-generated app icons so the macOS/Windows/Linux installers (and auto-update metadata) attach
  to the GitHub Release correctly.

## [0.10.0] - 2026-06-20

### Added
- **Cascade AI Desktop App.** Purpose-built Electron application with three switchable
  view modes: Cockpit (live agent orchestration graph + task input), Chat (conversational
  multi-agent interface with streaming), and Code (file tree + Monaco editor + agent diffs).
  Includes a built-in terminal (xterm.js + node-pty), system tray, desktop notifications
  for escalations and completions, and auto-updater via GitHub Releases.
- **Contextual help system.** Every UI surface has a `?` button that opens a slide-in panel
  with three tabs: Watch (HyperFrames video tutorials), Tour (interactive walkthrough),
  and Docs (searchable markdown reference with syntax highlighting).
- **Desktop installer CI.** Release workflow now builds and attaches macOS (.dmg),
  Windows (.exe), and Linux (.AppImage) installers to every GitHub Release automatically.

## [0.9.7] - 2026-06-20

### Added
- **Cascade Auto per-T2-manager model routing.** When `cascadeAuto` is enabled, each T2 manager
  now independently selects the benchmark-best model for its section type (coding, writing,
  analysis, …) — matching the per-subtask routing T3 workers already had. Concurrent T2 managers
  handling different section types will automatically use different models.

## [0.9.6] - 2026-06-16

Tool-sandbox hardening for runtime tool generation. LLM-authored tool code is now treated as
untrusted end-to-end: isolated execution, mandatory approval, and re-validated persistence.

### Security
- **Generated tools now run in a worker thread, not `node:vm`.** `node:vm` was never a security
  boundary (its `timeout` can't stop async runaway, code shared the main heap, and a throw could take
  down the TUI). Execution moved to `node:worker_threads` (built-in — no native dependency), giving an
  **enforceable kill timeout** (`worker.terminate()`, verified terminating an infinite loop in ~600 ms),
  a memory cap (`resourceLimits`), and crash containment. Cascade's privileged objects (registry,
  router, the permission escalator) stay on the main thread; the worker reaches them only through a
  message bridge whose `callTool` path is escalator-gated and whose `fetch` path stays SSRF-guarded by
  `safeFetch`. Timeout is tunable via `CASCADE_DYNAMIC_TOOL_TIMEOUT_MS`.
- **Dangerous tool calls now default-deny.** A generated tool that calls a dangerous tool (`shell`,
  `file_write`, `file_delete`, …) when no approver is wired is now **denied** instead of executing
  unguarded. The escalator is resolved **lazily at call time**, so tools registered before the per-run
  escalator exists (persisted at init, received from a peer) are still gated.
- **Persisted/peer tools load as untrusted and re-validated.** `.cascade/dynamic-tools.json` entries
  (and peer-broadcast specs) are re-checked on load and marked **untrusted**, so any dangerous action
  always **re-escalates** to you (`forceReprompt` bypasses the session approval cache) — a tool authored
  in a prior, possibly prompt-injected, run can no longer silently re-arm. New `persistDynamicTools`
  config (default `true`) disables persistence entirely when set to `false`.

### Tests
- `src/tools/tool-creator.test.ts` grows to 16 cases — worker compute, infinite-loop kill, default-deny
  with the dangerous op confirmed not to run, lazy-escalator gating, trusted vs untrusted `forceReprompt`,
  persisted re-validation + untrusted marking, the disable flag, and the escalator cache-bypass. Suite
  236 → 244.

## [0.9.5] - 2026-06-16

Dependency-hardening pass (safe + tested bumps only) plus a tool-generation correctness fix
surfaced while auditing the tool system.

### Fixed
- **Runtime tool generation was broken for any tool that did I/O.** `ToolCreator` validates
  generated code with a syntax check before registering it, but compiled it as a *synchronous*
  function while the runtime executes it inside an `async` IIFE. Every generated tool that used
  `await callTool(...)` or `await fetch(...)` — i.e. essentially all useful tools, including the
  generator prompt's own `file_read` example — was rejected as "await is only valid in async
  functions" and silently discarded. The check now validates with `AsyncFunction` semantics.

### Security / Dependencies
- **Cleared the `ws` DoS advisory (GHSA-96hv-2xvq-fx4p) on the server side.** Added an
  `overrides` pin of `ws` to `^8.21.0` (patched), unifying the socket.io server chain on the
  fixed release. This removes the 3 high-severity server-side findings; the only residual `ws`
  node is the **browser** socket.io-client, where the Node `ws` library is never executed
  (browsers use the native `WebSocket`), so it is not exploitable in the shipped dashboard.
- **Removed the unused `uuid` dependency.** Cascade generates IDs with `node:crypto.randomUUID`
  and never imported the `uuid` package — it was a vestigial direct dependency.
- **Safe in-range refreshes** (semver-compatible, full suite + build verified): `better-sqlite3`
  → 12.11.1, `undici` → 6.27.0, `playwright` → 1.61.0, `@tanstack/react-virtual` → 3.14.3.
- **Deferred (intentionally not forced):** the remaining audit findings all require *breaking*
  major upgrades and are tracked for a dedicated pass — runtime: `@anthropic-ai/sdk`, `node-cron`,
  `node-notifier`, transitive `uuid` (via the two former); dev/build-only and never shipped to
  npm consumers: `vitest`/`vite`/`esbuild`/`tsup`/`vite-node`. Production-only `npm audit` is down
  to 8 (from a chain of ws-driven highs), and none of the residual highs are reachable at runtime.

### Tests
- Added `src/tools/tool-creator.test.ts` (8 cases) — the tool-generation capability previously had
  **no coverage**, which is how the async-syntax-check regression shipped. Covers schema
  normalization, pure-compute generation, `await callTool()` (regression guard), the SSRF guard on
  the sandboxed `fetch`, syntax-error rejection, capability dedup, and dangerous-tool escalation.

## [0.9.4] - 2026-06-16

### Fixed
- **Cancellation is now near-instant.** The run's abort signal is threaded into the provider
  calls themselves (anthropic / openai / azure / gemini / ollama), so Ctrl+C/ESC aborts the
  **in-flight** request instead of only stopping between LLM calls — a real run cancelled in
  **~31 ms** vs. ~38 s before. Provider `AbortError` is converted to a graceful cancel (partial
  output preserved, no error surfaced), and a rapid double-press can no longer be dropped (the
  cancel-armed flag is read from a ref, not stale React state). A `⊘ Cancelling…` indicator shows
  immediately.
- **Cascade Auto no longer overrides an explicitly-configured model.** Auto only routes tiers
  left on `auto`, and its per-task picks are restored after each run — so `/why`, the status bar,
  and the next run reflect your configured models (the missing `restoreTierModels`).
- **Slash commands show immediate feedback.** A command is echoed the moment you press Enter, and
  a `⠋ Running command…` indicator shows while async ones (e.g. `/plan`) work.
- **Slash commands are excluded from up-arrow history** — recalling prompts no longer gets stuck
  on the last `/command` or triggers scroll.

## [0.9.3] - 2026-06-16

### Security
- **Dropped axios entirely.** The pinned axios 1.13.6 carried ~24 HIGH advisories (SSRF,
  prototype-pollution credential theft, proxy-auth leakage). Rather than upgrade it (which
  conflicts with the project's long-standing axios pin), the **4 runtime call sites were
  migrated to native `fetch`** — the Ollama provider (streaming via the async-iterable
  response body), the GitHub/GitLab tool (status-aware error handling preserved), webhook
  notifications, and `cascade doctor` — and **`posthog-node` was bumped to v5**, which no
  longer depends on axios. `axios` is now absent from the dependency tree (`npm ls axios` is
  empty), and the shipped CLI is axios-free.

### Notes
- The remaining `npm audit` findings are pre-existing transitive / dev-only dependencies that
  each need a breaking major bump, so they're deferred (out of scope for the axios pass) to
  avoid a breaking-change cascade pre-1.0: **esbuild** (build/dev-server only — not shipped to
  CLI users), **ws** and **uuid** (transitive via socket.io / node-cron / @google/genai / ink),
  and **@anthropic-ai/sdk** / **diff**.

## [0.9.2] - 2026-06-16

### Added
- **Ctrl+C / ESC now cancel the running task** instead of only quitting. While a task is in
  progress: the first Ctrl+C warns ("press again to cancel the task"), the second **cancels the
  run** and keeps Cascade open; **ESC cancels outright**. When idle, Ctrl+C keeps its old
  double-press **quit** behavior. The run's partial output is preserved (a `⊘ Task cancelled`
  note is shown). Wires the REPL to the existing `AbortSignal` cancellation path
  (`cascade.run({ signal })` → `run:cancelled`).

## [0.9.1] - 2026-06-15

### Added
- **T3→T2 reinforcement request** (`reinforcements.enabled`, off by default) — a worker that
  discovers its subtask should fan out can call a new **`request_workers`** tool to have its
  **manager spawn bounded sibling workers** for the new pieces. No 4th tier: the new workers are
  ordinary siblings under the same T2 (so they honor `t3Execution`), bounded by
  `reinforcements.maxPerSection` (default 4) and **depth-1** (reinforcement workers can't request
  more). This is the lighter replacement for sub-agent spawning — the T1/T2/T3 tiers are already
  an agent hierarchy, so a recursive 4th tier was redundant and risked local-Ollama contention.

### Docs
- Refreshed the landing page (`index.html`) and `README.md`.

## [0.9.0] - 2026-06-15

Resumability, reflection, and smarter local execution.

### Added
- **Run resumability** + **`/continue [tokens]`** — when a task stops at the budget cap, resume
  it with a raised budget instead of redoing it. Files already created persist on disk (via
  snapshots), so only the remaining work runs. `Cascade.resumeRun()` for SDK use.
- **Reflection / self-critique** (`reflection.enabled`, off by default) — after a worker's
  pass/fail self-test, an optional **goal-alignment** critique revises the output once if it
  falls short of the intent (distinct from, and on top of, the self-test).
- **`t3Execution`** (`'auto'` default · `'parallel'` · `'sequential'`) — T3 waves now run
  **sequentially for a local (Ollama) tier** (a single GPU serializes anyway, so parallel just
  thrashed the queue and risked slot-wait timeouts) and **parallel for cloud**. Force either if
  you prefer.

### Notes
- New config: `reflection`, `t3Execution`. Sub-agent spawning was re-scoped to a lighter
  "T3→T2 reinforcement request" for a later release (the T1/T2/T3 tiers are already an agent
  hierarchy, so a 4th tier was redundant and brought local-deadlock risk).

## [0.8.0] - 2026-06-14

Agentic controls — autonomy, smarter re-planning, and new slash commands (sub-agent
spawning follows in v0.9.0).

### Added
- **Autonomous mode** + **`/auto [on|off|status]`** — hands-off runs: the plan gate
  auto-approves and **non-dangerous** tools run without prompts, while **dangerous** tools
  still escalate and budget caps remain the hard stop. Config: `autonomy: 'manual' | 'auto'`.
- **Dynamic re-planning with early-stop** — T1's reviewer loop now **stops early when a
  corrective pass makes no net progress**, returning the best partial result instead of
  burning passes (and tokens) toward the budget cap. Config: `maxReplanPasses` (default 2).
- **`/plan <prompt>`** — preview T1's decomposition **without executing it** (the command
  deferred from v0.7.0).
- **`/replan [guidance]`** — re-run the last task with a corrective/steering framing.

### Notes
- New config: `autonomy`, `maxReplanPasses`. All slash commands registered in `/help`.
- Motivated by a real run that burned ~115 min before the budget cap stopped it; early-stop
  cuts that short when work isn't converging.

## [0.7.0] - 2026-06-14

Plan-review upgrade — the boardroom gate becomes a real review loop (the agentic
features — dynamic re-planning, autonomous mode, sub-agent spawning — follow in v0.8.0).

### Added
- **Iterative plan revision** — a steering note now re-plans **and re-asks**, so the
  board can refine T1's plan across multiple rounds (capped by `planReview.maxRevisionRounds`,
  default 5) instead of a single take-it-or-leave-it pass.
- **Automated plan reviewer** — with `planReview.autoReviewer`, a reviewer model critiques
  the plan (risks, gaps, over-/under-decomposition) and the critique is shown in the approval
  dialog before you decide.
- **Editable plan** — drop sections inline in the approval dialog (↑/↓ to move, `x` to drop,
  `m` to add a steering note); the edited plan runs directly without a re-decompose.
- **Wider gate** — `planApproval` gains `'complex'` and `'all'` (`'always'` kept as an alias);
  `'all'` also gates **Moderate** runs, pausing to review the worker decomposition before any
  worker spawns. (`planReview.editable` toggles inline editing.)

### Notes
- `planApproval` accepts `'never' | 'complex' | 'all' | 'always'`; new `planReview` config block.
- An on-demand `/plan` preview command is planned for a follow-up.

## [0.6.0] - 2026-06-14

### Added
- **Live benchmark-aware Cascade Auto** — when a tier is set to Auto, each task is
  routed to the model that is the best *value* (quality × cost-efficiency) for its
  type, using **current** public data. Quality scores come from a hybrid source
  (live GitHub-raw snapshot → on-disk cache → bundled table); per-token prices come
  live from OpenRouter (free, no key). All fetching is background and time-boxed —
  fully offline-safe.
- **Live model discovery** — each configured provider's live model list is queried
  on startup so newly released models are usable and stale catalog ids are caught.
- **`autoBias` config** (`balanced` default · `quality` · `cost`) to tune the
  cost/quality trade-off, plus a `benchmarks` config block (live toggle, refresh
  interval, custom source URL, pricing toggle).
- **Routing transparency** — `cascade models` shows each tier's benchmark score and
  the data source (live/cached/bundled) + pricing origin; `/why` reports the score,
  price, and data source behind each Cascade Auto pick.
- **Scheduled benchmark refresh** — a weekly workflow regenerates the bundled
  snapshot and opens a data-only PR (no version bump, so it never triggers a release).

### Fixed
- **Gemini `404 … is not found` on Auto** — the catalog mapped `gemini-2.5-flash`/
  `gemini-2.5-pro` to retired `-preview-*` ids; updated to the GA ids. The router now
  also **self-heals**: a "model not found" error drops the dead model and fails over
  to the next candidate instead of surfacing the raw error.
- **Pasting an API key inserted it twice with `[200~` markers** — Ink 6's native
  bracketed-paste handling raced our raw-stdin handler. Paste is now owned by a single
  handler, and bare (ESC-less) `[200~`/`[201~` markers are stripped as a safety net.
- **Runs could freeze with no output** — a stalled cloud stream (TCP open, no terminal
  chunk) or an unanswered tool-approval prompt awaited forever. Cloud LLM calls are now
  time-boxed (`cloudInferenceTimeoutMs`, default 2 min) and approval waits deny on timeout
  (`approvalTimeoutMs`, default 10 min), so one stuck call can no longer hang the whole run.

## [0.5.7] - 2026-06-13

The first tagged release since v0.5.5 — it rolls up the v0.5.6/v0.5.7 work plus
two feature/fix tracks that landed on top of it.

### Added
- **Delegation savings counter** — live `saved $X (Y%) vs. all-T1` in the StatusBar
  and `/cost`, plus a per-run receipt.
- **Agent comms feed (`/comms`)** — live ticker of PeerBus traffic (peer messages,
  broadcasts, file locks, barrier syncs).
- **`/why`** — per-run decision trail: complexity verdict + reason, models per tier,
  provider failovers, and permission escalations.
- **Boardroom plan gate** (`planApproval: "always"`) — approve the org chart before
  any T2 spawns (opt-in; default unchanged).
- **`--alt-screen`** — opt-in vim-style alternate screen with in-app PgUp/PgDn history.
- **`/copy [n]`** — copy a response via native clipboard tools with an OSC 52 fallback.
- **`cascade link`** — reuse credentials from Claude Code / Codex / Gemini CLI /
  Copilot (API keys adopt directly; subscription OAuth tokens only with `--accept-risk`).
- **Benchmark-aware model routing** — selecting "Auto" now enables Cascade Auto and a
  curated public-benchmark table routes each subtask to the model strongest at its
  type (per-subtask, cross-provider; local-only tiers pick the best local model).
- **Per-task budget ceiling** (`budget.maxTokensPerRun`, default 200k) stops runaway
  spend with a graceful partial result.
- **Runtime tool persistence & sharing** — created tools are saved to
  `.cascade/dynamic-tools.json` (reloaded next run), deduped by capability, and
  broadcast over the peer bus.

### Changed
- **Ink 5 → 6.8, React 18 → 19** (both workspaces); Node engines floor raised to **20**.
- **Flicker-free rendering** — `computeLiveAreaBudget()` shrinks panels before Ink
  redraws the whole screen; height-capped panels; terminal resize handling.
- Installs are now deterministic — `package-lock.json` and `web/package-lock.json`
  are committed (fixes the `ERESOLVE` seen when upgrading an existing checkout).
- Read-only inquiries ("read/explain/analyze this file") classify as **Simple**
  (single agent) instead of fanning out into the full hierarchy; the classifier
  error-path defaults to Moderate, not Complex.
- The text-tool fallback for non-native models carries full schema (enums, required)
  and parses tool calls far more tolerantly; tool-call arguments are validated first.

### Fixed
- **Security hardening** — dashboard network exposure, `web_fetch` SSRF, approval
  gaps, and code-interpreter injection; plus 10 issues from the ORACLE audit.
- **Slash-command popup** no longer corrupts while scrolling (constant row count,
  full-width rows).
- A trivial "read the README" task could fan out and **hang ~5 min / burn 655K
  tokens** — fixed via the classification change, the per-task cap, and gating
  file-lock coordination to write tasks with a timeout.
- **Tool creation** surfaces failures instead of swallowing them and wraps generated
  schemas into valid JSON Schema so created tools work across providers.
- Startup now warns on a stale build (compiled bundle version ≠ source), and
  `bin/cascade.js` prints a friendly "run `npm install && npm run build`" on a
  missing `dist/`.

## [0.5.6] - 2026-05-24

### Changed
- TUI visual redesign.

### Fixed
- Azure setup-wizard flow.
- StatusBar background-strip rendering.

## [0.5.5] - 2026-05-23

### Fixed
- Init wizard tier-model picker scrolls (`limit={8}`) instead of overflowing.
- Chat scrolling restored — stopped enabling mouse-reporting on mount (a v0.5.4
  regression) so the terminal's native scrollback works again.
- Slash-command suggestion panel — `wrap="truncate"` on descriptions + one extra
  row of fixed height so long entries don't squish onto one line.

## [0.5.4] - 2026-05-23

### Added
- `--alt-screen` precursor work: `<Static>`-based conversation rendering so completed
  messages go to native scrollback and only the live area re-renders.
- Auto-clear of the agent tree 8 s after a task completes.

### Changed
- `tier:status` throttled to 100 ms; `React.memo` on `AgentTree` / `StatusBar` / `HintBar`.

### Fixed
- Maximized-terminal flicker on cmd / PowerShell.
- Orchestrator resilience: new `CriticalToolError` (stops the agent loop on
  rate-limit/auth errors instead of retrying 15×) and `WorkerStallError` (carries
  partial output); T1 now surfaces the real root cause when all sections fail.

## [0.5.3] - 2026-05-23

### Added
- Headless `cascade run` / `-p` — bypasses the Ink REPL in non-TTY contexts
  (CI, pipes, scripts); progress to stderr, answer to stdout.

### Fixed
- `cascade models` column layout; `/clear` also resets cost maps; richer `/config`
  output with an undefined-`dashboard` guard.

## [0.5.2] - 2026-05-22

### Added
- Redesigned first-run setup wizard (welcome header, phased step tabs, field boxes).
- New tools — `glob`, `grep`, `web-fetch` — plus a model-performance tracker.

### Fixed
- Removed an accidental `cascade-ai` self-dependency; corrected `/tree` and
  `/sessions` descriptions; fixed stale T2/T3 test mocks.

---

Older releases (v0.1.1 – v0.4.0): see the
[GitHub Releases](https://github.com/Varun-SV/Cascade-AI/releases) page.

[0.5.7]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.7
[0.5.6]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.6
[0.5.5]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.5
[0.5.4]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.4
[0.5.3]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.3
[0.5.2]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.2
