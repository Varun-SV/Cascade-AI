import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { useReducedMotion } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, ExternalLink, GitBranch, Laptop, Menu, Moon, Search, Sun, X,
} from 'lucide-react';
import CascadeMark from '../components/CascadeMark.js';
import { initTheme, applyTheme } from '../lib/theme.js';
import { reduceMotionEnabled, themeMode, setThemeMode, type ThemeMode } from '../lib/prefs.js';
import { Blocks } from './Blocks.js';
import { DocLink, DocsNavContext, Inline, plainText } from './inline.js';
import DocsHero from './DocsHero.js';
import SearchDialog from './SearchDialog.js';
import { CHANGELOG_URL, PAGES, SECTIONS, SLUGS, neighbours, pageBySlug, pagesIn, sectionById } from './content/index.js';
import type { DocPage } from './content/types.js';
import { docsHref, parseDocsLocation } from './route.js';
import './docs.css';

const REPO = 'https://github.com/Varun-SV/Cascade-AI';
const TIER_DOT = ['bg-t1', 'bg-t2', 'bg-t3'];
const THEME_NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<ThemeMode, string> = { system: 'Theme: follow system', light: 'Theme: light', dark: 'Theme: dark' };

interface Props {
  pathname: string;
  hash: string;
  /** Move to a URL without a page load. Root gives the app's own navigate(). */
  onNavigate: (url: string, opts?: { replace?: boolean }) => void;
}

