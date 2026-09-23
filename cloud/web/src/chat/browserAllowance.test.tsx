import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { CHECKING, browserAllowanceFrom, browserChip, msUntilNextUtcMidnight, useBrowserAllowance } from './browserAllowance.js';
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
      disabled: false,
      title: 'Give this run a real browser — for pages that are images, or need signing in. Off means Cascade cannot open one.',
    });
  });

  it('cannot be pressed while the allowance is still being read, and says so', () => {
    expect(browserChip(CHECKING)).toEqual({
      exhausted: false,
      disabled: true,
      title: 'Checking how many browser sessions are left today…',
    });
    expect(browserChip({ used: 5, limit: 5 }).disabled, 'nor once it is used up').toBe(true);
    expect(browserChip({ used: 4, limit: 5 }).disabled).toBe(false);
  });
});

describe('useBrowserAllowance', () => {
  it('reads today’s allowance when signed in', async () => {
    mockedFetchUsage.mockResolvedValue(usage(1));
    const view = renderHook(() => useBrowserAllowance('user-1', true, 'idle', false, vi.fn()));
    await waitFor(() => expect(view.result.current).toEqual({ used: 1, limit: 5 }));
  });

  it('asks nothing while signed out', () => {
    renderHook(() => useBrowserAllowance(undefined, true, 'idle', false, vi.fn()));
    expect(mockedFetchUsage).not.toHaveBeenCalled();
  });

  it('switches the chip OFF when the allowance runs out, not just greys it', async () => {
    // Left on under a disabled button, the next message would still go out as
    // a browser run, and the server refuses those outright.
    mockedFetchUsage.mockResolvedValue(usage(5));
    const setBrowserMode = vi.fn();
    renderHook(() => useBrowserAllowance('user-1', true, 'idle', true, setBrowserMode));
    await waitFor(() => expect(setBrowserMode).toHaveBeenCalledWith(false));
  });

  it('leaves the chip alone while sessions remain', async () => {
    mockedFetchUsage.mockResolvedValue(usage(4));
    const setBrowserMode = vi.fn();
    const view = renderHook(({ on }) => useBrowserAllowance('user-1', true, 'idle', on, setBrowserMode), { initialProps: { on: false } });
    await waitFor(() => expect(view.result.current).toEqual({ used: 4, limit: 5 }));
    view.rerender({ on: true });
    expect(setBrowserMode).not.toHaveBeenCalled();
  });

  it('keeps the chip off until the first read says whether there is an allowance', async () => {
    // It looked available while /api/usage was on its way, so an exhausted
    // user could turn it on and send, and the server refused the whole run.
    let answer: (u: UsageInfo) => void = () => {};
    mockedFetchUsage.mockReturnValue(new Promise<UsageInfo>((resolve) => { answer = resolve; }));
    const setBrowserMode = vi.fn();
    const view = renderHook(() => useBrowserAllowance('user-1', true, 'idle', true, setBrowserMode));
    expect(view.result.current).toBe(CHECKING);
    expect(browserChip(view.result.current).disabled).toBe(true);
    expect(setBrowserMode, 'and not left on under a disabled chip').toHaveBeenCalledWith(false);

    await act(async () => { answer(usage(5)); });
    expect(view.result.current).toEqual({ used: 5, limit: 5 });
  });

  it('shows an answer that there is no allowance as none, not as still checking', async () => {
    mockedFetchUsage.mockResolvedValue({ plan: 'free', dailyRuns: 0, dailyRunLimit: 20, maxConcurrentRuns: 1 });
    const view = renderHook(() => useBrowserAllowance('user-1', true, 'idle', false, vi.fn()));
    expect(view.result.current).toBe(CHECKING);
    await waitFor(() => expect(view.result.current).toBeNull());
  });

  it('re-reads when a run starts or ends', async () => {
    mockedFetchUsage.mockResolvedValue(usage(1));
    const view = renderHook(({ busy }) => useBrowserAllowance('user-1', true, busy, false, vi.fn()), { initialProps: { busy: false } });
    await waitFor(() => expect(mockedFetchUsage).toHaveBeenCalledTimes(1));

    mockedFetchUsage.mockResolvedValue(usage(2));
    view.rerender({ busy: true });
    await waitFor(() => expect(view.result.current).toEqual({ used: 2, limit: 5 }));
  });

  it('keeps the last known allowance when a read fails, rather than re-enabling the chip', async () => {
    mockedFetchUsage.mockResolvedValue(usage(5));
    const view = renderHook(({ busy }) => useBrowserAllowance('user-1', true, busy, false, vi.fn()), { initialProps: { busy: false } });
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
    // Hidden, so the minute poll cannot be what re-reads it: the reset has to
    // come back on its own, including for a tab left in the background.
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      mockedFetchUsage.mockResolvedValue(usage(5));
      const view = renderHook(() => useBrowserAllowance('user-1', true, 'idle', false, vi.fn()));
      await act(async () => { await Promise.resolve(); });
      expect(view.result.current).toEqual({ used: 5, limit: 5 });
      expect(mockedFetchUsage).toHaveBeenCalledTimes(1);

      mockedFetchUsage.mockResolvedValue(usage(0));
      await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });

      expect(mockedFetchUsage, 're-read just after midnight').toHaveBeenCalledTimes(2);
      expect(view.result.current).toEqual({ used: 0, limit: 5 });
    } finally {
      hidden.mockRestore();
    }
  });

  it('does not re-read before the reset', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-09-23T20:00:00Z'));
    // Hidden, so the minute poll stays quiet and only the day's timer is
    // under test: it must not fire an hour early.
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      mockedFetchUsage.mockResolvedValue(usage(5));
      renderHook(() => useBrowserAllowance('user-1', true, 'idle', false, vi.fn()));
      await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
      expect(mockedFetchUsage).toHaveBeenCalledTimes(1);
    } finally {
      hidden.mockRestore();
    }
  });
});

