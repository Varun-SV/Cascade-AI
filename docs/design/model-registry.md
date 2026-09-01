# Model registry, capability profiles, and the safetensors question

Design analysis. No implementation. The recommendation is at the end of each
section; the reasoning is the point of the document.

Status: proposal. Nothing here is built.

---

## 0. Premises that are wrong, before anything else

Four of the framing assumptions do not match the code. Two of them change the
shape of the work; one of them is good news.

### 0.1 T2 does not choose which T3 worker receives a task

There is no worker pool and no assignment step. `T2Manager.executeSubtasks`
(`src/core/tiers/t2-manager.ts:560,581`) constructs **one `T3Worker` per subtask**,
minted fresh (`t2-manager.ts:535,581`), keyed by `subtaskId`. A `T3Worker` is
not bound to a model and never was — `BaseTier` (`src/core/tiers/base.ts:18`)
holds a router reference, not a model.

The model is resolved *inside* the worker, at
`src/core/tiers/t3-worker.ts:787`:

```ts
const picked = await this.router.selectModelForSubtask('T3', subtaskText, { requiresToolUse: tools.length > 0 });
```

which lands in `CascadeRouter.selectModelForSubtask`
(`src/core/router/index.ts:1720`) → `TaskAnalyzer.select` → `scoreModel`
(`src/core/router/task-analyzer.ts:528`).

So "T2 routes tasks by matching task type against profiles" describes a change
to **`task-analyzer.ts` and `selector.ts`**, not to `t2-manager.ts`. T2 is not
in the path at all. This matters for scoping: the routing half of Stage A is a
change to one scoring function and its inputs, behind an existing seam. It is
much smaller than the framing implies.

### 0.2 There is no hash-based dedup registry for peer-to-peer T3 coordination

Searched for; not there. What exists:

- `src/core/peer/bus.ts` — the actual T3↔T3 coordination. Outputs, barriers,
  file locks, broadcasts, retry-pending set. **No hashing anywhere in the
  file.**
- `capabilityKey()` at `src/tools/tool-creator.ts:131-135` — this is probably
  what was remembered. It dedups *LLM-generated tools* so peers don't
  regenerate the same one. But it is not a hash and not a registry: it is a
  sorted set of lowercased ≥3-char tokens joined by spaces, held in a
  per-instance in-memory `Map` (`capabilityIndex`) that dies with the process.
- The only real content-hash precedent in the repo is
  `src/retrieval/manifest.ts:28` (`sha256` per file, Merkle-ish root for the
  workspace index).

**Consequence:** Stage A does not extend an existing hash registry. It
introduces the first one. Budget for that, and steal the shape from
`manifest.ts` rather than from `tool-creator.ts`.

### 0.3 "Three surfaces" is right, but a fourth one must be explicitly excluded

The local surfaces:

| Surface | Entry | How it reaches the core |
| --- | --- | --- |
| CLI | `src/cli/` | same process |
| Local web dashboard | `web/` | served by `src/dashboard/server.ts`, same process as the CLI |
| Desktop | `app/` | `require()`s the built core — `app/electron/main.ts:70-80` (`dist/index.cjs` in dev, `resources/cascade-core/desktop-core.cjs` packaged) |

The fourth surface, the Railway-hosted app (`cloud/web` + `cloud/server`),
**deliberately excludes Ollama** — `cloud/web/src/lib/revoked-credentials.ts:166`
says so in as many words: a hosted page cannot reach a local endpoint. Local
GGUF selection must never appear there. It is not a surface for this feature; it
is a surface this feature must stay out of.

### 0.4 The good news: the surfaces are *already* thin clients over one core

This is the answer to open decision D and it is already true. All three local
surfaces run the same `CascadeRouter`, the same `ModelSelector`, the same
`MemoryStore`. Settings even go through one shared contract —
`src/config/settings-payload.ts` (`settingsSnapshot` / `commitSettings`), called
by both `src/dashboard/server.ts:225,235` and `app/electron/main.ts:554-558`.

What is duplicated is the **React UI**: `web/src`, `app/src/views/SettingsView.tsx`,
`cloud/web/src/components/SettingsModal.tsx`. Three model pickers, one config
writer underneath.

So "should the surfaces become thin clients over one registry" is already
answered yes by construction. A new registry gets shared for free. See §6.D for
the daemon half, which is a genuinely separate question.

### 0.5 One premise is understated, not wrong

Prior 3 says fp16 is "roughly 3x" a Q4_K_M GGUF. It is 16 bits/weight against
~4.8 bits/weight effective for Q4_K_M — **≈3.3×**, and the gap widens for the
models where it matters. A 32B at fp16 is ~64 GB (no consumer card); at Q4_K_M
~19.5 GB (fits a 24 GB card with room for KV cache). The conclusion the prior
draws from it is not just right, it is stronger than stated: quantization is not
merely the dominant lever, it is frequently the *only* lever that changes
whether the model runs at all.

---

## 1. What the code does today

### 1.1 Local models are discovered by name, from a server

Two paths, neither of which knows about files.

**Ollama** (`src/providers/ollama.ts:264`): `GET /api/tags`, filtered through a
hardcoded family allowlist (`ollama.ts:269`) and `isChatModel`. Then, per model,
`POST /api/show` (`ollama.ts:231`) yields `capabilities[]` (`tools`, `vision`)
and a `model_info` map. **This is already the GGUF metadata KV block** — the
code even comments on the architecture-prefixed keys (`ollama.ts:248-249`) and
reads `*.context_length` out of it. It ignores every other key.

