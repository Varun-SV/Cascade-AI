# Benchmark aggregation

Cascade Auto routes each subtask to the model that is actually strongest at it, by
multiplying a **0–100 quality score** (per model family, per task type) against live
cost. Those quality scores live in `src/core/router/benchmark-data.json` and are
fetched live from GitHub raw at runtime (`LiveDataProvider`), with a bundled table as
the offline fallback.

This document describes how that snapshot is produced from real benchmark sources —
conservatively, so routing stays honest about the quality-to-cost trade-off.

## The idea

Different benchmark sites measure quality on incompatible scales:

- **Terminal-Bench / SWE-bench Verified** — raw solve rate `%`, and a harder board
  gives every model a lower number (Gemini 3.8 Flash: 81% on Terminal-Bench 2.1,
  20% on 4.0).
- **Vals Index** — a weighted `%` over finance, coding, legal and tax agent tasks.
- **LMArena** — Elo-like ratings (~1000–1550).

You cannot take "the lowest of 80 and 77" across those until they mean the same thing.
So the aggregator does two steps:

1. **Normalize** every source onto a common 0–100 quality scale.
2. **Aggregate conservatively**: for each `family × task`, take the **lowest** value
   across the sources that cover it. We would rather under-claim quality than pay for
   quality that isn't reliably there.

## Normalization

Each source declares a `scale`, which implies a linear band `raw → (raw − min)/(max − min) · 100`:

| `scale`      | default band      | meaning                                            |
| ------------ | ----------------- | -------------------------------------------------- |
| `index0-100` | `0 … 100`         | already a 0–100 quality index → identity           |
| `percent`    | `0 … 100`         | a raw accuracy %                                   |
| `elo`        | `eloFloor … eloCeil` (default `1000 … 1500`) | Arena Elo → 0–100 |

A source may override the band **per task** via `calibration`:

```json
"calibration": { "code": { "min": 0, "max": 90 } }
```

Bands are **fixed**, not within-source min–max, so a model's score does not move just
because another model was added to (or dropped from) a capture.

### Anchors and `fitTo`

A fixed band per source is not enough once two sources rate the same task at different
difficulty: "the lowest of Terminal-Bench 2.1 and 4.0" would only ever report which
board is harder. So each task has one **anchor** source with a fixed band, and every
other source for that task is **fitted onto the anchor**:

```json
"calibration": { "code": { "fitTo": "vals-terminal-bench-2-1" } }
```

The aggregator takes the models both sources rate, fits a Theil–Sen line from this
source's raw numbers to the anchor's (the median of pairwise slopes, so one model run
under a broken config cannot tilt it), and normalizes through the anchor's band. A fit
needs **≥ 5 shared models**, a positive slope and **Spearman ≥ 0.6**; otherwise the task
is skipped for that source with a warning. Every fit is printed on every refresh:

```
fit vals-terminal-bench-4.code → vals-terminal-bench-2-1: n=19, y = 0.233x + 72.2, spearman 0.70
fit vals-swebench-verified.code → vals-terminal-bench-2-1: n=21, y = 1.417x + -50.6, spearman 0.89
```

| task              | anchor (fixed band)                          |
| ----------------- | -------------------------------------------- |
| `code`, `agentic` | Vals Terminal-Bench 2.1, `0 … 90`            |
| `analysis`, `data`| Vals Index, `0 … 73`                         |
| `creative`        | LMArena creative writing, `1000 … 1550` Elo  |

## Conservative aggregation

For each `family × task`, in order:

1. **Primary sources.** Gather the normalized values from every source that covers the
   cell, then:
   - **`robust` (default for the refresh)** — when **≥ 3** sources cover the cell, drop
     the single lowest as a possible mis-capture and take the next-lowest; with fewer
     than 3, fall back to `min`.
   - **`min`** — take the single lowest. Force with `BENCHMARK_AGG_MODE=min`.
2. **Fallback sources** (`"role": "fallback"`) — only when no primary source rates the
   cell. A fallback never moves a cell a real measurement covers.
3. **Imputed** — the mean of the family's own measured cells this run. A task no board
   has run the model on is assumed to sit at the model's general level, never above it.
   `agentic` is never imputed: a tool loop nobody measured is not assumed to hold.
4. **Baseline** — the committed value, only for a family nothing measures at all (today:
   the local Ollama families).

(The pure `buildFamilies` engine still defaults to `min`; the refresh script opts into
`robust` unless `BENCHMARK_AGG_MODE=min` is set.)

A family is emitted once it has all four task scores; `agentic` is optional.

Every score carries an auditable trace — run with `--explain` (or `BENCHMARK_EXPLAIN=1`)
to see which source set each value and what every source reported:

