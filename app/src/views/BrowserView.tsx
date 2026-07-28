import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppSelector } from '../store/index.js';
import { ArrowLeft, ArrowRight, RotateCw, X, ExternalLink, Home, Sparkles } from 'lucide-react';
import { CascadeMark } from '../components/CascadeMark.js';

/**
 * The built-in browser.
 *
 * Only the chrome lives here. The page itself is a native WebContentsView that
 * the main process positions OVER this component at the bounds we report — an
 * <iframe> is refused outright by X-Frame-Options on most sites worth looking
 * up, so the panel would be permanently blank on exactly the pages people want.
 *
 * The consequence to keep in mind: the page floats above the React tree, so it
 * must be hidden whenever this view unmounts, or it would sit on top of
 * whatever the user switched to.
 */

interface BrowserState {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

const EMPTY: BrowserState = {
  open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
};

export function BrowserView() {
  const api = window.cascade?.browser;
  const pageRef = useRef<HTMLDivElement>(null);

  // The native page floats ABOVE the React tree, so any modal would open behind
  // it — including the escalation prompt, which would put us right back at
  // "the run asked me something and I never saw it". Hide the page while
  // anything is asking for the user's attention.
  // EVERY overlay, not only the dialogs: the Why panel and Help panel are
  // slide-overs in the same content area, reachable from the always-visible
  // status bar and the command palette, and a React z-index cannot put them
  // above a native child view — they were simply invisible behind the page.
  const blocked = useAppSelector((st) =>
    st.app.showSettings
    || st.app.showPalette
    || st.app.showContinue
    || st.app.showWhyPanel
    || st.app.helpContext !== null
    || st.app.pendingApprovals.length > 0
    || st.app.pendingPlan !== null
    || st.app.pendingEscalations.length > 0
    || st.app.changesSessionId !== null,
  );
  const [state, setState] = useState<BrowserState>(EMPTY);
  const [address, setAddress] = useState('');
  // True while the address bar has focus, so live navigation events don't
  // overwrite what the user is halfway through typing.
  const editingRef = useRef(false);

  /** Report where the page rectangle is, in renderer CSS pixels. */
  const syncBounds = useCallback(() => {
    const el = pageRef.current;
    if (!el || !api) return;
    const r = el.getBoundingClientRect();
    void api.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  }, [api]);

  useEffect(() => {
    if (!api) return;
    // Hide, not close — the page and any signed-in session survive the modal.
    if (blocked) void api.hide();
    else {
      const el = pageRef.current;
      const r = el?.getBoundingClientRect();
      if (r) void api.open(undefined, { x: r.left, y: r.top, width: r.width, height: r.height });
    }
  }, [blocked, api]);

  useEffect(() => {
    if (!api) return;
    const offState = api.onState((s) => {
      setState(s);
      if (!editingRef.current) setAddress(s.url);
    });

    const el = pageRef.current;
    const r = el?.getBoundingClientRect();
    void api
      .open(undefined, r ? { x: r.left, y: r.top, width: r.width, height: r.height } : { x: 0, y: 0, width: 0, height: 0 })
      .then((res) => {
        if (res?.state) {
          setState(res.state);
          if (!editingRef.current) setAddress(res.state.url);
        }
      });

    // The native view does not participate in layout, so every way the
    // rectangle can move has to be reported explicitly.
    const ro = new ResizeObserver(syncBounds);
    if (el) ro.observe(el);
    window.addEventListener('resize', syncBounds);

    return () => {
      offState();
      ro.disconnect();
      window.removeEventListener('resize', syncBounds);
      // Hide, don't close: the page and any session the user signed into
      // survive a trip to Chat and back.
      void api.hide();
    };
  }, [api, syncBounds]);

  if (!api) {
    return (
      <div style={{ padding: 24, fontSize: 12.5, color: 'var(--text-dim)' }}>
        The built-in browser isn&apos;t available in this build.
      </div>
    );
  }

  const go = () => {
    const v = address.trim();
    if (v) void api.navigate(v);
    editingRef.current = false;
  };

  const btn = (enabled: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 26, height: 26, borderRadius: 6, border: 'none', flexShrink: 0,
    background: 'transparent', color: enabled ? 'var(--text-muted)' : 'var(--text-dim)',
    cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.4,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)', flexShrink: 0,
      }}>
        <button style={btn(state.canGoBack)} disabled={!state.canGoBack} onClick={() => void api.back()} title="Back">
          <ArrowLeft size={15} />
        </button>
        <button style={btn(state.canGoForward)} disabled={!state.canGoForward} onClick={() => void api.forward()} title="Forward">
          <ArrowRight size={15} />
        </button>
        <button
          style={btn(true)}
          onClick={() => (state.loading ? void api.stop() : void api.reload())}
          title={state.loading ? 'Stop' : 'Reload'}
        >
          {state.loading ? <X size={15} /> : <RotateCw size={14} />}
        </button>
        <button style={btn(true)} onClick={() => void api.navigate('https://duckduckgo.com/')} title="Home">
          <Home size={14} />
        </button>

        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
          background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 7, padding: '0 8px',
        }}>
          {state.loading
            ? <CascadeMark size={13} />
            : <span style={{ width: 13, flexShrink: 0 }} />}
          <input
            value={address}
            onChange={(e) => { editingRef.current = true; setAddress(e.target.value); }}
            onFocus={(e) => { editingRef.current = true; e.currentTarget.select(); }}
            onBlur={() => { editingRef.current = false; setAddress(state.url); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); go(); e.currentTarget.blur(); }
              else if (e.key === 'Escape') { e.preventDefault(); setAddress(state.url); e.currentTarget.blur(); }
            }}
            placeholder="Search, or enter an address"
            spellCheck={false}
            style={{
              flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text)', fontSize: 12.5, padding: '7px 0',
            }}
          />
        </div>

        <button
          style={btn(!!state.url)}
          disabled={!state.url}
          onClick={() => void api.openExternal(state.url)}
          title="Open in your system browser"
        >
          <ExternalLink size={14} />
        </button>
      </div>

      {/* Cascade can read whatever is on screen — say so plainly, because a
          browser inside an AI app that quietly reads pages would be worse than
          one that says it does. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)',
        fontSize: 10.5, color: 'var(--text-dim)',
      }}>
        <Sparkles size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span>
          Ask about &ldquo;this page&rdquo; in Chat and Cascade reads what&apos;s open here — including pages
          behind a login, which a plain fetch can&apos;t see.
        </span>
      </div>

      {/* The native page view is positioned over this rectangle. It must keep
          its size even while empty, or the bounds we report would be wrong. */}
      <div ref={pageRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {state.error && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--text-dim)', pointerEvents: 'none',
          }}>
            {state.error}
          </div>
        )}
      </div>
    </div>
  );
}
