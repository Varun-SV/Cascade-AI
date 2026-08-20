/**
 * The deterministic rung of the verification ladder.
 *
 * T1 asks the planner for acceptance criteria that are "1-3 checks a reviewer
 * could verify mechanically (file exists / contains X / command exits 0)", and
 * the planner obliges — but nothing ever checked them mechanically. Every
 * criterion went to selfTest(), an LLM call, which is both slower and a worse
 * judge of "does this file exist" than `stat` is. A grader that hallucinates a
 * pass on a file that was never written is exactly the failure the criteria
 * were introduced to prevent.
 *
 * So: decide here what can be decided by looking, and hand the rest to the
 * model unchanged. The governing rule is that **deferring is always safe and
 * deciding wrongly is not**, so every pattern below is deliberately narrow.
 * A criterion this module cannot confidently parse comes back `undecidable`
 * and the LLM grader sees it exactly as it does today.
 *
 * Shell criteria ("command exits 0") are deliberately NOT executed. Acceptance
 * text is LLM-authored and reaches this code as free prose; running it would
 * turn a plan into an arbitrary command execution channel. Those stay
 * undecidable.
 */

export type AcceptanceVerdict = 'passed' | 'failed' | 'undecidable';

export interface AcceptanceResult {
  criterion: string;
  verdict: AcceptanceVerdict;
  /** Human-readable reason, present for passed/failed. */
  detail?: string;
}

export interface AcceptanceProbe {
  /** null when the path does not exist or is not a regular file. */
  stat(path: string): Promise<{ size: number } | null>;
  /** utf-8 contents, or null when unreadable (missing, binary, too large). */
  read(path: string): Promise<string | null>;
}

export interface AcceptanceOptions {
  /**
   * Whether the worker being graded had ANY tool that could put a file on
   * disk. Defaults to true, which is every caller that does not say otherwise.
   *
   * When false, a file-shaped criterion is `undecidable` rather than `failed`.
   * `stat` still answers correctly — the file really is absent — but the
   * verdict is a judgement about the WORKER, and "you did not write the file"
   * is the wrong judgement when nothing in the run could write one. A hosted
   * chat run enables `web_search`/`web_fetch` only (cloud/server/src/runs.ts),
   * while T1 and T2 are asked for acceptance criteria phrased as "file exists
   * / contains X" — so the planner names a file, the worker answers in prose
   * because prose is all it can produce, and this rung failed it for that.
   * correctOutput then re-ran, the file was still absent, and the subtask
   * ESCALATED carrying a perfectly good answer.
   *
   * This is the same guard `shouldRequireArtifact()` applies one rung up (see
   * t3-worker.ts); the artifact rung got it in #151 and this rung, added
   * afterwards, never inherited it. Deferring keeps the module's governing
   * rule: the criterion still reaches selfTest(), which judges the OUTPUT and
   * can actually tell whether the work was done.
   */
  workerCanWriteFiles?: boolean;
}

/**
 * A filename-with-extension token, which is what a mechanical criterion names.
 *
 * The leading run is BOUNDED. Unbounded (`*`) it is a polynomial-ReDoS shape:
 * the pattern is unanchored with /g, so on input like "-------------…" every
 * position starts a fresh scan to the end looking for a `\w\.` that never
 * arrives — O(n²), on text an LLM wrote. 200 characters is far longer than any
 * real path, and a longer one simply stops being recognised as a path, which
 * lands the criterion in `undecidable` — the safe direction.
 */
const PATH_TOKEN = /[\w./\\-]{0,200}\w\.[A-Za-z0-9]{1,8}\b/g;

