/**
 * Brand tokens for the two PUBLIC surfaces: the landing page and the docs site
 * (src/docs). Both live in this app, so both read these values directly, and the
 * docs take their colours from the theme tokens in index.css, which hold the same
 * ramp.
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
