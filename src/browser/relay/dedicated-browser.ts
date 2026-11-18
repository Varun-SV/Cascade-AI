// ─────────────────────────────────────────────
//  Cascade AI — A browser launched for one lease
// ─────────────────────────────────────────────
//
//  The CLI's source: a browser of the run's own, behind the mandatory proxy, with the
//  request policy on before anything can leave it. One launch serves one lease, and
//  everything it started goes when the lease does.

import { type EgressProxy, type ProxyNetwork, startEgressProxy } from './egress-proxy.js';
import type { Consent } from './egress-rules.js';
import type { LeasedBrowser } from './device.js';
import { type LaunchedBrowser, launchBehindProxy } from './launch.js';
import { startRequestPolicy } from './request-enforcer.js';

export interface DedicatedBrowserOptions {
  consent: Consent;
  chromiumPath: string;
  /** Test seams only: the proxy's network, and the launch itself. */
  network?: ProxyNetwork;
  launch?: (proxy: EgressProxy) => Promise<LaunchedBrowser>;
}

/** Proxy, then browser, then policy. A failure at any step takes down what came before it. */
export async function startDedicatedBrowser(opts: DedicatedBrowserOptions): Promise<LeasedBrowser> {
  const proxy = await startEgressProxy({ consent: opts.consent, ...(opts.network ? { network: opts.network } : {}) });
  let browser: LaunchedBrowser | null = null;
  try {
    browser = await (opts.launch ? opts.launch(proxy) : launchBehindProxy({ chromiumPath: opts.chromiumPath, proxy }));
    const enforcer = await startRequestPolicy({ browser, consent: opts.consent });
    const launched = browser;
    let closed = false;
    return {
      tabWs: launched.tabWs, tabTargetId: launched.tabTargetId, enforcer,
      // The tab is the run's own, so it's closed, not left on about:blank.
      pageEnd: 'close',
      onEgressDown: (fn) => proxy.onClose(fn),
      async close() {
        if (closed) return;
        closed = true;
        enforcer.close();
        await launched.close().catch(() => {});
        await proxy.close().catch(() => {});
      },
    };
  } catch (e) {
    await browser?.close().catch(() => {});
    await proxy.close().catch(() => {});
    throw e;
  }
}
