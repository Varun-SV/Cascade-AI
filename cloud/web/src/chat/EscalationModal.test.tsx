// ─────────────────────────────────────────────
//  Cascade Cloud — the parked-section prompt
// ─────────────────────────────────────────────
//
//  These exist because this modal showed ONE parked section and counted the
//  rest. A Complex wave dispatches sections concurrently and each parks its own
//  five-minute timer the moment it asks, so the ones behind the first were not
//  being deferred — they were expiring, unseen, while somebody worked through
//  the prompt on top.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import EscalationModal from './EscalationModal.js';
import type { EscalationRequest } from './useChatSession.js';

const parked = (over: Partial<EscalationRequest> = {}): EscalationRequest => ({
  requestId: 'req-1',
  sectionId: 's1',
  sectionTitle: 'Section alpha',
  issues: ['worker was unsure'],
  summary: 'partial work',
  timeoutMs: 300_000,
  receivedAt: Date.now(),
  ...over,
} as EscalationRequest);

const noop = () => {};

describe('EscalationModal', () => {
  it('shows nothing when no section is parked', () => {
    const { container } = render(
      <EscalationModal requests={[]} onResolve={noop} onDismiss={noop} onExpire={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows every parked section, because each is already counting down', () => {
    render(
      <EscalationModal
        requests={[
          parked(),
          parked({ requestId: 'req-2', sectionId: 's2', sectionTitle: 'Section beta' }),
          parked({ requestId: 'req-3', sectionId: 's3', sectionTitle: 'Section gamma' }),
        ]}
        onResolve={noop}
        onDismiss={noop}
        onExpire={noop}
      />,
    );
    expect(screen.getByText('Section alpha')).toBeInTheDocument();
    expect(screen.getByText('Section beta')).toBeInTheDocument();
    expect(screen.getByText('Section gamma')).toBeInTheDocument();
    expect(screen.getAllByRole('radio', { name: /^Skip/ }), 'each answerable on its own').toHaveLength(3);
  });

  it('says how many are waiting in the title, rather than hiding the count', () => {
    render(
      <EscalationModal
        requests={[parked(), parked({ requestId: 'req-2', sectionId: 's2' })]}
        onResolve={noop}
        onDismiss={noop}
        onExpire={noop}
      />,
    );
    expect(screen.getByText(/2 sections paused for your decision/i)).toBeInTheDocument();
  });

  it('answers the section whose button was pressed, not the first on screen', () => {
    // Routing by position would apply one section's decision to another. The
    // key is what makes the answer land where it was aimed.
    const onResolve = vi.fn();
    render(
      <EscalationModal
        requests={[parked(), parked({ requestId: 'req-2', sectionId: 's2', sectionTitle: 'Section beta' })]}
        onResolve={onResolve}
        onDismiss={noop}
        onExpire={noop}
      />,
    );
    const beta = screen.getByRole('region', { name: 'Section beta' });
    fireEvent.click(within(beta).getByRole('radio', { name: /^Skip/ }));
    fireEvent.click(within(beta).getByRole('button', { name: 'Skip and keep draft' }));
    expect(onResolve).toHaveBeenCalledWith('skip', undefined, 'req-2');
  });

  it("keeps each section's guidance to itself", () => {
    // The guidance box is free text meant for specific work. Shared between
    // two prompts it would send one section's instructions to another — and
    // since both boxes look identical, nothing would look wrong.
    const onResolve = vi.fn();
    render(
      <EscalationModal
        requests={[parked(), parked({ requestId: 'req-2', sectionId: 's2', sectionTitle: 'Section beta' })]}
        onResolve={onResolve}
        onDismiss={noop}
        onExpire={noop}
      />,
    );
    const alpha = screen.getByRole('region', { name: 'Section alpha' });
    const beta = screen.getByRole('region', { name: 'Section beta' });
    fireEvent.click(within(alpha).getByRole('radio', { name: /^Guide/ }));
    fireEvent.change(screen.getByLabelText('Notes for Section alpha'), {
      target: { value: 'only the public repos' },
    });

    // The OTHER section has no notes box and nothing chosen: nothing to send.
    expect(screen.queryByLabelText('Notes for Section beta')).not.toBeInTheDocument();
    expect(within(beta).getByRole('button', { name: 'Choose how to continue' }), 'beta has no answer of its own').toBeDisabled();

    fireEvent.click(within(alpha).getByRole('button', { name: 'Retry with notes' }));
    expect(onResolve).toHaveBeenCalledWith('guidance', 'only the public repos', 'req-1');
  });

  it('reports an expiry against the section that expired', () => {
    // An older section's deadline must not clear a newer prompt somebody is
    // mid-answer on — which is what dropping "the first" would do now that
    // they are all on screen.
    const onExpire = vi.fn();
    render(
      <EscalationModal
        requests={[
          parked({ requestId: 'req-2', sectionId: 's2', timeoutMs: 300_000, receivedAt: Date.now() - 400_000 }),
        ]}
        onResolve={noop}
        onDismiss={noop}
        onExpire={onExpire}
      />,
    );
    expect(onExpire).toHaveBeenCalledWith('req-2');
  });

  it('keeps the sections in a bounded, scrollable region', () => {
    // Several full prompts are taller than a short viewport, and controls
    // clipped below the fold are unreachable — which fails the section exactly
    // as surely as never rendering it. The same lesson the questionnaire list
    // learned one round earlier.
    render(
      <EscalationModal
        requests={[parked(), parked({ requestId: 'req-2', sectionId: 's2', sectionTitle: 'Section beta' })]}
        onResolve={noop}
        onDismiss={noop}
        onExpire={noop}
      />,
    );
    const region = screen.getByText('Section alpha').closest('div[class*="overflow-y-auto"]');
    expect(region, 'bounded and scrollable').not.toBeNull();
    expect(region?.className).toMatch(/max-h-/);
  });

  // The prompt opened with a section TITLE and the failure, and nothing else.
  // "Main Task" names the work no better than "Section 3" does, so the person
  // was asked to choose between retrying, re-guiding and skipping without
  // being told what any of the three would be doing.
  it('says what the section was asked to do, not just what it is called', () => {
    render(
      <EscalationModal
        requests={[parked({ goal: 'Log in and probe the chatbot for prompt leakage' })]}
        onResolve={noop}
        onDismiss={noop}
        onExpire={noop}
      />,
    );
    expect(screen.getByText('Log in and probe the chatbot for prompt leakage')).toBeInTheDocument();
  });

  it('shows the work it already has, because that is what Skip keeps', () => {
    // The server has always sent this and the web modal dropped it — so the
    // one control that PRESERVES the partial output was offered without
    // showing the person what they would be preserving.
    render(
      <EscalationModal
        requests={[parked({ summary: 'Logged in; captured two responses.' })]}
        onResolve={noop}
        onDismiss={noop}
        onExpire={noop}
      />,
    );
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText(/Logged in; captured two responses\./)).toBeInTheDocument();
    // The whole of it, on asking.
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getAllByText(/Logged in; captured two responses\./)).toHaveLength(2);
  });

  it('says what each choice does to the run', () => {
    // Three bare verbs left the difference between them to be guessed — and
    // the irreversible one (a retry replaces the partial work) read as the
    // safest of the three.
    render(<EscalationModal requests={[parked()]} onResolve={noop} onDismiss={noop} onExpire={noop} />);
    expect(screen.getByRole('radio', { name: /^Guide/ })).toHaveAccessibleName(/replaces the draft/i);
    // BOTH retries discard the draft, not only the guided one.
    expect(screen.getByRole('radio', { name: /^Retry/ })).toHaveAccessibleName(/same way\. replaces the draft/i);
    expect(screen.getByRole('radio', { name: /^Skip/ })).toHaveAccessibleName(/keep the draft/i);
  });

  it('omits a block it has nothing to put in, rather than showing an empty one', () => {
    render(
      <EscalationModal
        requests={[parked({ goal: undefined, summary: '   ' })]}
        onResolve={noop}
        onDismiss={noop}
        onExpire={noop}
      />,
    );
    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View' })).not.toBeInTheDocument();
  });

  describe('the cascade card', () => {
    it('says where in the plan it stopped, and which checks failed', () => {
      render(
        <EscalationModal
          requests={[parked({ position: { index: 2, of: 4 }, issues: ['Initial check failed: completeness, compliance', 'Ran out of time'] })]}
          onResolve={noop}
          onDismiss={noop}
          onExpire={noop}
        />,
      );
      const path = screen.getByRole('navigation', { name: 'Where in the run' });
      expect(path).toHaveTextContent(/Plan.*Section 2 of 4.*Review/);
      const failed = screen.getByRole('list', { name: 'Failed checks' });
      expect(within(failed).getAllByRole('listitem').map((li) => li.textContent?.replace('✕', '').trim())).toEqual(['completeness', 'compliance']);
      expect(screen.getByText('Ran out of time')).toBeInTheDocument();
    });

    it('nothing is sent until a choice is made; a guided retry needs notes', () => {
      const onResolve = vi.fn();
      render(<EscalationModal requests={[parked()]} onResolve={onResolve} onDismiss={noop} onExpire={noop} />);
      expect(screen.getByRole('button', { name: 'Choose how to continue' })).toBeDisabled();
      fireEvent.click(screen.getByRole('radio', { name: /^Guide/ }));
      expect(screen.getByRole('button', { name: 'Retry with notes' })).toBeDisabled();
      fireEvent.click(screen.getByRole('radio', { name: /^Retry/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Retry as-is' }));
      expect(onResolve).toHaveBeenCalledWith('retry', undefined, 'req-1');
    });

    it('G, R and S choose, and Enter confirms, when one section is asking; never while typing notes', () => {
      const onResolve = vi.fn();
      render(<EscalationModal requests={[parked()]} onResolve={onResolve} onDismiss={noop} onExpire={noop} />);
      fireEvent.keyDown(window, { key: 'g' });
      expect(screen.getByRole('radio', { name: /^Guide/ })).toHaveAttribute('aria-checked', 'true');
      const notes = screen.getByLabelText('Notes for Section alpha');
      fireEvent.change(notes, { target: { value: 'keep it short' } });
      fireEvent.keyDown(notes, { key: 's' });
      expect(screen.getByRole('radio', { name: /^Guide/ }), 'a letter in the notes is a letter').toHaveAttribute('aria-checked', 'true');
      fireEvent.keyDown(notes, { key: 'Enter', ctrlKey: true });
      expect(onResolve).toHaveBeenCalledWith('guidance', 'keep it short', 'req-1');
    });

    it('the time left drains along the top', () => {
      render(
        <EscalationModal
          requests={[parked({ timeoutMs: 300_000, receivedAt: Date.now() - 150_000 })]}
          onResolve={noop}
          onDismiss={noop}
          onExpire={noop}
        />,
      );
      const bar = screen.getByRole('progressbar', { name: 'Time left for Section alpha' });
      expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(49);
      expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(51);
      expect(screen.getByText(/auto-fails in 2:30/)).toBeInTheDocument();
    });
  });

  it('Enter on a focused button is that button\'s, not a confirm (Codex on 8bf614b)', () => {
    const onResolve = vi.fn();
    render(<EscalationModal requests={[parked({ summary: 'Logged in.' })]} onResolve={onResolve} onDismiss={noop} onExpire={noop} />);
    fireEvent.keyDown(window, { key: 'r' });
    const view = screen.getByRole('button', { name: 'View' });
    fireEvent.keyDown(view, { key: 'Enter' });
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('radio', { name: /^Skip/ }), { key: 'Enter' });
    expect(onResolve).not.toHaveBeenCalled();
    // With nothing interactive focused, Enter confirms what was chosen.
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onResolve).toHaveBeenCalledWith('retry', undefined, 'req-1');
  });
});