**LM Studio / llama.cpp / vLLM** (`src/providers/openai-compatible.ts:86`):
`GET /models`, ids only. No capability metadata at all, which is why
`supportsToolUse` stays `undefined` and the probe in §1.4 exists.

A `ModelInfo` (`src/types.ts`) has an `id` and a `name` and no file identity.
`minSizeB` (`src/types.ts:41`, populated at `ollama.ts:299`) is **written and
never read** — a dead field that was reaching for exactly this.

Config (`src/config/schema.ts:31-33`) is three optional strings, `t1`/`t2`/`t3`.
No path type exists anywhere in the schema.

### 1.2 Routing scores models by regex-matched family

`TaskAnalyzer.scoreModel` (`src/core/router/task-analyzer.ts:528`):

```
balanced: perf × costEff × match × benchmark
quality:  perf × match × benchmark² × (0.85 + 0.15·costEff)
cost:     perf × match × costEff^1.5 × √benchmark
```

`benchmark` comes from `benchmarkScore01`
(`src/core/router/benchmarks.ts:143`), which calls `resolveFamily`
(`benchmarks.ts:128`) — a regex sweep over `baseModelId + id + name` against
`FAMILY_MATCHERS`, returning one of ~25 hardcoded family keys with a fixed
`{code, analysis, creative, data}` vector (`benchmarks.ts:39-80`, live-refreshed
from `benchmark-data.json`).

**The defect this proposal is really aimed at:** every local artifact that
matches `/qwen/i` gets `{code:78, analysis:73, creative:72, data:74}`. A
`qwen2.5-coder:7b-q4_K_M`, a `qwen3:32b-q8_0`, and a lobotomised `qwen:0.5b-q2_K`
score identically. Quantization, parameter count, fine-tune target and context
length — the four things that actually determine whether a local model can do
the subtask — are invisible to routing. `resolveFamily` reads `id` and `name`,
so pointing it at a file path does not help: `/models/Qwen2.5-Coder-7B-Q2_K.gguf`
still resolves to family `qwen` and inherits scores it has no claim to. An
*unrecognised* file is arguably treated better — `benchmarkScore01` returns a
neutral 0.5 (`benchmarks.ts:145`) rather than a confident wrong number.

`TaskType` is five values (`src/types.ts:128`): `code | analysis | creative |
data | mixed`. There is no tool-use or schema-adherence task type.

### 1.3 Outcome telemetry already exists — as a JSON file, keyed by model name

`ModelPerformanceTracker` (`src/core/router/model-performance-tracker.ts`)
persists to `~/.cascade/model-perf.json` (`:44`), keyed `` `${modelId}:${taskType}` ``
(`:124`). Per key it holds weighted `successCount`/`failureCount`,
`sampleCount` (confidence, explicitly not score — `:31`), retries, cost, and
context-token sums.

Since PR #218 this feeds a Beta posterior: `weightedPosterior` /
`posteriorMean` in `src/core/router/bayes.ts`, consumed by
`TaskAnalyzer.perfFor` (`task-analyzer.ts:569`) in `mean` or `sample` mode
(Thompson draw). Exploration is on by default; a draw that beats the mean-best
is announced as an exploration note.

**This is the single most important existing asset for this proposal.** "Runtime
telemetry writes back into the profile" is not new work — it is `record()` with
a different weight. §5 leans on this hard.

Note the key is a *model name*. Re-pull a tag, change a quant, keep the name:
the stats silently transfer to a different artifact. That is the same class of
bug as §1.2, one layer down.

### 1.4 A one-shot local capability benchmark already exists

`CascadeRouter.probeLocalToolSupport` (`src/core/router/index.ts:735`):

- selects `openai-compatible` models with `supportsToolUse === undefined`
- reads `store.getModelProfile(id, provider)` for a cached verdict
- if absent, runs `probeNativeToolCall` — one real inference with a trivial tool
- persists via `store.saveModelCapability` (`src/memory/store.ts:653`)
- re-injects through `selector.addDynamicModel` and refreshes tier bindings

