import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { StatusBar } from './StatusBar.js';
import { CostTracker } from './CostTracker.js';
import { getTheme } from '../../themes/index.js';
import { unpricedByModel } from '../index.js';

const theme = getTheme('cascade');
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function frame(el: React.ReactElement, columns: number): string {
  let out = '';
  const stdout = Object.assign(new EventEmitter(), { columns, rows: 40, isTTY: true, write: (s: string) => { if (s.includes('$')) out = s; return true; } });
  const app = render(el, { stdout: stdout as never, debug: true, patchConsole: false });
  app.unmount();
  return plain(out);
}

describe('spend Cascade could not price', () => {
  // The run that prompted this: $8.51 held still while tokens kept rising, because
  // later calls went to a model with no known price and were added as $0.
  const bar = (unpricedCalls: number, columns = 140) => frame(React.createElement(StatusBar, {
    theme, tierModels: {}, tokens: 11_800_000, costUsd: 8.51, workspacePath: '/w', isExecuting: true, unpricedCalls,
  }), columns);

  it('the status bar marks the cost as partial, and says how many calls it leaves out', () => {
    expect(bar(42)).toContain('$8.51+ · 42 calls not priced · 11.8M tok');
  });

  it('on a narrow terminal, the mark alone', () => {
    const f = bar(42, 90);
    expect(f).toContain('$8.51+ · 11.8M tok');
    expect(f).not.toContain('not priced');
  });

  it('control: with every call priced, the cost is shown as it was', () => {
    expect(bar(0)).toContain('$8.51 · 11.8M tok');
  });

  it('/cost names each model it could not price, with its calls', () => {
    const f = frame(React.createElement(CostTracker, {
      theme, totalTokens: 11_800_000, totalCostUsd: 8.51, callsByProvider: { gemini: 60 }, callsByTier: { T3: 60 },
      unpricedByModel: { 'gemini:gemini-x-preview': 40, 'openai:gpt-y': 2 },
    }), 140);
    expect(f).toContain('$8.510000+');
    expect(f).toContain('Not counted: 42 calls to gemini:gemini-x-preview (40), openai:gpt-y (2), which have no known price');
  });

  it('calls per model, summed over the tiers that made them', () => {
    expect(unpricedByModel({ T2: { 'g:x': 3, 'a:p': 0 }, T3: { 'g:x': 4, 'o:y': 1 } })).toEqual({ 'g:x': 7, 'o:y': 1 });
    expect(unpricedByModel(undefined)).toEqual({});
  });
});
