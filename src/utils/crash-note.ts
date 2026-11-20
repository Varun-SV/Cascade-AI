// ─────────────────────────────────────────────
//  Cascade AI — A note for a crash nothing can catch
// ─────────────────────────────────────────────
//
//  Native code (a sandbox's V8 isolate, a native addon) can take the whole
//  process down in a way no handler sees: no 'exit' event, no error, the window
//  just gone. The host that keeps an exit record (the CLI's exit guard) can be
//  told, just before such code runs, what it is about to do, and write that down
//  where a crash would leave it. The next start can then say what was running.
//
//  The SDK knows nothing of the host: with no listener, a note costs nothing.

type Listener = (doing: string | null) => void;
let listener: Listener | null = null;

/** The host's listener, or null to stop listening. */
export function onCrashNote(fn: Listener | null): void { listener = fn; }

/** Says what native code is about to run (null once it is over). Never throws. */
export function crashNote(doing: string | null): void {
  try { listener?.(doing); } catch { /* a note must never stop the work */ }
}
