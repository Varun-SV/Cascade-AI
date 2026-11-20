import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LeaderboardSection from './LeaderboardSection.js';
import type { Leaderboard } from '../lib/leaderboard.js';

const row = (model: string, extra: Record<string, unknown> = {}) => ({
  rank: 1, model, runs: 420, successRate: 0.94, score: 0.93, low: 0.91, high: 0.95, confidence: 'high', avgCostUsd: 0.012, avgRetries: 0.1, ...extra,
});
const board: Leaderboard = {
  generatedAt: '2026-11-20T10:00:00Z', totalRuns: 12_400, models: 9,
  tasks: {
    code: [row('claude-sonnet-5-5', { benchmark: 96, trend7d: 1.4 }) as never, row('old-model', { rank: 2, inactive: true, lastRun: '2026-09-01' }) as never],
    analysis: [], creative: [row('gpt-6.2', { runs: 12, confidence: 'low' }) as never], data: [], mixed: [],
  },
};

afterEach(() => vi.unstubAllGlobals());
const serve = (body: unknown, ok = true) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body })));

describe('LeaderboardSection', () => {
  it('shows the measured ranking, the published benchmark beside it, and inactive models kept', async () => {
    serve(board);
    render(<LeaderboardSection h2="" />);
    expect(await screen.findByText('claude-sonnet-5-5')).toBeTruthy();
    expect(screen.getByText(/12k runs across 9 models/)).toBeTruthy();
    expect(screen.getByText('96')).toBeTruthy();
    expect(screen.getByTitle('Last run 2026-09-01').textContent).toBe('inactive');
    expect(screen.getAllByText('91%').length).toBeGreaterThan(0);
  });

  it('switches kind of task, and says when one has nothing ranked yet', async () => {
    serve(board);
    render(<LeaderboardSection h2="" />);
    await screen.findByText('claude-sonnet-5-5');
    fireEvent.click(screen.getByRole('tab', { name: /Writing/ }));
    expect(screen.getByText('gpt-6.2')).toBeTruthy();
    expect(screen.getByText('low confidence')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Data/ }));
    expect(screen.getByText(/No model has enough runs of this kind yet/)).toBeTruthy();
  });

  it('says so when it cannot load', async () => {
    serve({}, false);
    render(<LeaderboardSection h2="" />);
    await waitFor(() => expect(screen.getByText(/couldn't be loaded/)).toBeTruthy());
  });

  it('explains how it scores, including that no prompt or answer is in it', async () => {
    serve(board);
    render(<LeaderboardSection h2="" />);
    expect(screen.getByText('How we score')).toBeTruthy();
    expect(screen.getByText(/No prompt, answer or account is stored in it/)).toBeTruthy();
  });
});
