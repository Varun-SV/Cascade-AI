// ─────────────────────────────────────────────
//  Cascade AI — Opt-in Telemetry (PostHog)
// ─────────────────────────────────────────────

import type { TelemetryConfig } from '../types.js';

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
