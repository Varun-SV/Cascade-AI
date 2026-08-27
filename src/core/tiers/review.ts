// ─────────────────────────────────────────────
//  Cascade AI — T1 review verdicts
// ─────────────────────────────────────────────
//
//  The reviewer used to answer "REJECTED: <prose>", and that prose went
//  straight into `currentAction` — a one-line status field. Every surface
//  truncates it (the CLI at 38, 42, 45, 60 and 80 characters; the run drawer
//  with a CSS clamp) except the web chat's status button, which renders its
//  label unclamped: a 780-character paragraph appeared beside a chevron sized
//  for a sentence.
//
//  Truncating there too would have been the wrong fix. That line is the only
//  explanation a user gets for why the run is repeating itself, so the answer
//  is to stop sending a paragraph where a verdict belongs: a short summary for
//  the status line, and the gaps as data for anything with room to show them.

/** One thing the reviewer says is missing. */
export interface ReviewGap {
  /** A single sentence naming the gap. */
  title: string;
  /** Optional elaboration, when the reviewer gave one. */
  detail?: string;
  /** Section titles this gap was found in, when the reviewer attributed it. */
  sections?: string[];
}

/** What a review pass concluded. */
export interface ReviewVerdict {
  approved: boolean;
  /** One line, safe to put in a status field. Absent when approved. */
  summary?: string;
  gaps: ReviewGap[];
  /**
   * The verdict as prose, for the correction prompt — which needs the full
   * detail, not the summary. Assembled from the parts rather than kept
   * separately so the two cannot disagree.
   */
  reason?: string;
}

/** Cap on the status-line summary. Long enough to be specific, short enough to sit in a chip. */
const SUMMARY_MAX = 120;

/**
 * Tighter cap for the summary WHEN it shares the status line with the gap
 * count and pass counter. Chosen so the assembled line still fits the
 * 80-character status bar: the longest tail (` — 12 gaps, pass 9 of 9`) is 23
 * characters, and 56 + 23 leaves a character in hand.
 */
const STATUS_SUMMARY_MAX = 56;

/**
 * The reviewer's requested answer format.
 *
 * Asking for a shape rather than a paragraph is the whole fix; the parser
 * below still copes when a model answers in prose anyway, because some will.
 */
export const REVIEW_FORMAT_INSTRUCTIONS = `If the outputs fully satisfy the request, reply with exactly: APPROVED

If they do not, reply in exactly this shape and nothing else:

REJECTED
Summary: <one sentence, at most 15 words, saying what is wrong overall>
- <a single sentence naming one missing thing> || <comma-separated section titles it applies to, or "all"> || <one sentence of detail>
- <the next one, same shape>

List at most 6 gaps, most important first. Keep every line on one line.`;