describe('useBrowserAllowance and who is signed in', () => {
  it('does not hand one account\u2019s exhausted allowance to the next', async () => {
    // Signed out and back in as someone else, on the same page. The second
    // account's first read fails, and a failed read keeps the last value —
    // which was the FIRST account's, so its chip stayed off.
    mockedFetchUsage.mockResolvedValue(usage(5));
    const view = renderHook(({ user }) => useBrowserAllowance(user, true, 'idle', false, vi.fn()), {
      initialProps: { user: 'alice' as string | undefined },
    });
    await waitFor(() => expect(view.result.current).toEqual({ used: 5, limit: 5 }));

    mockedFetchUsage.mockRejectedValue(new Error('offline'));
    view.rerender({ user: 'bob' });
    await waitFor(() => expect(mockedFetchUsage).toHaveBeenCalledTimes(2));
    expect(view.result.current, 'nothing known about bob yet, so nothing of alice\u2019s is held against him').toBe(CHECKING);
    expect(browserChip(view.result.current).exhausted).toBe(false);
  });

  it('checks again after signing out and back in as the same account', async () => {
    // The read was kept by user id, so the same account signing back in found
    // it still matching and was shown it while the new read was on its way:
    // sessions spent elsewhere in between looked unspent.
    mockedFetchUsage.mockResolvedValue(usage(1));
    const view = renderHook(({ user }) => useBrowserAllowance(user, true, 'idle', false, vi.fn()), {
      initialProps: { user: 'alice' as string | undefined },
    });
    await waitFor(() => expect(view.result.current).toEqual({ used: 1, limit: 5 }));

    view.rerender({ user: undefined });
    let answer: (u: UsageInfo) => void = () => {};
    mockedFetchUsage.mockReturnValue(new Promise<UsageInfo>((resolve) => { answer = resolve; }));
    view.rerender({ user: 'alice' });
    expect(view.result.current, 'a new session, so not known yet').toBe(CHECKING);

    await act(async () => { answer(usage(5)); });
    expect(view.result.current).toEqual({ used: 5, limit: 5 });
  });

  it('checks again when the deployment\u2019s browser goes away and comes back', async () => {
    mockedFetchUsage.mockResolvedValue(usage(1));
    const view = renderHook(({ available }) => useBrowserAllowance('alice', available, 'idle', false, vi.fn()), {
      initialProps: { available: true },
    });
    await waitFor(() => expect(view.result.current).toEqual({ used: 1, limit: 5 }));

    view.rerender({ available: false });
    mockedFetchUsage.mockReturnValue(new Promise<UsageInfo>(() => {}));
    view.rerender({ available: true });
    expect(view.result.current).toBe(CHECKING);
  });

  it('forgets the allowance on sign-out', async () => {
    mockedFetchUsage.mockResolvedValue(usage(5));
    const view = renderHook(({ user }) => useBrowserAllowance(user, true, 'idle', false, vi.fn()), {
      initialProps: { user: 'alice' as string | undefined },
    });
    await waitFor(() => expect(view.result.current).toEqual({ used: 5, limit: 5 }));
    view.rerender({ user: undefined });
    expect(view.result.current).toBeNull();
  });
});

