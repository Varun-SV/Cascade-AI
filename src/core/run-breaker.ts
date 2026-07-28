// ─────────────────────────────────────────────
//  Cascade AI — Run circuit breaker
// ─────────────────────────────────────────────
//
//  A run used to discover the same fatal fact once per subtask. When a tier's
//  model was unreachable — expired key, wrong model id, exhausted quota — every
//  worker failed identically, each got its own retry, and the workers queued
//  behind them were still scheduled. A six-subtask plan spent twelve worker
//  calls plus the whole T1/T2 planning overhead to learn one thing: the key is
//  dead. Then it apologised.
//
//  This breaker makes the run learn it once. Failures are recorded with their
//  classification (see router/provider-errors.ts); when enough SYSTEMIC ones
//  pile up against the same model, the breaker trips and the orchestrator stops
//  launching work that is certain to fail the same way.
//
//  Two deliberate limits on when it trips:
//
//    · Only systemic kinds count. A safety refusal or an over-long prompt is a
//      property of one subtask, not of the model, and must not stop the run.
//    · The count is per MODEL. One dead tier should not abort work that a
//      different, healthy tier is doing perfectly well.
//
//  Tripping is not an error condition — it is the run choosing to stop paying
//  for a known-bad outcome. The reason is carried out to the user verbatim, so
//  they get "quota exhausted on gemini-2.0-flash" instead of "system errors".

import {
  classifyProviderError,
  describeProviderError,
  type ClassifiedError,
} from './router/provider-errors.js';

/** Systemic failures against one model before the run stops trying it. */
export const DEFAULT_FAILURE_THRESHOLD = 3;

export interface BreakerTrip {
  modelId: string;
  kind: ClassifiedError['kind'];
  /** How many systemic failures on this model were seen before tripping. */
  failures: number;
  /** User-facing explanation, including the provider's own words. */
  message: string;
}

export class RunBreaker {
  private readonly threshold: number;
  /** modelId → consecutive systemic failures of the SAME kind. */
  private counts = new Map<string, { kind: ClassifiedError['kind']; n: number; last: ClassifiedError }>();
  private trip: BreakerTrip | null = null;

  constructor(threshold: number = DEFAULT_FAILURE_THRESHOLD) {
    this.threshold = Math.max(1, threshold);
  }

  /**
   * Record a failed model call. Returns the trip if this failure is the one
   * that opened the breaker, otherwise null.
   *
   * A non-systemic failure RESETS the model's counter: it is evidence the model
   * is reachable and answering, which is exactly what a systemic streak claims
   * it is not.
   */
  record(err: unknown, modelId: string | undefined): BreakerTrip | null {
    if (this.trip) return null;               // already open — first reason wins
    const id = modelId?.trim() || 'unknown-model';
    const c = classifyProviderError(err);

    if (!c.systemic) {
      this.counts.delete(id);
      return null;
    }

    const prev = this.counts.get(id);
    // A different systemic kind restarts the count: alternating 429/404 is not
    // three of anything, and the message we'd show would name the wrong cause.
    const n = prev && prev.kind === c.kind ? prev.n + 1 : 1;
    this.counts.set(id, { kind: c.kind, n, last: c });

    if (n >= this.threshold) {
      this.trip = {
        modelId: id,
        kind: c.kind,
        failures: n,
        message: describeProviderError(c, id),
      };
      return this.trip;
    }
    return null;
  }

  /** True once the run should stop launching work that would fail identically. */
  isOpen(): boolean {
    return this.trip !== null;
  }

  /** Why the breaker opened, or null while it is closed. */
  reason(): BreakerTrip | null {
    return this.trip;
  }

  /**
   * One line for a worker/section that never ran because the breaker was
   * already open. Says the work was skipped deliberately — not that it failed
   * on its own merits, which is what an empty FAILED status would imply.
   */
  skipMessage(): string {
    const t = this.trip;
    if (!t) return 'Skipped.';
    return `Skipped — the run stopped after ${t.failures} consecutive failures on ${t.modelId}. ${t.message}`;
  }

  /** Test/diagnostic view of the per-model streaks. */
  streaks(): Record<string, { kind: string; n: number }> {
    const out: Record<string, { kind: string; n: number }> = {};
    for (const [k, v] of this.counts) out[k] = { kind: v.kind, n: v.n };
    return out;
  }
}
