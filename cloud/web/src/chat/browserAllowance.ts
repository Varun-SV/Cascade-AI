import { useEffect, useState } from 'react';
import { fetchUsage, type UsageInfo } from '../lib/api.js';

/** Today's browser sessions against the plan's daily allowance. */
export interface BrowserAllowance {
  used: number;
  limit: number;
}

/** Null when the server does not report one, so an older server leaves the chip as it was. */
export function browserAllowanceFrom(usage: UsageInfo | null): BrowserAllowance | null {
  if (!usage || typeof usage.browserSessions !== 'number' || typeof usage.browserSessionLimit !== 'number') return null;
  return { used: usage.browserSessions, limit: usage.browserSessionLimit };
}

/**
 * How long until the allowance resets: the next midnight UTC, the boundary the
 * server's `todayKey()` counts days by.
 */
export function msUntilNextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

const CHIP_TITLE = 'Give this run a real browser — for pages that are images, or need signing in. Off means Cascade cannot open one.';

/**
 * What the Browser chip says, and whether it can be pressed.
 *
 * Off once the day's sessions are gone, and saying why on the chip itself: a
 * run sent with it on would be refused before it starts, and a control that
 * looks available until you use it is the thing this replaces.
 */
export function browserChip(allowance: BrowserAllowance | null): { exhausted: boolean; title: string } {
  if (!allowance) return { exhausted: false, title: CHIP_TITLE };
  const left = Math.max(0, allowance.limit - allowance.used);
  if (left === 0) {
    return {
      exhausted: true,
      title: `Today's ${allowance.limit} browser sessions are used up. They reset at midnight UTC.`,
    };
  }
  return { exhausted: false, title: `${CHIP_TITLE} ${left} of ${allowance.limit} browser sessions left today.` };
}

/**
 * Today's browser allowance, re-read whenever `refreshSignal` changes (a run
 * starting or finishing), and the chip switched OFF when it runs out.
 *
 * Off, not only disabled: a chip left on under a disabled button would still
 * send the next message as a browser run, which the server refuses outright.
 */
export function useBrowserAllowance(
  enabled: boolean,
  refreshSignal: unknown,
  browserMode: boolean,
  setBrowserMode: (on: boolean) => void,
): BrowserAllowance | null {
  const [allowance, setAllowance] = useState<BrowserAllowance | null>(null);
  // Bumped at each UTC reset. Runs are not the only thing that changes the
  // allowance: the day does. An exhausted chip cannot START the run that
  // would have re-read it, so without this it stayed off all the next day.
  const [day, setDay] = useState(0);

  useEffect(() => {
    // Signed out, there is no allowance to read and the request would only 401.
    if (!enabled) return;
    let live = true;
    // A failed read keeps the last known allowance rather than forgetting it:
    // "unknown" would re-enable a chip the server will refuse.
    fetchUsage().then((u) => { if (live) setAllowance(browserAllowanceFrom(u)); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, refreshSignal, day]);

  useEffect(() => {
    if (!enabled) return;
    // A second past midnight, so the server's clock has also crossed it.
    const timer = setTimeout(() => setDay((n) => n + 1), msUntilNextUtcMidnight(Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [enabled, day]);

  const { exhausted } = browserChip(allowance);
  useEffect(() => {
    if (exhausted && browserMode) setBrowserMode(false);
  }, [exhausted, browserMode, setBrowserMode]);

  return allowance;
}
