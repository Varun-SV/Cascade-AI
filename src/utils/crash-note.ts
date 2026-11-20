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
//  Runs overlap (a run's workers call tools in parallel), so each is tracked on
//  its own: one finishing leaves the others in the note.
//
//  The SDK knows nothing of the host: with no listener, a note costs nothing.

type Listener = (doing: string | null) => void;
let listener: Listener | null = null;
const active = new Map<number, string>();
let nextId = 0;

/** The host's listener, or null to stop listening. Told what runs now, at once. */
export function onCrashNote(fn: Listener | null): void {
  listener = fn;
  if (fn && active.size) emit();
}

function emit(): void {
  const doing = [...new Set(active.values())];
  try { listener?.(doing.length ? doing.join(' and ') : null); } catch { /* a note must never stop the work */ }
}

/**
 * Says native code is about to run. Returns the call that says this run is over
 * (calling it again does nothing). Never throws.
 */
export function nativeRun(doing: string): () => void {
  const id = ++nextId;
  active.set(id, doing);
  emit();
  return () => {
    if (active.delete(id)) emit();
  };
}
