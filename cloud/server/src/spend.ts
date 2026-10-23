// Spend & savings ledger: one row per run, kept apart from the chat it came
// from so tidying chats away never rewrites what was spent. Only numbers are
// stored (when, cost, saving, tokens, and which tier and model spent it), never
// a prompt or a reply.

/** How a run ended. A failed run still spent whatever its calls cost. */
export type SpendOutcome = 'answered' | 'stopped' | 'failed';

export interface SpendModelLine {
  tier: string;
  /** Model id, or '' when the run did not say which model served the tier. */
  model: string;
  costUsd: number;
  tokens: number;
  /**
   * Whether some of this model's calls had no known price, so its cost is an
   * undercount. False means priced: $0 with tokens is a free (local) model.
   * Null for runs whose report did not say, which is every report from before
   * the distinction was kept.
   */
  unpriced: boolean | null;
}

export interface SpendEntry {
  id: string;
  userId: string;
  conversationId: string | null;
  /** Epoch ms. */
  at: number;
  costUsd: number;
  savedUsd: number;
  tokens: number;
  outcome: SpendOutcome;
  lines: SpendModelLine[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The ledger id for a run on the user's device, from the device's own run id:
 * a synced turn and a spend-only record for the same run share it, so the run
 * is counted once. Scoped to the account, so one user's id can never name
 * another's row.
 */
export function deviceRunSpendId(userId: string, runId: string): string {
  return `device:${userId}:${runId}`;
}

/**
 * When a device's run finished, as it reported it: a run can reach the cloud
 * well after it ended (a queued send, a closed window), and counts on the day
 * it ended. Never later than its receipt: a device clock running ahead would
 * otherwise put a run in a day the report has not reached yet, counted in the
 * totals but in no chart slot. A time over 30 days back is not trusted either;
 * both use the receipt time. Undefined for a value that is not a time at all.
 */
export function deviceEndedAt(value: unknown, nowMs: number): number | undefined {
  if (value === undefined || value === null) return nowMs;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value > nowMs || value < nowMs - 30 * 86_400_000 ? nowMs : Math.floor(value);
}

/** A device's run id as `/turns` and `/usage/runs` accept it. */
export const DEVICE_RUN_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * A run's ledger row from its /why report, whether the object a run just built
 * or the JSON a stored reply carries. Old reports have cost per tier and one
 * model per tier; newer ones also split each tier by the models that served it,
 * which is what Cascade Auto's per-subtask picks need.
 */
export function spendEntryFromRun(input: {
  id: string;
  userId: string;
  conversationId: string | null;
  at: number;
  /** The run's cost as stored on its reply; the report's total when absent. */
  costUsd?: number | null;
  why: unknown;
  outcome?: SpendOutcome;
}): SpendEntry {
  let why: Record<string, unknown> = {};
  if (typeof input.why === 'string') {
    try { why = record(JSON.parse(input.why)); } catch { why = {}; }
  } else {
    why = record(input.why);
  }

  const lines: SpendModelLine[] = [];
  const byModel = record(why['costByModel']);
  const tokensByModel = record(why['tokensByModel']);
  // Present (even empty) on reports that keep priced and unpriced apart.
  const unpricedKnown = why['unpricedByModel'] !== undefined;
  const unpricedByModel = record(why['unpricedByModel']);
  if (Object.keys(byModel).length > 0 || Object.keys(tokensByModel).length > 0 || Object.keys(unpricedByModel).length > 0) {
    // An unpriced call that reported no usage appears only in unpricedByModel.
    for (const tier of new Set([...Object.keys(byModel), ...Object.keys(tokensByModel), ...Object.keys(unpricedByModel)])) {
      const costs = record(byModel[tier]);
      const tokens = record(tokensByModel[tier]);
      const unpriced = record(unpricedByModel[tier]);
      for (const model of new Set([...Object.keys(costs), ...Object.keys(tokens), ...Object.keys(unpriced)])) {
        lines.push({
          tier, model, costUsd: num(costs[model]), tokens: Math.round(num(tokens[model])),
          unpriced: unpricedKnown ? num(unpriced[model]) > 0 : null,
        });
      }
    }
  } else {
    const costByTier = record(why['costByTier']);
    const tokensByTier = record(why['tokensByTier']);
    const models = record(why['models']);
    for (const tier of new Set([...Object.keys(costByTier), ...Object.keys(tokensByTier)])) {
      const model = typeof models[tier] === 'string' ? (models[tier] as string) : '';
      lines.push({ tier, model, costUsd: num(costByTier[tier]), tokens: Math.round(num(tokensByTier[tier])), unpriced: null });
    }
  }
  // An unpriced call is kept even with no usage reported: it happened, and its
  // cost is unknown, which the report says rather than showing an exact $0.
  const kept = lines.filter((l) => l.costUsd > 0 || l.tokens > 0 || l.unpriced === true);

  const costUsd = input.costUsd != null ? num(input.costUsd) : num(why['totalCostUsd']);
  const tokens = num(why['totalTokens']) || kept.reduce((s, l) => s + l.tokens, 0);
  // A report from before price status was kept, with tokens at $0: that model
  // may have had no price, its calls left out of the total, so any saving the
  // report claimed against T1 cannot be checked. None is counted.
  const savingUnverifiable = kept.some((l) => l.unpriced === null && l.costUsd === 0 && l.tokens > 0);
  return {
    id: input.id,
    userId: input.userId,
    conversationId: input.conversationId,
    at: input.at,
    costUsd,
    // Same rule as the chat's saved chip: a run that saved nothing adds nothing.
    savedUsd: savingUnverifiable ? 0 : num(why['savedUsd']),
    tokens: Math.round(tokens),
    outcome: input.outcome ?? 'answered',
    lines: kept,
  };
}

/**
 * What one run of an old CLI cost, from the running total it sent.
 *
 * Before replies carried their own /why, the CLI synced its whole session's
 * cost so far with every reply: three runs costing c1, c2 and c3 arrived as
 * c1, c1+c2 and c1+c2+c3. Counted as they came, a session was billed again
 * for every earlier run on every later reply. The run is what the total grew
 * by since the chat's last such reply; a total that went down belongs to a new
 * session, and is all this run's.
 *
 * Only replies with a cost and no /why are read this way. Nothing else ever
 * stored that shape: a hosted reply always carries its /why, today's CLI and
 * desktop app send one, and the desktop app before them sent no cost at all.
 */
export function legacyCliRunCost(total: number, previousTotal: number | null): number {
  const now = num(total);
  if (previousTotal === null) return now;
  const before = num(previousTotal);
  return now >= before ? now - before : now;
}

// ── Report periods ─────────────────────────────

export type SpendPeriod = 'today' | '7d' | '30d' | 'all';
export type SpendBucket = 'hour' | 'day' | 'month';
export const SPEND_PERIODS: readonly SpendPeriod[] = ['today', '7d', '30d', 'all'];

const pad = (n: number) => String(n).padStart(2, '0');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The longest history "all time" still shows day by day. */
export const ALL_TIME_DAILY_UP_TO = 60;
/** Real UTC offsets run from −12:00 to +14:00. */
export const MAX_TZ_OFFSET_MIN = 14 * 60;

export function parsePeriod(v: unknown): SpendPeriod | null {
  return typeof v === 'string' && (SPEND_PERIODS as readonly string[]).includes(v) ? (v as SpendPeriod) : null;
}

/** Minutes east of UTC, e.g. 330 for India, −300 for New York in winter. */
export function parseTzOffset(v: unknown): number | null {
  if (v === undefined) return 0;
  if (typeof v !== 'string' || !/^-?\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return Math.abs(n) <= MAX_TZ_OFFSET_MIN ? n : null;
}

/**
 * Where the viewer's days begin and end: an IANA time zone name
 * (`Europe/London`), whose offset is looked up for each instant so a
 * daylight-saving change moves midnight with it, or a fixed offset in minutes
 * east of UTC.
 */
export type TimeZone = string | number;

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(zone: string): Intl.DateTimeFormat {
  let f = zoneFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    zoneFormats.set(zone, f);
  }
  return f;
}

/** A time zone name, or a fixed offset (see `parseTzOffset`); null when neither. */
export function parseTimeZone(v: unknown): TimeZone | null {
  if (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(v) && v.length <= 64) {
    try {
      zoneFormat(v);
      return v;
    } catch {
      return null;
    }
  }
  return parseTzOffset(v);
}

interface LocalTime { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** The wall-clock time at an instant in a zone. */
function localTime(atMs: number, zone: TimeZone): LocalTime {
  if (typeof zone === 'number') {
    const t = new Date(atMs + zone * 60_000);
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
  }
  const p: Record<string, number> = {};
  for (const part of zoneFormat(zone).formatToParts(new Date(atMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p['year']!, mo: p['month']!, d: p['day']!, h: p['hour']! % 24, mi: p['minute']!, s: p['second']! };
}

/** Minutes east of UTC in force at an instant. */
function offsetAt(atMs: number, zone: TimeZone): number {
  if (typeof zone === 'number') return zone;
  const l = localTime(atMs, zone);
  return Math.round((Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s) - Math.floor(atMs / 1000) * 1000) / 60_000);
}

/** A calendar date `n` days after (y, mo, d). */
function addDays(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const dateKey = (y: number, mo: number, d: number) => `${y}-${pad(mo)}-${pad(d)}`;

/** The first instant of a local calendar date. */
function startOfDate(y: number, mo: number, d: number, zone: TimeZone): number {
  const wall = Date.UTC(y, mo - 1, d);
  const day = dateKey(y, mo, d);
  const readsAsMidnight = (t: number) => {
    const l = localTime(t, zone);
    return dateKey(l.y, l.mo, l.d) === day && l.h === 0 && l.mi === 0 && l.s === 0;
  };
  // Midnight under each offset in force within a day of it. When clocks go
  // back across midnight it happens twice, and the day starts at the first.
  const DAY = 86_400_000;
  const offsets = new Set([-DAY, 0, DAY].map((k) => offsetAt(wall + k, zone)));
  const midnights = [...offsets].map((o) => wall - o * 60_000).filter(readsAsMidnight);
  if (midnights.length > 0) return Math.min(...midnights);
  // A zone whose clocks skip midnight starts that day at the first instant
  // that reads as it.
  let t = wall - offsetAt(wall, zone) * 60_000;
  t = wall - offsetAt(t, zone) * 60_000;
  for (let i = 0; i < 8; i++) {
    const l = localTime(t, zone);
    if (dateKey(l.y, l.mo, l.d) >= day) break;
    t += 15 * 60_000;
  }
  return t;
}

export interface PeriodRange {
  /** Epoch ms of the first instant counted, or null for all time. */
  fromMs: number | null;
  bucket: SpendBucket;
  /** The chart's slots in order, as the ledger's bucket keys (local time). */
  keys: string[];
}

/** The ledger's bucket key for a UTC instant, read in the viewer's local time. */
export function bucketKey(atMs: number, zone: TimeZone, bucket: SpendBucket): string {
  const l = localTime(atMs, zone);
  const day = dateKey(l.y, l.mo, l.d);
  if (bucket === 'month') return day.slice(0, 7);
  if (bucket === 'hour') return `${day} ${pad(l.h)}`;
  return day;
}

/**
 * Where a period starts and which chart slots it has, with days running from
 * the viewer's local midnight to the next, under the offset in force on each
 * day: a day with a daylight-saving change has 23 or 25 hours, not 24.
 */
export function periodRange(period: SpendPeriod, zone: TimeZone, nowMs: number, firstAtMs: number | null): PeriodRange {
  const today = localTime(nowMs, zone);
  const todayStart = startOfDate(today.y, today.mo, today.d, zone);
  if (period === 'today') {
    const next = addDays(today.y, today.mo, today.d, 1);
    const end = startOfDate(next.y, next.mo, next.d, zone);
    const keys: string[] = [];
    // Hour by hour to the next midnight; an hour the clocks repeat is one slot.
    for (let t = todayStart; t < end; t += HOUR) {
      const key = bucketKey(t, zone, 'hour');
      if (keys[keys.length - 1] !== key) keys.push(key);
    }
    return { fromMs: todayStart, bucket: 'hour', keys };
  }
  const datesFrom = (from: { y: number; mo: number; d: number }, days: number) =>
    Array.from({ length: days }, (_, i) => { const x = addDays(from.y, from.mo, from.d, i); return dateKey(x.y, x.mo, x.d); });
  if (period === '7d' || period === '30d') {
    const days = period === '7d' ? 7 : 30;
    const first = addDays(today.y, today.mo, today.d, -(days - 1));
    return { fromMs: startOfDate(first.y, first.mo, first.d, zone), bucket: 'day', keys: datesFrom(first, days) };
  }
  // All time: day by day while the history is short, so a new account sees
  // its days rather than one or two monthly bars; month by month after that.
  if (firstAtMs != null) {
    const first = localTime(firstAtMs, zone);
    const days = Math.round((Date.UTC(today.y, today.mo - 1, today.d) - Date.UTC(first.y, first.mo - 1, first.d)) / DAY) + 1;
    if (days <= ALL_TIME_DAILY_UP_TO) {
      return { fromMs: null, bucket: 'day', keys: datesFrom(first, days) };
    }
  }
  const keys: string[] = [];
  if (firstAtMs != null) {
    const last = bucketKey(nowMs, zone, 'month');
    let [y, m] = bucketKey(firstAtMs, zone, 'month').split('-').map(Number) as [number, number];
    for (let guard = 0; guard < 1200; guard++) {
      const key = `${y}-${pad(m)}`;
      keys.push(key);
      if (key >= last) break;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  return { fromMs: null, bucket: 'month', keys };
}

// ── The report ─────────────────────────────────

export interface SpendTotals {
  spentUsd: number;
  savedUsd: number;
  runs: number;
  tokens: number;
  /** Runs that ended in an error, and what they cost before it. */
  failedRuns: number;
  failedUsd: number;
}

export interface SpendSlot { key: string; spentUsd: number; savedUsd: number; runs: number }

export interface SpendModelRow {
  model: string;
  spentUsd: number;
  tokens: number;
  runs: number;
  /** Runs where some of this model's calls had no price: its cost is an undercount. */
  unpricedRuns: number;
  /** Runs at $0 with tokens whose report did not say whether they were priced. */
  priceUnknownRuns: number;
}
export interface SpendTierRow { tier: string; spentUsd: number; tokens: number; runs: number; models: SpendModelRow[] }

export interface SpendChatRow {
  /** Null for the chats that have since been deleted, counted together, and for runs with no chat. */
  conversationId: string | null;
  /** Runs that never had a chat: a device run that failed before its first reply. */
  noChat: boolean;
  title: string | null;
  spentUsd: number;
  savedUsd: number;
  runs: number;
}

export interface SpendReport {
  period: SpendPeriod;
  bucket: SpendBucket;
  totals: SpendTotals;
  series: SpendSlot[];
  tiers: SpendTierRow[];
  chats: SpendChatRow[];
}

/** The queries a report needs, so the shaping can be tested without SQLite. */
export interface SpendSource {
  firstSpendAt(userId: string): number | null;
  spendTotals(userId: string, fromMs: number | null): SpendTotals;
  /**
   * Each run's time, spend and saving. The report puts them into the viewer's
   * local days here rather than in SQL, which has no time zone rules.
   */
  spendRuns(userId: string, fromMs: number | null): Array<{ at: number; spentUsd: number; savedUsd: number }>;
  spendByTierModel(userId: string, fromMs: number | null): Array<{
    tier: string; model: string; spentUsd: number; tokens: number; runs: number; tierRuns: number;
    unpricedRuns: number; priceUnknownRuns: number;
  }>;
  spendTopChats(userId: string, fromMs: number | null, limit: number): SpendChatRow[];
}

export const TOP_CHATS = 5;
const TIER_ORDER = ['T1', 'T2', 'T3'];

export function buildSpendReport(
  source: SpendSource, userId: string, period: SpendPeriod, zone: TimeZone, nowMs: number,
): SpendReport {
  const range = periodRange(period, zone, nowMs, period === 'all' ? source.firstSpendAt(userId) : null);
  const found = new Map<string, SpendSlot>();
  for (const run of source.spendRuns(userId, range.fromMs)) {
    const key = bucketKey(run.at, zone, range.bucket);
    const slot = found.get(key) ?? { key, spentUsd: 0, savedUsd: 0, runs: 0 };
    slot.spentUsd += run.spentUsd;
    slot.savedUsd += run.savedUsd;
    slot.runs += 1;
    found.set(key, slot);
  }
  const series = range.keys.map((key) => found.get(key) ?? { key, spentUsd: 0, savedUsd: 0, runs: 0 });

  const tiers = new Map<string, SpendTierRow>();
  for (const r of source.spendByTierModel(userId, range.fromMs)) {
    const t = tiers.get(r.tier) ?? { tier: r.tier, spentUsd: 0, tokens: 0, runs: r.tierRuns, models: [] };
    t.spentUsd += r.spentUsd;
    t.tokens += r.tokens;
    t.models.push({
      model: r.model, spentUsd: r.spentUsd, tokens: r.tokens, runs: r.runs,
      unpricedRuns: r.unpricedRuns, priceUnknownRuns: r.priceUnknownRuns,
    });
    tiers.set(r.tier, t);
  }
  const rank = (tier: string) => { const i = TIER_ORDER.indexOf(tier); return i < 0 ? TIER_ORDER.length : i; };
  const tierRows = [...tiers.values()]
    .map((t) => ({ ...t, models: t.models.sort((a, b) => b.spentUsd - a.spentUsd || b.tokens - a.tokens) }))
    .sort((a, b) => rank(a.tier) - rank(b.tier) || a.tier.localeCompare(b.tier));

  return {
    period,
    bucket: range.bucket,
    totals: source.spendTotals(userId, range.fromMs),
    series,
    tiers: tierRows,
    chats: source.spendTopChats(userId, range.fromMs, TOP_CHATS),
  };
}
