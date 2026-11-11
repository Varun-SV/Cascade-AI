# Thinking as a routed resource

Status: **draft for discussion, revision 1.** Nothing here is implemented and
nothing here approves code. Section 9 lists the decisions still open.

## 1. Decisions already made by the maintainer

- Thinking effort becomes part of T1/T2/T3 routing. The tier structure stays;
  changing it is allowed later but is not part of this design.
- **Default goal: the cheapest way to reach the same quality.** When the user
  selects best quality (`autoBias: 'quality'`), the goal is the best result.
- Extra calls may be spent to learn whether more thinking helped.
- Effort is chosen automatically. The user gets one top-level control with
  three settings:

  | Setting | Meaning |
  |---|---|
  | none | Never ask a model to think. |
  | absolute | Automatic per call, never above a ceiling the user picks. |
  | maximum | Every call thinks as hard as its model allows. |

- The user's WebGPU is used as a **classifier only**: it estimates how hard a
  subtask is. It does not judge answers and does not run worker tasks.
- WebGPU applies to the **cloud web app only** at first. CLI and desktop get
  the same behaviour from the existing server-side task analysis.
- Design first, then a prototype behind a flag.

## 2. What exists today

- **Model routing is learned.** `TaskAnalyzer.select`
  (`src/core/router/task-analyzer.ts`) profiles each subtask (type, complexity
  1 to 5, `requiresReasoning`) and picks a model by a Thompson draw from a Beta
  posterior of success per (model, task type) (`src/core/router/bayes.ts`).
- **Thinking is not routed.** `GenerateOptions` (`src/types.ts`) has no effort
  field, so no tier can ask for more or less.
- **Each provider hardcodes its own behaviour.**
  - Anthropic (`src/providers/anthropic.ts:27`): always on, budget up to 8,000
    tokens, only for ids matching `claude-(opus|sonnet)-4`. Newer ids get none.
  - OpenAI (`src/providers/openai.ts`): provider default, except
    `reasoning_effort: 'none'` for two GPT-6 models when tools are sent.
  - Gemini: thought parts and signatures are carried, effort is not set.
- **The outcome signal is per run, not per subtask.** `recordRunOutcome` gives
  every model that served a run the run's single success or failure.
- **Checks that could give a finer signal already exist:** mechanical
  acceptance checks (`src/core/verification/acceptance.ts`) and T1 review
  verdicts whose gaps name the sections they were found in
  (`src/core/tiers/review.ts`).
- **A WebGPU model already runs in the web app** (`cloud/web/src/lib/localModel`,
  Qwen2.5 0.5B) for chat titles and a 3-way complexity classification.

## 3. Goals and limits

Goals:

1. In the default mode, spend less for the same measured quality.
2. In quality mode, get the best measured result within the ceiling and the
   run budget.
3. Learn effort from this user's own outcomes, the way model choice is learned.

Two limits on the brief, stated plainly:

- **Novelty.** Routing on model and effort together has been studied. What is
  specific to Cascade is combining it with the task graph and the existing
  posterior. This document does not claim the method is new to the world.
- **"Unbreakable."** No router is. The equivalent that can be built and tested
  is a set of invariants that hold whatever the learned part does (section 6).

## 4. Design

### 4.1 One effort scale

```ts
type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max';
```

- `GenerateOptions.effort?: EffortLevel` carries the request.
- Each provider maps the level to its own control. A model declares which
  levels it supports (`ModelInfo.effortLevels`); a model with no control
  declares none.
- A requested level the model lacks becomes the nearest supported level below
  it. The call result reports the level that was **applied**, and only that is
  recorded as evidence.
- The exact native parameters differ by provider and by model generation and
  have changed recently. Each mapping must be checked against the provider's
  current documentation when it is written, not taken from this document.

### 4.2 Route on (model, effort)

The unit the router chooses becomes a pair. A cheap model thinking hard and a
large model thinking lightly are then compared on the same two numbers:
expected success and expected cost.

- **Cost.** Thinking is billed as output. The planned cost of a pair uses the
  mean thinking tokens observed for that (model, effort), with a conservative
  default before any are observed.
- **Success.** Splitting every model's evidence five ways would starve the
  posterior. So the estimate is two parts:
  - the existing posterior per (model, task type), unchanged;
  - a small pooled **effort lift** table per (task type, complexity band,
    effort), shared across models. A model gets its own correction only after
    it has enough samples at that effort.
- **Selection** stays a Thompson draw, now over pairs.

### 4.3 The top-level control

```ts
thinking: { mode: 'none' | 'absolute' | 'maximum', ceiling: EffortLevel }
```

- `none`: effort `none` on every call.
- `absolute`: automatic, never above `ceiling`.
- `maximum`: the highest level each model supports, on every call.
- The run cost cap still applies in every mode, including `maximum`.

### 4.4 How the two quality settings use it

- **Default (`balanced`, and `cost`).** Among pairs whose expected success is
  within a small margin of the best pair, choose the cheapest. This is what
  "cheaper for the same quality" means mechanically. It is a change to how
  `balanced` scores today (quality times cost-efficiency) and is listed in
  section 9.
- **`quality`.** Choose the pair with the highest expected success. Cost only
  breaks ties.

### 4.5 Starting effort by position in the task graph