/** `contains "x"`, `contains 'x'`, `includes \`x\`` — the quoted needle forms. */
const QUOTED_NEEDLE = /(?:contains?|includes?|mentions?)\s+["'`]([^"'`]+)["'`]/i;

const EXISTS = /\b(?:exists?|is\s+created|is\s+present|was\s+created|be\s+created)\b/i;
const NON_EMPTY = /\b(?:non-?empty|not\s+empty)\b/i;
const NEGATION = /\b(?:not|no|never|without|absent|missing|does\s*n[o']t)\b/i;

/**
 * Resolve which file a criterion is talking about.
 * Prefers a path named in the criterion; falls back to the subtask's single
 * owned file, because "the file exists" is unambiguous when there is only one.
 */
function targetFile(criterion: string, ownedFiles: readonly string[]): string | null {
  const mentioned = [...new Set(criterion.match(PATH_TOKEN) ?? [])];

  // Two or more files named means the criterion is a conjunction ("a.md and
  // b.md both exist") or a comparison between them. Deciding it from whichever
  // path happened to match first would report a pass while half the criterion
  // was unchecked — the exact wrong-decision this rung must never make.
  if (mentioned.length > 1) return null;

  if (mentioned.length === 1) {
    const candidate = mentioned[0]!;
    // Prefer the owned path, so a bare "report.md" resolves to "docs/report.md".
    return ownedFiles.find((file) => file === candidate || file.endsWith(`/${candidate}`))
      ?? candidate;
  }

  // No path named: unambiguous only when the subtask owns exactly one file.
  return ownedFiles.length === 1 ? ownedFiles[0]! : null;
}

/**
 * Evaluate acceptance criteria, deciding only the mechanically checkable ones.
 * Order and length of the result always match `criteria`.
 */
export async function evaluateAcceptance(
  criteria: readonly string[],
  ownedFiles: readonly string[],
  probe: AcceptanceProbe,
  options: AcceptanceOptions = {},
): Promise<AcceptanceResult[]> {
  const canWriteFiles = options.workerCanWriteFiles ?? true;
  const results: AcceptanceResult[] = [];

  for (const criterion of criteria) {
    const text = criterion.trim();
    if (!text) {
      results.push({ criterion, verdict: 'undecidable' });
      continue;
    }

    // A negated criterion ("report.md does not contain TODO") inverts the
    // meaning of every pattern below. Rather than get that subtly wrong for a
    // rare phrasing, defer the whole thing.
    if (NEGATION.test(text)) {
      results.push({ criterion, verdict: 'undecidable' });
      continue;
    }

    const needle = text.match(QUOTED_NEEDLE)?.[1];
    const wantsExists = EXISTS.test(text);
    const wantsNonEmpty = NON_EMPTY.test(text);
    if (!needle && !wantsExists && !wantsNonEmpty) {
      results.push({ criterion, verdict: 'undecidable' });
      continue;
    }

    const file = targetFile(text, ownedFiles);
    if (!file) {
      results.push({ criterion, verdict: 'undecidable' });
      continue;
    }

    // Decided before the probe runs, not after: on a run with no file-writing
    // tool there is no reading of the filesystem that says anything about the
    // worker, so there is no reason to look.
    if (!canWriteFiles) {
      results.push({
        criterion,
        verdict: 'undecidable',
        detail: `no tool on this run can create ${file} — deferred to output review`,
      });
      continue;
    }

    const stat = await probe.stat(file);
    if (!stat) {
      results.push({ criterion, verdict: 'failed', detail: `${file} does not exist` });
      continue;
    }

    if (wantsNonEmpty && stat.size === 0) {
      results.push({ criterion, verdict: 'failed', detail: `${file} is empty` });
      continue;
    }

    if (needle) {
      const content = await probe.read(file);
      if (content === null) {
        // Exists but unreadable as text (a .docx, say). Existence is confirmed;
        // whether it "contains" the needle is not something this rung can say.
        results.push({ criterion, verdict: 'undecidable' });
        continue;
      }
      const found = content.includes(needle);
      results.push({
        criterion,
        verdict: found ? 'passed' : 'failed',
        detail: found
          ? `${file} contains ${JSON.stringify(needle)}`
          : `${file} does not contain ${JSON.stringify(needle)}`,
      });
      continue;
    }

    results.push({ criterion, verdict: 'passed', detail: `${file} exists` });
  }

  return results;
}

/** The criteria that still need a model's judgement. */
export function undecided(results: readonly AcceptanceResult[]): string[] {
  return results.filter((r) => r.verdict === 'undecidable').map((r) => r.criterion);
}

/** Failure messages, phrased so correctOutput can act on them directly. */
export function failures(results: readonly AcceptanceResult[]): string[] {
  return results
    .filter((r) => r.verdict === 'failed')
    .map((r) => `Acceptance not met — ${r.criterion}${r.detail ? ` (${r.detail})` : ''}`);
}
