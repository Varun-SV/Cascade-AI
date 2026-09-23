import { useEffect, useState } from 'react';
import { fetchUsage, type UsageInfo } from '../lib/api.js';

/** Today's browser sessions against the plan's daily allowance. */
export interface BrowserAllowance {
  used: number;
  limit: number;
}

/**
 * Not known yet: signed in, on a deployment with a browser, and the first read
 * of this user's usage has not answered. Distinct from null, which is a read
 * that answered with no allowance — a deployment that rations nothing.
 */
export const CHECKING = 'checking' as const;

/** What the chip is shown: an allowance, not known yet, or none to show. */
export type BrowserAllowanceView = BrowserAllowance | typeof CHECKING | null;

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
 *
 * And off until the first read says whether there is an allowance at all. A
 * chip that looked available while `/api/usage` was still on its way let an
 * exhausted user turn it on and send, and the server refused the whole run.
 */
export function browserChip(allowance: BrowserAllowanceView): { exhausted: boolean; disabled: boolean; title: string } {
  if (allowance === CHECKING) {
    return { exhausted: false, disabled: true, title: 'Checking how many browser sessions are left today…' };
  }
  if (!allowance) return { exhausted: false, disabled: false, title: CHIP_TITLE };
  const left = Math.max(0, allowance.limit - allowance.used);
  if (left === 0) {
    return {
      exhausted: true,
      disabled: true,
      title: `Today's ${allowance.limit} browser sessions are used up. They reset at midnight UTC.`,
    };
  }
  return { exhausted: false, disabled: false, title: `${CHIP_TITLE} ${left} of ${allowance.limit} browser sessions left today.` };
}

/**
 * Today's browser allowance, re-read whenever `refreshSignal` changes (a run
 * starting or finishing), and the chip switched OFF when it runs out.
 *
 * Off, not only disabled: a chip left on under a disabled button would still
 * send the next message as a browser run, which the server refuses outright.
 *
 * Nothing at all where the deployment has no browser: no read, no timers.
 * And the clocks run only while the server reports an allowance — a
 * deployment driving its own browser over CDP rations nothing, so re-reading
 * it every minute would be requests for an answer that cannot change.
 */
export function useBrowserAllowance(
  /** The signed-in user; none while signed out. */
  userId: string | undefined,
  /** Whether this deployment has a browser (`/api/config`'s `remoteBrowserEnabled`). */
  available: boolean,
  refreshSignal: unknown,
  browserMode: boolean,
  setBrowserMode: (on: boolean) => void,
): BrowserAllowanceView {
  // Remembered WITH the user it was read for. A signed-in boolean let the next
  // account on the same page inherit this one's exhausted allowance — and keep
  // it, since a failed first read deliberately leaves the last value in place.
  const [read, setRead] = useState<{ userId: string; allowance: BrowserAllowance | null } | null>(null);
  const known = read !== null && read.userId === userId;
  const allowance = known ? read.allowance : null;
  // Nothing read for this user yet — the first read is on its way, or failed
  // and is being retried. Not "no allowance": that is what a read SAYS.
  const checking = !!userId && available && !known;
  // Bumped at each UTC reset. Runs are not the only thing that changes the
  // allowance: the day does. An exhausted chip cannot START the run that
  // would have re-read it, so without this it stayed off all the next day.
  const [day, setDay] = useState(0);
  // Bumped to re-read on a clock and on returning to the tab — see below.
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    // Signed out, there is no allowance to read and the request would only 401.
    if (!userId || !available) return;
    let live = true;
    // A failed read keeps the last known allowance rather than forgetting it:
    // "unknown" would re-enable a chip the server will refuse. The same user's
    // only — see `read`.
    fetchUsage().then((u) => { if (live) setRead({ userId, allowance: browserAllowanceFrom(u) }); }).catch(() => {});
    return () => { live = false; };
  }, [userId, available, refreshSignal, day, recheck]);

  // Whether the server rations sessions here: it reported an allowance. Until
  // a read says so — or after one said it does not — only a run re-reads it.
  const rationed = available && allowance !== null;

  useEffect(() => {
    if (!userId || !rationed) return;
    // A second past midnight, so the server's clock has also crossed it.
    const timer = setTimeout(() => setDay((n) => n + 1), msUntilNextUtcMidnight(Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [userId, rationed, day]);

  // Off, for the same reason as exhausted: a chip left on under a disabled
  // button would still send the next message as a browser run.
  const { disabled } = browserChip(checking ? CHECKING : allowance);
  useEffect(() => {
    if (disabled && browserMode) setBrowserMode(false);
  }, [disabled, browserMode, setBrowserMode]);

  // The allowance can change without a run or a new day, in either direction.
  // An upgrade to Pro raises the limit, and nothing else re-reads an exhausted
  // chip — it cannot start the run that would — while Pro activates
  // asynchronously after payment, so one read when the upgrade closes could
  // still see Free. A downgrade or an expired Pro lowers it, and the chip stays
  // on under the old limit until a send is refused. So re-read every minute
  // the tab is visible, and on coming back to it, whatever the last read said.
  //
  // And while the first read has not answered: a failed one leaves the chip
  // off, so it is asked again rather than left off for good.
  useEffect(() => {
    if (!userId || !(rationed || checking)) return;
    const visible = () => typeof document === 'undefined' || !document.hidden;
    const timer = setInterval(() => { if (visible()) setRecheck((n) => n + 1); }, 60_000);
    const onVisible = () => { if (visible()) setRecheck((n) => n + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [userId, rationed, checking]);

  if (!available) return null;
  return checking ? CHECKING : allowance;
}
