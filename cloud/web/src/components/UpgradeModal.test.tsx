import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import UpgradeModal from './UpgradeModal.js';

type Json = Record<string, unknown> | null;

function mockApi(opts: { usage?: Json; billing?: Json }) {
  (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    const u = String(url);
    const respond = (data: Json) =>
      Promise.resolve({ ok: data !== null, status: data !== null ? 200 : 401, json: async () => data ?? { error: 'x' } });
    if (u.includes('/api/usage')) return respond(opts.usage ?? null);
    if (u.includes('/api/billing')) return respond(opts.billing ?? null);
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
}

describe('UpgradeModal', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { global.fetch = originalFetch; });

  it("shows the current plan and today's usage once loaded", async () => {
    mockApi({ usage: { plan: 'free', dailyRuns: 3, dailyRunLimit: 20, maxConcurrentRuns: 1 } });
    render(<UpgradeModal />);
    await waitFor(() => expect(screen.getByText(/3 \/ 20 runs used today/)).toBeInTheDocument());
  });

  it('shows "Coming soon" (disabled) when billing is not configured', async () => {
    mockApi({ billing: { configured: false, keyId: null, priceLabel: null, plan: 'free', status: null, currentEnd: null, hasSubscription: false } });
    render(<UpgradeModal />);
    await waitFor(() => expect(screen.getByText('Coming soon')).toBeDisabled());
  });

  it('shows a Subscribe button when billing is configured and the user is on free', async () => {
    mockApi({ billing: { configured: true, keyId: 'rzp_test', priceLabel: '₹499 / month', plan: 'free', status: null, currentEnd: null, hasSubscription: false } });
    render(<UpgradeModal />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Subscribe/ })).toBeInTheDocument());
    expect(screen.getByText('₹499 / month')).toBeInTheDocument();
  });

  it('shows Cancel + renews date when the user is on an active Pro subscription', async () => {
    mockApi({ billing: { configured: true, keyId: 'rzp_test', priceLabel: '₹499 / month', plan: 'pro', status: 'active', currentEnd: 1893456000, hasSubscription: true } });
    render(<UpgradeModal />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel subscription/ })).toBeInTheDocument());
  });

  it('always states the desktop app is free', async () => {
    mockApi({});
    render(<UpgradeModal />);
    expect(screen.getByText(/desktop app is free/i)).toBeInTheDocument();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
  });
});
