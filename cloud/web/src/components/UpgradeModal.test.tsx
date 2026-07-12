import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import UpgradeModal from './UpgradeModal.js';

describe('UpgradeModal', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows the current plan and today\'s usage once loaded', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ plan: 'free', dailyRuns: 3, dailyRunLimit: 20, maxConcurrentRuns: 1 }),
    });

    render(<UpgradeModal />);
    await waitFor(() => expect(screen.getByText(/3 \/ 20 runs used today/)).toBeInTheDocument());
    expect(screen.getByText('free')).toBeInTheDocument();
  });

  it('always shows the Pro plan as "Coming soon" and its button disabled', () => {
    render(<UpgradeModal />);
    const proButton = screen.getByText('Coming soon');
    expect(proButton).toBeDisabled();
  });

  it('renders without crashing when the usage fetch fails', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'Not signed in' }) });
    render(<UpgradeModal />);
    // No usage line renders, but the static plan comparison still does.
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
  });
});