describe('useBrowserAllowance after a plan change', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('notices a raised limit while the chip is exhausted, without a run or a new day', async () => {
    // Free user, 5 of 5 used, upgrades to Pro. The upgrade dialog refreshed
    // only its own copy, and an exhausted chip cannot start the run that
    // would re-read this one — it stayed off until reload or midnight.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    mockedFetchUsage.mockResolvedValue(usage(5));
    const view = renderHook(() => useBrowserAllowance('user-1', true, 'idle', false, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current).toEqual({ used: 5, limit: 5 });

    mockedFetchUsage.mockResolvedValue(usage(5, 50));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(view.result.current).toEqual({ used: 5, limit: 50 });
    expect(browserChip(view.result.current).exhausted, 'the chip is back').toBe(false);
  });

  it('asks again when the first read fails, rather than leaving the chip off for good', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    mockedFetchUsage.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(usage(1));
    const view = renderHook(() => useBrowserAllowance('user-1', true, 'idle', false, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current).toBe(CHECKING);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(view.result.current).toEqual({ used: 1, limit: 5 });
  });

  it('re-reads on coming back to the tab while exhausted', async () => {
    mockedFetchUsage.mockResolvedValue(usage(5));
    const view = renderHook(() => useBrowserAllowance('user-1', true, 'idle', false, vi.fn()));
    await waitFor(() => expect(view.result.current).toEqual({ used: 5, limit: 5 }));

    mockedFetchUsage.mockResolvedValue(usage(5, 50));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    await waitFor(() => expect(view.result.current).toEqual({ used: 5, limit: 50 }));
  });

  it('notices a lowered limit while sessions remain, and switches the chip off before a send is refused', async () => {
    // Pro, 6 of 50 used, and the subscription lapses to Free. Polling only
    // while exhausted never re-read a chip with sessions left, so it stayed on
    // under the old limit and the next browser message was refused.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    mockedFetchUsage.mockResolvedValue(usage(6, 50));
    const setBrowserMode = vi.fn();
    const view = renderHook(() => useBrowserAllowance('user-1', true, 'idle', true, setBrowserMode));
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current).toEqual({ used: 6, limit: 50 });

    mockedFetchUsage.mockResolvedValue(usage(6, 5));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(view.result.current).toEqual({ used: 6, limit: 5 });
    expect(setBrowserMode, 'switched off, not left on under a limit that no longer applies').toHaveBeenCalledWith(false);
  });

  it('does not poll a tab nobody is looking at', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      mockedFetchUsage.mockResolvedValue(usage(2));
      renderHook(() => useBrowserAllowance('user-1', true, 'idle', false, vi.fn()));
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(mockedFetchUsage).toHaveBeenCalledTimes(1);
    } finally {
      hidden.mockRestore();
    }
  });
});

describe('useBrowserAllowance where nothing is rationed', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reads nothing and sets no clock on a deployment with no browser', async () => {
    // It polled /api/usage every minute in every signed-in tab, on the
    // default deployment, for an allowance that deployment never reports.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-09-23T23:58:00Z'));
    mockedFetchUsage.mockResolvedValue(usage(2));
    const view = renderHook(() => useBrowserAllowance('user-1', false, 'idle', false, vi.fn()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(mockedFetchUsage, 'not even across midnight').not.toHaveBeenCalled();
    expect(view.result.current).toBeNull();
    expect(vi.getTimerCount(), 'no clock left running').toBe(0);
  });

  it('stops re-reading once the server says it rations nothing — a CDP deployment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    mockedFetchUsage.mockResolvedValue({ plan: 'free', dailyRuns: 0, dailyRunLimit: 20, maxConcurrentRuns: 1 });
    const view = renderHook(() => useBrowserAllowance('user-1', true, 'idle', false, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(mockedFetchUsage, 'read once, at mount').toHaveBeenCalledTimes(1);
    expect(view.result.current).toBeNull();
  });

  it('starts reading when the deployment turns out to have a browser', async () => {
    // /api/config arrives after the first render: unknown is not "yes".
    mockedFetchUsage.mockResolvedValue(usage(2));
    const view = renderHook(({ available }) => useBrowserAllowance('user-1', available, 'idle', false, vi.fn()), {
      initialProps: { available: false },
    });
    expect(mockedFetchUsage).not.toHaveBeenCalled();
    view.rerender({ available: true });
    await waitFor(() => expect(view.result.current).toEqual({ used: 2, limit: 5 }));
  });
});
