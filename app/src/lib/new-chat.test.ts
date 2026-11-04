import { describe, expect, it } from 'vitest';
import { newChatView } from './new-chat.js';

describe('newChatView', () => {
  it('starts the fresh session in place on views that can run one', () => {
    expect(newChatView('cockpit')).toBeNull();
    expect(newChatView('chat')).toBeNull();
    expect(newChatView('code')).toBeNull();
  });

  it('opens Chat from views with nowhere to type', () => {
    expect(newChatView('insights')).toBe('chat');
    expect(newChatView('browser')).toBe('chat');
    expect(newChatView('onboarding')).toBe('chat');
  });
});
