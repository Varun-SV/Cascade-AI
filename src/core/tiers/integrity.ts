// ─────────────────────────────────────────────
//  Cascade AI — Never pass off work that did not happen
// ─────────────────────────────────────────────
//
//  The reported run: asked to open a site with browser control and bring its
//  answers back unchanged, a tier that could not reach a browser wrote "I have
//  utilized this system's internal reasoning engine to simulate…" and returned
//  invented answers labelled as results.
//
//  Nothing forbade it. The image and video rules each say "never claim it
//  exists unless the tool reported it", but only for their own tool, so every
//  other capability was fair game. This states the rule once, for every
//  capability, and every prompt whose output can reach the user as an answer
//  carries it.
//
//  Two wordings, because there are two ways to do it. A tier that ACTS can fail
//  to do the thing and cover the gap. A tier that REPORTS on other tiers' work
//  can turn their failure into a success while summarising it.

/** For a tier that does the work: T3's agent loop, its correction and rewrite steps, a fast answer. */
export const ACTING_INTEGRITY_RULE =
  '- Never present simulated, hypothetical or invented results as real. If you cannot do what was asked — '
  + 'the tool you need is missing, returns an error or is refused — say so plainly, report what you did manage, '
  + 'and stop. Do not role-play performing the action, and do not fill in plausible-looking results, quotes, '
  + 'data or page contents you did not actually obtain.';

/** For a tier that reports on others' work: T2's section summary, T1's final compile. */
export const REPORTING_INTEGRITY_RULE =
  '- Report only what the work you were given actually produced. Where it says something could not be done, '
  + 'failed or is incomplete, say that too — never turn a failure into a success, and never add results, quotes, '
  + 'data or findings that are not in it.';

/** One tool call a worker made, and what came back. */
export interface ToolRecordEntry {
  name: string;
  result: string;
}

const MAX_RECORD_ENTRIES = 12;
const MAX_RESULT_CHARS = 160;

/**
 * What the worker ACTUALLY did, for the self-test to grade the output against.
 *
 * The grader was shown only the output, so an output that claims "I logged in
 * and asked the chatbot…" was checked against nothing but its own say-so. The
 * worker knows exactly which tools ran and what each one returned. A refused
 * `browser_control` ("All 1 browser session are in use…") is the whole story
 * of that run, and the grader never saw it.
 *
 * Results are clipped to their start, where a tool's outcome and any error
 * text appear, and the list is bounded so a tool-heavy subtask cannot crowd out
 * the output under test. When it is cut, it says so: silently dropping calls
 * would make a claimed action look unperformed.
 */
export function describeToolRecord(record: readonly ToolRecordEntry[]): string {
  if (!record.length) return 'none — no tool was called';
  const shown = record.slice(-MAX_RECORD_ENTRIES).map(({ name, result }) => {
    const flat = result.replace(/\s+/g, ' ').trim();
    const clipped = flat.length > MAX_RESULT_CHARS ? `${flat.slice(0, MAX_RESULT_CHARS)}…` : flat;
    return `- ${name} → ${clipped || '(empty result)'}`;
  });
  const omitted = record.length - shown.length;
  return (omitted > 0 ? `(${omitted} earlier call${omitted === 1 ? '' : 's'} not shown)\n` : '') + shown.join('\n');
}
