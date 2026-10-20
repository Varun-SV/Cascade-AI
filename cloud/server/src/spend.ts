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
  if (Object.keys(byModel).length > 0 || Object.keys(tokensByModel).length > 0) {
    for (const tier of new Set([...Object.keys(byModel), ...Object.keys(tokensByModel)])) {
      const costs = record(byModel[tier]);
      const tokens = record(tokensByModel[tier]);
      for (const model of new Set([...Object.keys(costs), ...Object.keys(tokens)])) {
        lines.push({ tier, model, costUsd: num(costs[model]), tokens: Math.round(num(tokens[model])) });
      }
    }
  } else {
    const costByTier = record(why['costByTier']);
    const tokensByTier = record(why['tokensByTier']);
    const models = record(why['models']);
    for (const tier of new Set([...Object.keys(costByTier), ...Object.keys(tokensByTier)])) {
      const model = typeof models[tier] === 'string' ? (models[tier] as string) : '';
      lines.push({ tier, model, costUsd: num(costByTier[tier]), tokens: Math.round(num(tokensByTier[tier])) });
    }
  }
  const kept = lines.filter((l) => l.costUsd > 0 || l.tokens > 0);

  const costUsd = input.costUsd != null ? num(input.costUsd) : num(why['totalCostUsd']);
  const tokens = num(why['totalTokens']) || kept.reduce((s, l) => s + l.tokens, 0);
  return {
    id: input.id,
    userId: input.userId,
    conversationId: input.conversationId,
    at: input.at,
    costUsd,
    // Same rule as the chat's saved chip: a run that saved nothing adds nothing.
    savedUsd: num(why['savedUsd']),
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

export interface PeriodRange {
  /** Epoch ms of the first instant counted, or null for all time. */
  fromMs: number | null;
  bucket: SpendBucket;
  /** The chart's slots in order, as the ledger's bucket keys (local time). */
  keys: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The ledger's bucket key for a UTC instant, read in the viewer's local time. */
export function bucketKey(atMs: number, tzOffsetMin: number, bucket: SpendBucket): string {
  const d = new Date(atMs + tzOffsetMin * 60_000);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (bucket === 'month') return day.slice(0, 7);
  if (bucket === 'hour') return `${day} ${pad(d.getUTCHours())}`;
  return day;
}

/**
 * Where a period starts and which chart slots it has, with days ending at the
 * viewer's local midnight. The offset is today's, so across a daylight-saving
 * change a run near midnight can land on the neighbouring day.
 */
export function periodRange(period: SpendPeriod, tzOffsetMin: number, nowMs: number, firstAtMs: number | null): PeriodRange {
  const offset = tzOffsetMin * 60_000;
  const todayStart = Math.floor((nowMs + offset) / DAY) * DAY - offset;
  if (period === 'today') {
    const keys = Array.from({ length: 24 }, (_, h) => bucketKey(todayStart + h * HOUR, tzOffsetMin, 'hour'));
    return { fromMs: todayStart, bucket: 'hour', keys };
  }
  if (period === '7d' || period === '30d') {
    const days = period === '7d' ? 7 : 30;
    const fromMs = todayStart - (days - 1) * DAY;
    const keys = Array.from({ length: days }, (_, i) => bucketKey(fromMs + i * DAY, tzOffsetMin, 'day'));
    return { fromMs, bucket: 'day', keys };
  }
  // All time: day by day while the history is short, so a new account sees
  // its days rather than one or two monthly bars; month by month after that.
  if (firstAtMs != null) {
    const firstDay = Math.floor((firstAtMs + offset) / DAY) * DAY - offset;
    const days = Math.round((todayStart - firstDay) / DAY) + 1;
    if (days <= ALL_TIME_DAILY_UP_TO) {
      const keys = Array.from({ length: days }, (_, i) => bucketKey(firstDay + i * DAY, tzOffsetMin, 'day'));
      return { fromMs: null, bucket: 'day', keys };
    }
  }
  const keys: string[] = [];
  if (firstAtMs != null) {
    const last = bucketKey(nowMs, tzOffsetMin, 'month');
    let [y, m] = bucketKey(firstAtMs, tzOffsetMin, 'month').split('-').map(Number) as [number, number];
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

export interface SpendModelRow { model: string; spentUsd: number; tokens: number; runs: number }
export interface SpendTierRow { tier: string; spentUsd: number; tokens: number; runs: number; models: SpendModelRow[] }

export interface SpendChatRow {
  /** Null for the chats that have since been deleted, counted together. */
  conversationId: string | null;
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
  spendSeries(userId: string, fromMs: number | null, tzOffsetMin: number, bucket: SpendBucket): SpendSlot[];
  spendByTierModel(userId: string, fromMs: number | null): Array<{ tier: string; model: string; spentUsd: number; tokens: number; runs: number; tierRuns: number }>;
  spendTopChats(userId: string, fromMs: number | null, limit: number): SpendChatRow[];
}

export const TOP_CHATS = 5;
const TIER_ORDER = ['T1', 'T2', 'T3'];

export function buildSpendReport(
  source: SpendSource, userId: string, period: SpendPeriod, tzOffsetMin: number, nowMs: number,
): SpendReport {
  const range = periodRange(period, tzOffsetMin, nowMs, period === 'all' ? source.firstSpendAt(userId) : null);
  const found = new Map(source.spendSeries(userId, range.fromMs, tzOffsetMin, range.bucket).map((s) => [s.key, s]));
  const series = range.keys.map((key) => found.get(key) ?? { key, spentUsd: 0, savedUsd: 0, runs: 0 });

  const tiers = new Map<string, SpendTierRow>();
  for (const r of source.spendByTierModel(userId, range.fromMs)) {
    const t = tiers.get(r.tier) ?? { tier: r.tier, spentUsd: 0, tokens: 0, runs: r.tierRuns, models: [] };
    t.spentUsd += r.spentUsd;
    t.tokens += r.tokens;
    t.models.push({ model: r.model, spentUsd: r.spentUsd, tokens: r.tokens, runs: r.runs });
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
