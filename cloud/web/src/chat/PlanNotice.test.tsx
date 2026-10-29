import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MotionConfig } from 'framer-motion';
import PlanNotice from './PlanNotice.js';

afterEach(cleanup);

const approval = {
  plan: { sections: [{ title: 'Research', t3Subtasks: [{}, {}] }, { title: 'Write', t3Subtasks: [{}] }] },
} as never;

// The tree draws itself by animating pathLength; framer shows the drawn share
// as the first number of stroke-dasharray ("0 1" = undrawn, "1 1" = complete).
const drawn = (container: HTMLElement) =>
  [...container.querySelectorAll('svg path')].map((p) => p.getAttribute('stroke-dasharray'));

describe('PlanNotice plan tree', () => {
  it('renders already grown when Settings → Reduce motion is on', () => {
    // App renders chat inside <MotionConfig reducedMotion="always"> for the saved setting.
    const { container } = render(<MotionConfig reducedMotion="always"><PlanNotice approval={approval} /></MotionConfig>);
    const paths = drawn(container);
    expect(paths).toHaveLength(2 + 3); // two branches, three worker stems
    expect(paths.every((d) => d === '1 1')).toBe(true);
    expect(container.querySelector('svg circle')?.getAttribute('style')).not.toContain('scale(0)');
  });

  it('grows from nothing when motion is allowed', () => {
    const { container } = render(<MotionConfig reducedMotion="never"><PlanNotice approval={approval} /></MotionConfig>);
    expect(drawn(container).every((d) => d === '0 1')).toBe(true);
  });
});

describe('PlanNotice draws only workers that exist', () => {
  it('gives a section with no subtasks no worker stems', () => {
    const noWorkers = {
      t3Count: 0,
      plan: { sections: [{ title: 'Research', t3Subtasks: [] }, { title: 'Write' }] },
    } as never;
    const { container, getByText } = render(<MotionConfig reducedMotion="always"><PlanNotice approval={noWorkers} /></MotionConfig>);
    // Two manager branches, zero stems — matching the summary's count.
    expect(container.querySelectorAll('svg path')).toHaveLength(2);
    expect(getByText('0 workers')).toBeInTheDocument();
  });
});
