import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SpendChart, { axisLabels, fmtUsd, niceCeil, slotLabel, slotTitle } from './SpendChart.js';

afterEach(cleanup);

describe('the spend chart\'s helpers', () => {
  it('rounds the axis up to a clean number', () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(0.37)).toBe(0.5);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.2)).toBe(2);
    expect(niceCeil(2.1)).toBe(2.5);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(0.0031)).toBeCloseTo(0.005, 10);
  });

  it('shows cents, fractions of a cent when that is all there is, and whole dollars when large', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.0042)).toBe('$0.0042');
    expect(fmtUsd(1.5)).toBe('$1.50');
    expect(fmtUsd(12345.6)).toBe('$12,346');
  });

  it('labels a week in full, and a month about five times, always the last', () => {
    expect([...axisLabels(7, 'day').keys()]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const month = axisLabels(30, 'day');
    expect([...month.keys()]).toEqual([0, 6, 12, 18, 24, 29]);
    // On a narrow screen only the first, middle and last stay.
    expect([...month].filter(([, narrow]) => narrow).map(([i]) => i)).toEqual([0, 18, 29]);
    expect([...axisLabels(24, 'hour').keys()]).toEqual([0, 6, 12, 18, 23]);
    expect(axisLabels(0, 'day').size).toBe(0);
  });

  it('reads slot keys as local calendar values', () => {
    expect(slotLabel('2026-09-29 13', 'hour')).toBe('13:00');
    expect(slotTitle('2026-09-29 23', 'hour')).toBe('23:00–00:00');
    expect(slotTitle('2026-09-29', 'day')).toMatch(/29/);
    expect(slotLabel('2026-01', 'month')).toMatch(/Jan/);
  });
});

describe('SpendChart', () => {
  const series = [
    { key: '2026-09-27', spentUsd: 0, savedUsd: 0, runs: 0 },
    { key: '2026-09-28', spentUsd: 0.2, savedUsd: 0.6, runs: 2 },
    { key: '2026-09-29', spentUsd: 0.1, savedUsd: 0, runs: 1 },
  ];

  it('stacks what was saved on what was spent, against one scale', () => {
    const { container } = render(<SpendChart series={series} bucket="day" />);
    const slots = screen.getAllByTestId('spend-slot');
    expect(slots).toHaveLength(3);
    // An empty day draws nothing; a day with both draws two segments.
    expect(slots[0]!.querySelectorAll('span')).toHaveLength(0);
    const [saved, spent] = [...slots[1]!.querySelectorAll('span')] as HTMLElement[];
    expect(saved!.style.background).toBe('var(--chart-saved)');
    expect(spent!.style.background).toBe('var(--chart-spent)');
    // $0.80 of a $1 axis: 60% saved above 20% spent.
    expect(saved!.style.height).toBe('max(2px, 60%)');
    expect(spent!.style.height).toBe('max(2px, 20%)');
    expect(container).toHaveTextContent('$1.00');
  });

  it('shows a slot\'s figures on hover, and walks them with the arrow keys', () => {
    render(<SpendChart series={series} bucket="day" />);
    fireEvent.pointerEnter(screen.getAllByTestId('spend-slot')[1]!);
    expect(screen.getByRole('status')).toHaveTextContent('$0.20 spent');
    expect(screen.getByRole('status')).toHaveTextContent('$0.60 saved');
    expect(screen.getByRole('status')).toHaveTextContent('2 runs');

    const chart = screen.getByRole('group');
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('$0.10 spent');
    expect(screen.getByRole('status')).toHaveTextContent('1 run');
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(screen.getByRole('status')).toHaveTextContent('0 runs');
    fireEvent.blur(chart);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
