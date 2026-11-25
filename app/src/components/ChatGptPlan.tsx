import { useCallback, useEffect, useState } from 'react';
import {
  LIMIT_BODY, LIMIT_TITLE, MANAGE_USAGE_LABEL, USING_PLAN_LABEL, WELCOME_BODY, WELCOME_TITLE, usingPlan,
  type PlanViewState,
} from '../lib/chatgpt-plan.js';

/** The plan's state, kept up to date by the main process. Null where there is no desktop bridge. */
export function useChatGptPlan(): { view: PlanViewState | null; refresh: () => void } {
  const [view, setView] = useState<PlanViewState | null>(null);
  const refresh = useCallback(() => {
    void window.cascade?.chatgpt?.status().then(setView).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    window.cascade?.chatgpt?.onChanged((v) => setView(v));
  }, [refresh]);
  return { view, refresh };
}

const btn = (primary: boolean): React.CSSProperties => ({
  padding: '7px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
  background: primary ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
  color: primary ? '#fff' : 'var(--text)', border: primary ? 'none' : '1px solid var(--border)',
});

const manageUsage = (): void => { void window.cascade?.chatgpt?.manageUsage(); };

/** "Using ChatGPT plan · Manage usage", next to the model selector. */
export function ChatGptPlanBadge({ model }: { model: string }) {
  const { view } = useChatGptPlan();
  const [others, setOthers] = useState(1);
  useEffect(() => {
    void window.cascade?.getSettings().then((s) => setOthers((s.providersWithKey ?? []).filter((p) => p !== 'chatgpt').length)).catch(() => undefined);
  }, [view?.planReady]);
  if (!view || !usingPlan(model, view.planReady, others)) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
      <span>{USING_PLAN_LABEL}</span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={manageUsage} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', fontSize: 11.5, textDecoration: 'underline' }}>
        {MANAGE_USAGE_LABEL}
      </button>
    </span>
  );
}

/**
 * The first-sign-in welcome (once; "Got it" ends it for good) and the usage-limit
 * message, Manage usage first.
 */
export function ChatGptNotices() {
  const { view } = useChatGptPlan();
  const [limit, setLimit] = useState(false);
  useEffect(() => {
    const on = (): void => setLimit(true);
    window.addEventListener('cascade:chatgpt-usage-limit', on);
    return () => window.removeEventListener('cascade:chatgpt-usage-limit', on);
  }, []);

  const shell = (title: string, body: string, actions: React.ReactNode) => (
    <div role="dialog" aria-modal="true" aria-labelledby="chatgpt-notice-title" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'grid', placeItems: 'center', zIndex: 1000 }}>
      <div style={{ width: 'min(420px, calc(100vw - 32px))', background: 'var(--bg-panel, var(--bg))', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 10, padding: 18, fontSize: 13, lineHeight: 1.5 }}>
        <h2 id="chatgpt-notice-title" style={{ margin: '0 0 6px', fontSize: 16 }}>{title}</h2>
        <p style={{ margin: '0 0 14px', color: 'var(--text-muted)' }}>{body}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{actions}</div>
      </div>
    </div>
  );

  if (limit) {
    return shell(LIMIT_TITLE, LIMIT_BODY, (
      <>
        <button type="button" style={btn(false)} onClick={() => setLimit(false)}>Close</button>
        <button type="button" style={btn(true)} autoFocus onClick={() => { manageUsage(); setLimit(false); }}>{MANAGE_USAGE_LABEL}</button>
      </>
    ));
  }
  if (view?.welcomePending && view.planReady) {
    return shell(WELCOME_TITLE, WELCOME_BODY, (
      <>
        <button type="button" style={btn(false)} onClick={manageUsage}>{MANAGE_USAGE_LABEL}</button>
        <button type="button" style={btn(true)} autoFocus onClick={() => { void window.cascade?.chatgpt?.dismissWelcome(); }}>Got it</button>
      </>
    ));
  }
  return null;
}

