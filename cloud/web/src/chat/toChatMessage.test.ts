import { describe, expect, it } from 'vitest';
import { toChatMessage } from './useChatSession.js';

describe('toChatMessage', () => {
  it('keeps a stopped reply marked as stopped when the chat is reloaded', () => {
    const row = { id: 'm1', role: 'assistant', content: 'half an answer', cancelled: true };
    expect(toChatMessage(row).cancelled).toBe(true);
    expect(toChatMessage({ ...row, cancelled: undefined }).cancelled).toBeUndefined();
  });
});
