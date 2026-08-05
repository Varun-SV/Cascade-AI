import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TIER_COLORS } from '../lib/brand.js';

/**
 * The spine: a vertical line the page hangs from, with a node per tracked
 * section that lights as that section scrolls into view.
 *
 * This is the device that makes the page itself cascade rather than merely
 * describing a cascade. The old landing said "three tiers" in a row of three
 * equal, centred cards — the layout of any SaaS page with the word applied on
 * top. Here the colour walks azure → sky → teal down the page and the content
 * steps rightward with it, so the structure of the product is the structure of
 * the page.
 *
 * Node positions are MEASURED from the real sections rather than spaced evenly.
 * Even spacing quietly assumes every section is the same height, and these are
 * not remotely: `tiers` is three stacked cards, `surfaces` is a single row. The
 * result was a spine whose markers sat next to nothing in particular, with the
 * last one pinned to the bottom of the container instead of beside the heading
 * it stood for — a diagram of the page's structure that disagreed with the page.
 *
 * Progress uses IntersectionObserver rather than a scroll handler: scroll
 * listeners fire on every frame and force layout reads, which on a long
 * marketing page is the difference between smooth and janky on a mid-range
 * phone.
 */

interface Props {
  /** Ids of the sections the spine tracks, top to bottom. */
  sectionIds: readonly string[];
  /** Respect the user's motion preference; static when reduced. */
  reduced: boolean;
}

export default function CascadeSpine({ sectionIds, reduced }: Props) {
  const [active, setActive] = useState(0);
  /** Each section's centre, as a % of the rail's height. */
  const [offsets, setOffsets] = useState<number[]>([]);
  const railRef = useRef<HTMLDivElement>(null);

  /**
   * Measure where each tracked section actually sits. Re-runs on resize and
   * whenever a section changes height (fonts loading, text reflowing at a
   * breakpoint), so the markers keep pointing at their content.
   */
  const measure = useCallback(() => {
    const rail = railRef.current;
    const parent = rail?.parentElement;
    if (!rail || !parent) return;

    const parentTop = parent.getBoundingClientRect().top;
    const parentHeight = parent.getBoundingClientRect().height;
    if (parentHeight <= 0) return;

    const next = sectionIds.map((id) => {
      const el = document.getElementById(id);
      if (!el) return 0;
      const box = el.getBoundingClientRect();
      // Anchor to the section's heading area rather than its middle: the node
      // should sit beside the title you are reading, not floating in the body.
      const anchor = box.top - parentTop + Math.min(48, box.height / 2);
      return Math.max(0, Math.min(100, (anchor / parentHeight) * 100));
    });
    setOffsets(next);
  }, [sectionIds]);

  // Layout effect so the first paint already has real positions — measuring in
  // a passive effect would show one frame of evenly-spaced markers first.
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    const parent = railRef.current?.parentElement;
    if (parent) observer.observe(parent);
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, sectionIds]);

  useEffect(() => {
    if (reduced) { setActive(sectionIds.length - 1); return; }

    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (!elements.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = elements.indexOf(entry.target as HTMLElement);
          // Only ever advance. Scrolling back up shouldn't un-light the spine —
          // the cascade is a story about what has happened, not a cursor.
          if (index >= 0) setActive((current) => Math.max(current, index));
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [sectionIds, reduced]);

  // The fill reaches the active section's own node, so line and marker agree.
  const fillTo = offsets.length ? (offsets[Math.min(active, offsets.length - 1)] ?? 0) : 0;

  return (
    <div
      ref={railRef}
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-4 hidden w-px lg:block"
      style={{ background: 'rgb(var(--c-elev) / 0.12)' }}
    >
      {/* Height is the only animated property — heights on a 1px element are
          cheap; gradients recalculated per frame are not. */}
      <div
        className="absolute inset-x-0 top-0 origin-top"
        style={{
          height: `${fillTo}%`,
          background: `linear-gradient(to bottom, ${TIER_COLORS[0]}, ${TIER_COLORS[1]}, ${TIER_COLORS[2]})`,
          transition: reduced ? undefined : 'height 700ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
      {sectionIds.map((id, i) => {
        const reached = i <= active;
        const color = TIER_COLORS[Math.min(i, TIER_COLORS.length - 1)];
        return (
          <span
            key={id}
            className="absolute -left-[5px] block h-[11px] w-[11px] rounded-full border-2"
            style={{
              top: `${offsets[i] ?? 0}%`,
              borderColor: reached ? color : 'rgb(var(--c-elev) / 0.25)',
              background: reached ? color : 'rgb(var(--c-ink-900))',
              boxShadow: reached ? `0 0 14px ${color}66` : undefined,
              transition: reduced ? undefined : 'all 420ms ease',
            }}
          />
        );
      })}
    </div>
  );
}