**Stage A is a generalization of this exact mechanism.** Probe-on-first-sight,
persist in SQLite, feed the selector. The pattern is proven in this codebase,
including the part everyone gets wrong (`probed === null` means transport error
→ retry next start, don't cache a false negative — `index.ts:744`).

### 1.5 Persistence: two stores, neither hash-keyed

`better-sqlite3`. Workspace DB at `.cascade/memory.db`; global runtime DB at
`~/.cascade-ai/runtime.db` (`src/constants.ts:13-27`).

Schema (`src/memory/store.ts:732-859`): `sessions`, `messages`, `identities`,
`scheduled_tasks`, `audit_log`, `runtime_sessions`, `runtime_nodes`,
`runtime_node_logs`, `file_snapshots`, and — the relevant one — **`model_cache`**:

```sql
CREATE TABLE IF NOT EXISTS model_cache (
  id TEXT PRIMARY KEY,        -- `${provider}:${model_id}`
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',   -- a serialized ModelInfo
  updated_at TEXT NOT NULL
);
```

`metadata` is a JSON `ModelInfo` blob carrying `specializations`
(`store.ts:628`) and `supportsToolUse` (`store.ts:653`), queried with
`json_extract` (`store.ts:668`). So: JSON-in-SQLite with promoted columns is
already the house style, and there is precedent for querying into the blob.

Migration style is `CREATE TABLE IF NOT EXISTS` plus bare `ALTER TABLE ... ADD
COLUMN` in a try/catch (`store.ts:863-864`). Crude, but it is the convention;
a new table follows it without ceremony.

### 1.6 Local execution control: a per-process queue and nothing else

`LocalRequestQueue` (`src/core/router/local-queue.ts`), instantiated at
`src/core/router/index.ts:596` with `config.localConcurrency ?? 1`
(`schema.ts:315`). FIFO, default concurrency **1**, to protect single-GPU VRAM.
Acquired at `index.ts:1117` with a timeout and the run's abort signal.

Two facts that matter later:

1. It is **per-`CascadeRouter` instance**, so per process. CLI and desktop open
   at once → two independent queues → two concurrent generations on one GPU.
   The protection is real but not machine-wide.
2. Cascade sends **no `keep_alive`** to Ollama (grep: absent from
   `ollama.ts`). Residency is entirely Ollama's default. Cascade has no load,
   keep-alive or evict control today, and no code that wants it.

`localInferenceTimeoutMs` defaults to **300 000 ms** (`schema.ts:320`). A slow
model does not merely lose on latency; past five minutes it *fails the subtask*.
Nothing currently predicts that.

---

## 2. The proposed registry

### 2.1 Split the profile in two, because half of it is portable and half is not

One table cannot hold this. What a file *is* (architecture, parameter count,
quantization, vocabulary size, expert count) is a property of the bytes and
identical on every machine. What a file *does* (tokens/sec, peak VRAM,
adherence rate under a specific KV-cache dtype and offload split) is a property
of the bytes **on this host under this runtime** and transfers nowhere.

Conflating them is how you end up with the §1.2 defect at higher resolution:
a confident number attached to the wrong scope.

```
model_artifact   — host-independent. What the file is.
  artifact_id    TEXT PRIMARY KEY     -- see §2.2
  source_kind    TEXT                 -- 'gguf-file' | 'ollama-tag' | 'endpoint-id'
  source_ref     TEXT                 -- path, tag, or opaque server id
  arch_kind      TEXT                 -- 'dense' | 'moe' | 'vlm' | 'unknown'  (§6.C)
  arch           TEXT                 -- JSON, discriminated by arch_kind
  params_b       REAL                 -- promoted: queried on every selection
  quant          TEXT                 -- 'Q4_K_M', 'F16', …
  ctx_max        INTEGER
  file_bytes     INTEGER
  first_seen     TEXT
  lineage        TEXT                 -- JSON or NULL; Stage B only (§7)

model_profile    — host- and runtime-bound. What the file does here.
  artifact_id    TEXT   -- FK
  runtime_id     TEXT   -- §2.3
  host_id        TEXT   -- §2.3
  bench_tier     INTEGER  -- highest tier completed, 0..3
  metrics        TEXT     -- JSON; see §2.5
  vram_peak_bytes INTEGER -- promoted: feasibility gate
  tok_per_sec    REAL     -- promoted: feasibility gate
  adherence      REAL     -- promoted: eligibility gate
  measured_at    TEXT
  PRIMARY KEY (artifact_id, runtime_id, host_id)
```

Promoted columns are exactly the ones read on **every** selection. Everything
else lives in JSON, matching `model_cache`'s existing shape.

### 2.2 Keying an artifact: hash the header, not the file

A 20 GB sha256 is 30–90 seconds of disk. Doing that when someone picks a file in
a settings dialog is not acceptable, and doing it in the background introduces a
state machine ("profiled, pending identity") for no gain.

**Proposal: hash the GGUF header block plus the file size.** The GGUF header is
a metadata KV section followed by the full tensor index — every tensor's name,
shape, dtype and offset. For a 7B that is tens of kilobytes and it is already a
near-unique fingerprint: two different quantizations of the same base model
differ in dtype for every tensor *and* in total size; two different fine-tunes
of the same architecture differ in the KV metadata; a truncated download differs
in size. Cost: one `read()` of a few dozen KB.

```
artifact_id = "gguf-h1:" + sha256(header_bytes || u64le(file_size))[0..32]
```

The prefix is a scheme tag so a future full-content scheme can coexist rather
than silently colliding. This is an **identity key for a local cache**, not a
security boundary — nothing about it should be presented as proving two files
are identical, and it must never be used to accept a profile computed on another
machine (see §9).

For the two server-mediated paths, the artifact identity is weaker and must be
labelled as such:

- **Ollama**: `POST /api/show` already returns `model_info`, the GGUF KV block
  (`ollama.ts:242-255`). Fingerprint that map plus the digest Ollama reports.
  No file access, no new dependency. Cheap and available today.
- **Bare OpenAI-compatible**: only an id string. There is no artifact identity
  to be had. Such a model gets `source_kind='endpoint-id'` and is keyed on the
  id, i.e. exactly today's behaviour — and the profile must be marked
  low-confidence, because the server can swap the file underneath the id at any
  time.

### 2.3 Runtime and host identity

```
runtime_id = hash(loader_name, loader_version, n_ctx, n_gpu_layers,
                  kv_cache_dtype, flash_attn)
host_id    = hash(gpu_name, vram_total, driver_version, cpu_model, ram_total)
```

Rationale: KV-cache quantization and partial CPU offload change *numerics*, not
just speed — a model measured at `n_gpu_layers=99, kv=f16` and the same file at
`n_gpu_layers=20, kv=q8_0` are different systems and should not share a
measurement. If those knobs are not observable through the chosen server API,
that is a reason to record `runtime_id='unknown'` and downgrade confidence — not
a reason to pretend the measurement is portable.

**Invalidation is by key, not by TTL.** A new driver, a new llama.cpp build, a
different context setting produces a different `runtime_id`/`host_id` and
therefore a profile miss, which re-benches. No staleness heuristic to tune. The
one thing that *does* need a TTL is `source_kind='endpoint-id'`, because its
identity is a promise rather than an observation.

### 2.4 Tiers of bench cost

The default must be nearly free, or people will turn it off and the whole thing
is dead.

| Tier | What | Cost | When |
| --- | --- | --- | --- |
| **T0 Header** | Parse GGUF KV: arch, params, quant, `ctx_max`, vocab size, `*.expert_count`, `*.block_count`. No inference, no load. | ~milliseconds | Automatic, on selection. Free on the Ollama path via `/api/show`. |
| **T1 Smoke** | One load + one short generation. Confirms it loads at the requested context; measures load time, prompt-eval and eval tok/s, peak VRAM if observable. | ~10–30 s | Automatic, on selection. Failure ⇒ `unusable`, never routed. |
| **T2 Adherence** | N fixed prompts requiring exact structured output, scored by a **deterministic validator with no judge model**: (a) a tool call against a fixed schema, (b) a JSON object against a schema, (c) stop-token discipline — does it stop, or run to `max_tokens`, (d) instruction negation — "do not include X". | ~1–3 min | Automatic on first *routing* use; that is, deferred until the model is about to matter. |
| **T3 Task quality** | Small fixed sets per `TaskType`, programmatically scored where a scorer honestly exists: code snippets with assertions, exact-match extraction for `data`, multi-hop questions with fixed answers for `analysis`. | ~5–20 min | **Opt-in only.** Never automatic. |
| **T4 Shadow** | Real traffic, scored on outcome, output discarded. The opt-in shadow lane from the #218 design. | ongoing | Opt-in only. Out of scope for Stage A. |

**`creative` has no honest programmatic scorer.** Do not build one. Judging
creative writing requires either a judge model (a cloud call, on the offline
path, defeating the purpose) or a human. `creative` stays at the family prior,
and the UI must say so rather than showing a fabricated bar. This is a real
limitation of the design and it should be stated in the product, not hidden.

### 2.5 What `metrics` holds

```jsonc
{
  "adherence": {                      // T2 — the gate
    "toolCallValid": 0.95,            // parses AND matches schema
    "jsonValid": 0.90,
    "stoppedCleanly": 0.99,
    "negationHonoured": 0.80,
    "n": 40                           // sample size, so a posterior can read it
  },
  "throughput": {                     // T1
    "loadMs": 4200, "promptTokPerSec": 850, "evalTokPerSec": 42,
    "vramPeakBytes": 5100000000, "vramObserved": true
  },
  "quality": {                        // T3, opt-in, only where a scorer exists
    "code": 0.61, "data": 0.55, "analysis": 0.48,
    "n": { "code": 20, "data": 20, "analysis": 20 }
  },
  "arch": { /* MoE router entropy etc. — see §6.C */ }
}
```

Every measurement carries its `n`. A number without a sample size cannot become
a posterior prior, and §5 requires exactly that.

---

## 3. How T2 routing changes

Restating §0.1: this is a change to `task-analyzer.ts` and `selector.ts`. T2 is
not involved.

### 3.1 Feasibility gates run *before* scoring

Today a model that cannot fit or cannot finish is scored and can win. Three
hard filters, applied in `selector`'s candidate list:

1. **Fit.** `vram_peak_bytes > host VRAM` (with headroom for KV cache at the
   configured context) ⇒ ineligible. Today nothing checks this; the failure mode
   is a load error or a silent CPU-offload crawl.
2. **Time.** `projected_output_tokens / tok_per_sec > localInferenceTimeoutMs`
   (`schema.ts:320`, 5 min) ⇒ ineligible for this subtask. This converts a
   guaranteed timeout-failure into a routing decision.
3. **Adherence.** Subtask needs tools (`requiresToolUse`, already threaded
   through `selectModelForSubtask` at `t3-worker.ts:787`) and
   `adherence.toolCallValid` is below threshold ⇒ ineligible.

Gates are not scores. A model that fails one is not "less preferred"; it is out.

### 3.2 The measured profile replaces the family prior — for that artifact only

`benchmarkScore01` (`benchmarks.ts:143`) gains a profile-aware branch: if a T3
profile exists for `(artifact, runtime, host)`, use its measured per-`TaskType`
score. If only T0/T1/T2 has run, keep `resolveFamily`'s number as the prior.
Cloud models are untouched — they have no artifact and never will.

### 3.3 The metric question: adherence gates, throughput gates, quality ranks

The prior is that tool-call/JSON adherence should dominate routing. **Half
right, and the half that is wrong matters.**

**Where the prior is right, and the code proves it.** Cascade's entire local
path is scar tissue from adherence failures. `useTextTools`
(`t3-worker.ts:801`) exists because local models fumble native tool format.
`probeNativeToolCall` (`index.ts:759`) exists because their servers lie about
supporting it. `buildTextToolSystemPrompt` re-sends the full per-parameter
contract because they forget it. `parseReviewResponse`
(`src/core/tiers/review.ts`) has a prose fallback because a model told to answer
in a shape answers in prose. A T3 worker runs an agent loop of up to 15
iterations (`t3-worker.ts:771`); a model that cannot emit a well-formed tool
call fails the subtask on iteration 1 no matter how good its reasoning is.
Reasoning quality is worth nothing behind a broken output contract.

Adherence is also the only metric that can be measured **locally, offline,
deterministically, with no judge model** — which is the difference between a
bench harness that runs on the user's machine and one that needs a cloud key to
grade itself. That alone is close to decisive for a local-first feature.

**Where the prior is wrong: adherence saturates.** It is a bounded metric with a
ceiling that competent models hit. Once three candidates score 0.98, 0.99 and
0.99 on a 40-prompt suite, the differences are inside the noise and ranking on
them is ranking on sampling error. A metric that cannot discriminate at the top
of its range cannot be the primary ranking metric — it can only be a threshold.
Optimising it further also has a perverse tail: the most rigidly schema-adherent
local models are frequently small instruction-tuned ones that are *worse* at the
underlying task. Rank on adherence and you systematically route to the model
that formats well and thinks poorly.

**Recommendation.**

- **Gate on adherence** (hard threshold, per subtask, tools-required-aware).
- **Gate on throughput** against the timeout — currently missing entirely and
  probably the single largest source of unexplained local-run failure today.
- **Rank on task-type quality** among survivors, via the existing posterior.
- **Break ties on throughput**, not on adherence. Among two adherent, comparable
  models, the faster one is strictly better for a tier that runs many subtasks
  in a wave.

One concrete addition: `TaskType` (`src/types.ts:128`) has no notion of
tool-heaviness, and `requiresToolUse` is a boolean passed separately. If
adherence is going to gate, the *degree* of tool-dependence should be part of
the task profile rather than a flag — but that is a `task-analyzer` change worth
doing on its own merits, and I would not bundle it into Stage A.

---

## 4. Priors 1, 2, 4, 5 — tested

**Prior 1 — partial loading doesn't help dense transformers.** Correct, and
worth stating more strongly: every token traverses every weight of every layer,
so "load only what you need" for a dense model means "load all of it". The thing
safetensors gives you is *zero-copy mmap with per-tensor offsets*, which is a
file-access property (and one GGUF also has). It buys faster load and lower
peak host RAM during load. It does not buy capability selection. Upheld.

**Prior 2 — the cases where it does hold.** Three of four upheld, one struck.

- *MoE expert pruning from router statistics on a domain calibration set* —
  real, and the only version of "load less" that changes the resident set. All
  experts must be resident because routing is per-token per-layer, so you cannot
  select at load time without rewriting the checkpoint. Requires forward passes
  over a calibration set to collect the statistics. Upheld, and expensive.
- *Vocab / lm_head trimming* — real and larger than people expect. Qwen-class
  vocab is ~152k; at hidden 3584 the embedding is ~1.09 GB in fp16, and an
  untied `lm_head` another ~1.09 GB. Also **the most dangerous transform on the
  list for this product**: trim a token the model needs and you have silently
  broken code output, non-English text, or an emoji, in a way no aggregate
  metric catches. Upheld as *possible*, flagged as high-risk.
- *Depth pruning* — agreed, needs a healing fine-tune, different project. Out.
- *Skipping vision towers in VLM checkpoints* — **struck**. In the GGUF world
  the vision encoder and projector already ship as a **separate `mmproj-*.gguf`
  file**; the language model GGUF does not contain them. A text-only T3 gets
  this saving today by not loading the projector. There is nothing to build and
  no reason to reach for safetensors for it. (Verify against your llama.cpp
  version — §9.)

**Prior 4 — safetensors as offline foundry input, GGUF as output, registry
tracks lineage.** Upheld, and it is the recommendation. See §6.A.

**Prior 5 — the bench is the validation gate; Stage A before Stage B.** Upheld,
and this is the most important prior in the set. It deserves teeth rather than
agreement, so §7 turns it into a falsifiable gate instead of a sequencing
preference.

---

## 5. The one architectural instruction: do not build a second scoring path

Everything above is inputs. The temptation is to have the profile produce a
"profile score" that gets multiplied into `scoreModel` alongside `benchmark` and
`perf`. **Don't.** That creates two systems of belief about the same model that
can disagree, and nothing to arbitrate them.

PR #218 already built the arbitration. `weightedPosterior(successWeight,
failureWeight, observations)` in `src/core/router/bayes.ts` separates *where the
belief sits* from *how tightly it is held*. A bench result is precisely a batch
of weighted observations with a known `n`.

So:

- **T0/T1** set eligibility. Not belief. Gates, per §3.1.
- **T2/T3** seed the posterior as a prior: `n` bench trials at the measured
  success rate, entered with a bench weight.
- **Runtime telemetry** is the same `record()` call the tracker already makes
  (`model-performance-tracker.ts:109`), on the same key.

Then "telemetry writes back into the profile so it tracks reality instead of
freezing at bench day" is not a feature to build — it is what the posterior
already does. Bench day is the prior; real runs are the observations; the
posterior narrows. The `sampleCount`-is-confidence-not-score discipline
(`model-performance-tracker.ts:31`) carries over unchanged, and exploration
keeps working because it reads the same posterior.

One required change: **the tracker key must become the artifact id** for local
models. Today it is the model name (`:124`), so re-pulling a tag or changing a
quant silently inherits another artifact's history. That is a small change with
a migration question attached (§9).

---

## 6. Open decisions

### A. Where safetensors sits

**Recommendation: offline foundry, producing GGUF. Do not build direct T3
safetensors loading. Confidence: high (~85%).**

Reasoning:

1. **The VRAM math forecloses it.** §0.5 — fp16 is ~3.3× Q4_K_M. Adopting
   safetensors as a runtime format costs more capability (models that no longer
   fit) than any pruning transform returns. The only self-consistent way to run
   safetensors at competitive memory is to quantize it at load — i.e. to do the
   foundry's job at runtime, per load, on the user's critical path.
2. **It has no runtime in this stack.** Serving safetensors means vLLM,
   ExLlamaV2, transformers, or candle. The first three are Python; the fourth is
   Rust. Cascade is Node. See §6.B — the cost is not "a dependency", it is a
   second language runtime on three surfaces.
3. **The transforms are offline by nature anyway.** Expert pruning needs
   calibration forward passes. Calibrated quantization needs an importance
   matrix over a corpus. LoRA merging is a one-time weight edit. None of these
   is a per-request operation; all of them produce an artifact. An artifact
   producer is a foundry.
4. **Lineage is the actual product.** `base checkpoint hash → transform recipe →
   derived GGUF hash → benchmark profile` is the valuable thing, and it is
   valuable precisely because the derived artifact is a *file* with an identity.
   Direct loading would dissolve the identity that makes lineage meaningful.

**What would change my mind:**

- The target is a single Linux box with CUDA and a Python environment already
  present, and the deployment story is "our server", not "our users' laptops".
  Then vLLM serves safetensors behind the existing `openai-compatible` provider
  with zero Cascade changes, and the foundry framing is unnecessary overhead.
- The models in scope shrink to ≤3B, where fp16 fits comfortably and the
  quantization advantage stops mattering.
- **Per-task LoRA hot-swapping becomes the primary use case.** This is the
  strongest counter-argument and I am not confident about it: swapping adapters
  per task type at serving time is a genuinely different capability from
  producing one merged artifact, and it is the one thing a merge-to-GGUF
  pipeline handles badly. llama.cpp does have runtime LoRA support, which would
  keep the recommendation intact — but I have not verified its current state,
  and if it is weak, this decision needs revisiting. Flagged in §9.

### B. Is a Python/torch dependency acceptable?

**Recommendation: no torch in any shipped surface, ever. The foundry is a
separate, optional, user-installed tool. Confidence: high (~90%).**

The real costs, laid out as asked:

*Install size.* torch CPU wheel ≈ 200 MB. The CUDA wheel is **2.5–3.5 GB
unpacked** — it vendors cuDNN and cuBLAS. Add `transformers`, `accelerate`,
`safetensors`. Cascade ships on npm (`package.json` `files`: `dist`, `bin`,
`web/dist`, `completions`). A multi-gigabyte postinstall is not a thing an npm
CLI can do.

*Cold start.* `import torch` alone is ~1–3 s; CUDA context init adds more. Every
CLI invocation would pay it, or you build a warm sidecar and now you are
maintaining a supervised process (§6.D).

*Packaging across surfaces.* This repo already shows how delicate the native
path is: `npmRebuild: false` with an explicit `@electron/rebuild` CI step, plus
hand-listed `extraResources` for `better-sqlite3`, `bindings`, and
`file-uri-to-path` (`app/electron-builder.yml:31-45`) — all that ceremony for
*one* native module. Bundling a Python runtime plus a CUDA torch venv per
platform (win/mac-arm/mac-x64/linux) is a categorically larger problem, and the
macOS ARM story has no CUDA at all.

*No CUDA.* torch CPU works and is unusably slow for the actual workload: MoE
router statistics need many forward passes over a calibration set, which on CPU
for a 7B is hours. So the dependency would be enormous *and* inert on most
machines that installed it.

**Alternatives, ranked:**

1. **Separate optional tool, user-installed** (`cascade-foundry`, Python, its
   own repo or an extras install). Cascade never imports it; it consumes the
   output GGUF plus a lineage JSON via a documented file contract. Cost to
   Cascade: a schema. **Recommended.**
2. **Container.** `docker run cascade-foundry` — best reproducibility (calibrated
   quantization is sensitive to library versions), needs Docker, fine for an
   offline batch step. Good second choice, and a good *first* choice if the
   foundry's outputs are meant to be shared or reproduced.
3. **GGUF-only tooling — and this is the underrated one.** llama.cpp ships
   `llama-quantize` and `llama-imatrix`. Importance-matrix-calibrated
   quantization is **exactly** the "custom calibrated quantization" lever from
   Stage B, and it needs no Python and no torch at all — just a binary and a
   calibration corpus. Since §0.5 establishes quantization as the dominant
   lever, the highest-value Stage B transform is reachable with zero of the cost
   in this section. (Conversion from HF safetensors *to* GGUF does still need
   `convert_hf_to_gguf.py` — Python, but not torch, and a one-time step.)
4. **Rust readers** (`safetensors` crate, `candle`). Enough for pure tensor
   surgery — vocab trimming, dropping expert tensors — because those are slicing
   operations, not gradient ops. **Not** enough to *decide* which experts to
   drop, which needs forward passes. So Rust can execute a recipe but cannot
   author one.

The ordering that falls out: **do (3) first, and possibly only (3).** It
delivers the dominant lever with no new runtime. (1) becomes necessary only when
expert pruning is actually wanted, and by then §7's gate will have said whether
the bench can validate it.

### C. Profile schema across dense / MoE / multimodal

**Recommendation: tagged union in JSON, discriminated by `arch_kind`, with only
the routing-hot fields promoted to columns. Confidence: high.**

The failure to avoid is a wide table where `expert_count`, `router_entropy` and
`vision_tower_params` are `NULL` for 90% of rows, and every consumer has to know
which nulls are meaningful.

```jsonc
// arch_kind = 'dense'
{ "kind": "dense", "layers": 32, "hidden": 3584, "heads": 28, "kvHeads": 4,
  "vocab": 152064, "tiedEmbeddings": false }

