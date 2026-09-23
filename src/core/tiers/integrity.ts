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
  /**
   * The tool that actually ran, when it was not the one asked for: the
   * worker's fallback answered a failed call with a sibling or a synthesized
   * tool. What happened is what THIS tool does, not what `name` would have.
   */
  ranAs?: string;
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
export function recordToolCall(
  name: string,
  result: string,
  input?: Record<string, unknown>,
  /** The tool that answered in `name`'s place, if the worker fell back. */
  ranAs?: string,
): ToolRecordEntry {
  const args = describeArgs(input);
  return {
    name,
    result: clip(RedactionLayer.redactSecrets(result.slice(0, MAX_SCAN_CHARS))),
    ...(args ? { args } : {}),
    ...(ranAs && ranAs !== name ? { ranAs } : {}),
  };
}

const MAX_ARG_CHARS = 60;
const MAX_ARGS_CHARS = 160;
/**
 * The words that mark a secret, matched as WHOLE words of an identifier or a
 * selector — `#author`, `authors.txt` and `passage` are not `auth` or `pass`.
 * A substring match hid the text of ordinary writes and fills, which is the
 * evidence this record exists to show. `key` alone is not one: a key press is
 * `key=Enter`. It counts after a word that makes it a credential.
 */
const SECRET_WORDS = new Set([
  'password', 'passwords', 'passwd', 'passphrase', 'passcode', 'pass', 'pwd',
  'secret', 'secrets', 'token', 'tokens', 'auth', 'authorization', 'cookie', 'cookies',
  'credential', 'credentials', 'otp', 'pin', 'cvv', 'cvc', 'apikey',
]);
const KEY_QUALIFIERS = new Set(['api', 'access', 'private', 'secret', 'client', 'signing', 'account']);

function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether an identifier or selector names a secret. See SECRET_WORDS. */
function namesSecret(text: string): boolean {
  const words = wordsOf(text);
  return words.some((w, i) => SECRET_WORDS.has(w) || (w === 'key' && i > 0 && KEY_QUALIFIERS.has(words[i - 1]!)));
}

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
  const intoSecret = entries.some(([k, v]) => !TYPED_VALUE.test(k) && typeof v === 'string' && namesSecret(v));
  const parts = entries.map(([k, v]) => {
    if (namesSecret(k) || (intoSecret && TYPED_VALUE.test(k))) return `${k}=[redacted]`;
    const raw = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
    // A command or a URL can carry a credential under an innocent key.
    const flat = RedactionLayer.redactSecrets(raw.slice(0, MAX_SCAN_CHARS)).replace(/\s+/g, ' ').trim();
    return `${k}=${flat.length > MAX_ARG_CHARS ? `${flat.slice(0, MAX_ARG_CHARS)}…` : flat}`;
  });
  const joined = parts.join(', ');
  return joined.length > MAX_ARGS_CHARS ? `${joined.slice(0, MAX_ARGS_CHARS)}…` : joined;
}

/**
 * The wrappers T3Worker and the registry put around a call — a throw, a
 * denial, a refused argument. They are never a tool's own content, so they
 * mean failure whichever tool was called.
 */
const ENVELOPE_FAILURE = /^(?:Tool error:|Tool \S+ was denied|Tool not found:)/;

/**
 * Each built-in tool's own way of saying it failed, keyed by the tool's name.
 *
 * Keyed, because a tool that returns content can return content that begins
 * like a failure: a page that starts "Failed experiments…", a log file that
 * starts "Build failed: …", a script that prints "Error: …". Matched against
 * every result, those read as failures, and an answer built on them was
 * graded unsupported. So each wording counts only for the tool that emits it,
 * and only in the exact form it emits it.
 */
