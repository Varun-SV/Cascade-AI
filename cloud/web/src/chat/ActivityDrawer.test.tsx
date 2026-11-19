import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MotionConfig } from 'framer-motion';
import ActivityDrawer from './ActivityDrawer.js';
import { mergeThinking, type ActivityNode } from './useChatSession.js';

afterEach(cleanup);

describe('mergeThinking', () => {
  it('appends streamed pieces and lets the finished call replace them', () => {
    let nodes: ActivityNode[] = [{ tierId: 'w1', role: 'T3', status: 'ACTIVE', order: 0 }];
    nodes = mergeThinking(nodes, { tierId: 'w1', call: 1, text: 'I should ', done: false });
    nodes = mergeThinking(nodes, { tierId: 'w1', call: 1, text: 'read it', done: false });
    expect(nodes[0]!.thinking).toBe('I should read it');
    nodes = mergeThinking(nodes, { tierId: 'w1', call: 1, text: 'I should read the file', done: true });
    nodes = mergeThinking(nodes, { tierId: 'w1', call: 2, text: 'Now write', done: false });
    expect(nodes[0]!.thinking).toBe('I should read the file\n\nNow write');
  });

  it('adds an agent it has not seen yet, and ignores an empty piece', () => {
    const nodes = mergeThinking([], { tierId: 't1', role: 't1', call: 1, text: 'plan', done: false });
    expect(nodes).toEqual([expect.objectContaining({ tierId: 't1', role: 'T1', thinking: 'plan', order: 0 })]);
    expect(mergeThinking(nodes, { tierId: 't1', call: 1, text: '', done: false })).toBe(nodes);
  });
});

describe('ActivityDrawer thinking', () => {
  it('folds each agent\'s thinking under its row until asked', () => {
    render(
      <MotionConfig reducedMotion="always">
        <ActivityDrawer activity={[
          { tierId: 'a', role: 'T1', label: 'Plan', status: 'COMPLETED', thinking: 'Split it in two.', order: 0 },
          { tierId: 'b', role: 'T3', label: 'Work', status: 'ACTIVE', thinking: 'Reading now', order: 1 },
          { tierId: 'c', role: 'T3', label: 'Quiet', status: 'ACTIVE', order: 2 },
        ]} />
      </MotionConfig>,
    );
    expect(screen.queryByText('Split it in two.')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /thought process/i }));
    expect(screen.getByText('Split it in two.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /thinking…/i })).toHaveAttribute('aria-expanded', 'false');
  });
});
