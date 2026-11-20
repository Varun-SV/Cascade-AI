// What the decision card shows about a parked section, kept apart from the
// drawing so it can be tested. The desktop app keeps a copy of these helpers
// (app/src/lib/escalation-view.ts): one decision, one reading of it.

/** Where it stopped, split into the checks that failed (shown as chips) and anything else said. */
export function readIssues(issues: readonly string[]): { checks: string[]; notes: string[] } {
  const checks: string[] = [];
  const notes: string[] = [];
  for (const raw of issues) {
    const issue = raw.trim();
    if (!issue) continue;
    // "Initial check failed: completeness, compliance", "Review checks failed - tests and lint"
    const m = /\bchecks?\s+failed\s*[:\-–]\s*(.+)$/i.exec(issue);
    if (m) {
      for (const name of m[1]!.split(/,|\band\b/i)) {
        const n = name.trim().replace(/[.;]+$/, '');
        if (n && !checks.includes(n.toLowerCase())) checks.push(n.toLowerCase());
      }
    } else if (!notes.includes(issue)) {
      notes.push(issue);
    }
  }
  return { checks, notes };
}

/** The draft in one line, and how much there is of it. */
export function draftPreview(summary: string, max = 140): { line: string; words: number } {
  const text = summary.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const first = text.split(/\n+/)[0] ?? '';
  const line = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
  return { line, words };
}

/** "1.2k words", "340 words". */
export function wordCount(words: number): string {
  if (words >= 1000) return `${(words / 1000).toFixed(words >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k words`;
  return `${words} ${words === 1 ? 'word' : 'words'}`;
}

/** m:ss for a countdown. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type EscalationChoice = 'guidance' | 'retry' | 'skip';

/** The three answers, as the cards show them. Same words on every surface. */
export const CHOICES: ReadonlyArray<{ id: EscalationChoice; key: string; label: string; detail: string; confirm: string }> = [
  { id: 'guidance', key: 'G', label: 'Guide', detail: 'Redo it with your notes. Replaces the draft.', confirm: 'Retry with notes' },
  { id: 'retry', key: 'R', label: 'Retry', detail: 'Redo it the same way. Replaces the draft.', confirm: 'Retry as-is' },
  { id: 'skip', key: 'S', label: 'Skip', detail: 'Keep the draft and move on.', confirm: 'Skip and keep draft' },
];
