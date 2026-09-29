import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';

/**
 * One row of a popover menu.
 *
 * - `action` runs and closes the menu.
 * - `radio` and `toggle` change a setting and leave the menu open, so several
 *   can be set in one visit (routing, then tier, then Fast answer).
 * - `label` and `separator` group rows; `custom` renders a block (the usage
 *   gauges in the account menu).
 */
export type MenuItem =
  | { kind: 'action'; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | { kind: 'radio'; label: string; sub?: string; checked: boolean; onSelect: () => void; disabled?: boolean }
  | { kind: 'toggle'; label: string; sub?: string; icon?: ReactNode; checked: boolean; onToggle: () => void; disabled?: boolean; title?: string }
  | { kind: 'label'; label: string }
  | { kind: 'separator' }
  | { kind: 'custom'; key: string; render: ReactNode };

interface Props {
  /** The button that opened the menu. Placement follows it; clicks on it are left to its own handler. */
  anchor: HTMLElement;
  items: MenuItem[];
  onClose: () => void;
  /** Accessible name for the menu. */
  label: string;
}

const MARGIN = 8;

/**
 * The calm-direction popover: a card below its button (or above it when there
 * is no room, as for the composer's menus), rendered into <body> so no
 * overflow-hidden ancestor clips it.
 */
export default function Menu({ anchor, items, onClose, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = Math.min(Math.max(MARGIN, r.left), window.innerWidth - w - MARGIN);
    let y = r.bottom + 6;
    if (y + h > window.innerHeight - MARGIN) y = Math.max(MARGIN, r.top - h - 6);
    setPos({ x, y });
  }, [anchor, items]);

  // Focus the first row on open so the keyboard can drive it at once.
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])');
    first?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    // A resize moves the anchor out from under the card; the prototype closes rather than chase it.
    const onResize = () => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  function onKeyDown(e: React.KeyboardEvent) {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); rows[(n + rows.length) % rows.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); anchor.focus(); }
    else if (e.key === 'Tab') onClose();
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="cz-menu"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      {items.map((it, i) => {
        if (it.kind === 'separator') return <div key={`s${i}`} className="my-[5px] mx-1.5 h-px bg-elev/10" />;
        if (it.kind === 'label') return <div key={`l${i}`} className="px-[9px] pb-[3px] pt-2 text-[11.5px] font-medium text-ink-500">{it.label}</div>;
        if (it.kind === 'custom') return <div key={it.key}>{it.render}</div>;
        if (it.kind === 'action') {
          return (
            <button
              key={`a${i}`}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { onClose(); it.onSelect(); }}
              className={`cz-mi ${it.danger ? 'text-danger-300' : ''}`}
            >
              {it.icon && <span className="flex shrink-0 text-ink-300">{it.icon}</span>}
              <span className="min-w-0 flex-1">{it.label}</span>
            </button>
          );
        }
        if (it.kind === 'radio') {
          return (
            <button
              key={`r${i}`}
              type="button"
              role="menuitemradio"
              aria-checked={it.checked}
              disabled={it.disabled}
              onClick={it.onSelect}
              className="cz-mi"
            >
              <span className="min-w-0 flex-1">
                {it.label}
                {it.sub && <span className="block text-[12px] text-ink-500">{it.sub}</span>}
              </span>
              {it.checked && <Check size={14} className="shrink-0 text-accent-500" />}
            </button>
          );
        }
        return (
          <button
            key={`t${i}`}
            type="button"
            role="menuitemcheckbox"
            aria-checked={it.checked}
            disabled={it.disabled}
            title={it.title}
            onClick={it.onToggle}
            className="cz-mi"
          >
            {it.icon && <span className="flex shrink-0 text-ink-300">{it.icon}</span>}
            <span className="min-w-0 flex-1">
              {it.label}
              {it.sub && <span className="block text-[12px] text-ink-500">{it.sub}</span>}
            </span>
            <span className="cz-switch pointer-events-none origin-right scale-[0.85]" aria-hidden="true" data-on={it.checked} />
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
