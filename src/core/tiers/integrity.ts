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
import { contextParts } from '../../utils/truncate.js';

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
  /**
   * What the model was shown of the result, redacted and flattened — when that
   * is more than `result`. What an honest output can have taken from the call.
   * See `recordToolCall`, and `appendToolRecord` for how long it is kept.
   */
  evidence?: string;
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
 * How much of an argument is redacted before it is clipped. Enough that the
 * clipped part lies well inside it, without scanning a whole large file.
 */
const MAX_SCAN_CHARS = 4096;

function clip(result: string): string {
  const flat = result.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_RESULT_CHARS ? `${flat.slice(0, MAX_RESULT_CHARS)}…` : flat;
}

/**
 * How far from a cut to look for the end of the record it went through. See
 * `dropCutRecord`.
 */
const CUT_SLACK = 256;
/** What ends a record — a line, a list item, a header field, a query parameter. */
const RECORD_BREAK = /[\n,;&]/g;

/**
 * Drop the record a cut went through, from the side of the cut that kept part
 * of it: a credential split in two is not recognisable, and half of one
 * still gives it away — `sk-ant-api03-Ab` or `api_key":"s3` read as nothing
 * to the redaction rules. Looked for within CUT_SLACK of the cut; failing
 * that, CUT_SLACK characters go.
 */
function dropCutRecord(text: string, side: 'end' | 'start'): string {
  if (side === 'end') {
    const near = text.slice(-CUT_SLACK);
    let last = -1;
    for (const m of near.matchAll(RECORD_BREAK)) last = m.index;
    return text.slice(0, text.length - near.length + (last >= 0 ? last + 1 : 0));
  }
  const near = text.slice(0, CUT_SLACK);
  const first = near.search(RECORD_BREAK);
  return text.slice(first >= 0 ? first + 1 : near.length);
}

/**
 * What the model was shown of a result — the whole, or the head and tail
 * `truncateForContext` keeps — with its secrets out and its whitespace
 * flattened. An output can only honestly contain what the model saw, so this
 * is the evidence there is for it; the elided middle was never evidence.
 */
function shownEvidence(result: string): string {
  const flat = (text: string) => RedactionLayer.redactSecrets(text).replace(/\s+/g, ' ').trim();
  const parts = contextParts(result);
  if (!parts) return flat(result);
  return `${flat(dropCutRecord(parts.head, 'end'))} … ${flat(dropCutRecord(parts.tail, 'start'))}`;
}

/**
 * What is kept of one call: the start of its result, where the outcome and any
 * error are — and, as evidence, what the model was shown of the rest.
 *
 * Bounded HERE, when the call is recorded, not when the record is shown. The
 * record used to hold every result whole for the life of the worker — a few
 * `file_read`s of large files is hundreds of megabytes. It then kept only the
 * first 160 characters, which left an accurate answer taken from further into
 * a page indistinguishable from an invented one. What the model saw is at
 * most `truncateForContext`'s bound per call, and `appendToolRecord` bounds
 * the record as a whole.
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
  const evidence = shownEvidence(result);
  const head = clip(evidence);
  return {
    name,
    result: head,
    // Only when it says more than the head does.
    ...(evidence.length > MAX_RESULT_CHARS ? { evidence } : {}),
    ...(args ? { args } : {}),
    ...(ranAs && ranAs !== name ? { ranAs } : {}),
  };
}

/**
 * The most evidence a record holds, across all its calls. Enough for a score
 * of results as large as the model is ever shown one.
 */
const MAX_RECORD_EVIDENCE_CHARS = 256_000;

/**
 * Add a call to a worker's record, keeping the record's evidence within
 * MAX_RECORD_EVIDENCE_CHARS: past it, the OLDEST calls give theirs up first.
 * They keep the start of their result, so the record still says what each
 * call did and whether it worked.
 */
