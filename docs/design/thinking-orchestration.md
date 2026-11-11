# Thinking as a routed resource

Status: **draft for discussion, revision 2.** Nothing here is implemented and
nothing here approves code. Section 9 lists the decisions still open; none of
them has been decided by the maintainer yet.

Revision 2 answers the council review on PR #340. Claude's position on each
point is recorded here and on the review threads:

- **A, control semantics:** accepted. Models declare a capability class, and
  an effort that cannot be honoured is never mapped silently (4.1, 4.3,
  invariants 1 and 2).
- **B, statistical identification:** accepted. Effort lift is learned only
  from randomized, propensity-logged assignments; retries are kept separate
  (4.2, 4.6).
- **C, budget enforcement:** accepted with one change. Calls are capped to
  what was reserved instead of reserving each model's worst case, because the
  router deliberately moved away from worst-case reservation (4.9).
- **D, evaluation:** accepted in full (section 8).

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
- Each provider maps the level to its own control. Every model declares one
  capability class:

  | Class | Meaning |
  |---|---|
  | `controllable` | Lists the levels it accepts, and whether `none` is one of them. |
  | `always-on` | Thinks, and cannot be turned off or lowered. |
  | `no-thinking` | Has no thinking at all. |
  | `unknown` | Not yet classified. Treated as uncontrolled. |

- **Eligibility is decided at selection time, not at the provider.** A pair
  is only offered to the router if the model can honour that level. A
  requested level between two supported ones becomes the nearest supported
  level **below** it, never above.
- **Nothing is mapped silently to a provider default.** A call on an
  `always-on` or `unknown` model is labelled `uncontrolled` in the result and
  in `/why`, and it contributes no effort evidence.
- The call result reports both the **requested** and the **applied** level.
  Only the applied level is recorded as evidence.
- **Version drift.** If a provider rejects an effort parameter the model was
  declared to accept, the model is reclassified `unknown` for the session and
  the rejection is reported. Whether that call is then retried is governed by
  the mode (4.3).
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

**Identifying the lift.** The router chooses effort from difficulty, so
outcomes from its own choices confound effort with difficulty and model. The
lift table is therefore not learned from them.

- A small, budget-bounded share of calls has its effort **randomized** among
  the eligible levels around the chosen one. Each records the probability
  with which its level was assigned.
- The lift is estimated only from those calls, within strata of (task type,
  complexity band, model family), weighted by the logged probability.
- Each estimate carries an interval. A level is preferred over a cheaper one
  only when the interval excludes "no lift".
- **No extrapolation.** A stratum with too few randomized samples has no
  lift estimate; the router uses the starting prior from 4.5 there.
- Model-specific corrections are kept, under the same rules.
- Randomized calls never exceed the ceiling and count toward the run budget.

### 4.3 The top-level control

```ts
thinking: { mode: 'none' | 'absolute' | 'maximum', ceiling: EffortLevel }
```

- `none`: only models that can run without thinking are eligible
  (`controllable` with `none`, or `no-thinking`). `always-on` and `unknown`
  models are excluded from automatic selection.
- `absolute`: automatic, never above `ceiling`. `always-on` and `unknown`
  models are excluded from automatic selection, because their effort cannot
  be shown to respect the ceiling.
- `maximum`: the highest level each model supports, on every call. The
  ceiling does not apply in this mode; that is its purpose.
- The run budget applies in every mode, including `maximum`.
- **Fail closed.** If a mode leaves no eligible model, or the user has pinned
  a model the mode excludes, the run does not quietly proceed with
  uncontrolled thinking. What it does instead is open decision 7.

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

The prototype allows one effort raise per subtask.

A retry is not a clean comparison with the first attempt: it also sees the
failure. So retry outcomes are recorded in their own table, used only to
decide whether raising effort on a retry is worth it. They never feed the
first-attempt lift estimate in 4.2.

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

An estimate of thinking tokens is not a cap. Enforcement works by
reservation:

- **Reserve, then cap the call to the reservation.** Before a call starts, the
  router reserves its input plus an output allowance that includes thinking,
  and sends that allowance as the provider's output-token limit. Where the
  provider enforces the limit over thinking as well as the answer, the call
  cannot spend more than was reserved.
- **Why not each model's worst case.** `admitWork` reserves expected output
  today because reserving the worst case refused the first call of a run on a
  small cap. Capping the call to an affordable allowance gives a bounded
  worst case without that failure.
