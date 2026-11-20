import { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { TASK_LABELS, compactCount, fetchLeaderboard, pct, runCost, type Leaderboard, type LeaderboardTask } from '../lib/leaderboard.js';

/**
 * How each model has actually done on each kind of task across Cascade's runs:
 * the numbers routing itself learns from, not a published benchmark. Those sit in
 * a column of their own, for comparison.
 *
 * Ranked by the lower end of each model's range, so a model climbs by being run
 * and doing well, not by a few lucky runs. A model routing stopped choosing stays,
 * marked inactive. The data is counts per model and task type: no prompt, answer
 * or person is in it.
 */
export default function LeaderboardSection({ h2 }: { h2: string }) {
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [failed, setFailed] = useState(false);
  const [task, setTask] = useState<LeaderboardTask>('code');

  useEffect(() => {
    const ctl = new AbortController();
    fetchLeaderboard(ctl.signal).then(setBoard, () => { if (!ctl.signal.aborted) setFailed(true); });
    return () => ctl.abort();
  }, []);

  const rows = board?.tasks[task] ?? [];
  const updated = board ? new Date(board.generatedAt) : null;

  return (
    <section id="leaderboard" className="scroll-mt-20 pt-[88px]" aria-labelledby="leaderboard-h">
      <h2 id="leaderboard-h" className={h2}>Which model is best, measured live.</h2>
      <p className="-mt-3 mb-6 max-w-[62ch] text-[14.5px] text-ink-300">
        Scores from every run Cascade has routed{board && board.totalRuns > 0 ? `: ${compactCount(board.totalRuns)} runs across ${board.models} models so far` : ''}.
        Not a benchmark: what happened when real work was sent to each model.
      </p>

      <div role="tablist" aria-label="Kind of task" className="mb-3 flex flex-wrap gap-1.5">
        {TASK_LABELS.map(([id, label]) => (
          <button
            key={id} type="button" role="tab" aria-selected={task === id} aria-controls="leaderboard-table"
            onClick={() => setTask(id)}
            className={`h-8 rounded-full px-3.5 text-[13px] ${task === id ? 'bg-ink-50 text-ink-950' : 'bg-card text-ink-300 hover:text-ink-50'}`}
          >
            {label}{board ? <span className="ml-1.5 opacity-60">{board.tasks[id].length}</span> : null}
          </button>
        ))}
      </div>

      <div id="leaderboard-table" role="tabpanel" className="overflow-x-auto rounded-2xl bg-card">
        {failed ? (
          <p className="m-0 p-5 text-[14px] text-ink-500">The leaderboard couldn't be loaded just now.</p>
        ) : !board ? (
          <p className="m-0 p-5 text-[14px] text-ink-500" aria-live="polite">Loading the latest scores…</p>
        ) : rows.length === 0 ? (
          <p className="m-0 p-5 text-[14px] text-ink-500">No model has enough runs of this kind yet to be ranked fairly. Check back soon.</p>
        ) : (
          <table className="w-full min-w-[640px] border-collapse text-left text-[13.5px]">
            <caption className="sr-only">Models ranked by how they did on {TASK_LABELS.find(([id]) => id === task)?.[1].toLowerCase()} tasks across Cascade's runs</caption>
            <thead>
              <tr className="whitespace-nowrap text-[12px] uppercase tracking-[0.08em] text-ink-500">
                <th scope="col" className="px-4 py-3 font-medium">#</th>
                <th scope="col" className="px-2 py-3 font-medium">Model</th>
                <th scope="col" className="px-2 py-3 font-medium">Cascade score</th>
                <th scope="col" className="px-2 py-3 text-right font-medium">Runs</th>
                <th scope="col" className="px-2 py-3 text-right font-medium">Succeeded</th>
                <th scope="col" className="px-2 py-3 text-right font-medium">Cost / run</th>
                <th scope="col" className="px-2 py-3 text-right font-medium">7 days</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Benchmarks</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} className={`border-t border-elev/10 ${r.inactive ? 'text-ink-500' : 'text-ink-100'}`}>
                  <td className="px-4 py-2.5 font-mono text-ink-500">{r.rank}</td>
                  <td className="max-w-[260px] truncate px-2 py-2.5 font-mono text-[13px]" title={r.model}>
                    {r.model}
                    {r.inactive && <span className="ml-2 rounded bg-elev/10 px-1.5 py-0.5 font-sans text-[11px] text-ink-500" title={r.lastRun ? `Last run ${r.lastRun}` : undefined}>inactive</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5">
                    <span className="font-semibold">{pct(r.low)}</span>
                    <span className="ml-1.5 text-[12px] text-ink-500" title={`Between ${pct(r.low)} and ${pct(r.high)}, 90% likely`}>to {pct(r.high)}</span>
                    <span className={`block text-[11px] ${r.confidence === 'high' ? 'text-t3' : 'text-ink-500'}`}>{r.confidence} confidence</span>
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono">{compactCount(r.runs)}</td>
                  <td className="px-2 py-2.5 text-right font-mono">{pct(r.successRate)}</td>
                  <td className="px-2 py-2.5 text-right font-mono">{runCost(r.avgCostUsd)}</td>
                  <td className="px-2 py-2.5 text-right font-mono">
                    {r.trend7d === undefined || Math.abs(r.trend7d) < 0.5 ? <span className="text-ink-500">—</span>
                      : r.trend7d > 0 ? <span className="inline-flex items-center text-t3"><ArrowUpRight size={13} aria-hidden="true" />{r.trend7d.toFixed(1)}<span className="sr-only"> points up</span></span>
                        : <span className="inline-flex items-center text-ink-300"><ArrowDownRight size={13} aria-hidden="true" />{Math.abs(r.trend7d).toFixed(1)}<span className="sr-only"> points down</span></span>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-ink-300">{r.benchmark ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <details className="mt-3 text-[13px] text-ink-500">
        <summary className="cursor-pointer text-ink-300 hover:text-ink-50">How we score</summary>
        <div className="mt-2 flex max-w-[70ch] flex-col gap-2">
          <p className="m-0">Each time Cascade routes work to a model, it records whether the model got it done, how many retries it took, and what it cost. A thumbs-up or thumbs-down on an answer counts for more than an automatic outcome. That is everything the leaderboard is made of: counts per model and kind of task. No prompt, answer or account is stored in it.</p>
          <p className="m-0"><b className="text-ink-300">Cascade score</b> is the range the model's success rate is 90% likely to be in, given its runs so far. Models are ranked by the low end of that range, so a model with a few lucky runs doesn't outrank one proven over hundreds. The range narrows as runs add up; confidence is high from 200 runs, medium from 30. A model needs 5 runs to be ranked.</p>
          <p className="m-0"><b className="text-ink-300">Benchmarks</b> is the published score for the same kind of task (Terminal-Bench, SWE-bench and the Vals Index for coding and analysis, LMArena for writing), where a board has measured the model, for comparison.</p>
          <p className="m-0">Nothing is dropped: a model Cascade stopped choosing stays on the board, marked <i>inactive</i> after 30 days without a run. <b className="text-ink-300">7 days</b> is the change in its score since a week ago.</p>
          {updated && <p className="m-0">Updated {updated.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.</p>}
        </div>
      </details>
    </section>
  );
}
