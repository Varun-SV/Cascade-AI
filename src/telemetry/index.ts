// ─────────────────────────────────────────────
//  Cascade AI — Opt-in Telemetry (PostHog)
// ─────────────────────────────────────────────

import type { TaskComplexity, TelemetryConfig, TierRole } from '../types.js';

// ── Typed event catalogue ──────────────────────

export interface TelemetryEvents {
  'cascade:session_start': {
    complexity?: TaskComplexity;
    providerCount: number;
    cascadeAutoEnabled: boolean;
    toolCreationEnabled: boolean;
  };
  'cascade:session_end': {
    durationMs: number;
    taskCount: number;
    totalTokens: number;
    totalCostUsd: number;
  };
  'cascade:task_complete': {
    complexity: TaskComplexity;
    tier: TierRole | 'simple';
    durationMs: number;
    tokenCount: number;
    costUsd: number;
    t2Count: number;
    t3Count: number;
  };
  'cascade:task_failed': {
    tier: TierRole;
    errorType: string;
    complexity?: TaskComplexity;
  };
  'cascade:tool_executed': {
    toolName: string;
    tier: TierRole;
    success: boolean;
    durationMs?: number;
  };
  'cascade:tool_created': {
    name: string;
    description: string;
  };
  'cascade:model_selected': {
    tier: TierRole;
    modelId: string;
    provider: string;
    reason: 'config_override' | 'cascade_auto' | 'priority_list' | 'fallback';
    complexity?: number;
  };
  'cascade:peer_sync': {
    syncType: string;
    tier: 'T2' | 'T3';
    participantCount: number;
  };
  'cascade:escalation': {
    fromTier: TierRole;
    toTier: TierRole | 'user';
    toolName: string;
    approved: boolean;
  };
  'cascade:provider_failover': {
    from: string;
    to: string;
    reason: string;
  };
  'cascade:t2_overlap_detected': {
    sectionCount: number;
    overlapCount: number;
    switchedToSequential: boolean;
  };
  'cascade:file_lock_contention': {
    filePath: string;
    waitMs: number;
  };
}

export type TelemetryEventName = keyof TelemetryEvents;

export class Telemetry {
  private client: unknown = null;
  private enabled: boolean;
  private distinctId: string;

  constructor(config: TelemetryConfig, distinctId: string) {
    this.enabled = config.enabled;
    this.distinctId = distinctId;
    if (config.enabled && config.posthogApiKey) {
      this.init(config.posthogApiKey);
    }
  }

  private init(apiKey: string): void {
    // Dynamically import PostHog to avoid loading it when telemetry is off
    import('posthog-node').then(({ PostHog }) => {
      this.client = new PostHog(apiKey, { host: 'https://app.posthog.com' });
    }).catch(() => { /* PostHog unavailable */ });
  }

  /**
   * Capture a typed telemetry event. Silently no-ops if telemetry is disabled.
   */
  capture<E extends TelemetryEventName>(event: E, properties: TelemetryEvents[E]): void;
  capture(event: string, properties?: Record<string, unknown>): void;
  capture(event: string, properties?: Record<string, unknown>): void {
    if (!this.enabled || !this.client) return;
    try {
      const ph = this.client as { capture: (opts: unknown) => void };
      ph.capture({ distinctId: this.distinctId, event, properties });
    } catch { /* never throw on telemetry */ }
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;
    try {
      const ph = this.client as { shutdown: () => Promise<void> };
      await ph.shutdown();
    } catch { /* ignore */ }
  }
}

// No-op telemetry for when it's disabled
export const noopTelemetry: Pick<Telemetry, 'capture' | 'shutdown'> = {
  capture: () => {},
  shutdown: async () => {},
};
