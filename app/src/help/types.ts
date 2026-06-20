export interface TourStep {
  /** CSS selector for the element to highlight. */
  target: string;
  /** Tooltip body text shown for this step. */
  content: string;
  /** Preferred tooltip placement relative to the target. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
}
