import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import Modal from './Modal.js';
import Segmented from './Segmented.js';
import SpendChart, { fmtUsd, slotTitle } from './SpendChart.js';
import { fetchEveryone, fetchSpendReport, type EveryoneView, type SpendPeriod, type SpendReport as Report, type SpendSurfaceFilter } from '../lib/api.js';

const SURFACES: Array<{ value: SpendSurfaceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'cloud', label: 'Cloud' },
  { value: 'desktop', label: 'Desktop' },
  { value: 'cli', label: 'CLI' },
];
type Whose = 'you' | 'everyone';
const WHOSE: Array<{ value: Whose; label: string }> = [{ value: 'you', label: 'You' }, { value: 'everyone', label: 'Everyone' }];
type WeekSpan = '1' | '4' | '12';
const SPANS: Array<{ value: WeekSpan; label: string }> = [
  { value: '1', label: 'Last week' }, { value: '4', label: '4 weeks' }, { value: '12', label: '12 weeks' },
];

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${(s / 60).toFixed(1)} min`;
}

const PERIODS: Array<{ value: SpendPeriod; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
];

const TIER_NAME: Record<string, string> = { T1: 'T1 · Planner', T2: 'T2 · Manager', T3: 'T3 · Worker' };
const TIER_DOT: Record<string, string> = { T1: 'bg-t1', T2: 'bg-t2', T3: 'bg-t3' };
const BUCKET_NAME: Record<Report['bucket'], { one: string; many: string }> = {
  hour: { one: 'Hour', many: 'Hours' }, day: { one: 'Day', many: 'Days' }, month: { one: 'Month', many: 'Months' },
};

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const card = 'rounded-[14px] bg-card px-4 py-3.5';
const ring = { boxShadow: 'inset 0 0 0 1px rgb(var(--c-elev) / 0.1)' };

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={`${card} flex min-w-0 flex-col gap-0.5`} style={ring}>
      <span className="text-[12px] text-ink-400">{label}</span>
      <span className="truncate text-[22px] font-semibold leading-tight text-ink-50">{value}</span>
      {note && <span className="text-[12px] leading-snug text-ink-500">{note}</span>}
    </div>
  );
}

function TierRows({ tiers, total }: { tiers: Report['tiers']; total: number }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (t: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });
  const cols = 'grid grid-cols-[minmax(0,1fr)_3.5rem_4.5rem] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_4.5rem]';
  type Priced = { spentUsd: number; tokens: number; unpricedRuns: number; priceUnknownRuns: number };
  // Whether a model had a price is recorded per run, not read off a $0: a
  // local model is free and shows $0.00. "+" marks a cost missing some calls;
  // "*" one that includes older $0 runs which did not record whether they
  // were priced, so it may be missing some.
  const cost = (p: Priced) => {
    if (p.unpricedRuns > 0) return p.spentUsd > 0 ? `${fmtUsd(p.spentUsd)}+` : 'no price';
    if (p.priceUnknownRuns > 0) return p.spentUsd > 0 ? `${fmtUsd(p.spentUsd)}*` : 'not recorded';
    return fmtUsd(p.spentUsd);
  };
  const tierPriced = (t: Report['tiers'][number]): Priced => ({
    spentUsd: t.spentUsd, tokens: t.tokens,
    unpricedRuns: t.models.reduce((n, m) => n + m.unpricedRuns, 0),
    priceUnknownRuns: t.models.reduce((n, m) => n + m.priceUnknownRuns, 0),
  });
  return (
    <div className="flex flex-col text-[13px]">
      <div className={`${cols} px-2 pb-1.5 text-[11.5px] text-ink-500`}>
        <span>Tier and model</span>
        <span className="text-right">Runs</span>
        <span className="hidden text-right sm:block">Tokens</span>
        <span className="text-right">Spent</span>
      </div>
      {tiers.map((t) => {
        const expanded = open.has(t.tier);
        // A share of nothing says nothing: shown only once something was priced.
        const share = total > 0 ? Math.round((t.spentUsd / total) * 100) : null;
        return (
          <div key={t.tier} className="flex flex-col border-t border-elev/10">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => toggle(t.tier)}
              className={`${cols} rounded-lg px-2 py-2 text-left hover:bg-elev/[0.05]`}
            >
              <span className="flex min-w-0 items-center gap-2 text-ink-50">
                <ChevronRight size={14} className={`shrink-0 text-ink-500 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${TIER_DOT[t.tier] ?? 'bg-ink-500'}`} />
                <span className="truncate">{TIER_NAME[t.tier] ?? t.tier}</span>
                {share !== null && <span className="shrink-0 text-[12px] text-ink-500">{share}%</span>}
              </span>
              <span className="text-right tabular-nums text-ink-300">{t.runs.toLocaleString('en-US')}</span>
              <span className="hidden text-right tabular-nums text-ink-300 sm:block">{fmtTokens(t.tokens)}</span>
              <span className="text-right font-medium tabular-nums text-ink-50">{cost(tierPriced(t))}</span>
            </button>
            {expanded && (
              <ul className="m-0 mb-1.5 flex list-none flex-col p-0">
                {t.models.map((m) => (
                  <li key={m.model} className={`${cols} px-2 py-1 text-[12.5px]`}>
                    <span className="truncate pl-[37px] font-mono text-[12px] text-ink-300" title={m.model || undefined}>
                      {m.model || 'Model not recorded'}
                    </span>
                    <span className="text-right tabular-nums text-ink-400">{m.runs.toLocaleString('en-US')}</span>
                    <span className="hidden text-right tabular-nums text-ink-400 sm:block">{fmtTokens(m.tokens)}</span>
                    <span className="text-right tabular-nums text-ink-300">{cost(m)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SeriesTable({ report }: { report: Report }) {
  const rows = report.series.filter((s) => s.runs > 0);
  return (
    <table className="w-full border-collapse text-[13px]">
      <caption className="pb-1.5 text-left text-[12px] text-ink-500">
        {BUCKET_NAME[report.bucket].many} with no runs are left out.
      </caption>
      <thead>
        <tr className="text-[11.5px] text-ink-500">
          <th scope="col" className="py-1 text-left font-normal">{BUCKET_NAME[report.bucket].one}</th>
          <th scope="col" className="py-1 text-right font-normal">Runs</th>
          <th scope="col" className="py-1 text-right font-normal">Spent</th>
          <th scope="col" className="py-1 text-right font-normal">Saved</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.key} className="border-t border-elev/10">
            <th scope="row" className="py-1.5 text-left font-normal text-ink-300">{slotTitle(s.key, report.bucket)}</th>
            <td className="py-1.5 text-right tabular-nums text-ink-300">{s.runs}</td>
            <td className="py-1.5 text-right tabular-nums text-ink-50">{fmtUsd(s.spentUsd)}</td>
            <td className="py-1.5 text-right tabular-nums text-ink-300">{fmtUsd(s.savedUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Body({ report, onOpenChat }: { report: Report; onOpenChat: (id: string) => void }) {
  const [table, setTable] = useState(false);
  const { totals } = report;
  // One slot is not a chart; its numbers are the whole story.
  const chartable = report.series.length > 1;
  const unpriced = report.tiers.some((t) => t.models.some((m) => m.unpricedRuns > 0));
  const priceUnknown = report.tiers.some((t) => t.models.some((m) => m.priceUnknownRuns > 0));

  if (totals.runs === 0) {
    return <p className="m-0 py-10 text-center text-[14px] text-ink-400">No runs in this period.</p>;
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-3 gap-2.5">
        <Tile label="Spent" value={fmtUsd(totals.spentUsd)} note="at published prices" />
        <Tile
          label="Saved"
          value={fmtUsd(totals.savedUsd)}
          // A sum of each run's saving: a run that cost more than T1 would
          // have counts as saving nothing, not as a loss, so no percentage of
          // an all-T1 total is claimed for the period.
          note={totals.savedUsd > 0 ? 'on runs that cost less than T1' : undefined}
        />
        <Tile label="Runs" value={totals.runs.toLocaleString('en-US')} note={`${fmtTokens(totals.tokens)} tokens`} />
      </div>

      <section className={`${card} flex flex-col gap-3`} style={ring} aria-labelledby="spend-series-h">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h3 id="spend-series-h" className="m-0 text-[13.5px] font-medium text-ink-50">Spent and saved by {report.bucket}</h3>
          <span className="flex items-center gap-3 text-[12px] text-ink-400">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'var(--chart-spent)' }} />Spent</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'var(--chart-saved)' }} />Saved on runs cheaper than T1</span>
          </span>
          <span className="flex-1" />
          {chartable && (
            <button type="button" aria-pressed={table} onClick={() => setTable((v) => !v)} className="cz-btn cz-btn-ghost cz-btn-sm">
              {table ? 'Chart' : 'Table'}
            </button>
          )}
        </div>
        {chartable && !table ? <SpendChart series={report.series} bucket={report.bucket} /> : <SeriesTable report={report} />}
      </section>

      {report.tiers.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="spend-tiers-h">
          <h3 id="spend-tiers-h" className="m-0 text-[13.5px] font-medium text-ink-50">By tier and model</h3>
          <TierRows tiers={report.tiers} total={totals.spentUsd} />
        </section>
      )}

      <HowRunsWent totals={totals} />

      {report.chats.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="spend-chats-h">
          <h3 id="spend-chats-h" className="m-0 text-[13.5px] font-medium text-ink-50">Costliest chats</h3>
          <ul className="m-0 flex list-none flex-col p-0 text-[13px]">
            {report.chats.map((c) => {
              const detail = `${plural(c.runs, 'run')}${c.savedUsd > 0 ? ` · saved ${fmtUsd(c.savedUsd)}` : ''}`;
              const body = (
                <>
                  <span className={`min-w-0 flex-1 truncate ${c.conversationId ? 'text-ink-50' : 'italic text-ink-400'}`}>
                    {c.conversationId ? (c.title || 'Untitled chat') : c.noChat ? 'Runs with no chat' : 'Deleted chats'}
                  </span>
                  <span className="hidden shrink-0 text-[12px] text-ink-500 sm:inline">{detail}</span>
                  <span className="w-[4.5rem] shrink-0 text-right font-medium tabular-nums text-ink-50">{fmtUsd(c.spentUsd)}</span>
                </>
              );
              return (
                <li key={c.conversationId ?? (c.noChat ? 'no-chat' : 'deleted')} className="border-t border-elev/10">
                  {c.conversationId ? (
                    <button
                      type="button"
                      onClick={() => onOpenChat(c.conversationId!)}
                      title={`Open this chat · ${detail}`}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-elev/[0.05]"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-2 py-2" title={detail}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="flex flex-col gap-1 text-[12px] leading-relaxed text-ink-500">
        {totals.failedRuns > 0 && (
          <p className="m-0">
            Includes {plural(totals.failedRuns, 'run')} that failed after spending {fmtUsd(totals.failedUsd)}.
          </p>
        )}
        <p className="m-0">
          Costs use each provider&apos;s published prices.
          {unpriced ? ' A model with no published price shows its tokens, and "no price" or a "+" where its cost is missing.' : ''}
          {priceUnknown ? ' Older runs did not record whether a $0 model was priced: those show "not recorded", or a "*" where they are mixed with priced runs.' : ''}{' '}
          Deleted chats stay counted, and days end at your local midnight.
        </p>
      </div>
    </div>
  );
}

/** How the runs ended, how long they took, and how their agents and tiers fared: counts only. */
function HowRunsWent({ totals }: { totals: Report['totals'] }) {
  const stopped = totals.stoppedRuns ?? 0;
  const answered = Math.max(0, totals.runs - totals.failedRuns - stopped);
  const timed = totals.timedRuns ?? 0;
  const agents = totals.agents;
  const agentCount = agents ? agents.completed + agents.failed + agents.escalated + agents.other : 0;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="spend-runs-h">
      <h3 id="spend-runs-h" className="m-0 text-[13.5px] font-medium text-ink-50">How runs went</h3>
      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-4">
        <div><dt className="text-[12px] text-ink-500">Answered</dt><dd className="m-0 tabular-nums text-ink-50">{answered.toLocaleString('en-US')}</dd></div>
        <div><dt className="text-[12px] text-ink-500">Stopped</dt><dd className="m-0 tabular-nums text-ink-50">{stopped.toLocaleString('en-US')}</dd></div>
        <div><dt className="text-[12px] text-ink-500">Failed</dt><dd className="m-0 tabular-nums text-ink-50">{totals.failedRuns.toLocaleString('en-US')}</dd></div>
        <div><dt className="text-[12px] text-ink-500">Average time</dt><dd className="m-0 tabular-nums text-ink-50">{timed > 0 ? fmtDuration((totals.durationMs ?? 0) / timed) : '—'}</dd></div>
        <div><dt className="text-[12px] text-ink-500">Failovers</dt><dd className="m-0 tabular-nums text-ink-50">{(totals.failovers ?? 0).toLocaleString('en-US')}</dd></div>
        {agents && agentCount > 0 && (
          <div className="col-span-2 sm:col-span-3">
            <dt className="text-[12px] text-ink-500">Agents</dt>
            <dd className="m-0 text-ink-50">
              {agents.completed.toLocaleString('en-US')} completed, {agents.failed.toLocaleString('en-US')} failed, {agents.escalated.toLocaleString('en-US')} escalated
              {agents.other > 0 ? `, ${agents.other.toLocaleString('en-US')} unfinished` : ''}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** Everyone: whole published weeks, cells over the minimums, sums of those only. */
function Everyone({ view }: { view: EveryoneView }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-ink-300">{view.label === 'no weeks released yet' ? 'No weeks released yet.' : `Across all users, ${view.label}.`}</p>
      {view.rows.length === 0 ? (
        <p className="m-0 py-6 text-center text-[14px] text-ink-400">Nothing to show for these weeks.</p>
      ) : (
        <table className="w-full text-[13px]">
          <caption className="sr-only">Runs, tokens and spend by tier and model, across all users</caption>
          <thead>
            <tr className="text-left text-[11.5px] text-ink-500">
              <th scope="col" className="pb-1.5 font-normal">Tier and model</th>
              <th scope="col" className="pb-1.5 text-right font-normal">Runs</th>
              <th scope="col" className="hidden pb-1.5 text-right font-normal sm:table-cell">Tokens</th>
              <th scope="col" className="pb-1.5 text-right font-normal">Spent</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={`${r.tier}|${r.model}`} className="border-t border-elev/10">
                <td className="py-1.5"><span className="text-ink-400">{r.tier}</span> <span className="text-ink-50">{r.model || 'model not recorded'}</span></td>
                <td className="py-1.5 text-right tabular-nums">{r.runs.toLocaleString('en-US')}</td>
                <td className="hidden py-1.5 text-right tabular-nums sm:table-cell">{fmtTokens(r.tokens)}</td>
                <td className="py-1.5 text-right tabular-nums text-ink-50">{fmtUsd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="m-0 text-[12px] leading-relaxed text-ink-500">
        Published a whole week at a time, once the week is over, and never changed after. A model on a tier is shown only
        where at least {view.minimums.runs} runs from at least {view.minimums.users} people used it that week, and every
        total here adds up only what is shown. Success rates aren&apos;t shown yet.
      </p>
    </div>
  );
}

/**
 * What your runs cost and what delegating below T1 saved, over a period: the
 * totals, the days (or hours, or months), each tier's spend split by the models
 * that served it, and the chats that cost the most.
 */
export default function SpendReport({ onClose, onOpenChat, everyone = false }: {
  onClose: () => void;
  onOpenChat: (id: string) => void;
  /** Whether the server publishes Everyone: the switch for it shows only then. */
  everyone?: boolean;
}) {
  const [period, setPeriod] = useState<SpendPeriod>('30d');
  const [surface, setSurface] = useState<SpendSurfaceFilter>('all');
  const [whose, setWhose] = useState<Whose>('you');
  const [span, setSpan] = useState<WeekSpan>('4');
  const [everyoneView, setEveryoneView] = useState<EveryoneView | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const load = whose === 'everyone'
      ? fetchEveryone(surface, Number(span)).then((v) => { if (live) setEveryoneView(v); })
      : fetchSpendReport(period, surface).then((r) => { if (live) setReport(r); });
    load
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [period, surface, whose, span, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // A failed load hides the last report: it was for another period.
  const current = error || whose !== 'you' ? null : report;
  const currentEveryone = error || whose !== 'everyone' ? null : everyoneView;

  return (
    <Modal title="Spend & savings" onClose={onClose} maxWidth="max-w-3xl" sheetOnPhone>
      <div className="flex flex-col gap-4 px-5 pb-6 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          {everyone && <Segmented label="Whose runs" value={whose} onChange={setWhose} options={WHOSE} />}
          <Segmented label="Where they ran" value={surface} onChange={setSurface} options={SURFACES} />
        </div>
        {whose === 'you'
          ? <Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS} />
          : <Segmented label="Weeks" value={span} onChange={setSpan} options={SPANS} />}
        {error && (
          <p role="alert" className="m-0 flex items-center gap-3 text-[13px] text-ink-300">
            Couldn&apos;t load your spending: {error}
            <button type="button" onClick={retry} className="cz-btn cz-btn-ghost cz-btn-sm">Try again</button>
          </p>
        )}
        {!current && !currentEveryone && loading && <p className="m-0 py-10 text-center text-[14px] text-ink-400">Loading…</p>}
        {currentEveryone && (
          <div aria-busy={loading} className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <Everyone view={currentEveryone} />
          </div>
        )}
        {current && (
          // While another period loads, the last one stays in place, dimmed.
          <div aria-busy={loading} className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <Body report={current} onOpenChat={onOpenChat} />
          </div>
        )}
      </div>
    </Modal>
  );
}
