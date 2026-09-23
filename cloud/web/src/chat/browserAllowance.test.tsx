import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { browserAllowanceFrom, browserChip, msUntilNextUtcMidnight, useBrowserAllowance } from './browserAllowance.js';
import { fetchUsage, type UsageInfo } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({ fetchUsage: vi.fn() }));
const mockedFetchUsage = vi.mocked(fetchUsage);

const usage = (browserSessions: number, browserSessionLimit = 5): UsageInfo => ({
  plan: 'free', dailyRuns: 0, dailyRunLimit: 20, maxConcurrentRuns: 1, browserSessions, browserSessionLimit,
});

beforeEach(() => { vi.clearAllMocks(); });

describe('browserAllowanceFrom', () => {
  it('is nothing when the server does not count browser sessions', () => {
    // An older server: the chip stays exactly as it was rather than guessing.
    expect(browserAllowanceFrom({ plan: 'free', dailyRuns: 0, dailyRunLimit: 20, maxConcurrentRuns: 1 })).toBeNull();
    expect(browserAllowanceFrom(null)).toBeNull();
  });

  it('reads what the server counted', () => {
    expect(browserAllowanceFrom(usage(2))).toEqual({ used: 2, limit: 5 });
  });
});

describe('browserChip', () => {
  it('says what the chip does, and how many sessions are left today', () => {
    const chip = browserChip({ used: 2, limit: 5 });
    expect(chip.exhausted).toBe(false);
    expect(chip.title).toMatch(/Give this run a real browser/);
    expect(chip.title).toContain('3 of 5 browser sessions left today.');
  });

  it('is off once the day’s sessions are gone, and says when they come back', () => {
    const chip = browserChip({ used: 5, limit: 5 });
    expect(chip.exhausted).toBe(true);
    expect(chip.title).toBe("Today's 5 browser sessions are used up. They reset at midnight UTC.");
  });

  it('treats an overshoot as used up, not as a negative number left', () => {
    // Concurrent opens can each pass the last unit of allowance.
    expect(browserChip({ used: 6, limit: 5 }).exhausted).toBe(true);
  });

  it('leaves the chip as it was when there is no allowance to show', () => {
    expect(browserChip(null)).toEqual({
      exhausted: false,
      title: 'Give this run a real browser — for pages that are images, or need signing in. Off means Cascade cannot open one.',
    });
  });
});

describe('useBrowserAllowance', () => {
  it('reads today’s allowance when signed in', async () => {
    mockedFetchUsage.mockResolvedValue(usage(1));
    const view = renderHook(() => useBrowserAllowance(true, 'idle', false, vi.fn()));
    await waitFor(() => expect(view.result.current).toEqual({ used: 1, limit: 5 }));
  });

  it('asks nothing while signed out', () => {
    renderHook(() => useBrowserAllowance(false, 'idle', false, vi.fn()));
    expect(mockedFetchUsage).not.toHaveBeenCalled();
  });

  it('switches the chip OFF when the allowance runs out, not just greys it', async () => {
    // Left on under a disabled button, the next message would still go out as
    // a browser run, and the server refuses those outright.
    mockedFetchUsage.mockResolvedValue(usage(5));
    const setBrowserMode = vi.fn();
    renderHook(() => useBrowserAllowance(true, 'idle', true, setBrowserMode));
    await waitFor(() => expect(setBrowserMode).toHaveBeenCalledWith(false));
  });

  it('leaves the chip alone while sessions remain', async () => {
    mockedFetchUsage.mockResolvedValue(usage(4));
    const setBrowserMode = vi.fn();
    const view = renderHook(() => useBrowserAllowance(true, 'idle', true, setBrowserMode));
    await waitFor(() => expect(view.result.current).toEqual({ used: 4, limit: 5 }));
    expect(setBrowserMode).not.toHaveBeenCalled();
  });

  it('re-reads when a run starts or ends', async () => {
    mockedFetchUsage.mockResolvedValue(usage(1));
    const view = renderHook(({ busy }) => useBrowserAllowance(true, busy, false, vi.fn()), { initialProps: { busy: false } });
    await waitFor(() => expect(mockedFetchUsage).toHaveBeenCalledTimes(1));

    mockedFetchUsage.mockResolvedValue(usage(2));
    view.rerender({ busy: true });
    await waitFor(() => expect(view.result.current).toEqual({ used: 2, limit: 5 }));
  });

  it('keeps the last known allowance when a read fails, rather than re-enabling the chip', async () => {
    mockedFetchUsage.mockResolvedValue(usage(5));
    const view = renderHook(({ busy }) => useBrowserAllowance(true, busy, false, vi.fn()), { initialProps: { busy: false } });
    await waitFor(() => expect(view.result.current).toEqual({ used: 5, limit: 5 }));

    mockedFetchUsage.mockRejectedValue(new Error('offline'));
    view.rerender({ busy: true });
    await waitFor(() => expect(mockedFetchUsage).toHaveBeenCalledTimes(2));
    expect(view.result.current).toEqual({ used: 5, limit: 5 });
  });
});

describe('msUntilNextUtcMidnight', () => {
  it('counts to the next midnight UTC, the day the server counts sessions by', () => {
    expect(msUntilNextUtcMidnight(Date.parse('2026-09-23T23:59:00Z'))).toBe(60_000);
    expect(msUntilNextUtcMidnight(Date.parse('2026-09-23T00:00:00Z'))).toBe(24 * 60 * 60 * 1000);
    expect(msUntilNextUtcMidnight(Date.parse('2026-12-31T12:00:00Z')), 'across a year end').toBe(12 * 60 * 60 * 1000);
  });
});

describe('useBrowserAllowance across the UTC reset', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('re-reads the allowance when the day turns over, so an exhausted chip comes back', async () => {
    // Runs were the only refresh, and an exhausted chip cannot start the run
    // that would re-read it: it stayed off all the next day.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-09-23T23:59:00Z'));
    mockedFetchUsage.mockResolvedValue(usage(5));
    const view = renderHook(() => useBrowserAllowance(true, 'idle', false, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current).toEqual({ used: 5, limit: 5 });
    expect(mockedFetchUsage).toHaveBeenCalledTimes(1);

    mockedFetchUsage.mockResolvedValue(usage(0));
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });

    expect(mockedFetchUsage, 're-read just after midnight').toHaveBeenCalledTimes(2);
    expect(view.result.current).toEqual({ used: 0, limit: 5 });
  });

  it('does not re-read before the reset', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-09-23T20:00:00Z'));
    mockedFetchUsage.mockResolvedValue(usage(5));
    renderHook(() => useBrowserAllowance(true, 'idle', false, vi.fn()));
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
    expect(mockedFetchUsage).toHaveBeenCalledTimes(1);
  });
});