```
claude-fable-5
  code       91  [robust]  vals-swebench-verified=93, vals-terminal-bench-2-1=89, vals-terminal-bench-4=91
  analysis   85  [fallback]  general-fallback-terminal-bench-4=85
  creative   91  [robust]  lmarena-creative-writing=91
  agentic    89  [robust]  aa-tau2-bench-telecom=89, vals-swebench-verified=93, vals-terminal-bench-2-1=89, vals-terminal-bench-4=91
```

## Sources

One JSON file per board in `scripts/benchmarks/sources/` (text sources, as of 2026-10-28):

| file | measures | tasks | provenance |
| --- | --- | --- | --- |
| `vals-terminal-bench-2-1` | 89 terminal tasks, one harness | code, agentic (**anchor**) | captured |
| `vals-terminal-bench-4` | 66 long-horizon terminal tasks | code, agentic (fitted) | captured |
| `vals-swebench-verified` | real GitHub issues, bash-only agent | code, agentic (fitted) | captured |
| `aa-tau2-bench-telecom` | multi-turn tool use under a policy | agentic (fitted) | mirror-captured |
| `vals-index` | finance/coding/legal/tax agent work | analysis, data (**anchor**) | captured |
| `general-fallback-terminal-bench-4` | Terminal-Bench 4.0 fitted to the index | analysis, data (fallback) | derived |
| `lmarena-creative-writing` | human preference on writing | creative (**anchor**) | mirror-captured |
| `openai-gpt-5.6-2026-08` | OpenAI's GPT-5.6 launch evals | all four | captured |

```json
{
  "source":     "vals-terminal-bench-4",
  "label":      "Vals AI · Terminal-Bench 4.0 (mini-swe-agent, bash only, avg@3)",
  "url":        "https://www.vals.ai/benchmarks/terminal-bench-4",
  "capturedAt": "2026-10-28",
  "provenance": "captured",
  "scale":      "percent",
  "calibration": { "code": { "fitTo": "vals-terminal-bench-2-1" }, "agentic": { "fitTo": "vals-terminal-bench-2-1" } },
  "models":     { "claude-opus-5.5": { "code": 65.15, "agentic": 65.15 } }
}
```

- Family keys are one per model **version** and match `resolveFamily` in
  `src/core/router/benchmarks.ts`: `claude-opus-5.5`, `gpt-6.1-sol`, `gemini-3.8-flash`, …
  A single `claude-opus` row used to score Opus 4.5 and Opus 5.5 identically, though
  Terminal-Bench puts them over twenty points apart.
- A source may cover only some families and only some task types — the aggregator uses
  whatever cells are present.
- Malformed rows/files are skipped with a warning, never aborting the refresh.
- `role: "fallback"` marks a source that only fills cells no primary source rates.

### Provenance and honesty

