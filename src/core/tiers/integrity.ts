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

// "Stop" is for when there is no way forward, not the first error. A tool
// error can be the way forward: argument validation tells the model to "supply
// them and call the tool again", and a busy browser says to try again. A rule
// that ended the subtask at any error contradicted both.

/** For a tier that does the work: T3's agent loop, its correction and rewrite steps, a fast answer. */
export const ACTING_INTEGRITY_RULE =
  '- Never present simulated, hypothetical or invented results as real. A tool error you can act on — a missing or '
  + 'invalid argument, or a message telling you to try again — is not the end: correct the call and retry. If you '
  + 'still cannot do what was asked — the tool you need is missing, or it keeps failing or refusing — say so '
  + 'plainly, report what you did manage, and stop. Do not role-play performing the action, and do not fill in '
  + 'plausible-looking results, quotes, data or page contents you did not actually obtain.';

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

function clip(result: string): string {
  const flat = result.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_RESULT_CHARS ? `${flat.slice(0, MAX_RESULT_CHARS)}…` : flat;
}

/**
 * What is kept of one call: the start of its result, where the outcome and any
 * error are.
 *
 * Clipped HERE, when the call is recorded, not when the record is shown. The
 * context already gets a bounded copy, but the record held every result whole
 * for the life of the worker — a few `file_read`s of large files is hundreds
 * of megabytes kept to show the grader 160 characters of each.
 */
export function recordToolCall(name: string, result: string): ToolRecordEntry {
  return { name, result: clip(result) };
}

/**
 * A result the tool itself reported as a failure or refusal.
 *
 * Several conventions, because tools report failure in their own words rather
 * than by throwing: T3Worker.executeTool's `Tool error:` and denials, `Error:`
 * from most tools — and `browser_control`'s `Failed: …`, which is how a refused
 * browser action (the session cap among them) actually comes back. Missing
 * that one counted the reported run's refusal as a result. An empty but real
 * result ("No matches found for: …") is not a failure: the action happened.
 */
const FAILURE_RESULT = new RegExp([
  '^Tool error:', '^Error:', '^Tool \\S+ was denied', '^Tool not found:',
  '^Failed\\b', '^[A-Z][\\w ]* failed:', '^Unknown (browser )?action:',
  '^Permission denied:', '^Not found:', '^Invalid ',
].join('|'));

function reportsFailure(result: string): boolean {
  return FAILURE_RESULT.test(result);
}

/**
 * What the worker ACTUALLY did, for the self-test to grade the output against.
 *
 * The grader was shown only the output, so an output that claims "I logged in
 * and asked the chatbot…" was checked against nothing but its own say-so. The
 * worker knows exactly which tools ran and what each one returned. A refused
 * `browser_control` ("All 1 browser session are in use…") is the whole story
 * of that run, and the grader never saw it.
 *
 * Every call is accounted for, and the size stays bounded: the latest in full
 * (clipped), the earlier ones by tool and outcome. Earlier calls used to be a
 * bare count — while the grader is told to fail an action no listed call
 * performed, so a correct output citing call 1 of 13 read as unperformed.
 */
export function describeToolRecord(record: readonly ToolRecordEntry[]): string {
  if (!record.length) return 'none — no tool was called';
  const recent = record.slice(-MAX_RECORD_ENTRIES);
  const earlier = record.slice(0, record.length - recent.length);
  const detail = recent.map(({ name, result }) => `- ${name} → ${clip(result) || '(empty result)'}`);
  if (!earlier.length) return detail.join('\n');

  // By tool, in the order each was first used. Bounded by the number of
  // distinct tools, however many calls there were.
  const byTool = new Map<string, { ok: number; failed: number }>();
  for (const { name, result } of earlier) {
    const tally = byTool.get(name) ?? { ok: 0, failed: 0 };
    if (reportsFailure(result)) tally.failed++; else tally.ok++;
    byTool.set(name, tally);
  }
  const summary = [...byTool].map(([name, { ok, failed }]) => {
    const outcomes = [ok && `${ok} returned a result`, failed && `${failed} an error or refusal`].filter(Boolean).join(', ');
    return `- ${name} ×${ok + failed} (${outcomes})`;
  });
  return [
    `Earlier calls, by tool (${earlier.length}):`,
    ...summary,
    `Most recent ${recent.length}:`,
    ...detail,
  ].join('\n');
}
