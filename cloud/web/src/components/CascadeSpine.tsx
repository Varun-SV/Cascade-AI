import { useEffect, useRef, useState } from 'react';
import { TIER_COLORS } from '../lib/brand.js';

/**
 * The spine: a vertical line the page hangs from, with a node per tier that
 * lights as its section scrolls into view.
 *
 * This is the device that makes the page itself cascade rather than merely
 * describing a cascade. The old landing said "three tiers" in a row of three
 * equal, centred cards — the layout of any SaaS page with the word applied on
 * top. Here the colour walks azure → sky → teal down the page and the content
 * steps rightward with it, so the structure of the product is the structure of
 * the page.
 *
 * Progress is driven by IntersectionObserver rather than a scroll handler:
 * scroll listeners fire on every frame and force layout reads, which on a long
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
  const railRef = useRef<HTMLDivElement>(null);

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

  const filled = sectionIds.length > 1 ? active / (sectionIds.length - 1) : 1;

  return (
    <div
      ref={railRef}
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-4 hidden w-px lg:block"
      style={{ background: 'rgb(var(--c-elev) / 0.12)' }}
    >
      {/* The travelling fill. Height is the only animated property — transforms
          and heights on a 1px element are cheap; gradients recalculated per
          frame are not. */}
      <div
        className="absolute inset-x-0 top-0 origin-top"
        style={{
          height: `${filled * 100}%`,
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
              top: `${(i / Math.max(1, sectionIds.length - 1)) * 100}%`,
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