const TOOL_FAILURE: Record<string, RegExp> = {
  // `outcome.detail` is page content, so only the prefixes this tool adds.
  browser_control: /^(?:Failed: |Error: (?:browser control is not available|action is required|the run was cancelled|"[^"\n]*" needs |the browser could not perform ))/,
  browser: /^(?:Error: Playwright is not installed|Browser launch failed: |Browser action "[^"\n]*" failed: |Browser error \(page reset\): |Unknown browser action: )/,
  read_current_page: /^(?:Error: could not read the open page|No page is open in the built-in browser)/,
  code_search: /^(?:Code search failed: |Provide a "query" to search the codebase)/,
  knowledge_graph_search: /^Provide a "query" naming the entities/,
  generate_document: /^(?:Provide (?:a "path" for the document|"content" — )|generate_document renders \.docx, \.pptx and \.xlsx\. )/,
  generate_image: /^Provide a "prompt" describing the image/,
  generate_speech: /^Provide "text" to speak/,
  generate_video: /^Provide a "prompt" describing the video/,
  run_code: /^(?:Execution (?:failed \(\d+ms\):|timed out after )|Error: [\w.]+ interpreter not found\.)/,
  // A non-zero exit, and the output that came with it.
  shell: /^Exit (?!0:)[^\s:]+:(?:\s|$)/,
  // A success starts "URL: …", so a failure's wording cannot be page text.
  web_fetch: /^(?:HTTP [45]\d\d |Refused to fetch |Failed to fetch |Failed to read response body: )/,
  web_search: /^Error: query is required/,
  github: /^(?:Error: No \w+ token provided|Authentication failed: |Permission denied: |Not found: Repository |Validation error from |Rate limited by |\w+ API error \(\d{3}\): |\w+ request failed: )/,
  grep: /^Invalid regex pattern: /,
  peer_message: /^(?:Error: (?:toId is required|Peer communication is not enabled)|Unknown action: )/,
  // No answer came back, for whichever reason — the questions obtained nothing.
  ask_user: /^(?:Error: ask_user needs |(?:There is nobody watching this run to answer|The run was stopped while the question was open|They saw the questions and chose not to answer|They did not answer in time)\. Proceed on your best reading)/,
  transcribe_audio: /^(?:Could not read the audio file at |Provide a "path" to the audio file)/,
};

/**
 * A tool with no entry above: one created at run time, or an MCP tool. A
 * created tool's sandbox says these in its own words, and a created tool
 * commonly returns what its inner call returned. An MCP tool's failure is a
 * protocol flag, not a wording; `McpClient.callTool` turns it into the
 * `Tool error:` envelope.
 */
const OTHER_TOOL_FAILURE = /^(?:Dynamic tool "[^"\n]*" timed out |Error calling \S+: |Permission denied for )/;

/** Whether this tool's result says the call failed or was refused. */
export function toolReportedFailure(name: string, result: string): boolean {
  if (ENVELOPE_FAILURE.test(result)) return true;
  return (TOOL_FAILURE[name] ?? OTHER_TOOL_FAILURE).test(result);
}

/**
 * Read from the record as kept: clipped, redacted, whitespace flattened. The
 * wordings above are prefixes and allow for the flattening, so the start of
 * the result is all they need.
 */
function failedCall({ name, result, ranAs }: ToolRecordEntry): boolean {
  // A fallback's result is the tool that ran, behind the worker's marker.
  return ranAs
    ? toolReportedFailure(ranAs, result.replace(/^\[(?:Fallback via|Synthesized) [^\]]*\]: /, ''))
    : toolReportedFailure(name, result);
}

/** How a call is named in the record — with the tool that stood in for it, if one did. */
function callName({ name, ranAs }: ToolRecordEntry): string {
  return ranAs ? `${name} [ran as ${ranAs}]` : name;
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
  const call = (entry: ToolRecordEntry) => `- ${entry.name}${entry.args ? `(${entry.args})` : ''}${entry.ranAs ? ` [ran as ${entry.ranAs}]` : ''}`;
  const detail = recent.map((entry) => `${call(entry)} → ${clip(entry.result) || '(empty result)'}`);
  if (!before.length) return detail.join('\n');

  const lines: string[] = [];
  if (oldest.length) {
    // By tool, in the order each was first used. Bounded by the number of
    // distinct tools, however many calls there were.
    const byTool = new Map<string, { ok: number; failed: number }>();
    for (const entry of oldest) {
      const key = callName(entry);
      const tally = byTool.get(key) ?? { ok: 0, failed: 0 };
      if (failedCall(entry)) tally.failed++; else tally.ok++;
      byTool.set(key, tally);
    }
    lines.push(`Earliest calls, by tool (${oldest.length}):`);
    for (const [name, { ok, failed }] of byTool) {
      const outcomes = [ok && `${ok} returned a result`, failed && `${failed} an error or refusal`].filter(Boolean).join(', ');
      lines.push(`- ${name} ×${ok + failed} (${outcomes})`);
    }
  }
  lines.push(`Earlier calls (${outlined.length}):`);
  for (const entry of outlined) {
    lines.push(`${call(entry)} → ${failedCall(entry) ? 'an error or refusal' : 'returned a result'}`);
  }
  lines.push(`Most recent ${recent.length}:`, ...detail);
  return lines.join('\n');
}
