import { useEffect, useRef, useState } from 'react';
import { mermaidConfig, renderMermaid } from '../lib/mermaid-render';

let seq = 0;

// Reads the app theme so diagrams follow light/dark like the terminal does.
function isDarkTheme(): boolean {
  const attr = document.documentElement.getAttribute('data-theme') ?? '';
  return attr !== 'light';
}

/**
 * Renders a ```mermaid fence as an actual diagram. The mermaid package is
 * heavyweight, so it's imported lazily on first use. While the source is
 * still streaming in (or simply doesn't parse), the caller's fallback —
 * the normal syntax-highlighted code block — is shown instead, so a
 * half-received diagram never flashes an error.
 */
export function MermaidBlock({ code, fallback }: { code: string; fallback: React.ReactNode }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize(mermaidConfig(isDarkTheme() ? 'dark' : 'default'));
        // Parses first, and never leaves mermaid's own error graphic on the page.
        const rendered = await renderMermaid(mermaid, `cascade-mmd-${++seq}`, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) { setSvg(null); setFailed(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (failed || !svg) return <>{fallback}</>;
  return (
    <div
      ref={containerRef}
      style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, overflowX: 'auto', marginBottom: 8 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