A mistake in a plan is repeated by every worker under it; a mistake in a leaf
task affects one result. Starting effort follows that.

- The starting level is a prior from tier and from how many graph nodes depend
  on this one (`src/core/orchestration/task-graph.ts`).
- T1 planning and review start higher than T2 decomposition, which starts
  higher than a T3 leaf.
- It is only a prior. Evidence from section 4.7 overrides it.

### 4.6 Raise effort before switching model

When a subtask fails a check:

1. If the model is below the ceiling and the effort lift table predicts a
   gain worth its cost, retry on the same model one level up.
2. Otherwise switch model through the existing failover path.

The prototype allows one effort raise per subtask. The level that passed is
recorded, which is how the lift table learns.

### 4.7 A per-subtask quality signal

Effort cannot be learned from "the run succeeded". Outcomes are recorded per
subtask, from these sources, most trusted first:

| Source | Cost | Exists today |
|---|---|---|
| Mechanical acceptance check | none | yes |
| T1 review gap attributed to a section | none extra | yes |
| Sampled judge call | one cheap call | no |
| Explicit user rating | none | yes, per run |
| Run outcome | none | yes, per run |

The judge:

- runs on a sample of subtasks, and on every exploratory pick;
- uses a different, cheap model from the one that produced the answer;
- counts toward the run budget, has its own share cap, and stops when the run
  is wrapping up;
- is weighted below mechanical checks in the posterior.

### 4.8 WebGPU difficulty hint (web app only)

- The on-device classifier already returns a 3-way complexity. It gains a
  difficulty hint sent with the run.
- The hint may move a subtask's **starting** level by at most one step.
- It is client-supplied, so it never raises the ceiling, never changes a
  budget, and is ignored when absent or malformed.
- CLI and desktop use the server-side `TaskAnalyzer` profile for the same
  input.

### 4.9 Budget and visibility

- Preflight cost estimates and the run budget include expected thinking
  tokens.
- When a run is wrapping up, effort drops to the lowest level that still
  produces an answer.
- `/why` and the routing data show the effort applied to each call and the
  reason.

## 5. What a call looks like, end to end

1. The subtask is profiled (type, complexity), plus the WebGPU hint on web.
2. The starting level comes from tier, graph position and the hint.
3. The router draws over (model, effort) pairs under the ceiling and the
   affordable-call limit.
4. The provider applies the nearest supported level and reports it.
5. Checks run. A failure may raise effort once, then switches model.
6. The outcome is recorded against the applied (model, effort).

## 6. Invariants

These hold regardless of what the learned part decides, and each gets a test.

1. Effort never exceeds the ceiling. `none` never sends a thinking request
   where the provider allows turning it off.
2. Effort never breaks a call. An unsupported level is lowered, and a
   parameter-shape rejection retries once without effort.
3. The run cost cap is the hard limit in every mode.
4. Evidence is recorded only for the effort that was applied, and only for
   calls that reached a provider.
5. Existing thinking-state replay is untouched: OpenAI reasoning items, Gemini
   thought signatures, Anthropic thinking blocks alongside tool calls.
6. With the flag off, every request is byte-identical to today's.

## 7. Staged delivery

| Stage | Content | Routing change |
|---|---|---|
| 0 | `effort` in `GenerateOptions`, provider mappings, the top-level control, the Anthropic id fix | none; fixed per-tier levels |
| 1 | Per-subtask outcomes; applied effort recorded | none; data only |
| 2 | (model, effort) selection, the lift table, the effort raise, behind a flag | yes |
| 3 | Sampled judge | yes |
| 4 | WebGPU hint in the web app | yes, web only |

Each stage is reviewed from its own diff and tests.

## 8. How we will know it works

- A fixed set of tasks with mechanical acceptance checks, run with the flag
  off and on.
- Default mode passes when the acceptance pass rate is not lower and cost per
  passed task is lower.
- Quality mode passes when the acceptance pass rate is higher.
- If neither holds after stage 2, the routing stages are not shipped and
  stage 0 stays as a manual control.

## 9. Open decisions

1. **Naming.** "absolute" may read as "fixed" to users. Suggested label in the
   UI: "Auto", with the ceiling beside it. The config key can keep any name.
2. **Default ceiling** for `absolute`. Suggested: `high`.
3. **Changing `balanced`** to "cheapest within a margin of the best" (section
   4.4), and the size of that margin.
4. **Pinned models.** When a user pins a model for a tier, is effort still
   automatic for it? Suggested: yes, within the ceiling.
5. **Judge spend.** Sample rate and its share of the run budget. Suggested
   start: 10% of subtasks, at most 5% of run spend.
6. **Shared data.** Whether effort outcomes join the shared routing data that
   opted-in users contribute, or stay local at first.

## 10. Risks

- **Sparse evidence.** The lift table pools across models to compensate; a
  model that responds unusually to effort is learned slowly.
- **Judge error.** A cheap judge can be wrong. It is down-weighted and never
  overrides a mechanical check.
- **Latency.** Higher effort is slower. Speed is not a goal here, so a run can
  get slower while getting cheaper or better.
- **Provider drift.** Thinking controls change between model generations.
  Invariant 2 keeps a wrong mapping from failing a run, at the price of
  silently running without thinking until the mapping is fixed.
