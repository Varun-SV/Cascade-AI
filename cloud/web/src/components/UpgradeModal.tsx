import { useEffect, useState } from 'react';
import { Check, Crown } from 'lucide-react';
import { fetchUsage, type UsageInfo } from '../lib/api.js';

const FREE_FEATURES = ['1 run at a time', '20 runs / day', 'Chat + web search/fetch tools'];
const PRO_FEATURES = ['3 runs at a time', '200 runs / day', 'Everything in Free'];

export default function UpgradeModal() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  useEffect(() => {
    fetchUsage().then(setUsage).catch(() => setUsage(null));
  }, []);

  return (
    <div className="p-4 text-sm text-ink-100">
      {usage && (
        <p className="mb-4 text-xs text-ink-400">
          You're on the <span className="font-medium text-ink-200">{usage.plan}</span> plan —{' '}
          {usage.dailyRuns} / {usage.dailyRunLimit} runs used today.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-ink-700 p-3">
          <h3 className="mb-2 text-sm font-semibold text-ink-100">Free</h3>
          <ul className="flex flex-col gap-1.5 text-xs text-ink-300">
            {FREE_FEATURES.map((f) => (
              <li key={f} className="flex items-center gap-1.5">
                <Check size={12} className="shrink-0 text-ink-400" /> {f}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-accent-600 bg-ink-800 p-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink-100">
            <Crown size={14} className="text-accent-400" /> Pro
          </h3>
          <ul className="flex flex-col gap-1.5 text-xs text-ink-300">
            {PRO_FEATURES.map((f) => (
              <li key={f} className="flex items-center gap-1.5">
                <Check size={12} className="shrink-0 text-accent-400" /> {f}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled
            className="mt-3 w-full cursor-not-allowed rounded-md bg-ink-700 px-3 py-1.5 text-xs font-medium text-ink-400"
          >
            Coming soon
          </button>
        </div>
      </div>
    </div>
  );
}
