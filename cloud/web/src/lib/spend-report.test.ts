import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSpendReport } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchSpendReport', () => {
  it('asks for the period with the viewer\'s offset, so days end at their midnight', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // UTC+5:30 reports -330.
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-330);
    await fetchSpendReport('7d');
    expect(fetchMock).toHaveBeenCalledWith('/api/usage/report?period=7d&tz=330', { credentials: 'include' });
  });
});
