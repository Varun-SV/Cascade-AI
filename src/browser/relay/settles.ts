// ─────────────────────────────────────────────
//  Cascade AI — Bounded waits for the device's own calls
// ─────────────────────────────────────────────
//
//  Its own module so the relay needs nothing that launches a browser: the extension
//  bundles the relay, and has no processes, files or sockets of its own to start.

/** Whether a CDP call succeeded in time. A page spinning in a loop never answers. */
export function settlesWithin(call: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const finish = (ok: boolean): void => { clearTimeout(timer); resolve(ok); };
    call.then(() => finish(true), () => finish(false));
  });
}