/** The docs: a sidebar of sections, one page at a time, search, and (on wide screens) the page's own outline. */
export default function DocsApp({ pathname, hash, onNavigate }: Props) {
  const loc = useMemo(() => parseDocsLocation(pathname, hash, SLUGS), [pathname, hash]);
  const page = loc.kind === 'page' ? pageBySlug(loc.slug) ?? null : null;
  const anchor = loc.kind === 'page' ? loc.anchor : null;

  const [drawer, setDrawer] = useState(false);
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<ThemeMode>(() => themeMode());
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const osReduced = useReducedMotion();
  const still = !!osReduced || reduceMotionEnabled();

  useEffect(() => initTheme(), []);

  // The old single-page address, /docs#privacy, becomes the page's own: the URL says where you are.
  useEffect(() => {
    if (loc.kind === 'page' && pathname.replace(/\/+$/, '') === '/docs') onNavigate(docsHref(loc.slug), { replace: true });
  }, [loc, pathname, onNavigate]);

  // Ctrl or Cmd+K opens search, as it does for chats in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setDrawer(false);
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Title of the tab.
  useEffect(() => {
    const before = document.title;
    document.title = page ? `${page.title} · Cascade docs` : loc.kind === 'missing' ? 'Page not found · Cascade docs' : 'Cascade docs';
    return () => { document.title = before; };
  }, [page, loc.kind]);

  // A new page starts at its top, or at its anchor; focus moves to it for keyboard and screen-reader users.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const target = anchor ? document.getElementById(anchor) : null;
    if (target) target.scrollIntoView?.({ block: 'start' });
    else root.scrollTop = 0;
    if (firstRender.current) { firstRender.current = false; return; }
    if (!target) mainRef.current?.focus({ preventScroll: true });
  }, [loc.kind === 'page' ? loc.slug : loc.kind, anchor]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = useCallback((url: string) => { setDrawer(false); onNavigate(url); }, [onNavigate]);
  const nav = useMemo(() => ({ navigate }), [navigate]);

  function cycleTheme() {
    const next = THEME_NEXT[mode];
    setMode(next);
    setThemeMode(next);
    applyTheme(next);
  }
  const ThemeIcon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Laptop;
  const activeSlug = page?.slug ?? null;

  return (
    <DocsNavContext.Provider value={nav}>
      <div
        ref={rootRef}
        className={clsx('docs-root h-dvh overflow-x-clip bg-paper text-ink-100', drawer ? 'overflow-y-hidden' : 'overflow-y-auto')}
        data-testid="docs"
      >
        <a href="#docs-main" className="docs-skip" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>

        <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-elev/10 bg-paper/85 px-2.5 backdrop-blur-md sm:gap-2 sm:px-5">
          <button
            type="button" aria-label="Open the menu" aria-expanded={drawer} aria-controls="docs-drawer"
            onClick={() => setDrawer(true)} className="cz-ib lg:hidden"
          ><Menu size={18} /></button>
          <DocLink href="/docs" className="flex items-center gap-2.5 text-ink-50 no-underline">
            <CascadeMark size={22} animate={false} />
            <span className="font-serif text-[19px] font-medium tracking-[-0.01em]">Cascade</span>
            <span className="rounded-md bg-elev/[0.08] px-1.5 py-px font-mono text-[11px] uppercase tracking-wide text-ink-300">Docs</span>
          </DocLink>

          <button
            type="button" onClick={() => setSearching(true)} aria-label="Search the docs"
            className="mx-auto hidden h-9 w-full max-w-[420px] items-center gap-2 rounded-[10px] bg-card px-3 text-left text-[13.5px] text-ink-400 hover:text-ink-200 sm:flex"
            style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--c-elev) / 0.14)' }}
          >
            <Search size={15} />
            <span className="flex-1">Search the docs</span>
            <kbd className="rounded border border-elev/15 px-1.5 font-mono text-[11px] text-ink-400">Ctrl K</kbd>
          </button>

          <nav aria-label="Site" className="ml-auto flex items-center gap-1 sm:ml-0">
            <button type="button" aria-label="Search the docs" onClick={() => setSearching(true)} className="cz-ib sm:hidden"><Search size={18} /></button>
            <a href={REPO} target="_blank" rel="noopener noreferrer" aria-label="Cascade on GitHub" className="cz-ib hidden sm:inline-flex"><GitBranch size={17} /></a>
            <button type="button" onClick={cycleTheme} aria-label={THEME_LABEL[mode]} title={THEME_LABEL[mode]} className="cz-ib"><ThemeIcon size={17} /></button>
            <a
              href="/" aria-label="Open Cascade" className="cz-btn cz-btn-ghost cz-btn-sm ml-1 whitespace-nowrap no-underline"
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onNavigate('/');
              }}
            >
              <span className="sm:hidden" aria-hidden="true">Open app</span>
              <span className="hidden sm:inline" aria-hidden="true">Open Cascade</span>
            </a>
          </nav>
        </header>

        <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 lg:grid-cols-[264px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)_228px]">
          <aside aria-label="Documentation" className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] self-start overflow-y-auto border-r border-elev/10 px-3 py-5 lg:block">
            <SidebarNav activeSlug={activeSlug} />
          </aside>

          <main
            id="docs-main" ref={mainRef} tabIndex={-1}
            className="min-w-0 px-5 pb-24 pt-8 outline-none sm:px-8 lg:px-12"
          >
            {loc.kind === 'home' && <HomeView still={still} theme={mode} onSearch={() => setSearching(true)} />}
            {page && <PageView page={page} />}
            {loc.kind === 'missing' && <NotFound slug={loc.slug} onSearch={() => setSearching(true)} />}
          </main>

          {page && (
            <aside aria-label="On this page" className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] self-start overflow-y-auto py-8 pl-2 pr-5 xl:block">
              <Toc page={page} scroller={rootRef} />
            </aside>
          )}
        </div>

        <footer className="border-t border-elev/10 px-5 py-6 text-center text-[12.5px] text-ink-500">
          <a href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer" className="hover:text-ink-200">Changelog</a>
          <span aria-hidden="true"> · </span>
          <a href={REPO} target="_blank" rel="noopener noreferrer" className="hover:text-ink-200">GitHub</a>
          <span aria-hidden="true"> · </span>
          <DocLink href="/docs/privacy" className="hover:text-ink-200">Privacy</DocLink>
        </footer>

        {drawer && <Drawer activeSlug={activeSlug} onClose={() => setDrawer(false)} />}
        {searching && <SearchDialog onClose={() => setSearching(false)} onOpen={(url) => { setSearching(false); onNavigate(url); }} />}
      </div>
    </DocsNavContext.Provider>
  );
}

// ── Sidebar ──────────────────────────────────