/** Settings → Providers: Continue with ChatGPT, the active account, switching, sign-out, Manage usage. */
export function ChatGptPlanSection() {
  const { view, refresh } = useChatGptPlan();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const bridge = window.cascade?.chatgpt;
  if (!bridge || !view) return null;

  const signIn = async (accountId?: string, enablePlan = false): Promise<void> => {
    setBusy(true); setNote(null);
    const r = await bridge.signIn({ ...(accountId ? { accountId } : {}), ...(enablePlan ? { enablePlan: true } : {}) });
    setBusy(false);
    if (!r.ok) setNote(r.error);
    else if (!r.planUsageEnabled) setNote('Signed in, but ChatGPT plan use was not enabled, so Cascade will not use it. You can enable it below, or use another provider or an API key.');
    refresh();
  };
  const signOut = async (accountId?: string): Promise<void> => {
    setBusy(true); setNote(null);
    const r = await bridge.signOut(accountId ? { accountId } : {});
    setBusy(false);
    setNote(r.ok ? r.message : r.error);
    refresh();
  };
  const switchTo = async (accountId: string): Promise<void> => {
    const r = await bridge.switch({ accountId });
    if (r.ok && r.needsSignIn) await signIn(accountId); else if (!r.ok) setNote(r.error);
  };

  const active = view.active;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        ChatGPT plan{view.planReady && <span style={{ color: 'var(--success)', marginLeft: 6 }}>• in use</span>}
      </label>
      <p style={{ fontSize: 11.5, margin: 0, color: 'var(--text-muted)' }}>
        Complete eligible AI requests with usage included in your ChatGPT plan or credits balance. This is separate from your Cascade Cloud account and from API keys.
      </p>
      {active ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5 }}>{active.label}</span>
          <span style={{ fontSize: 11, color: active.planUsageEnabled && active.signedIn ? 'var(--success)' : 'var(--text-muted)' }}>
            {!active.signedIn ? 'signed out' : active.planUsageEnabled ? 'plan usage on' : 'plan usage not enabled'}
          </span>
          <span style={{ flex: 1 }} />
          {active.signedIn && !active.planUsageEnabled && (
            <button type="button" style={btn(false)} disabled={busy} onClick={() => void signIn(active.id, true)}>Enable plan usage</button>
          )}
          {!active.signedIn && <button type="button" style={btn(true)} disabled={busy} onClick={() => void signIn(active.id)}>Continue with ChatGPT</button>}
          {active.signedIn && <button type="button" style={btn(false)} disabled={busy} onClick={() => void signOut(active.id)}>Sign out</button>}
        </div>
      ) : (
        <div>
          <button type="button" style={btn(true)} disabled={busy} onClick={() => void signIn()}>Continue with ChatGPT</button>
        </div>
      )}
      {busy && view.signingIn && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.5, color: 'var(--text-muted)' }}>
          <span>Finish in your browser…</span>
          <button type="button" style={btn(false)} onClick={() => void bridge.cancel()}>Cancel</button>
        </div>
      )}
      {view.accounts.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <label htmlFor="chatgpt-account">Account</label>
          <select id="chatgpt-account" value={active?.id ?? ''} onChange={(e) => void switchTo(e.target.value)}
            style={{ padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-raised)', color: 'inherit', fontSize: 12 }}>
            {!active && <option value="">Choose an account</option>}
            {view.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}{a.signedIn ? '' : ' (signed out)'}</option>)}
          </select>
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 11.5 }}>
        {active && (
          <button type="button" onClick={() => void signIn()} disabled={busy} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)' }}>
            Add another account
          </button>
        )}
        <button type="button" onClick={manageUsage} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', textDecoration: 'underline' }}>
          {MANAGE_USAGE_LABEL}
        </button>
      </div>
      {note && <p role="status" style={{ fontSize: 11.5, margin: 0, color: 'var(--text-muted)' }}>{note}</p>}
      <p style={{ fontSize: 11, margin: 0, color: 'var(--text-dim)' }}>
        For paid ChatGPT plans. Plus has a five-hour limit shared with every app you use your plan in. Not available in the web app.
      </p>
    </div>
  );
}
