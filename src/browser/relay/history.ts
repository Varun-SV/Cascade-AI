// ─────────────────────────────────────────────
//  Cascade AI — Going back and forward (R-A2)
// ─────────────────────────────────────────────
//
//  In a browser Playwright didn't launch, the back-forward cache restores a page
//  with no load event, so waiting for `load` hangs. Wait for the commit, then wait
//  separately and briefly for the page to be ready.

export interface HistoryPage {
  goBack(opts: { waitUntil: 'commit'; timeout?: number }): Promise<unknown>;
  goForward(opts: { waitUntil: 'commit'; timeout?: number }): Promise<unknown>;
  waitForLoadState(state: 'domcontentloaded', opts?: { timeout?: number }): Promise<unknown>;
}

export async function navigateHistory(page: HistoryPage, delta: -1 | 1, timeoutMs = 10_000): Promise<void> {
  const opts = { waitUntil: 'commit' as const, timeout: timeoutMs };
  await (delta < 0 ? page.goBack(opts) : page.goForward(opts));
  // A restored page may have fired this already, which is fine. Not being ready
  // yet isn't a failed navigation.
  await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 2000) }).catch(() => {});
}
