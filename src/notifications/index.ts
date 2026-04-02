// ─────────────────────────────────────────────
//  Cascade AI — Desktop Notifications + Webhooks
// ─────────────────────────────────────────────

import axios from 'axios';
import notifier from 'node-notifier';
import type { WebhookConfig } from '../types.js';

export class NotificationManager {
  private webhooks: WebhookConfig[];

  constructor(webhooks: WebhookConfig[] = []) {
    this.webhooks = webhooks;
  }

  desktop(title: string, message: string, sound = false): void {
    try {
      notifier.notify({ title, message, sound, appID: 'Cascade AI' });
    } catch { /* desktop notifications not available in all environments */ }
  }

  async webhook(event: string, payload: Record<string, unknown>): Promise<void> {
    const applicable = this.webhooks.filter(
      (w) => w.events.includes(event as never) || w.events.includes('*' as never),
    );

    await Promise.allSettled(
      applicable.map((w) =>
        axios.post(w.url, { event, payload, timestamp: new Date().toISOString() }, {
          headers: {
            'Content-Type': 'application/json',
            ...(w.secret ? { 'X-Cascade-Secret': w.secret } : {}),
            ...(w.headers ?? {}),
          },
          timeout: 5_000,
        }),
      ),
    );
  }

  async taskComplete(title: string, summary: string, durationMs: number): Promise<void> {
    this.desktop('Cascade Task Complete', `${title}\n${summary.slice(0, 100)}`);
    await this.webhook('task:complete', { title, summary, durationMs });
  }

  async taskFailed(title: string, error: string): Promise<void> {
    this.desktop('Cascade Task Failed', `${title}\n${error.slice(0, 100)}`, true);
    await this.webhook('task:error', { title, error });
  }
}
