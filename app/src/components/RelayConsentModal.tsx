import { useEffect, useRef, useState } from 'react';

interface Ask { id: number; runId: string; expiresAt: number; sites?: string[] }

/**
 * A cloud run asking for this app's browser (app/electron/desktop-relay.ts): which
 * sites it may open, or no. One question at a time; one the run stops asking is taken
 * down. Closing it is a no.
 */
export function RelayConsentModal() {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [sites, setSites] = useState('');
  const [anyPublic, setAnyPublic] = useState(false);
  const [screenshots, setScreenshots] = useState(false);
  // Parts of the run working side by side, each in a browser of its own.
  const [tabs, setTabs] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const relay = window.cascade?.relay;
    if (!relay) return;
    relay.onAsk((a) => setAsks((q) => [...q, a]));
    relay.onAskClosed(({ id }) => setAsks((q) => q.filter((a) => a.id !== id)));
  }, []);
  const ask = asks[0];
  // Pre-filled with the site the run wants to start on.
  useEffect(() => { setSites((ask?.sites ?? []).join(' ')); setAnyPublic(false); setScreenshots(false); setTabs(4); setError(null); input.current?.focus(); }, [ask?.id]);
  if (!ask) return null;

  const answer = async (text: string, any = false, shots = false, max = 1) => {
    const r = await window.cascade?.relay?.answer(ask.id, text, any, shots, max);
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
        onSubmit={(e) => { e.preventDefault(); if (sites.trim() || anyPublic) void answer(sites, anyPublic, screenshots, tabs); else setError('Type at least one site, tick "Any public site", or press Say no.'); }}
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
        {(ask.sites?.length ?? 0) > 0 && <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>Filled in with the site the run wants to start on. Add or remove sites as you like.</p>}
        <label style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
          <input type="checkbox" checked={anyPublic} onChange={(e) => setAnyPublic(e.target.checked)} />
          <span>Any public site <span style={{ color: 'var(--text-muted)' }}>(for research: it can open whatever it finds; your private network stays blocked unless named above)</span></span>
        </label>
        <label style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
          <input type="checkbox" checked={screenshots} onChange={(e) => setScreenshots(e.target.checked)} />
          <span>Let Cascade take screenshots of these sites for your report <span style={{ color: 'var(--text-muted)' }}>(password, card and code fields are blurred)</span></span>
        </label>
        <label style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
          <span>Browsers at once</span>
          <select value={tabs} onChange={(e) => setTabs(Number(e.target.value))} style={{ padding: '2px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-raised)', color: 'inherit', fontSize: 13 }}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span style={{ color: 'var(--text-muted)' }}>(parts of the run work side by side, each in its own window; each uses some memory)</span>
        </label>
        {error && <p role="alert" style={{ color: 'var(--danger, #e5484d)', margin: '6px 0 0' }}>{error}</p>}
        <ul style={{ margin: '12px 0', paddingLeft: 18, color: 'var(--text-muted)' }}>
          <li>The run gets a new window with an empty profile, closed and wiped when it ends. Nothing you&apos;re signed in to is in it.</li>
          <li>Sent to your Cascade server while it runs: the addresses of pages in that window, their text and structure, and what the run types into them. No screenshots, unless you tick the box for them: then still pictures of the run&apos;s window, with password, card and one-time-code fields and other sites&apos; frames blurred.</li>
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
