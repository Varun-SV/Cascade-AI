import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSpendReport } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchSpendReport', () => {
  it('asks for the period with the viewer\'s time zone by name, so each day ends at its own midnight', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Europe/London' } as Intl.ResolvedDateTimeFormatOptions);
    await fetchSpendReport('7d');
    expect(fetchMock).toHaveBeenCalledWith('/api/usage/report?period=7d&tz=Europe%2FLondon', { credentials: 'include' });
  });

  it('falls back to today\'s offset where the browser names no zone', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({} as Intl.ResolvedDateTimeFormatOptions);
    // UTC+5:30 reports -330.
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-330);
    await fetchSpendReport('7d');
    expect(fetchMock).toHaveBeenCalledWith('/api/usage/report?period=7d&tz=330', { credentials: 'include' });
  });
});
