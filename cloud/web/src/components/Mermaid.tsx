import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
let seq = 0;

/**
 * Lazily loads mermaid (it's ~1 MB, so it must not sit in the initial bundle)
 * and renders one diagram to inline SVG. On any parse/render error it falls
 * back to showing the raw source, so a malformed diagram never blanks the reply.
 * `securityLevel: 'strict'` disables mermaid's own HTML/script injection.
 */
export default function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!mermaidPromise) {
          mermaidPromise = import('mermaid').then((m) => {
            m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
            return m.default;
          });
        }
        const mermaid = await mermaidPromise;
        const id = `mmd-${Date.now()}-${seq++}`;
        // parse() throws on invalid syntax before we attempt a render.
        await mermaid.parse(code);
        const { svg: out } = await mermaid.render(id, code);
        if (!cancelled) { setSvg(out); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not render diagram');
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="my-2 overflow-hidden rounded-xl border border-warning-500/30 bg-warning-500/[0.06]">
        <div className="flex items-center gap-1.5 border-b border-warning-500/20 px-3 py-1.5 text-[11px] text-warning-300">
          <AlertTriangle size={12} /> Diagram couldn't render — showing source
        </div>
        <pre className="overflow-x-auto p-3 text-xs text-ink-300">{code}</pre>
      </div>
    );
  }
  if (!svg) {
    return <div className="my-2 animate-pulse rounded-xl border border-elev/10 bg-elev/[0.04] px-3 py-6 text-center text-xs text-ink-500">Rendering diagram…</div>;
  }
  return (
    <div
      ref={ref}
      className="mermaid-diagram my-2 flex justify-center overflow-x-auto rounded-xl border border-elev/10 bg-black/20 p-3 [&_svg]:max-w-full [&_svg]:h-auto"
      // eslint-disable-next-line react/no-danger -- mermaid output, securityLevel:'strict'
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
