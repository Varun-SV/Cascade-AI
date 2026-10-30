import { afterEach, describe, it, expect, vi } from 'vitest';
import { PENDING_PROMPT_TTL_MS, savePendingPrompt, takePendingPrompt } from './pendingPrompt.js';

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

describe('pending prompt across sign-in', () => {
  it('hands the saved prompt over once', () => {
    savePendingPrompt('  Plan a two-week trip  ', 1_000);
    expect(takePendingPrompt(2_000)).toBe('Plan a two-week trip');
    expect(takePendingPrompt(3_000)).toBeNull();
  });

  it('expires, and clears the stale entry', () => {
    savePendingPrompt('old prompt', 0);
    expect(takePendingPrompt(PENDING_PROMPT_TTL_MS + 1)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('a blank prompt clears rather than saves', () => {
    savePendingPrompt('first');
    savePendingPrompt('   ');
    expect(takePendingPrompt()).toBeNull();
  });

  it('ignores malformed entries and unavailable storage', () => {
    sessionStorage.setItem('cascade-cloud-pending-prompt', '{not json');
    expect(takePendingPrompt()).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => savePendingPrompt('x')).not.toThrow();
  });
});
