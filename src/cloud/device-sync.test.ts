import { describe, expect, it, vi } from 'vitest';
import { syncRunSpend, syncTurn, type DeviceSyncTarget } from './device-sync.js';

const gone = () => new Error('Request failed (404).');
const turn = { userContent: 'q', runId: 'run-1234', assistant: { content: 'a', costUsd: 0.01, why: '{"totalTokens":10}' } };

function target(convId: string | null = 'old-chat') {
  const client = { appendTurn: vi.fn().mockResolvedValue([]), recordRunSpend: vi.fn().mockResolvedValue({ recorded: true }) };
  const t: DeviceSyncTarget & { client: typeof client } = { client, convId };
  let made = 0;
  // As the CLI's ensureCloudConversation: the linked chat, or a new one.
  const chat = vi.fn(async () => { if (!t.convId) t.convId = `new-chat-${++made}`; return t.convId; });
  return { t, client, chat };
}

describe('a CLI run sent to the cloud', () => {
  it('copies a turn to the session\'s chat', async () => {
    const { t, client, chat } = target();
    await syncTurn(t, turn, chat);
    expect(client.appendTurn).toHaveBeenCalledWith('old-chat', turn);
    expect(client.recordRunSpend).not.toHaveBeenCalled();
  });

  it('sends a turn again to the same chat when its answer was lost', async () => {
    const { t, client, chat } = target();
    client.appendTurn.mockRejectedValueOnce(new Error('socket hang up'));
    await syncTurn(t, turn, chat);
    expect(client.appendTurn.mock.calls.map((c) => c[0])).toEqual(['old-chat', 'old-chat']);
    expect(t.convId).toBe('old-chat');
  });

  it('moves to a new chat when the linked one was deleted, and keeps using it', async () => {
    const { t, client, chat } = target();
    client.appendTurn.mockRejectedValueOnce(gone());
    await syncTurn(t, turn, chat);
    expect(client.appendTurn.mock.calls.map((c) => c[0])).toEqual(['old-chat', 'new-chat-1']);
    expect(t.convId).toBe('new-chat-1');
    expect(client.recordRunSpend).not.toHaveBeenCalled();
  });

  it('records the spend alone, under the turn\'s run id, when the turn cannot be added', async () => {
    const { t, client, chat } = target();
    client.appendTurn.mockRejectedValue(new Error('Request failed (502).'));
    await syncTurn(t, { ...turn, outcome: 'stopped' }, chat);
    expect(client.recordRunSpend).toHaveBeenCalledWith({ conversationId: null, outcome: 'stopped', runId: 'run-1234', costUsd: 0.01, why: turn.assistant.why });
  });

  it('records a run with no turn without its chat once that chat is gone', async () => {
    const { t, client } = target();
    client.recordRunSpend.mockRejectedValueOnce(gone());
    const run = { conversationId: 'old-chat', outcome: 'failed' as const, runId: 'run-5678', costUsd: 0.02, why: '{}' };
    await syncRunSpend(t, run);
    expect(client.recordRunSpend).toHaveBeenNthCalledWith(2, { ...run, conversationId: null });
    expect(t.convId).toBeNull();
  });

  it('does not retry spend for other failures, and never throws', async () => {
    const { t, client } = target();
    client.recordRunSpend.mockRejectedValue(new Error('offline'));
    await expect(syncRunSpend(t, { conversationId: 'old-chat', outcome: 'failed', runId: 'run-9999', costUsd: 0.02, why: '{}' })).resolves.toBeUndefined();
    expect(client.recordRunSpend).toHaveBeenCalledTimes(1);
    expect(t.convId).toBe('old-chat');
  });
});
