import { describe, it, expect } from 'vitest';
import { titleOf } from './conversations.js';

describe('titleOf', () => {
  const recent = [{ id: 'c1', title: 'Postgres vs SQLite' }];

  it('names a chat from the recent list', () => {
    expect(titleOf('c1', recent, null)).toBe('Postgres vs SQLite');
  });

  it('names an older chat opened from search by the title it was opened with', () => {
    expect(titleOf('c9', recent, { id: 'c9', title: 'Offsite budget from last year' })).toBe('Offsite budget from last year');
  });

  it('does not borrow the title of a different chat', () => {
    expect(titleOf('c9', recent, { id: 'c7', title: 'Something else' })).toBeUndefined();
    expect(titleOf(undefined, recent, null)).toBeUndefined();
  });
});
