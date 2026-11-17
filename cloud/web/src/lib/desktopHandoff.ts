// Run on my desktop (Settings → Browser): a message that needs the browser is handed to
// the desktop app with a one-time code. A handoff carries text only.

/** What the desktop handoff says first, naming any files that can't go with the chat. */
export function desktopHandoffNotice(files: string[]): string {
  const base = 'Browser runs happen in your desktop app (Settings → Browser). Send this chat there to run it; the reply comes back here when the app syncs.';
  if (files.length === 0) return base;
  return `${base} Files don't go with it: attach ${files.join(', ')} again in the app.`;
}