// arch_kind = 'moe'
{ "kind": "moe", "layers": 48, "hidden": 4096,
  "expertCount": 8, "expertsUsedPerToken": 2, "sharedExpertCount": 1,
  "routerStats": null }        // populated only by a foundry calibration run

// arch_kind = 'vlm'
{ "kind": "vlm", "text": { /* a dense or moe object, nested */ },
  "visionTower": { "present": true, "separateFile": true,
                   "projectorRef": "mmproj-f16.gguf" } }
```

Three rules:

1. **`vlm` nests rather than extends.** A multimodal checkpoint is a text model
   plus a tower; modelling it as "dense with extra fields" makes the MoE-VLM
   case unrepresentable. Nesting handles it for free.
2. **Promote only what selection reads on the hot path** — `params_b`, `quant`,
   `ctx_max`, `arch_kind`, and the three profile gates
   (`vram_peak_bytes`, `tok_per_sec`, `adherence`). Everything else stays in
   JSON. This mirrors `model_cache`, which promotes `provider`/`model_id`/`name`
   and leaves the rest in `metadata` (`store.ts:835-842`), and it is queryable —
   `json_extract` is already used at `store.ts:668`.
3. **Arch-specific *measurements* go in `metrics.arch`, not in `arch`.** `arch`
   is what the header says; `metrics.arch` is what a bench measured. Router
   entropy on a calibration set is a measurement and is host/runtime-bound like
   every other measurement — it belongs in `model_profile`, not
   `model_artifact`. Getting this boundary wrong is how a foundry result ends up
   presented as a property of the file.

Do **not** add a `capabilities` bitmask or a generic key-value EAV table. Both
are the same mistake in different clothes: they make the schema stop describing
anything.

### D. Thin clients over one registry, plus a model-manager daemon?

**Recommendation: the registry, yes — and it is nearly free because §0.4 is
already true. The daemon, no. That is over-engineering for this codebase.
Confidence: high on the daemon, very high on the registry.**

*The registry half is already solved.* All three local surfaces share one
`CascadeRouter`, one `ModelSelector`, one `MemoryStore` — Electron `require`s
the built core (`app/electron/main.ts:70-80`), the dashboard runs in-process
(`src/dashboard/server.ts`), the CLI is that process. A new table in
`MemoryStore` and a new branch in `benchmarkScore01` are visible to all three the
day they land. The only genuinely triplicated work is the file-picker UI in
three React trees — and even that writes through one contract,
`settings-payload.ts`.

*The daemon half is a solution looking for its problem.* A model manager owning
load/keep-alive/evict presumes Cascade loads models. It doesn't. **Ollama and LM
Studio are already that daemon**, and they already do keep-alive and eviction.
Building a second one means either wrapping them (a supervisor over a
supervisor) or replacing them (loading GGUFs in-process — new native
dependency, new platform matrix, and §6.B's packaging problem in a different
costume). Cascade does not even send `keep_alive` today (§1.6); the cheap
version of "manage residency" has not been tried.

*The one real gap the daemon would close, and the cheaper way to close it.*
`LocalRequestQueue` is per-process (`index.ts:596`). CLI and desktop running at
once each admit `localConcurrency` calls, so a single-GPU machine gets 2×
concurrent generations and the VRAM protection the default of 1 was written for
silently stops holding. That is a genuine bug and it will get worse as surfaces
multiply.

Fix it with a **machine-wide advisory lock file in `~/.cascade-ai/`**, not a
daemon: an atomic-create lock with a stale-PID sweep, acquired around the same
seam `LocalRequestQueue.acquire()` already occupies (`index.ts:1117`). Tens of
lines, no new process, no supervision, no lifecycle, no IPC protocol, and it
composes with the existing abort-signal handling. A daemon would cost a startup
path, a crash-recovery path, a version-skew story between core and daemon, and a
socket — to solve a mutual-exclusion problem that a lock file solves.

**Revisit only if** Cascade drops Ollama/LM Studio and loads GGUFs in-process.
At that point a manager is not over-engineering, it is the whole feature.

---

## 7. Staged plan, with a hard stop

### Stage A.0 — Identity and header. No routing change.

GGUF header parser (pure TS, no native dep — the format is a documented KV
block; nothing here needs to read tensors). `artifact_id` per §2.2.
`model_artifact` + `model_profile` tables in `MemoryStore`, following the
existing `CREATE TABLE IF NOT EXISTS` convention. Ollama path fingerprints
`/api/show`'s `model_info`, which costs nothing new.

Ships dark. Nothing routes differently. Verifiable on its own: the same file
under two names produces one artifact row; two quants of one model produce two.

### Stage A.1 — File selection + smoke bench + feasibility gates.

File picker in CLI, desktop, and local dashboard (**not** `cloud/web` — §0.3).
T0 automatic, T1 on selection. The three gates from §3.1 in the selector.

This is the point at which the feature pays for itself, and note *why*: the
throughput gate (§3.1.2) fixes an existing unexplained failure — a model that
cannot finish inside `localInferenceTimeoutMs` currently gets selected and then
times out. That is worth shipping even if nothing else in this document is ever
built.

### Stage A.2 — Adherence suite + posterior seeding.

T2 per §2.4. Write-back per §5 — bench results as weighted observations on the
existing Beta posterior, **not** a new scoring term. Tracker key moves to
`artifact_id` for local models.

### ⛔ HARD STOP — the gate to Stage B

Prior 5 is right that the bench validates the foundry, but "Stage A must land
first" is a sequencing statement and sequencing is not a gate. Here is a
falsifiable one:

> Take one model. Produce a deliberately damaged variant — requantize the same
> file to Q2_K. Require the harness to rank the damaged variant **below** the
> Q4_K_M, with the difference **outside the credible interval** of the
> posteriors it produced.

If the harness cannot detect a quantization cliff — the largest, bluntest,
most reliably-reproducible quality change available — it certainly cannot detect
the subtle degradation from dropping an expert or trimming a vocabulary. Failing
this gate does not mean "try harder on Stage B"; it means the bench is not yet a
measurement and Stage B would be pruning blind.

This is testable the day A.2 lands, before a line of Stage B is designed. It
costs one `llama-quantize` run.

### Stage B — only after the gate passes, and narrower than proposed.

**B.1 — Calibrated quantization only.** llama.cpp `llama-imatrix` +
`llama-quantize`. No torch, no Python, no safetensors runtime (§6.B item 3).
Lineage recorded: `base artifact_id → recipe → derived artifact_id → profile`.
This is the dominant lever (§0.5) at the lowest cost in the document.

**B.2 — LoRA merging.** Only if adapters are actually in play, and only after
checking whether runtime LoRA makes merging unnecessary (§9).

**B.3 — Expert pruning.** Only if MoE models are actually in the local fleet,
only after B.1 has demonstrated the lineage machinery works, and only with the
foundry as a separate installed tool (§6.B item 1).

**Not scheduled: vocab trimming.** Highest risk-to-reward on the list (§4). It
should be reconsidered only after the harness has caught a real regression in
anger — not a synthetic one from the gate above.

---

## 8. What NOT to build

Scope to kill, explicitly:

- **torch, in anything shipped.** Not in the CLI, not in the desktop bundle, not
  as an optional peer dep that half of installs will fail on.
- **A model-manager daemon.** Use a lock file (§6.D).
- **Direct safetensors loading at runtime** (§6.A).
- **Vision-tower stripping.** Already free — the projector is a separate GGUF
  (§4).
- **Depth pruning / healing fine-tune.** Different project, correctly identified
  as such.
- **A creative-quality bench.** No honest local scorer exists (§2.4).
- **Local file support in `cloud/web`.** A hosted page cannot reach the user's
  disk, and the codebase already refuses this on purpose (§0.3).
- **Cross-machine profile sharing.** Measurements are host-bound (§2.3). Sharing
  them recreates the family-table defect at higher resolution and with more
  confidence attached — the worst of both.
- **A second scoring path parallel to the posterior** (§5). The most important
  item on this list.
- **Full-file hashing on the selection path** (§2.2).
- **A generic capability bitmask or EAV table** (§6.C).

---

## 9. Open questions / needs verification

Ordered by how much they can invalidate the plan. The first one can invalidate
Stage A.1 outright.

1. **Can LM Studio be told to load a specific file?** Its OpenAI-compatible
   `/models` returns ids (`openai-compatible.ts:86-100`); Cascade reads only
   `id`/`name`/`model`. If there is no way to say "load *this path*", then on
   the LM Studio path "select a GGUF file" means the user picks a file Cascade
   can hash but cannot cause to be loaded — the profile would describe an
   artifact that is not necessarily the one serving. **This is the biggest
   unknown in the document and it should be checked before anything is built.**
2. **Ollama with an arbitrary path.** A Modelfile `FROM /path/to.gguf` +
   `ollama create` registers it — but I believe this **copies** the file into
   Ollama's blob store, which for a 20 GB artifact is a disk cost the UI must
   warn about, and it renames the model. Needs confirming against current
   Ollama.
3. **llama.cpp server, N models.** `llama-server` takes `-m` at startup, not per
   request. If a router wants to choose among several local artifacts per
   subtask, that implies N servers or a swap-proxy (the `llama-swap` pattern).
   **This one determines whether §6.D's "no daemon" answer survives**: if the
   only way to route across multiple local files is to manage server processes,
   Cascade needs a process manager after all — just not the one that was
   proposed.
4. **Is llama.cpp's runtime LoRA support good enough to skip merging?** Bears
   directly on §6.A's counter-argument and on whether B.2 exists.
5. **Confirm the separate-`mmproj` claim** against the llama.cpp version you
   target. §4 strikes a Stage B item on the strength of it.
6. **Is the header hash discriminating enough?** I believe yes (tensor index +
   size), but it should be tested against the adversarial-ish case: two
   fine-tunes of one base at the same quant, identical architecture, near-identical
   size.
7. **Peak VRAM without vendor tooling.** `nvidia-smi` is not always present;
   Apple Silicon has no equivalent notion; ROCm differs again. The fit gate
   (§3.1.1) may have to fall back to an estimate from `params_b × bits_per_weight
   + KV-cache size`, in which case `vramObserved: false` must be honest about it
   and the gate needs headroom.
8. **Where do profiles live — workspace or global?** Both DBs exist
   (`src/constants.ts:19,27`). My view: **global**, because a GGUF file on disk
   is a machine fact, not a project fact, and re-benching per workspace is
   wasted minutes. But `model_cache` today lives in the workspace DB, so this is
   an inconsistency to decide deliberately rather than inherit.
9. **Migrating `model-perf.json` when the tracker key changes to `artifact_id`**
   (§5). Options: drop local-model history (clean, loses real evidence), or
   carry it forward on a best-effort name match (keeps evidence, risks
   attributing one artifact's history to another — the exact bug being fixed).
   I lean toward dropping it, but it is your call and it is user-visible.
10. **Should `creative` be dropped from local routing entirely** rather than
    left at the family prior? An unmeasurable dimension that still participates
    in scoring is a confident number with nothing behind it — the same failure
    §1.2 is trying to fix.
