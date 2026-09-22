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
import { render, screen, fireEvent } from '@testing-library/react';
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
    expect(screen.getAllByRole('button', { name: /skip this section/i }), 'each answerable on its own').toHaveLength(3);
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
    expect(screen.getByText(/2 sections need your decision/i)).toBeInTheDocument();
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
    fireEvent.click(screen.getAllByRole('button', { name: /skip this section/i })[1]!);
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
    fireEvent.change(screen.getByLabelText('Guidance for Section alpha'), {
      target: { value: 'only the public repos' },
    });

    // The OTHER section's guidance button stays disabled — its box is empty.
    const guidanceButtons = screen.getAllByRole('button', { name: /retry with guidance/i });
    expect(guidanceButtons[1], 'beta has no draft of its own').toBeDisabled();

    fireEvent.click(guidanceButtons[0]!);
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
});
