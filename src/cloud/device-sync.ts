// ─────────────────────────────────────────────
//  Cascade AI — Sending a device run to the cloud
// ─────────────────────────────────────────────
//
//  How the CLI copies a finished run to the signed-in account: its turn into
//  the session's cloud chat, or, for a run with no turn, what it spent. Both
//  carry the run's own id, so the cloud adds a turn once and counts a run
//  once however often it is sent. Best-effort: nothing here throws.

import type { CloudTurnInput } from './client.js';

/** The calls this needs from the cloud client. */
export interface DeviceSyncClient {
  appendTurn(conversationId: string, turn: CloudTurnInput): Promise<unknown>;
  recordRunSpend(run: {
    conversationId: string | null; outcome: 'answered' | 'failed' | 'stopped'; costUsd: number; why: string; runId?: string; endedAt?: number;
  }): Promise<unknown>;
}

/** The session's link to its cloud chat; `convId` is cleared when the chat is gone. */
export interface DeviceSyncTarget {
  client: DeviceSyncClient;
  convId: string | null;
}

/** The cloud answers 404 for a chat that was deleted, or is not this account's. */
const isGone = (err: unknown) => /\(404\)/.test(err instanceof Error ? err.message : String(err));

/**
 * Copies a turn into the session's chat. A send whose answer was lost is
 * sent once more (the cloud adds it once). A chat that is gone is replaced
 * by a new one, once. If the turn still cannot be added, what the run spent
 * is recorded on its own, under the same run id.
 */
export async function syncTurn(
  target: DeviceSyncTarget,
  turn: CloudTurnInput & { runId: string },
  /** The session's chat, creating it (and setting `target.convId`) if there is none. */
  chat: () => Promise<string>,
): Promise<void> {
  try {
    for (let replaced = false; ;) {
      const convId = await chat();
      try {
        for (let attempt = 0; ; attempt++) {
          try { await target.client.appendTurn(convId, turn); return; } catch (err) {
            if (attempt >= 1 || isGone(err)) throw err;
          }
        }
      } catch (err) {
        if (!isGone(err) || replaced) throw err;
        // Deleted from the web or the desktop while this session was open.
        if (target.convId === convId) target.convId = null;
        replaced = true;
      }
    }
  } catch {
    await syncRunSpend(target, {
      conversationId: null, outcome: turn.outcome ?? 'answered', runId: turn.runId,
      costUsd: turn.assistant.costUsd ?? 0, why: turn.assistant.why ?? '{}',
      ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
    });
  }
}

/**
 * Records what a run with no turn spent, under the session's chat if there
 * is one. If that chat is gone, the link is cleared and the run is recorded
 * on its own, under the same run id.
 */
export async function syncRunSpend(
  target: DeviceSyncTarget,
  run: { conversationId: string | null; outcome: 'answered' | 'failed' | 'stopped'; costUsd: number; why: string; runId: string; endedAt?: number },
): Promise<void> {
  try {
    await target.client.recordRunSpend(run);
  } catch (err) {
    if (!isGone(err) || !run.conversationId) return;
    if (target.convId === run.conversationId) target.convId = null;
    await target.client.recordRunSpend({ ...run, conversationId: null }).catch(() => { /* best-effort */ });
  }
}
