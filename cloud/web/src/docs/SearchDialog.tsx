import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import clsx from 'clsx';
import { docsHref } from './route.js';
import { search, searchTerms, type SearchHit } from './search.js';

/** The text with each search word marked, so you see why it matched. */
function Marked({ text, terms }: { text: string; terms: string[] }): ReactNode {
  if (!terms.length) return text;
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(${esc.join('|')})`, 'ig'));
  return parts.map((part, i) => (
    i % 2 === 1
      ? <mark key={i} className="rounded-sm bg-accent-500/20 text-ink-50">{part}</mark>
      : <Fragment key={i}>{part}</Fragment>
  ));
}

/** Ctrl or Cmd+K: find a page or a section of one. Arrow keys pick, Enter opens, Esc closes. */
export default function SearchDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (url: string) => void }) {
  const [query, setQuery] = useState('');
  const [row, setRow] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const hits = useMemo(() => search(query), [query]);
  const terms = useMemo(() => searchTerms(query), [query]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => { opener?.focus?.(); };
  }, []);
  useEffect(() => { setRow(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [row, hits]);

  const urlOf = (h: SearchHit) => docsHref(h.slug, h.anchor ?? undefined);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setRow((r) => (hits.length ? (r + 1) % hits.length : 0)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setRow((r) => (hits.length ? (r - 1 + hits.length) % hits.length : 0)); return; }
    if (e.key === 'Enter' && hits[row]) { e.preventDefault(); onOpen(urlOf(hits[row]!)); }
    // Keep Tab inside the dialog.
    if (e.key === 'Tab') e.preventDefault();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[10vh]" role="presentation" data-testid="docs-search">
      <div className="docs-fade absolute inset-0 bg-black/55" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog" aria-modal="true" aria-label="Search the docs" onKeyDown={onKeyDown}
        className="docs-pop relative flex max-h-[76vh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl bg-card"
        style={{ boxShadow: 'var(--glass-shadow-strong), inset 0 0 0 1px rgb(var(--c-elev) / 0.14)' }}
      >
        <div className="flex items-center gap-2.5 border-b border-elev/10 px-4">
          <Search size={16} className="shrink-0 text-ink-400" aria-hidden="true" />
          <input
            ref={input} value={query} onChange={(e) => setQuery(e.target.value)}
            type="search" role="combobox" aria-expanded="true" aria-controls="docs-search-results"
            aria-activedescendant={hits[row] ? `docs-hit-${row}` : undefined} aria-label="Search the docs"
            placeholder="Search titles, headings and text"
            className="h-12 min-w-0 flex-1 bg-transparent text-[15.5px] text-ink-50 outline-none placeholder:text-ink-500"
            autoComplete="off" spellCheck={false}
          />
          <kbd className="rounded border border-elev/15 px-1.5 font-mono text-[11px] text-ink-400">Esc</kbd>
        </div>
        <ul ref={list} id="docs-search-results" role="listbox" aria-label="Results" className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-2">
          {hits.map((h, i) => (
            <li
              key={`${h.slug}#${h.anchor ?? ''}`} id={`docs-hit-${i}`} role="option" aria-selected={i === row}
              onMouseMove={() => setRow(i)}
              onClick={() => onOpen(urlOf(h))}
              className={clsx('flex cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2.5', i === row ? 'bg-accent-500/10' : '')}
            >
              <span className="flex items-baseline gap-2">
                <span className="text-[14.5px] font-medium text-ink-50"><Marked text={h.heading ?? h.pageTitle} terms={terms} /></span>
                <span className="truncate text-[12px] text-ink-400">{h.heading ? `${h.pageTitle} · ` : ''}{h.section}</span>
              </span>
              <span className="line-clamp-2 text-[12.5px] leading-snug text-ink-300"><Marked text={h.snippet} terms={terms} /></span>
            </li>
          ))}
          {query.trim() && hits.length === 0 && (
            <li role="presentation" className="px-3 py-8 text-center text-[14px] text-ink-400" data-testid="docs-search-empty">
              Nothing matches &ldquo;{query.trim()}&rdquo;. Try fewer or different words.
            </li>
          )}
          {!query.trim() && (
            <li role="presentation" className="px-3 py-8 text-center text-[13.5px] text-ink-400">
              Type to search every page. Try <button type="button" className="text-accent-400 hover:underline" onClick={() => setQuery('undo')}>undo</button>,{' '}
              <button type="button" className="text-accent-400 hover:underline" onClick={() => setQuery('workspace')}>workspace</button> or{' '}
              <button type="button" className="text-accent-400 hover:underline" onClick={() => setQuery('rate limit')}>rate limit</button>.
            </li>
          )}
        </ul>
        <div className="flex items-center justify-end gap-3 border-t border-elev/10 px-4 py-2 text-[11.5px] text-ink-500">
          <span><kbd className="font-mono">↑↓</kbd> to move</span>
          <span className="inline-flex items-center gap-1"><CornerDownLeft size={11} /> to open</span>
        </div>
      </div>
    </div>
  );
}