export function appendToolRecord(record: ToolRecordEntry[], entry: ToolRecordEntry): void {
  record.push(entry);
  let held = record.reduce((sum, e) => sum + (e.evidence?.length ?? 0), 0);
  for (let i = 0; i < record.length && held > MAX_RECORD_EVIDENCE_CHARS; i++) {
    const { evidence, ...kept } = record[i]!;
    if (!evidence) continue;
    record[i] = kept;
    held -= evidence.length;
  }
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
 *
 * Then, given the output, the passages of any call's evidence that bear on
 * it. See `passagesFor`.
 */
export function describeToolRecord(record: readonly ToolRecordEntry[], output?: string): string {
  if (!record.length) return 'none — no tool was called';
  const recent = record.slice(-MAX_RECORD_ENTRIES);
  const before = record.slice(0, record.length - recent.length);
  const outlined = before.slice(-MAX_OUTLINE_ENTRIES);
  const oldest = before.slice(0, before.length - outlined.length);
  const call = (entry: ToolRecordEntry) => `- ${entry.name}${entry.args ? `(${entry.args})` : ''}${entry.ranAs ? ` [ran as ${entry.ranAs}]` : ''}`;
  const detail = recent.map((entry) => `${call(entry)} → ${clip(entry.result) || '(empty result)'}`);
  const passages = output ? passagesFor(record, output, call) : [];
  if (passages.length) {
    passages.unshift('Passages from what those calls returned, chosen for the words they share with the output:');
  }
  if (!before.length) return [...detail, ...passages].join('\n');

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
  lines.push(`Most recent ${recent.length}:`, ...detail, ...passages);
  return lines.join('\n');
}

/** The most the passages take up in the self-test prompt, labels included. */
const MAX_PASSAGES_CHARS = 6_000;
const MAX_PASSAGE_CHARS = 280;
/** Two words the output uses, or one of its figures. One shared word is chance. */
const MIN_PASSAGE_SCORE = 2;
/** Words too common to say a passage is about what the output says. */
const COMMON_WORDS = new Set([
  'about', 'after', 'also', 'been', 'before', 'being', 'both', 'could', 'does', 'each', 'from', 'have', 'here',
  'into', 'just', 'like', 'more', 'most', 'only', 'other', 'over', 'should', 'some', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'very', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'would', 'your',
]);

function wordsIn(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * What the output says, as the words that could tie it to a source: its
 * figures, which weigh most because a number is the easiest thing to invent,
 * and its longer words other than the commonest.
 */
function claimTerms(output: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const word of wordsIn(output)) {
    if (/\d/.test(word)) { if (word.length >= 2) terms.set(word, 2); }
    else if (word.length >= 4 && !COMMON_WORDS.has(word)) terms.set(word, 1);
  }
  return terms;
}

/**
 * Runs of whole words, each at most MAX_PASSAGE_CHARS, each starting halfway
 * into the one before — so a statement up to half a window long lies whole in
 * at least one, rather than split between two with its subject in the first
 * and its figure in the second.
 */
function windowsOf(evidence: string): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  for (let at = 0; at < evidence.length; at = evidence.indexOf(' ', at) + 1 || evidence.length) starts.push(at);
  const wordEnd = (k: number) => (k + 1 < starts.length ? starts[k + 1]! - 1 : evidence.length);
  const windows: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < starts.length;) {
    const start = starts[i]!;
    // The last word that ends inside the window. A single word longer than a
    // window is sliced.
    let j = i;
    while (j + 1 < starts.length && wordEnd(j + 1) - start <= MAX_PASSAGE_CHARS) j++;
    windows.push({ start, end: Math.min(wordEnd(j), start + MAX_PASSAGE_CHARS) });
    if (wordEnd(j) >= evidence.length) break;
    let next = i + 1;
    while (next < j && starts[next]! - start < MAX_PASSAGE_CHARS / 2) next++;
    i = next;
  }
  return windows;
}

/**
 * The parts of what the calls returned that bear on the output, for the grader
 * to check its claims against.
 *
 * The record keeps what the model was shown of each result, but a prompt that
 * carried all of it would be most of a context window. So the evidence is
 * searched for the output's own words and figures, and the passages that share
 * the most with it are shown, within MAX_PASSAGES_CHARS. A figure the output
 * took from a page is in a passage that has it; one it made up is in none.
 * From any call still holding evidence, not only the latest: an output can
 * draw on the first page it read.
 */
function passagesFor(
  record: readonly ToolRecordEntry[],
  output: string,
  call: (entry: ToolRecordEntry) => string,
): string[] {
  const terms = claimTerms(output);
  if (!terms.size) return [];
  const candidates: Array<{ entry: number; start: number; end: number; score: number }> = [];
  record.forEach((entry, i) => {
    const evidence = entry.evidence;
    if (!evidence) return;
    for (const { start, end } of windowsOf(evidence)) {
      let score = 0;
      for (const word of new Set(wordsIn(evidence.slice(start, end)))) score += terms.get(word) ?? 0;
      if (score >= MIN_PASSAGE_SCORE) candidates.push({ entry: i, start, end, score });
    }
  });
  // The most in common first; on a tie, the later call, which the output was
  // more likely written from.
  candidates.sort((a, b) => b.score - a.score || b.entry - a.entry || a.start - b.start);
  const chosen: typeof candidates = [];
  const labelled = new Set<number>();
  let used = 0;
  for (const c of candidates) {
    // Windows overlap, and the text they share is shown once: the best of them.
    if (chosen.some((o) => o.entry === c.entry && o.start < c.end && c.start < o.end)) continue;
    const cost = c.end - c.start + 5 + (labelled.has(c.entry) ? 0 : call(record[c.entry]!).length + 2);
    if (used + cost > MAX_PASSAGES_CHARS) continue;
    used += cost;
    labelled.add(c.entry);
    chosen.push(c);
  }
  // Back in the order they were read.
  chosen.sort((a, b) => a.entry - b.entry || a.start - b.start);
  const lines: string[] = [];
  for (let i = 0; i < chosen.length;) {
    const entry = chosen[i]!.entry;
    const texts: string[] = [];
    for (; i < chosen.length && chosen[i]!.entry === entry; i++) {
      texts.push(`"${record[entry]!.evidence!.slice(chosen[i]!.start, chosen[i]!.end)}"`);
    }
    lines.push(`${call(record[entry]!)}: ${texts.join(' … ')}`);
  }
  return lines;
}
