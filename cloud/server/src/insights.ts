// ─────────────────────────────────────────────
//  Cascade Cloud — routing and spend across everyone, published safely
// ─────────────────────────────────────────────
//
//  The "Everyone" view of docs/design/byo-browser-and-routing-data.md §8. What one
//  user's runs cost is theirs to see in full (the You view, spend.ts); what all users'
//  runs cost is published only in a form no one user's runs can be read out of:
//
//  - Releases are closed ISO weeks (UTC, Monday to Monday). A week is released once,
//    after it closes, and never revised: rows arriving later for it are left out. No
//    rolling windows, no free-form filters, no calendar months.
//  - A cell is one week, one surface, one tier, one model. It is published only with
//    at least MIN_RUNS runs from at least MIN_USERS users. The user count itself is
//    never published.
//  - Nothing else is computed from the ledger. "All surfaces", a tier's total, and a
//    span of weeks are sums of published cells only, so no figure can be subtracted
//    from another to reveal a cell that was held back. A span is labelled by its weeks
//    ("weeks 40–43"), never as a month.
//  - Only runs, cost and tokens. Success rates and model-to-model comparisons stay out
//    until outcomes are truthful (§8, "Hold back").

import type { SpendSurface } from './spend.js';

export const MIN_RUNS = 20;
export const MIN_USERS = 5;
/** The longest span of weeks the view combines. */
export const MAX_WEEKS = 26;

const WEEK_MS = 7 * 86_400_000;

/** Monday 00:00 UTC of the ISO week holding `ms`. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** The ISO week label, `2026-W46`: its year is the year of its Thursday. */
export function isoWeek(ms: number): string {
  const monday = weekStart(ms);
  const thursday = new Date(monday + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week = 1 + Math.round((monday - weekStart(jan4)) / WEEK_MS);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The weeks that have closed by `nowMs`, from the one holding `fromMs`, oldest first. */
export function closedWeeks(fromMs: number, nowMs: number): Array<{ week: string; startMs: number; endMs: number }> {
  const out: Array<{ week: string; startMs: number; endMs: number }> = [];
  for (let start = weekStart(fromMs); start + WEEK_MS <= nowMs; start += WEEK_MS) {
    out.push({ week: isoWeek(start), startMs: start, endMs: start + WEEK_MS });
  }
  return out;
}

export interface WeekCell { surface: SpendSurface; tier: string; model: string; runs: number; users: number; costUsd: number; tokens: number }
export interface PublishedCell { surface: SpendSurface; tier: string; model: string; runs: number; costUsd: number; tokens: number }

/** What may be published of one week: the cells over both minimums, and nothing about the rest. */
export function publishable(cells: readonly WeekCell[]): PublishedCell[] {
  return cells
    .filter((c) => c.runs >= MIN_RUNS && c.users >= MIN_USERS)
    .map(({ surface, tier, model, runs, costUsd, tokens }) => ({ surface, tier, model, runs, costUsd, tokens }));
}

/** The store behind releases, so the rules can be tested without SQLite. */
export interface InsightsStore {
  /** Earliest run with a surface, or null with none. */
  firstSurfacedRunAt(): number | null;
  isReleased(week: string): boolean;
  /** Every cell of a week from the ledger, unfiltered: never leaves this module. */
  weekCells(startMs: number, endMs: number): WeekCell[];
  /** Writes a week's release once; a week already released is left as it is. */
  release(week: string, cells: PublishedCell[], atMs: number): void;
  released(weeks: readonly string[]): Map<string, PublishedCell[]>;
}

/** Releases every week that has closed and isn't released yet. Idempotent. */
export function releaseClosedWeeks(store: InsightsStore, nowMs: number): string[] {
  const first = store.firstSurfacedRunAt();
  if (first === null) return [];
  const done: string[] = [];
  for (const w of closedWeeks(first, nowMs)) {
    if (store.isReleased(w.week)) continue;
    store.release(w.week, publishable(store.weekCells(w.startMs, w.endMs)), nowMs);
    done.push(w.week);
  }
  return done;
}

export interface EveryoneRow { tier: string; model: string; runs: number; costUsd: number; tokens: number }
export interface EveryoneView {
  surface: SpendSurface | 'all';
  /** "weeks 2026-W40–2026-W43", or one week's label: never a month. */
  label: string;
  weeks: Array<{ week: string; rows: EveryoneRow[] }>;
  /** The span's rows: sums of the published cells above, and of nothing else. */
  rows: EveryoneRow[];
  minimums: { runs: number; users: number };
}

function sumRows(cells: readonly PublishedCell[]): EveryoneRow[] {
  const by = new Map<string, EveryoneRow>();
  for (const c of cells) {
    const key = `${c.tier}\u0000${c.model}`;
    const row = by.get(key) ?? { tier: c.tier, model: c.model, runs: 0, costUsd: 0, tokens: 0 };
    row.runs += c.runs;
    row.costUsd += c.costUsd;
    row.tokens += c.tokens;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => a.tier.localeCompare(b.tier) || b.runs - a.runs || a.model.localeCompare(b.model));
}

/** The last `count` released weeks, for one surface or all, built from published cells only. */
export function everyoneView(store: InsightsStore, surface: SpendSurface | null, count: number, nowMs: number): EveryoneView {
  const n = Math.max(1, Math.min(MAX_WEEKS, Math.floor(count)));
  const lastClosed = weekStart(nowMs) - WEEK_MS;
  const weeks: string[] = [];
  for (let i = n - 1; i >= 0; i--) weeks.push(isoWeek(lastClosed - i * WEEK_MS));
  const released = store.released(weeks);
  const shown = weeks.filter((w) => released.has(w));
  const pick = (cells: readonly PublishedCell[]) => (surface ? cells.filter((c) => c.surface === surface) : cells);
  const perWeek = shown.map((week) => ({ week, rows: sumRows(pick(released.get(week)!)) }));
  const label = shown.length === 0 ? 'no weeks released yet'
    : shown.length === 1 ? `week ${shown[0]}` : `weeks ${shown[0]}–${shown[shown.length - 1]}`;
  return {
    surface: surface ?? 'all',
    label,
    weeks: perWeek,
    rows: sumRows(shown.flatMap((w) => pick(released.get(w)!))),
    minimums: { runs: MIN_RUNS, users: MIN_USERS },
  };
}
