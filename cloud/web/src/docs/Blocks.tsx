import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, Info, Lightbulb } from 'lucide-react';
import clsx from 'clsx';
import type { Block } from './content/types.js';
import { Inline } from './inline.js';

/** Copy text. The async clipboard needs a secure context; an old-style copy covers the rest. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    const ok = await copyText(code);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  }
  return (
    <figure className="group my-4 overflow-hidden rounded-xl bg-sunk" style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--c-elev) / 0.1)' }}>
      <figcaption className="flex items-center justify-between gap-2 border-b border-elev/10 px-3.5 py-1.5 text-[11.5px] text-ink-400">
        <span className="font-mono">{title ?? lang ?? 'text'}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={state === 'copied' ? 'Copied' : 'Copy code'}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-ink-300 transition-colors hover:bg-elev/[0.07] hover:text-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500"
        >
          {state === 'copied' ? <Check size={13} className="text-success-500" /> : <Copy size={13} />}
          <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Press Ctrl+C' : 'Copy'}</span>
        </button>
      </figcaption>
      <pre className="m-0 overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] text-ink-100"><code>{code}</code></pre>
    </figure>
  );
}

const CALLOUT = {
  note: { icon: Info, label: 'Note', box: 'bg-info-950 text-info-300', ring: 'rgb(var(--c-info-500) / 0.35)', icon_cls: 'text-info-500' },
  warn: { icon: AlertTriangle, label: 'Warning', box: 'bg-warning-950 text-warning-300', ring: 'rgb(var(--c-warning-500) / 0.4)', icon_cls: 'text-warning-500' },
  tip: { icon: Lightbulb, label: 'Tip', box: 'bg-success-950 text-success-300', ring: 'rgb(var(--c-success-500) / 0.35)', icon_cls: 'text-success-500' },
} as const;

function Callout({ kind, title, text }: { kind: keyof typeof CALLOUT; title?: string; text: string }) {
  const c = CALLOUT[kind];
  const Icon = c.icon;
  return (
    <aside
      role="note"
      aria-label={title ?? c.label}
      data-callout={kind}
      className={clsx('my-4 flex gap-3 rounded-xl px-4 py-3 text-[14px] leading-relaxed', c.box)}
      style={{ boxShadow: `inset 0 0 0 1px ${c.ring}` }}
    >
      <Icon size={16} className={clsx('mt-[3px] shrink-0', c.icon_cls)} aria-hidden="true" />
      <div className="min-w-0 text-ink-100">
        <p className="m-0 mb-0.5 text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ink-50">{title ?? c.label}</p>
        <p className="m-0"><Inline text={text} /></p>
      </div>
    </aside>
  );
}

export const H2_CLASS = 'group relative mb-3 mt-10 scroll-mt-20 font-serif text-[26px] font-normal leading-tight tracking-[-0.015em] text-ink-50';
export const H3_CLASS = 'group relative mb-2 mt-7 scroll-mt-20 font-serif text-[19px] font-medium leading-snug text-ink-50';

function Heading({ level, id, children }: { level: 2 | 3; id: string; children: ReactNode }) {
  const Tag = level === 2 ? 'h2' : 'h3';
  return (
    <Tag id={id} className={level === 2 ? H2_CLASS : H3_CLASS}>
      {children}
      <a
        href={`#${id}`}
        aria-label="Link to this section"
        className="ml-2 text-ink-500 no-underline opacity-0 transition-opacity hover:text-accent-400 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(e) => {
          // A same-page anchor: keep the page where it is, and put the anchor in the URL.
          e.preventDefault();
          window.history.replaceState(null, '', `#${id}`);
          document.getElementById(id)?.scrollIntoView?.({ block: 'start' });
        }}
      >#</a>
    </Tag>
  );
}

const P_CLASS = 'my-3 text-[15.5px] leading-[1.7] text-ink-200';

export function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case 'p':
      return <p className={P_CLASS}><Inline text={block.text} /></p>;
    case 'h2':
      return <Heading level={2} id={block.id}><Inline text={block.text} /></Heading>;
    case 'h3':
      return <Heading level={3} id={block.id}><Inline text={block.text} /></Heading>;
    case 'ul':
      return (
        <ul className="my-3 list-disc space-y-1.5 pl-6 text-[15.5px] leading-[1.65] text-ink-200 marker:text-ink-500">
          {block.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}
        </ul>
      );
    case 'ol':
      return (
        <ol className="my-3 list-decimal space-y-2 pl-6 text-[15.5px] leading-[1.65] text-ink-200 marker:font-mono marker:text-ink-500">
          {block.items.map((it, i) => <li key={i} className="pl-1"><Inline text={it} /></li>)}
        </ol>
      );
    case 'code':
      return <CodeBlock code={block.code} {...(block.lang ? { lang: block.lang } : {})} {...(block.title ? { title: block.title } : {})} />;
    case 'callout':
      return <Callout kind={block.kind} text={block.text} {...(block.title ? { title: block.title } : {})} />;
    case 'table':
      return (
        <div className="cz-tbl my-4 text-[14px] leading-snug text-ink-200" role="region" tabIndex={0} aria-label="Table">
          <table>
            <thead>
              <tr>{block.head.map((h, i) => <th key={i} scope="col"><Inline text={h} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, c) => <td key={c}><Inline text={cell} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((b, i) => <BlockView key={i} block={b} />)}</>;
}