- **One ledger.** First attempts, effort raises, randomized calls and judge
  calls all reserve from the same run ledger. A reservation is taken
  atomically, so concurrent T2 and T3 workers cannot each be admitted against
  the same remaining budget. No call starts without one.
- **Reconciliation.** A reservation is released against reported usage when
  the call settles, including on timeout, cancellation and a stream that
  ends early.
- **When the budget is exhausted**, further work calls are refused and the
  run wraps up, as today.
- **What cannot be guaranteed.** Where a provider has no enforced limit that
  covers thinking, the amount finally billed can exceed the reservation. Such
  a model is marked unbounded, is not offered above its lowest level while a
  cost cap is set, and the limit is stated in the documentation.
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

1. In `absolute` mode, applied effort never exceeds the ceiling. In `none`
   mode, no automatically selected call thinks. Neither mode escalates on its
   own.
2. An effort that cannot be honoured is never replaced silently by a provider
   default. The call is either not offered, refused, or labelled
   `uncontrolled`, according to the mode.
3. No call starts without a budget reservation that fits what is left. Where
   the provider enforces the output limit, spend cannot exceed the cap; where
   it does not, that is documented and the model is restricted (4.9).
4. Evidence is recorded only for the effort that was applied, and only for
   calls that reached a provider.
5. Existing thinking-state replay is untouched: OpenAI reasoning items, Gemini
   thought signatures, Anthropic thinking blocks alongside tool calls.
6. With the flag off, every request is byte-identical to today's.

## 7. Staged delivery

| Stage | Content | Routing change |
|---|---|---|
| 0 | `effort` in `GenerateOptions`, provider mappings, the top-level control, the Anthropic id fix | none; fixed per-tier levels |
| 1 | Per-subtask outcomes; requested and applied effort and assignment probability recorded; the reservation ledger | none; data only |
| 2 | Randomized effort assignment, (model, effort) selection, the lift table, the effort raise, behind a flag | yes |
| 3 | Sampled judge | yes |
| 4 | WebGPU hint in the web app | yes, web only |

Each stage is reviewed from its own diff and tests.

## 8. How we will know it works

**Controlled comparison.** Baseline routing against effort-aware routing on:

- the same stratified task set (by task type and complexity), each with
  mechanical acceptance checks;
- the same provider and model versions, recorded with the results;
- the same run budget.

**Reported for both arms:**

- acceptance pass rate, with confidence intervals;
- total spend per successful task;
- p50 and p95 latency;
- exploration and judge overhead, as a share of spend.

**Pass conditions.**

- Default mode: pass rate not lower beyond its interval, and spend per
  successful task lower.
- Quality mode: pass rate higher beyond its interval.
- If neither holds after stage 2, the routing stages are not shipped and
  stage 0 stays as a manual control.

**Acceptance tests named by the review.**

- A capability matrix per provider and model: `none`, an unsupported level,
  tool calls and a rejected parameter, asserting requested against applied
  effort and no unintended escalation.
- Synthetic no-lift and positive-lift data: the estimator is calibrated and
  shows no preference for high effort when there is no lift.
- Budget: concurrent fan-out, timeout, retry, streamed-usage reconciliation
  and judge overhead, proving that no unreserved call starts.

**Rollback.** Everything from stage 2 on sits behind one flag. Turning it off
restores today's requests (invariant 6).

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
7. **When a mode excludes the only available model, or a pinned one.**
   Options: refuse the run with a message naming the model and the mode, or
   run it labelled `uncontrolled` after a visible notice. Suggested: refuse
   under automatic selection; for a pinned model, run with the notice, since
   the pin is the user's explicit choice.
8. **Randomized share.** How many calls have their effort randomized, and its
   share of the run budget. Suggested start: 5% of calls, at most 3% of run
   spend, and none on runs with a cost cap below a set floor.

## 10. Risks

- **Sparse evidence.** Learning only from randomized calls is slower than
  learning from every call. Until a stratum has support, effort there is the
  fixed prior, so early gains will be small.
- **Judge error.** A cheap judge can be wrong. It is down-weighted and never
  overrides a mechanical check.
- **Latency.** Higher effort is slower. Speed is not a goal here, so a run can
  get slower while getting cheaper or better.
- **Provider drift.** Thinking controls change between model generations. A
  wrong mapping is reported and the model is reclassified, which can make a
  model unavailable in `none` and `absolute` until the mapping is fixed.
