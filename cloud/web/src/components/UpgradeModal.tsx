import { useCallback, useEffect, useState } from 'react';
import { Check, Crown, Loader2, Monitor } from 'lucide-react';
import { fetchUsage, fetchBilling, startSubscription, cancelSubscription, type UsageInfo, type BillingInfo } from '../lib/api.js';
import { openSubscriptionCheckout } from '../lib/razorpay.js';

const FREE_FEATURES = ['1 run at a time', '20 runs / day', 'Chat + web search/fetch tools'];
const PRO_FEATURES = ['3 runs at a time', '200 runs / day', 'Priority routing', 'Everything in Free'];

// Statuses that mean the paid plan is currently active.
const ACTIVE = new Set(['active', 'authenticated', 'charged', 'cancel_scheduled']);

function formatDate(unixSeconds: number | null): string | null {
  if (!unixSeconds) return null;
  try { return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return null; }
}

export default function UpgradeModal() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchUsage().then(setUsage).catch(() => setUsage(null));
    fetchBilling().then(setBilling).catch(() => setBilling(null));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const isPro = billing ? (billing.plan === 'pro' || (billing.hasSubscription && !!billing.status && ACTIVE.has(billing.status))) : false;
  const cancelScheduled = billing?.status === 'cancel_scheduled';
  const renews = formatDate(billing?.currentEnd ?? null);

  async function subscribe() {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const { subscriptionId, keyId } = await startSubscription();
      await openSubscriptionCheckout({
        keyId,
        subscriptionId,
        onSuccess: () => { setNotice('Payment received — your Pro plan will activate shortly.'); setBusy(false); refresh(); },
        onDismiss: () => setBusy(false),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start checkout.');
      setBusy(false);
    }
  }

  async function cancel() {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await cancelSubscription();
      setNotice('Your subscription will end at the current billing period.');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 text-sm text-ink-100">
      {usage && (
        <p className="mb-3 text-xs text-ink-400">
          You're on the <span className="font-medium text-ink-200">{usage.plan}</span> plan —{' '}
          {usage.dailyRuns} / {usage.dailyRunLimit} runs used today.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-white/10 p-3">
          <h3 className="mb-2 text-sm font-semibold text-ink-100">Free</h3>
          <ul className="flex flex-col gap-1.5 text-xs text-ink-300">
            {FREE_FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-1.5"><Check size={12} className="mt-0.5 shrink-0 text-ink-400" /> {f}</li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-accent-600 bg-white/[0.05] p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink-100">
              <Crown size={14} className="text-accent-400" /> Pro
            </h3>
            {billing?.priceLabel && <span className="text-[11px] font-medium text-accent-300">{billing.priceLabel}</span>}
          </div>
          <ul className="flex flex-col gap-1.5 text-xs text-ink-300">
            {PRO_FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-1.5"><Check size={12} className="mt-0.5 shrink-0 text-accent-400" /> {f}</li>
            ))}
          </ul>

          {isPro ? (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-[11px] text-ink-300">
                {cancelScheduled
                  ? `Cancels${renews ? ` on ${renews}` : ' at period end'} — active until then.`
                  : renews ? `Active · renews ${renews}.` : 'Active.'}
              </p>
              {!cancelScheduled && (
                <button
                  type="button"
                  onClick={cancel}
                  disabled={busy}
                  className="w-full rounded-md border border-white/10 px-3 py-1.5 text-xs text-ink-300 hover:bg-white/[0.05] hover:text-danger-400 disabled:opacity-40"
                >
                  Cancel subscription
                </button>
              )}
            </div>
          ) : billing?.configured ? (
            <button
              type="button"
              onClick={subscribe}
              disabled={busy}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-accent-400 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Crown size={13} />} Subscribe
            </button>
          ) : (
            <button type="button" disabled className="mt-3 w-full cursor-not-allowed rounded-md bg-ink-700 px-3 py-1.5 text-xs font-medium text-ink-400">
              Coming soon
            </button>
          )}
        </div>
      </div>

      {notice && <p className="mt-3 rounded-md border border-success-500/25 bg-success-500/10 px-3 py-2 text-xs text-success-300">{notice}</p>}
      {error && <p className="mt-3 rounded-md border border-danger-800 bg-danger-950/40 px-3 py-2 text-xs text-danger-300">{error}</p>}

      <div className="mt-4 flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-ink-300">
        <Monitor size={14} className="shrink-0 text-ink-400" />
        <span>The <span className="font-medium text-ink-200">desktop app is free</span> — always. Cascade Cloud is the hosted convenience: no install, your chats synced, run from anywhere.</span>
      </div>
    </div>
  );
}
