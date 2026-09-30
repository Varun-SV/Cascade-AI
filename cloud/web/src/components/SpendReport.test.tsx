import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SpendReport as Report } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({ fetchSpendReport: vi.fn() }));
import { fetchSpendReport } from '../lib/api.js';
import SpendReport from './SpendReport.js';

const mocked = vi.mocked(fetchSpendReport);

function report(over: Partial<Report> = {}): Report {
  return {
    period: '30d',
    bucket: 'day',
    totals: { spentUsd: 0.64, savedUsd: 1.92, runs: 3, tokens: 12_300, failedRuns: 0, failedUsd: 0 },
    series: [
      { key: '2026-09-28', spentUsd: 0.4, savedUsd: 1.2, runs: 1 },
      { key: '2026-09-29', spentUsd: 0.24, savedUsd: 0.72, runs: 2 },
    ],
    tiers: [
      { tier: 'T1', spentUsd: 0.16, tokens: 2000, runs: 3, models: [{ model: 'anthropic:big', spentUsd: 0.16, tokens: 2000, runs: 3 }] },
      {
        tier: 'T3', spentUsd: 0.48, tokens: 10_300, runs: 3, models: [
          { model: 'openai:mini', spentUsd: 0.48, tokens: 9_000, runs: 3 },
          { model: 'ollama:llama', spentUsd: 0, tokens: 1_300, runs: 1 },
        ],
      },
    ],
    chats: [
      { conversationId: 'c1', title: 'Big report', spentUsd: 0.6, savedUsd: 1.8, runs: 2 },
      { conversationId: null, title: null, spentUsd: 0.04, savedUsd: 0.12, runs: 1 },
    ],
    ...over,
  };
}

beforeEach(() => mocked.mockReset());
afterEach(cleanup);

describe('SpendReport', () => {
  it('opens on the last 30 days: spent, saved, runs', async () => {
    mocked.mockResolvedValue(report());
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    expect(mocked).toHaveBeenCalledWith('30d');
    await screen.findByText('Spent and saved by day');
    expect(screen.getByText('$0.64')).toBeInTheDocument();
    expect(screen.getByText('$1.92')).toBeInTheDocument();
    expect(screen.getByText('75% less than all on T1')).toBeInTheDocument();
    expect(screen.getByText('12.3K tokens')).toBeInTheDocument();
    expect(screen.getAllByTestId('spend-slot')).toHaveLength(2);
  });

  it('asks for the period chosen, keeping the last one on screen until it arrives', async () => {
    mocked.mockResolvedValueOnce(report());
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    await screen.findByText('$0.64');
    let answer: (r: Report) => void = () => {};
    mocked.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(mocked).toHaveBeenLastCalledWith('7d');
    expect(screen.getByText('$0.64').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    answer(report({ period: '7d', totals: { ...report().totals, spentUsd: 0.25 } }));
    await screen.findByText('$0.25');
  });

  it('opens a tier onto the models that served it, and says when a model has no price', async () => {
    mocked.mockResolvedValue(report());
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    const t3 = await screen.findByRole('button', { name: /T3 · Worker/ });
    expect(screen.queryByText('openai:mini')).toBeNull();
    expect(t3).toHaveTextContent('75%');
    fireEvent.click(t3);
    expect(t3).toHaveAttribute('aria-expanded', 'true');
    const mini = screen.getByText('openai:mini').closest('li')!;
    expect(mini).toHaveTextContent('$0.48');
    expect(screen.getByText('ollama:llama').closest('li')!).toHaveTextContent('no price');
    expect(screen.getByText(/A model with no published price shows its tokens but no cost/)).toBeInTheDocument();
  });

  it('opens a chat from the list; deleted ones are counted together and not a link', async () => {
    mocked.mockResolvedValue(report());
    const onOpenChat = vi.fn();
    render(<SpendReport onClose={() => {}} onOpenChat={onOpenChat} />);
    fireEvent.click(await screen.findByRole('button', { name: /Big report/ }));
    expect(onOpenChat).toHaveBeenCalledWith('c1');
    const deleted = screen.getByText('Deleted chats');
    expect(deleted.closest('button')).toBeNull();
  });

  it('shows the same figures as a table', async () => {
    mocked.mockResolvedValue(report({ series: [...report().series, { key: '2026-09-30', spentUsd: 0, savedUsd: 0, runs: 0 }] }));
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Table' }));
    const table = screen.getByRole('table');
    // Days with no runs are left out.
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table).toHaveTextContent('$0.40');
    expect(screen.getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a single slot as a table, not a one-bar chart', async () => {
    mocked.mockResolvedValue(report({ period: 'all', series: [report().series[1]!] }));
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    await screen.findByRole('table');
    expect(screen.queryByTestId('spend-slot')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Table' })).toBeNull();
  });

  it('says what failed runs cost', async () => {
    mocked.mockResolvedValue(report({ totals: { ...report().totals, failedRuns: 2, failedUsd: 0.05 } }));
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    expect(await screen.findByText('Includes 2 runs that failed after spending $0.05.')).toBeInTheDocument();
  });

  it('gives no share of the spend when nothing had a price', async () => {
    mocked.mockResolvedValue(report({
      totals: { ...report().totals, spentUsd: 0 },
      tiers: [{ tier: 'T2', spentUsd: 0, tokens: 52, runs: 1, models: [{ model: 'openai-compatible:stub', spentUsd: 0, tokens: 52, runs: 1 }] }],
    }));
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    const t2 = await screen.findByRole('button', { name: /T2 · Manager/ });
    expect(t2).not.toHaveTextContent('%');
    expect(t2).toHaveTextContent('no price');
  });

  it('says so when a period has no runs', async () => {
    mocked.mockResolvedValue(report({ totals: { spentUsd: 0, savedUsd: 0, runs: 0, tokens: 0, failedRuns: 0, failedUsd: 0 }, tiers: [], chats: [] }));
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    expect(await screen.findByText('No runs in this period.')).toBeInTheDocument();
  });

  it('does not leave another period\'s figures up when a new one fails to load', async () => {
    mocked.mockResolvedValueOnce(report());
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    await screen.findByText('$0.64');
    mocked.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'All time' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('$0.64')).toBeNull();
  });

  it('says when it could not load, and tries again', async () => {
    mocked.mockRejectedValueOnce(new Error('offline'));
    render(<SpendReport onClose={() => {}} onOpenChat={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    mocked.mockResolvedValueOnce(report());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('$0.64');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
