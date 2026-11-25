import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';
import { isDocsPath } from './route.js';

/** How a docs link moves around: set by DocsApp, so links never reload the page. */
export interface DocsNav {
  navigate: (url: string) => void;
}
export const DocsNavContext = createContext<DocsNav>({ navigate: (url) => { window.location.assign(url); } });

/**
 * A link. One into the docs navigates in place (a click with a modifier key,
 * or a middle click, still opens a new tab as a link should); anything else
 * is an ordinary link, and an off-site one opens in a new tab.
 */
export function DocLink({ href, className, children, onNavigate, ...rest }: {
  href: string;
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
  'aria-current'?: 'page';
  'data-testid'?: string;
}) {
  const { navigate } = useContext(DocsNavContext);
  const internal = href.startsWith('/docs') && isDocsPath(href.split(/[#?]/)[0]!);
  const external = /^https?:\/\//.test(href);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!internal || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
    onNavigate?.();
  };
  return (
    <a
      href={href}
      className={className}
      onClick={onClick}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...rest}
    >
      {children}
    </a>
  );
}

const LINK_CLASS = 'text-accent-400 underline decoration-accent-400/40 underline-offset-2 hover:decoration-accent-400';
const TOKEN = /(`[^`]+`|\*\*(?:[^*]|\*(?!\*))+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

/** `code`, **bold** and [label](href): the whole of the inline markup the docs use. */
export function Inline({ text }: { text: string }): ReactNode {
  const parts = text.split(TOKEN);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="rounded-md bg-sunk px-[0.4em] py-[0.12em] font-mono text-[0.86em] text-ink-50">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i} className="font-semibold text-ink-50"><Inline text={part.slice(2, -2)} /></strong>;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) return <DocLink key={i} href={link[2]!} className={LINK_CLASS}>{link[1]}</DocLink>;
    return part;
  });
}

/** Inline markup as plain text, for search and for page titles. */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*((?:[^*]|\*(?!\*))+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}
