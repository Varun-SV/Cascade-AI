/**
 * Brand tokens for the two PUBLIC surfaces: the landing page (this app) and the
 * docs site (cloud/server/src/docs.ts).
 *
 * The docs page is a self-contained HTML string with inline CSS — it has to be,
 * so it renders under a strict origin with no external assets — and the server
 * package's rootDir keeps it from importing anything here. So it carries its own
 * copy of these values, and `docs.test.ts` reads this file and fails if the two
 * ever disagree. That is the drift guard: one set of numbers, enforced rather
 * than hoped for.
 *
 * The ramp is not decoration. Azure → sky → teal maps onto Tier 1 → 2 → 3, so
 * colour descends with the hierarchy everywhere it appears: the mark, the tier
 * cards, the spine running down the page.
 */

export const AZURE = '#4C8DFF';
export const SKY = '#38B0DE';
export const TEAL = '#2DD4BF';

/** Tier index → accent. Index 0 is T1. */
export const TIER_COLORS = [AZURE, SKY, TEAL] as const;

export interface Tier {
  n: '1' | '2' | '3';
  name: string;
  color: string;
  /** What this tier decides — the one-liner under the heading. */
  text: string;
  /** A concrete decision it makes, so the tier reads as real rather than abstract. */
  example: string;
}

export const TIERS: readonly Tier[] = [
  {
    n: '1',
    name: 'Administrator',
    color: AZURE,
    text: 'Reads the request, plans the work, and delegates. Simple asks it answers directly.',
    example: '“Build a competitor report” → 4 sections, 2 of them able to run in parallel.',
  },
  {
    n: '2',
    name: 'Supervisor',
    color: SKY,
    text: 'Breaks each section into subtasks and coordinates the workers running underneath it.',
    example: 'Section “Pricing” → fetch pages, extract tables, reconcile currencies.',
  },
  {
    n: '3',
    name: 'Worker',
    color: TEAL,
    text: 'Does the actual generation, on the cheapest model that is genuinely good enough for the job.',
    example: 'Table extraction → a small fast model. Final synthesis → a frontier one.',
  },
];
