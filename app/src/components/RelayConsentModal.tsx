import { useEffect, useRef, useState } from 'react';

interface Ask { id: number; runId: string; expiresAt: number }

/**
 * A cloud run asking for this app's browser (app/electron/desktop-relay.ts): which
 * sites it may open, or no. One question at a time; one the run stops asking is taken
 * down. Closing it is a no.
 */
export function RelayConsentModal() {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [sites, setSites] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const relay = window.cascade?.relay;
    if (!relay) return;
    relay.onAsk((a) => setAsks((q) => [...q, a]));
    relay.onAskClosed(({ id }) => setAsks((q) => q.filter((a) => a.id !== id)));
  }, []);
  const ask = asks[0];
  useEffect(() => { setSites(''); setError(null); input.current?.focus(); }, [ask?.id]);
  if (!ask) return null;

  const answer = async (text: string) => {
    const r = await window.cascade?.relay?.answer(ask.id, text);
    if (r && 'error' in r) { setError(r.error); return; }
    setAsks((q) => q.filter((a) => a.id !== ask.id));
  };
  const mins = Math.max(1, Math.round((ask.expiresAt - Date.now()) / 60_000));
  const btn = (primary: boolean): React.CSSProperties => ({
    padding: '7px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
    background: primary ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
    color: primary ? '#fff' : 'var(--text)', border: primary ? 'none' : '1px solid var(--border)',
  });

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="relay-ask-title" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'grid', placeItems: 'center', zIndex: 1000 }}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (sites.trim()) void answer(sites); else setError('Type at least one site, or press Say no.'); }}
        style={{ width: 'min(480px, calc(100vw - 32px))', background: 'var(--bg-panel, var(--bg))', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 10, padding: 18, fontSize: 13, lineHeight: 1.5 }}
      >
        <h2 id="relay-ask-title" style={{ margin: '0 0 4px', fontSize: 16 }}>A cloud run wants this app&apos;s browser</h2>
        <p style={{ margin: '0 0 12px', color: 'var(--text-muted)' }}>This question lapses in about {mins} min.</p>
        <label htmlFor="relay-sites" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Sites it may open</label>
        <input
          id="relay-sites" ref={input} value={sites} onChange={(e) => setSites(e.target.value)} spellCheck={false} autoComplete="off"
          placeholder="example.com docs.example.com"
          style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'inherit', fontSize: 13 }}
        />
        {error && <p role="alert" style={{ color: 'var(--danger, #e5484d)', margin: '6px 0 0' }}>{error}</p>}
        <ul style={{ margin: '12px 0', paddingLeft: 18, color: 'var(--text-muted)' }}>
          <li>The run gets a new window with an empty profile, closed and wiped when it ends. Nothing you&apos;re signed in to is in it.</li>
          <li>Sent to your Cascade server while it runs: the addresses of pages in that window, their text and structure, and what the run types into them. No screenshots.</li>
          <li>Pages on any other site don&apos;t load there. Downloads are cancelled. A site on your private network loads only if you name it here.</li>
          <li>Close the window to stop the run, or turn this off in Settings.</li>
        </ul>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btn(false)} onClick={() => void answer('')}>Say no</button>
          <button type="submit" style={btn(true)}>Allow these sites</button>
        </div>
      </form>
    </div>
  );
}