function SidebarNav({ activeSlug, onPick }: { activeSlug: string | null; onPick?: () => void }) {
  return (
    <nav aria-label="Docs sections" className="flex flex-col gap-5 text-[13.5px]">
      {SECTIONS.map((s, i) => (
        <div key={s.id}>
          <h2 className="m-0 mb-1.5 flex items-center gap-2 px-2.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-400">
            <span className={clsx('h-1.5 w-1.5 rounded-full', TIER_DOT[i % 3])} aria-hidden="true" />
            {s.title}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-px p-0">
            {pagesIn(s.id).map((p) => {
              const on = p.slug === activeSlug;
              return (
                <li key={p.slug}>
                  <DocLink
                    href={docsHref(p.slug)}
                    onNavigate={onPick}
                    {...(on ? { 'aria-current': 'page' as const } : {})}
                    className={clsx(
                      'block rounded-lg px-2.5 py-1.5 no-underline transition-colors',
                      on ? 'bg-accent-500/10 font-medium text-accent-400' : 'text-ink-300 hover:bg-elev/[0.06] hover:text-ink-50',
                    )}
                  >{p.title}</DocLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <a href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer" className="mx-2.5 inline-flex items-center gap-1.5 text-ink-400 no-underline hover:text-ink-100">
        Changelog on GitHub <ExternalLink size={12} />
      </a>
    </nav>
  );
}

function Drawer({ activeSlug, onClose }: { activeSlug: string | null; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 lg:hidden" data-testid="docs-drawer">
      <div className="docs-fade absolute inset-0 bg-black/55" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel} id="docs-drawer" role="dialog" aria-modal="true" aria-label="Documentation menu"
        className="docs-slide absolute inset-y-0 left-0 flex w-[min(320px,86vw)] flex-col bg-side shadow-2xl"
        style={{ paddingLeft: 'env(safe-area-inset-left, 0px)' }}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-elev/10 px-4">
          <span className="font-serif text-[18px] text-ink-50">Cascade docs</span>
          <button type="button" aria-label="Close the menu" onClick={onClose} className="cz-ib"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav activeSlug={activeSlug} onPick={onClose} />
        </div>
      </div>
    </div>
  );
}

// ── Pages ────────────────────────────────────

function PageView({ page }: { page: DocPage }) {
  const section = sectionById(page.section);
  const { prev, next } = neighbours(page.slug);
  return (
    <article className="mx-auto w-full max-w-[760px]" data-testid="docs-page">
      <nav aria-label="Breadcrumb" className="mb-3 text-[12.5px] text-ink-400">
        <DocLink href="/docs" className="text-ink-400 no-underline hover:text-ink-100">Docs</DocLink>
        <span aria-hidden="true" className="mx-1.5">/</span>
        <span>{section?.title}</span>
      </nav>
      <div className="mb-4 h-[3px] w-12 rounded-full" style={{ background: 'var(--cascade-ramp-x)' }} aria-hidden="true" />
      <h1 className="m-0 font-serif text-[clamp(30px,4.4vw,42px)] font-normal leading-[1.08] tracking-[-0.022em] text-ink-50">{page.title}</h1>
      <p className="mb-6 mt-3 text-[17px] leading-relaxed text-ink-300">{plainText(page.summary)}</p>
      <Blocks blocks={page.blocks} />
      <nav aria-label="Previous and next" className="mt-14 grid grid-cols-1 gap-3 border-t border-elev/10 pt-6 sm:grid-cols-2">
        {prev ? (
          <DocLink href={docsHref(prev.slug)} className="group flex flex-col gap-1 rounded-xl bg-card p-4 no-underline transition-colors hover:bg-sunk" data-testid="docs-prev">
            <span className="flex items-center gap-1.5 text-[12px] text-ink-400"><ArrowLeft size={13} /> Previous</span>
            <span className="text-[15px] font-medium text-ink-50">{prev.title}</span>
          </DocLink>
        ) : <span />}
        {next ? (
          <DocLink href={docsHref(next.slug)} className="group flex flex-col items-end gap-1 rounded-xl bg-card p-4 text-right no-underline transition-colors hover:bg-sunk" data-testid="docs-next">
            <span className="flex items-center gap-1.5 text-[12px] text-ink-400">Next <ArrowRight size={13} /></span>
            <span className="text-[15px] font-medium text-ink-50">{next.title}</span>
          </DocLink>
        ) : <span />}
      </nav>
    </article>
  );
}

function HomeView({ still, theme, onSearch }: { still: boolean; theme: string; onSearch: () => void }) {
  const start = ['quick-start', 'workspaces', 'cli-commands', 'troubleshooting']
    .map((s) => pageBySlug(s)).filter((p): p is DocPage => !!p);
  return (
    <div className="mx-auto w-full max-w-[920px]" data-testid="docs-home">
      <section className="relative isolate overflow-hidden rounded-3xl bg-card px-6 py-10 sm:px-10 sm:py-14" style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--c-elev) / 0.12)' }}>
        <div className="pointer-events-none absolute inset-y-0 right-0 -z-10 w-full opacity-30 sm:w-[54%] sm:opacity-100" data-testid="docs-hero-box">
          <DocsHero still={still} theme={theme} />
        </div>
        <p className="m-0 font-mono text-[12px] uppercase tracking-[0.12em] text-ink-400">Documentation</p>
        <h1 className="m-0 mt-3 max-w-[14ch] font-serif text-[clamp(36px,6vw,58px)] font-normal leading-[1.03] tracking-[-0.03em] text-ink-50">
          Everything about Cascade.
        </h1>
        <p className="mb-7 mt-4 max-w-[34ch] text-[17px] leading-relaxed text-ink-200">
          Set it up, point it at your own keys and your own files, and see exactly what it did and what it cost.
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          <DocLink href="/docs/quick-start" className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent-500 px-4 text-[14px] font-medium text-white no-underline hover:bg-accent-600">
            Quick start <ArrowRight size={15} />
          </DocLink>
          <button type="button" onClick={onSearch} className="inline-flex h-10 items-center gap-2 rounded-xl bg-elev/[0.07] px-4 text-[14px] text-ink-100 hover:bg-elev/[0.12]">
            <Search size={15} /> Search <kbd className="rounded border border-elev/15 px-1.5 font-mono text-[11px] text-ink-400">Ctrl K</kbd>
          </button>
        </div>
      </section>

      <h2 className="m-0 mb-3 mt-10 font-serif text-[22px] font-normal text-ink-50">Start with</h2>
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
        {start.map((p, i) => (
          <li key={p.slug}>
            <DocLink href={docsHref(p.slug)} className="flex h-full flex-col gap-1 rounded-2xl bg-card p-4 no-underline transition-colors hover:bg-sunk" data-testid="docs-start">
              <span className="flex items-center gap-2 text-[15px] font-medium text-ink-50">
                <span className={clsx('h-2 w-2 rounded-full', TIER_DOT[i % 3])} aria-hidden="true" />{p.title}
              </span>
              <span className="text-[13.5px] leading-snug text-ink-300"><Inline text={p.summary} /></span>
            </DocLink>
          </li>
        ))}
      </ul>

      <h2 className="m-0 mb-3 mt-10 font-serif text-[22px] font-normal text-ink-50">Everything else</h2>
      <div className="grid grid-cols-1 gap-x-8 gap-y-7 sm:grid-cols-2">
        {SECTIONS.map((s, i) => (
          <section key={s.id} aria-labelledby={`home-${s.id}`}>
            <h3 id={`home-${s.id}`} className="m-0 flex items-center gap-2 text-[15px] font-semibold text-ink-50">
              <span className={clsx('h-2 w-2 rounded-full', TIER_DOT[i % 3])} aria-hidden="true" />{s.title}
            </h3>
            <p className="m-0 mb-2 mt-1 text-[13.5px] leading-snug text-ink-400">{s.blurb}</p>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[14px]">
              {pagesIn(s.id).map((p) => (
                <li key={p.slug}><DocLink href={docsHref(p.slug)} className="text-accent-400 no-underline hover:underline">{p.title}</DocLink></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-10 text-[13px] text-ink-500">{PAGES.length} pages.</p>
    </div>
  );
}

function NotFound({ slug, onSearch }: { slug: string; onSearch: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[640px] pt-10" data-testid="docs-missing">
      <h1 className="m-0 font-serif text-[34px] font-normal text-ink-50">That page is not here.</h1>
      <p className="mt-3 text-[16px] leading-relaxed text-ink-300">
        There is no docs page called <code className="rounded-md bg-sunk px-1.5 py-0.5 font-mono text-[0.9em]">{slug}</code>. Try the search, or start from the home page.
      </p>
      <div className="mt-5 flex gap-2.5">
        <button type="button" onClick={onSearch} className="cz-btn cz-btn-ghost"><Search size={15} /> Search</button>
        <DocLink href="/docs" className="cz-btn cz-btn-ghost no-underline">Docs home</DocLink>
      </div>
    </div>
  );
}

// ── "On this page" ───────────────────────────

function Toc({ page, scroller }: { page: DocPage; scroller: RefObject<HTMLDivElement | null> }) {
  const heads = useMemo(() => page.blocks.flatMap((b) => (b.t === 'h2' || b.t === 'h3' ? [b] : [])), [page]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    setActive(heads[0]?.id ?? null);
    if (typeof IntersectionObserver === 'undefined' || !heads.length) return;
    // The heading nearest the top of the reading area is the one being read.
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const first = heads.find((h) => seen.get(h.id));
      if (first) setActive(first.id);
    }, { root: scroller.current, rootMargin: '-72px 0px -68% 0px' });
    for (const h of heads) { const el = document.getElementById(h.id); if (el) io.observe(el); }
    return () => io.disconnect();
  }, [heads, scroller]);

  if (heads.length < 2) return null;
  return (
    <nav aria-label="On this page" className="text-[13px]">
      <p className="m-0 mb-2 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-400">On this page</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 border-l border-elev/10 p-0">
        {heads.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              onClick={(e) => { e.preventDefault(); window.history.replaceState(null, '', `#${h.id}`); document.getElementById(h.id)?.scrollIntoView?.({ block: 'start' }); setActive(h.id); }}
              aria-current={active === h.id ? 'location' : undefined}
              className={clsx(
                '-ml-px block border-l py-1 no-underline transition-colors',
                h.t === 'h3' ? 'pl-6' : 'pl-3',
                active === h.id ? 'border-accent-400 text-accent-400' : 'border-transparent text-ink-400 hover:text-ink-100',
              )}
            >{plainText(h.text)}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
