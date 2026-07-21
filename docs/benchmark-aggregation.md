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

- **SWE-bench Verified** — raw solve rate `%` (frontier tops out near ~75%).
- **MMLU / GPQA / MATH** — raw accuracy `%`.
- **Artificial Analysis** — a 0–100 Intelligence Index.
- **LMArena / Chatbot Arena** — Elo ratings (~1000–1500).

You cannot take "the lowest of 80 and 77" across those until they mean the same thing.
So the aggregator does two steps:

1. **Normalize** every source onto a common 0–100 quality scale.
2. **Aggregate conservatively**: for each `family × task`, take the **lowest** value
   across the sources that cover it. If SWE-bench says a model is 80 for code and Arena
   says 77, routing uses **77** — we would rather under-claim quality than pay for
   quality that isn't reliably there.

## Normalization

Each source declares a `scale`, which implies a linear band `raw → (raw − min)/(max − min) · 100`:

| `scale`      | default band      | meaning                                            |
| ------------ | ----------------- | -------------------------------------------------- |
| `index0-100` | `0 … 100`         | already a 0–100 quality index → identity           |
| `percent`    | `0 … 100`         | a raw accuracy %                                   |
| `elo`        | `eloFloor … eloCeil` (default `1000 … 1500`) | Arena Elo → 0–100 |

A raw benchmark **%** is *not* a quality percentage — SWE-bench Verified near 70% is a
frontier result, not a "70/100". So a source may override the band **per task** via
`calibration`, mapping against a documented reference-max:

```json
"scale": "percent",
"calibration": { "code": { "min": 0, "max": 75 } }
```

Bands are **fixed**, not within-source min–max, so a model's score does not move just
because another model was added to (or dropped from) a capture.

## Conservative aggregation

For each `family × task`, gather the normalized values from every source that covers it,
then:

- **`min` (default)** — take the single lowest. Strict quality-to-cost.
- **`robust`** — when **≥ 3** sources cover the cell, drop the single lowest as a
  possible mis-capture and take the next-lowest; with fewer than 3, fall back to `min`.
  Select with `BENCHMARK_AGG_MODE=robust`.

Any cell **no source covers** keeps its committed baseline value, so partial coverage
never blanks a score. A family is only emitted once it has all four task scores (from
sources or baseline).

Every score carries an auditable trace — run with `--explain` (or `BENCHMARK_EXPLAIN=1`)
to see which source set each value and what every source reported:

```
gpt-5
  code        93  [min]  artificial-analysis=96, lmarena=93, suite-leaderboards=96
  analysis    94  [min]  artificial-analysis=96, lmarena=94, suite-leaderboards=95
```

## Sources

One JSON file per site in `scripts/benchmarks/sources/`:

```json
{
  "source":     "suite-leaderboards",
  "label":      "SWE-bench Verified, MMLU/GPQA, writing evals, MATH/GSM8K",
  "url":        "https://www.swebench.com/ , …",
  "capturedAt": "2026-07-21",
  "provenance": "captured" | "seed-approximation",
  "scale":      "percent",
  "calibration": { "code": { "min": 0, "max": 75 } },
  "models":     { "claude-opus": { "code": 70, "analysis": 87, … } }
}
```

- Family keys match the router's canonical families (see `resolveFamily` in
  `src/core/router/benchmarks.ts`): `claude-opus`, `gpt-5`, `gemini-2.5-pro`, …
- A source may cover only some families and only some task types — the aggregator uses
  whatever cells are present.
- Malformed rows/files are skipped with a warning, never aborting the refresh.

### Provenance and honesty

The committed source files ship as **`seed-approximation`** — maintainer-approximated
starting values, because Artificial Analysis blocks automated fetch and Arena/suite
numbers move. They are honestly labelled, not passed off as exact official captures.
To improve accuracy, read the live leaderboard at each source's `url`, replace the
numbers, set `"provenance": "captured"` and a fresh `capturedAt`, and commit — the next
refresh re-aggregates automatically. **Do not invent numbers**; leave a cell out (partial
coverage) rather than guess, and the baseline holds it.

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

`benchmarkScore01(model, taskType)` in `src/core/router/benchmarks.ts` resolves a model
to its family, reads the live/cached snapshot (falling back to the bundled table), and
returns the 0–1 strength the router multiplies against cost. Azure deployments resolve
through their `baseModelId`, so a deployment named `prod-fast` still scores as its real
base model.