/** Trim, collapse whitespace, and cut to `max` on a word boundary where possible. */
function tidy(text: string, max = 0): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!max || flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]$/, '')}…`;
}

/**
 * Split a `a, b` / `a; b` section list into titles. Empty for "all".
 *
 * Both rules here exist because a section title is ordinary English and the
 * old ones read it as syntax:
 *
 * - Splitting on ` and ` invented two sections out of one real title —
 *   "Research and Development" became "Research" and "Development", neither of
 *   which is in the plan. A conjunction is far more often part of a title than
 *   between two of them, so punctuation is now the only separator. The cost is
 *   that a reviewer writing "Alpha and Beta" for two sections gets one label
 *   instead of two; a slightly odd label beats a pair of invented ones.
 * - `/^all\b/` discarded the attribution of any title merely STARTING with
 *   "All", such as "All Hands Migration", reporting a gap against every
 *   section instead of the one it was found in. Only the bare wildcard counts.
 */
function parseSections(raw: string): string[] | undefined {
  const flat = tidy(raw);
  if (!flat || /^all(\s+sections)?$/i.test(flat) || flat === '-') return undefined;
  const parts = flat.split(/[;,]/).map((s) => tidy(s)).filter(Boolean);
  return parts.length ? parts : undefined;
}

/**
 * Read the reviewer's answer into a verdict.
 *
 * Deliberately forgiving. A model told to answer in a shape will sometimes
 * answer in prose regardless, and the fallback matters as much as the happy
 * path: it must NOT put the whole paragraph in `summary`, because that field
 * goes on the status line and would reproduce the exact bug this replaces.
 * So prose becomes a first-sentence summary plus one gap carrying the rest.
 */
export function parseReviewResponse(raw: string): ReviewVerdict {
  const text = raw.trim();
  if (/^approved\b/i.test(text)) return { approved: true, gaps: [] };

  const body = text.replace(/^rejected\s*:?\s*/i, '').trim();
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);

  const gaps: ReviewGap[] = [];
  let summary = '';

  for (const line of lines) {
    const summaryMatch = line.match(/^summary\s*:\s*(.+)$/i);
    if (summaryMatch && !summary) {
      summary = tidy(summaryMatch[1]!, SUMMARY_MAX);
      continue;
    }
    // A bullet or a numbered item. Both are what models actually produce, so
    // both are accepted rather than only the one that was asked for.
    const bulletMatch = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (!bulletMatch) continue;
    const [titlePart, sectionPart, detailPart] = bulletMatch[1]!.split('||');
    const title = tidy(titlePart ?? '');
    if (!title) continue;
    const gap: ReviewGap = { title };
    const sections = sectionPart ? parseSections(sectionPart) : undefined;
    if (sections) gap.sections = sections;
    const detail = detailPart ? tidy(detailPart) : '';
    if (detail) gap.detail = detail;
    gaps.push(gap);
  }

  // Prose fallback: no bullets came back at all.
  if (gaps.length === 0) {
    const firstSentence = body.split(/(?<=[.!?])\s/)[0] ?? body;
    summary = summary || tidy(firstSentence, SUMMARY_MAX);
    const rest = tidy(body);
    if (rest) gaps.push({ title: rest.length > 400 ? tidy(rest, 400) : rest });
  }

  // A rejection with nothing in it — an empty or truncated response that got as
  // far as "REJECTED". Left alone this produced `approved: false` with zero
  // gaps and the summary "0 things are missing": the orchestrator spent a
  // corrective pass on a reason that said nothing, while the client read zero
  // gaps as an approval and cleared the card. A generic gap keeps the two in
  // agreement, and a wasted pass (capped at maxReplanPasses) is a safer
  // failure than approving output the reviewer meant to reject.
  if (gaps.length === 0) {
    gaps.push({ title: 'The reviewer rejected the output without saying what was wrong.' });
  }

  if (!summary) {
    summary = tidy(gaps[0]!.title, SUMMARY_MAX);
  }

  return { approved: false, summary, gaps, reason: verdictToProse(summary, gaps) };
}

/** The verdict as the correction prompt wants it — full detail, not the summary. */
function verdictToProse(summary: string, gaps: ReviewGap[]): string {
  const lines = gaps.map((g, i) => {
    const where = g.sections?.length ? ` (in: ${g.sections.join(', ')})` : '';
    const detail = g.detail ? ` ${g.detail}` : '';
    return `${i + 1}. ${g.title}${where}${detail}`;
  });
  return [summary, ...lines].filter(Boolean).join('\n');
}

/**
 * The one-line form for a status field.
 *
 * This is what replaces the paragraph. It has to survive an 80-character
 * budget in the CLI and still say something specific.
 */
export function reviewStatusLine(verdict: ReviewVerdict, pass: number, maxPasses: number): string {
  const n = verdict.gaps.length;
  const what = n === 1 ? '1 gap' : `${n} gaps`;
  // The summary LEADS, and that ordering is the point of including it.
  //
  // Only the web chat renders the structured verdict as a card; the CLI, the
  // local dashboard and the desktop run drawer show `currentAction` and
  // nothing else. Reporting a count and a pass number told those three that
  // the run was repeating but not why — strictly less than the paragraph this
  // replaced, which at least named the problem before it was cut off. The
  // summary is already bounded (SUMMARY_MAX) and is re-bounded tighter here so
  // the whole line still fits the 80-character status bar; the CLI's agent
  // tree cuts at 38, so whatever goes first is the part most people read.
  const summary = verdict.summary ? tidy(verdict.summary, STATUS_SUMMARY_MAX) : '';
  return summary
    ? `${summary} — ${what}, pass ${pass} of ${maxPasses}`
    : `Review found ${what} — replanning, pass ${pass} of ${maxPasses}`;
}
