/**
 * The Cascade mark — three arcs falling, widest at the top.
 *
 * Used as the loading indicator in place of a generic spinning circle. The
 * arcs are the three tiers (T1 plans, T2 manages, T3 works) and they light in
 * that order, so the wait shows the shape of what is actually happening
 * instead of an anonymous rotation. Tier colours come from the theme, so the
 * mark matches the tier badges elsewhere in the run explorer.
 *
 * Static (`animate={false}`) it is just the logo — same geometry, so the brand
 * and the busy state are the same object rather than two things that resemble
 * each other. Kept byte-identical in geometry to the desktop's CascadeMark.
 */
export default function CascadeMark({
  size = 16,
  animate = true,
  title,
  className = '',
}: {
  size?: number;
  /** Off for a plain logo. On for "working…". */
  animate?: boolean;
  /** Accessible label. Omit inside a control that already names itself. */
  title?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`${animate ? 'cascade-mark ' : ''}shrink-0 overflow-visible ${className}`.trim()}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* Widest at the top, narrowing as work fans down the hierarchy. Round
          caps so the arcs read as flowing water rather than as brackets. */}
      <path d="M3.5 7.5 Q12 14.5 20.5 7.5" stroke="rgb(var(--c-t1))" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M6.25 12.5 Q12 17.75 17.75 12.5" stroke="rgb(var(--c-t2))" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M9 17.5 Q12 20.5 15 17.5" stroke="rgb(var(--c-t3))" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}
