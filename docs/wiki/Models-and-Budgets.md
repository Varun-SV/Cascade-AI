# Models, Auto Routing and Budgets

## Supported provider adapters

The source includes Anthropic, OpenAI, Gemini, Azure OpenAI, Ollama, and OpenAI-compatible provider adapters. Not every provider exposes the same modalities or models. Verify actual account/deployment access and configure a vision-capable model for image tasks.

## Auto vs pinned tiers

By default, Cascade can choose a model for each tier/task. The `autoBias` setting has `balanced`, `quality` and `cost` preferences. Pinning `models.t1`, `models.t2`, or `models.t3` overrides the corresponding Auto selection. A pinned model is not silently replaced just to save budget.

Auto combines:
1. Task classification and model capabilities.
2. Benchmark quality scores for the relevant task, with per-modality data where available.
3. Provider pricing and actual local/remote cost distinctions.
4. Historical user feedback and model performance, with exploration to prevent established models permanently crowding out newcomers.
5. Availability and failure-aware failover.

Benchmarks are **not** all measurements of identical quality: the aggregation process normalizes source scales, records provenance, and has a committed fallback. Maintainer approximations are labeled `seed-approximation`, not asserted to be exact live measurements.

## Per-run spending caps

A capped run reserves **20%** of the available cost/token budget for writing a final answer; work planning, managers and workers normally use the remaining **80%**. The planner attempts to fit sections/workers and their dependencies into the affordable portion. As the cap approaches, a bounded set of cheaper eligible models can be preferred on Auto tiers. Work that does not fit is not started. The result should state when planned work was omitted.

This is a *budget-control policy*, not a guarantee of an exact provider invoice: upstream token measurement, pricing and in-flight requests can introduce differences.

## Useful controls

```text
/model          # select a provider, tier and model
/models         # inspect available models
/rate good      # give positive feedback on the last run
/rate bad       # report a poor result
/why            # explain the router decision
/cost           # show cost and delegation estimates
/budget         # inspect or change the session budget
```

Local endpoints should be marked local only when the compute genuinely belongs to you. A rented Ollama server is not automatically free.

Sources: [router](https://github.com/Varun-SV/Cascade-AI/tree/main/src/core/router), [run-budget policy](https://github.com/Varun-SV/Cascade-AI/blob/main/src/core/router/run-budget.ts), [benchmark methodology](https://github.com/Varun-SV/Cascade-AI/blob/main/docs/benchmark-aggregation.md), [config schema](https://github.com/Varun-SV/Cascade-AI/blob/main/src/config/schema.ts).
