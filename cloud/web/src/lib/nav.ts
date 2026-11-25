// Minimal client-side navigation. The app has no router: App decides what to
// show from its own state, and the only URL-driven surface is /docs. This is
// the whole of it: push or replace a URL, and tell Root (which listens for
// this event and for popstate, i.e. back and forward) to re-read it.

export const NAVIGATE_EVENT = 'cascade:navigate';

/** Go to a same-origin URL without a page load. */
export function navigateTo(url: string, opts: { replace?: boolean } = {}): void {
  try {
    if (opts.replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
  } catch {
    // A sandboxed frame can refuse pushState; fall back to a real navigation.
    window.location.assign(url);
    return;
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export interface Where { pathname: string; hash: string }

export function currentWhere(): Where {
  return { pathname: window.location.pathname, hash: window.location.hash.replace(/^#/, '') };
}
