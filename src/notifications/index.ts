// ─────────────────────────────────────────────
//  Cascade AI — Desktop Notifications + Webhooks
// ─────────────────────────────────────────────

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
      applicable.map(async (w) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 5_000);
        try {
          await fetch(w.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(w.secret ? { 'X-Cascade-Secret': w.secret } : {}),
              ...(w.headers ?? {}),
            },
            body: JSON.stringify({ event, payload, timestamp: new Date().toISOString() }),
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      }),
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