Every committed text source is a real capture. The three `seed-approximation` files that
used to ship (maintainer-typed numbers labelled Artificial Analysis, LMArena and "suite
leaderboards") were removed on 2026-10-28: they still rated GPT-4o at 85 for code and
Gemini 2.5 Flash at 82 when every agentic board put them near 50, and Auto was routing a
majority of picks to models their providers had since deprecated. A test now fails if a
`seed-approximation` text source is added back. To improve accuracy, re-read the board at
each source's `url`, replace the numbers, set a fresh `capturedAt`, and commit. **Do not
invent numbers**; leave a cell out rather than guess.

`derived` (new) marks a source computed from a captured one by a documented fit, such as
the Terminal-Bench 4.0 fallback.

The refresh also maintains two compatibility rules in `scripts/refresh-benchmarks.mjs`:

- **Legacy keys.** Cascade fetches this file live from GitHub, so builds released before
  the version split still look up `claude-opus`, `claude-sonnet` and `claude-haiku`. Those
  keys are kept as copies of `claude-opus-5`, `claude-sonnet-5` and `claude-haiku-4.5`.
- **Dropped families.** A family nothing measures any more and whose model its provider
  has shut down (`gemini-1.5-pro`, `gemini-2.0-flash-lite`, `gpt-4o-mini`) is removed, so it
  reads as the neutral 0.5 instead of a confident seed.

> **Why not OpenRouter rankings here?** OpenRouter's rankings measure token *popularity*,
> not per-task quality, so folding them into a quality-min would be a category error.
> OpenRouter is already wired as Cascade's live **pricing + capability** source
> (`LiveDataProvider.fetchCatalog`), which is where it belongs.

## Running it

```bash
node scripts/refresh-benchmarks.mjs            # aggregate sources → benchmark-data.json
node scripts/refresh-benchmarks.mjs --explain  # print the per-cell provenance trace
BENCHMARK_AGG_MODE=robust node scripts/refresh-benchmarks.mjs
BENCHMARK_AGG=off node scripts/refresh-benchmarks.mjs   # skip the aggregator
```

The script writes `benchmark-data.json` **only when the scores actually change**, so a
no-op run produces no diff. An optional `BENCHMARK_SOURCE_URL` still fetches a
pre-normalized families map and merges it *over* the aggregate for specific families.

`.github/workflows/refresh-benchmarks.yml` runs this weekly (and on demand) and opens a
data-only PR when the snapshot changes. Editing a source file and pushing it is enough;
the next scheduled run re-aggregates and proposes the update.

## Where the scores are used

`benchmarkScore01(model, taskType, agenticWeight)` in `src/core/router/benchmarks.ts`
resolves a model to its family, reads the live/cached snapshot (falling back to the
bundled copy of this same file — there is no separate hand-typed table any more), and
returns the 0–1 strength the router multiplies against cost. Azure deployments resolve
through their `baseModelId`, so a deployment named `prod-fast` still scores as its real
base model.

`agenticWeight` blends in the `agentic` score. Cascade Auto passes **0.5 for T1 and T2**
(they plan, brief, check and hand off in tool loops; when one of them drops a call the
whole wave under it is stranded), **0.35 for a T3 worker that calls tools**, and 0 for
one that only writes (`agenticWeightFor` in `task-analyzer.ts`).

### Model lifecycle

Scores alone cannot keep Auto off a model the provider is shutting down — a deprecated
model can still score well. `src/core/router/lifecycle.ts` records what Anthropic, OpenAI
and Google have published (`retired`, `deprecated`, `restricted` to existing customers,
or `superseded` by an auto-routed newer id), and the selector keeps those models out of
Auto's candidates, chains and failovers. A user can still **pin** one, and Auto still
falls back to one when nothing else is usable. The tier chains in `src/constants.ts` hold
only fully served models, which `lifecycle.test.ts` enforces.

### Reviewing a refresh

`npx tsx scripts/benchmarks/routing-snapshot.ts` prints Auto's pick for every provider set
× bias × tier × task type, from the benchmark data alone (no history, no feedback). Run it
before and after a data change and diff the two to see what the change does to routing.

## Non-text modalities

Cascade's routing scope is expanding beyond text/chat to every kind of model on the
market — vision, image generation, video generation, speech-to-text, text-to-speech,
music generation, embeddings/reranking. Those modalities aren't wired into
`benchmarkScore01`/`TaskType` yet (that's a router change, not a data change), but the
**data side** ships ahead of it: a `modalities` section in `benchmark-data.json`,
additive and backwards-compatible with everything above — a consumer that only knows
about `families` never has to look at it.

### Why a different normalization

The text pipeline above normalizes each source onto a common 0–100 scale via a fixed
band (`scale` + optional `calibration`), because its four task types share a reasonably
stable meaning across sources. Non-text modalities don't: an LMArena image-generation
Elo, a Word Error Rate, and an MTEB retrieval nDCG@10 have no shared unit at all, and
unlike text Elo there's no well-established floor/ceiling to anchor a band against. So
modality sources are normalized by **percentile rank within that source's own model
set** instead — `scripts/benchmarks/modality-aggregate.mjs`. A model's score says only
"how this model compared to the other models this same source also rated," which is
always well-defined no matter what the source's raw units are. This is the core rule
for the whole redesign: **never compare a raw number from one source against a raw
number from another** — normalize first, in that source's own terms, always.

Percentile rank uses the standard mid-rank formula (ties split the difference):
`rank(v) = (countBelow(v) + 0.5 * countEqual(v)) / n * 100`. A source with only one
model normalizes to a neutral 50 — with nothing to compare against, no claim is made.
`lowerIsBetter: true` on a source (e.g. a WER-based speech-to-text source) flips which
direction counts as "below."

Once every source is in percentile terms, cross-source aggregation is the *same*
conservative policy as the text pipeline (imported from `aggregate.mjs`, not
reimplemented): the lowest value per family, or `robust` mode's "drop one low outlier
when ≥ 3 sources cover the cell."

### Modality source files

Same directory, `scripts/benchmarks/sources/*.json`, distinguished by a `modality` key
the legacy text loader (`sources.mjs`) skips over:

```json
{
  "source":     "hf-open-asr-leaderboard-shortform",
  "modality":   "speech-to-text",
  "metric":     "Open ASR Leaderboard English short-form average WER %",
  "label":      "Open ASR Leaderboard (short-form)",
  "url":        "https://raw.githubusercontent.com/huggingface/open_asr_leaderboard/main/scripts/data/en_shortform.csv",
  "capturedAt": "2026-09-21",
  "provenance": "captured",
  "lowerIsBetter": true,
  "models": { "openai/whisper-large-v3": 7.44, "nvidia/parakeet-tdt-0.6b-v2": 6.05 }
}
```

No `scale`/`calibration` — the raw number's units don't matter, only its rank among the
other models the same source rates. A source may cover as many or as few models and
families as it has real data for.

### Provenance values

- **`captured`** — read from the primary source itself (its own page, or a data file the
  primary source's own maintainers publish — e.g. the MMMU project's or Hugging Face's
  own GitHub repo).
- **`captured-via-search`** — the primary source's page couldn't be fetched directly
  (blocked, dynamic-JS-rendered, etc.), but a search result surfaced a direct quote of
  its published numbers, with attribution. Real numbers, one hop removed from the page.
- **`mirror-captured`** — read from a third-party mirror/scraper of the primary source
  (not the vendor's own infrastructure), used because the vendor's domain was
  unreachable from the research environment. Its legitimacy (real project, transparent
  methodology, not a ToS violation) should be checked before trusting it, and this is
  strictly lower-confidence than `captured` — treat it as a candidate for replacement by
  a direct `captured` read once the source becomes reachable.
- **`seed-approximation`** — maintainer-approximated starting values, not a real
  capture. As with the text pipeline: honestly labelled, never invented to fill a gap.

### Family keys are per-modality

Unlike the text pipeline's `families`, which key against Cascade's canonical chat-model
families (`resolveFamily` in `benchmarks.ts`), modality family keys are whatever the
source calls the model (kept close to the source's own naming, lightly slugified) —
there is no shared `resolveFamily`-style canonicalization across image/video/audio
model names yet, and inventing one without real usage data would be exactly the kind of
guess the integrity rule rules out.

### What percentile rank does NOT give you

Normalizing within a source removes the unit problem and introduces a population
problem in its place, and the second one is not solved yet. **A percentile is a rank
inside one source's own model set.** Being the best of five open-weights models and
being the best of a forty-model blended arena both come out near 100, and nothing in
the number says which happened. Reading two such scores off one 0-100 axis is only
valid when the sources share enough models to anchor one to the other.

The committed text-to-speech pair is the live example: `text-to-speech-aa-arena`
rates eight models, `text-to-speech-aa-open-weights` rates five, and **they share
none**. There is no measurement linking the two populations, so no amount of
arithmetic here can calibrate them — the information simply is not in the data.

So the aggregator reports the condition instead of hiding it. `cohortOverlap()`
returns `{ sources, families, shared, components, disjoint }` per modality, and it
**ships in `benchmark-data.json` as `modalityComparability`** — beside the scores it
qualifies, not only in the refresh log, so a consumer reads both from the same file.

- `components` is the number of connected islands in the source-overlap graph. Two
  sources that share a model are one island; a third that shares nothing with either
  is a second. `disjoint` is `components > 1`.
- `shared` is how many models more than one source rates — the anchors calibration
  would actually need.
- `carriedFamilies` is how many cells were kept from the previous snapshot because
  no source covered them this run. Those scores were measured against a population
  that is not present, so a run that carries anything cannot claim its cohorts are
  connected — the absent source counts as its own component. Without that, skipping
  one of two disjoint sources would leave its scores in the file while the metadata
  reported one source, one component and `disjoint: false`: the gate saying yes to
  exactly the values it exists to refuse.

**Both matter, and neither is sufficient alone.** Counting shared models says A and B
are linked and says nothing about C, which is why connectivity is measured rather than
occurrence. And `components === 1` is necessary but not sufficient: the committed
`embeddings` pair is connected by exactly **one** shared model out of sixteen — a
bridge in the graph sense, nowhere near a calibration.

Over the committed sources today, **two modalities are disjoint: `text-to-speech` and
`vision`** (the second found by running the measure rather than by reasoning about the
first).

**Before `modalities` drives routing**, a consumer must require `components === 1`
*and* enough `shared` anchors to mean it, or keep each source's percentiles separate
rather than collapsing them onto one axis. Treating today's values as comparable
quality scores would rank a small model top of a weak field above a strong model
mid-field in a hard one. `modality-aggregate.test.mjs` pins that failure mode with a
disjoint strong-vs-weak pair, pins the unconnected-third-source case, and asserts the
committed TTS and vision sources are disjoint — so a future refresh that adds a
bridging source shows up as those tests changing.

### Running it

The same `node scripts/refresh-benchmarks.mjs` run aggregates both pipelines in one
pass — text sources into `families`, modality sources into `modalities` — and writes
`benchmark-data.json` only when either section actually changed. `--explain` /
`BENCHMARK_EXPLAIN=1` prints both traces; `BENCHMARK_AGG=off` skips both aggregators.
