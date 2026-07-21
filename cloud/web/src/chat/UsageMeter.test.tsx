import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import UsageMeter from './UsageMeter.js';

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ dailyRuns: 8, dailyRunLimit: 20 }),
  }) as unknown as typeof fetch;
});

describe('UsageMeter — context vs model window', () => {
  it('shows the conversation size against the model window, not run throughput', async () => {
    render(<UsageMeter contextTokens={30_000} contextWindow={400_000} lastRunTokens={539_947} refreshSignal={0} />);
    // Context reads as conversation size / window — small chat, big window.
    await waitFor(() => expect(screen.getByText(/~30k \/ 400k tok/)).toBeInTheDocument());
    // A 30k conversation in a 400k window is NOT "full" — no warning.
    expect(screen.queryByText(/filling the model's window/i)).not.toBeInTheDocument();
    // The heavy run's throughput is shown separately, clearly labelled.
    expect(screen.getByText(/Last run used ~540k tok across all tiers/)).toBeInTheDocument();
  });

  it('warns only when the conversation itself approaches the window', async () => {
    render(<UsageMeter contextTokens={370_000} contextWindow={400_000} refreshSignal={1} />);
    await waitFor(() => expect(screen.getByText(/filling the model's window/i)).toBeInTheDocument());
  });

  it('renders a context figure with no last run (i.e. after a refresh)', async () => {
    // contextTokens comes from the loaded messages, so it survives a reload even
    // when there is no last-run throughput to show.
    render(<UsageMeter contextTokens={12_000} contextWindow={200_000} refreshSignal={2} />);
    await waitFor(() => expect(screen.getByText(/~12k \/ 200k tok/)).toBeInTheDocument());
    expect(screen.queryByText(/Last run used/)).not.toBeInTheDocument();
  });
});
