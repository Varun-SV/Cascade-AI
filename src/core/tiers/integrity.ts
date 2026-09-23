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

import { RedactionLayer } from '../audit/redaction.js';

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

/** One tool call a worker made, what it was asked to do, and what came back. */
export interface ToolRecordEntry {
  name: string;
  result: string;
  /** A bounded, redacted summary of the call's arguments. See `describeArgs`. */
  args?: string;
}

const MAX_RECORD_ENTRIES = 12;
/** Calls before those that keep what they were asked, with the outcome only. */
const MAX_OUTLINE_ENTRIES = 48;
const MAX_RESULT_CHARS = 160;
/**
 * How much of a result is redacted before it is clipped. Enough that the
 * clipped part lies well inside it, without scanning a whole large file.
 */
const MAX_SCAN_CHARS = 4096;

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
 *
 * And with its secrets taken out, arguments included. The record goes to the
 * self-test grader, which can be a different model on a different provider
 * from the worker that read the file or ran the command — one that never had
 * the credential it printed.
 */
export function recordToolCall(name: string, result: string, input?: Record<string, unknown>): ToolRecordEntry {
  const args = describeArgs(input);
  return { name, result: clip(RedactionLayer.redactSecrets(result.slice(0, MAX_SCAN_CHARS))), ...(args ? { args } : {}) };
}

const MAX_ARG_CHARS = 60;
const MAX_ARGS_CHARS = 160;
/** A key, or a field a value is being typed into, that names a secret. */
const SECRETIVE = /pass(word)?|pwd|secret|token|api[-_]?key|auth|cookie|credential|otp|\bpin\b/i;
/** The argument that carries what is typed or written, rather than where. */
const TYPED_VALUE = /^(value|text|content|input)$/i;

/**
 * What a call was asked to do, so the grader can check the claim and not just
 * the tool.
 *
 * A result alone does not say what was done: `browser_control` answers a fill
 * with "Filled #q" and never the text, and a successful shell command may
 * print nothing. An output could claim to have typed or run something else
 * entirely and still look supported by the tool's name and result.
 *
 * Bounded like the result, and redacted: any argument whose name looks like a
 * secret, and — since the value typed into a password field arrives under a
 * plain `value` key — the typed value whenever another argument (the
 * selector, the field name) points at a secret.
 */
export function describeArgs(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const entries = Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const intoSecret = entries.some(([k, v]) => !TYPED_VALUE.test(k) && typeof v === 'string' && SECRETIVE.test(v));
  const parts = entries.map(([k, v]) => {
    if (SECRETIVE.test(k) || (intoSecret && TYPED_VALUE.test(k))) return `${k}=[redacted]`;
    const raw = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
    // A command or a URL can carry a credential under an innocent key.
    const flat = RedactionLayer.redactSecrets(raw.slice(0, MAX_SCAN_CHARS)).replace(/\s+/g, ' ').trim();
    return `${k}=${flat.length > MAX_ARG_CHARS ? `${flat.slice(0, MAX_ARG_CHARS)}…` : flat}`;
  });
  const joined = parts.join(', ');
  return joined.length > MAX_ARGS_CHARS ? `${joined.slice(0, MAX_ARGS_CHARS)}…` : joined;
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
 *
 * Each tool's own wording, listed rather than guessed at: a looser pattern
 * ("anything that says failed") would also match a file or page that merely
 * starts that way, and call a real read a failure.
 */
const FAILURE_RESULT = new RegExp([
  '^Tool error:', '^Error(?::| calling )', '^Tool \\S+ was denied', '^Tool not found:',
  '^Failed\\b', '^[A-Z][\\w ]* failed:', '^Unknown (browser )?action:',
  '^Permission denied\\b', '^Not found:', '^Invalid ',
  // run_code
  '^Execution (?:failed|timed out)\\b',
  // shell: a non-zero exit (or a signal) — the command ran and did not succeed
  '^Exit (?!0:)[^\\s:]+:',
  // web_fetch
  '^HTTP [45]\\d\\d ', '^Refused to fetch ',
  // browser (the desktop tool)
  '^Browser action "[^"\\n]*" failed:', '^Browser error \\(page reset\\):',
  // dynamic tools
  '^Dynamic tool "[^"\\n]*" timed out',
  // github / gitlab
  '^Validation error from ', '^Rate limited by ',
  // generate_media
  '^Could not read ',
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
 * Every call is accounted for, and the size stays bounded, in three tiers: the
 * latest in full (clipped); the ones before them with what each was asked and
 * whether it worked; anything older by tool and outcome. The middle tier is
 * there because a tally says a navigation happened but not WHERE — so an
 * output naming the site visited in call 1 of 13 could not be checked.
 */
export function describeToolRecord(record: readonly ToolRecordEntry[]): string {
  if (!record.length) return 'none — no tool was called';
  const recent = record.slice(-MAX_RECORD_ENTRIES);
  const before = record.slice(0, record.length - recent.length);
  const outlined = before.slice(-MAX_OUTLINE_ENTRIES);
  const oldest = before.slice(0, before.length - outlined.length);
  const call = ({ name, args }: ToolRecordEntry) => `- ${name}${args ? `(${args})` : ''}`;
  const detail = recent.map((entry) => `${call(entry)} → ${clip(entry.result) || '(empty result)'}`);
  if (!before.length) return detail.join('\n');

  const lines: string[] = [];
  if (oldest.length) {
    // By tool, in the order each was first used. Bounded by the number of
    // distinct tools, however many calls there were.
    const byTool = new Map<string, { ok: number; failed: number }>();
    for (const { name, result } of oldest) {
      const tally = byTool.get(name) ?? { ok: 0, failed: 0 };
      if (reportsFailure(result)) tally.failed++; else tally.ok++;
      byTool.set(name, tally);
    }
    lines.push(`Earliest calls, by tool (${oldest.length}):`);
    for (const [name, { ok, failed }] of byTool) {
      const outcomes = [ok && `${ok} returned a result`, failed && `${failed} an error or refusal`].filter(Boolean).join(', ');
      lines.push(`- ${name} ×${ok + failed} (${outcomes})`);
    }
  }
  lines.push(`Earlier calls (${outlined.length}):`);
  for (const entry of outlined) {
    lines.push(`${call(entry)} → ${reportsFailure(entry.result) ? 'an error or refusal' : 'returned a result'}`);
  }
  lines.push(`Most recent ${recent.length}:`, ...detail);
  return lines.join('\n');
}
