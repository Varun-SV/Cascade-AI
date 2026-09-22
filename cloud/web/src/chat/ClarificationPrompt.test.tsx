// ─────────────────────────────────────────────
//  Cascade Cloud — the questionnaire
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ClarificationPrompt } from './ClarificationPrompt.js';
import type { ClarificationRequest } from './useChatSession.js';

const ask = (over: Partial<ClarificationRequest> = {}): ClarificationRequest => ({
  requestId: 'req-1',
  questions: [
    { id: 'q1', prompt: 'Which account?', kind: 'choice', options: ['Personal', 'Work'] },
    { id: 'q2', prompt: 'Include which?', kind: 'multi', options: ['Drafts', 'Archived'] },
    { id: 'q3', prompt: 'Anything else?', kind: 'text' },
  ],
  ...over,
});

describe('ClarificationPrompt', () => {
  it('shows nothing when nothing is being asked', () => {
    const { container } = render(<ClarificationPrompt clarifications={[]} onAnswer={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('asks every question in the one form', () => {
    // The point of a questionnaire over one question per turn: three round
    // trips read as an interrogation, one form reads as a thing to finish.
    render(<ClarificationPrompt clarifications={[ask()]} onAnswer={() => {}} />);
    expect(screen.getByText('Which account?')).toBeInTheDocument();
    expect(screen.getByText('Include which?')).toBeInTheDocument();
    expect(screen.getByText('Anything else?')).toBeInTheDocument();
  });

  it('sends one selection, several selections, and typed text together', () => {
    const onAnswer = vi.fn();
    render(<ClarificationPrompt clarifications={[ask()]} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.change(screen.getByLabelText('Anything else?'), { target: { value: 'last 30 days' } });
    fireEvent.click(screen.getByRole('button', { name: /send answers/i }));

    expect(onAnswer).toHaveBeenCalledWith('req-1', [
      { id: 'q1', value: 'Personal' },
      { id: 'q2', value: ['Drafts', 'Archived'] },
      { id: 'q3', value: 'last 30 days' },
    ]);
  });

  it('replaces a single choice rather than accumulating one', () => {
    const onAnswer = vi.fn();
    render(<ClarificationPrompt clarifications={[ask()]} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    fireEvent.click(screen.getByRole('button', { name: /send answers/i }));

    expect(onAnswer).toHaveBeenCalledWith('req-1', [{ id: 'q1', value: 'Work' }]);
  });

  it('unticks a multi-select option that is clicked again', () => {
    const onAnswer = vi.fn();
    render(<ClarificationPrompt clarifications={[ask()]} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));
    fireEvent.click(screen.getByRole('button', { name: /send answers/i }));

    expect(onAnswer).toHaveBeenCalledWith('req-1', [{ id: 'q2', value: ['Archived'] }]);
  });

  it('leaves an untouched question out instead of sending a blank', () => {
    // A blank string reads as an answer once it reaches the model. Omitting it
    // is what keeps "(no answer given)" honest.
    const onAnswer = vi.fn();
    render(<ClarificationPrompt clarifications={[ask()]} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
    fireEvent.change(screen.getByLabelText('Anything else?'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /send answers/i }));

    expect(onAnswer).toHaveBeenCalledWith('req-1', [{ id: 'q1', value: 'Personal' }]);
  });

  it('lets someone say they would rather not answer', () => {
    // Without this the only way to decline is to wait out a two-minute gate
    // with the run blocked the whole time. An empty set is read as a
    // deliberate skip, distinct from never having replied.
    const onAnswer = vi.fn();
    render(<ClarificationPrompt clarifications={[ask()]} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(onAnswer).toHaveBeenCalledWith('req-1', []);
  });

  it('shows every open question, because every one of them is already expiring', () => {
    // This test used to assert the opposite — one form, with "2 more waiting"
    // behind it. That was my rule, copied from the approval queue, and it was
    // wrong here for a reason the approval queue does not have: parallel
    // workers each call `ask_user`, and every request starts its two-minute
    // timer the moment it is asked, visible or not.
    //
    // So hiding the later ones did not defer them, it expired them. Somebody
    // answering the first form carefully could have two more time out behind
    // it, never knowing they had been asked, while the workers that asked went
    // ahead on assumptions with a person sitting right there.
    render(
      <ClarificationPrompt
        clarifications={[ask(), ask({ requestId: 'req-2' }), ask({ requestId: 'req-3' })]}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getAllByText('Which account?'), 'all three, not one').toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /send answers/i }), 'each answerable on its own').toHaveLength(3);
  });

  it('keeps the forms in a bounded, scrollable region', () => {
    // Rendering them all is not the same as making them reachable. The chat
    // panel is fixed-height with `overflow-hidden` above this, so on a short or
    // mobile viewport the later forms — and their Send and Skip buttons — are
    // clipped off the bottom. A form nobody can scroll to expires exactly like
    // a form nobody was shown, which is the failure showing them all was meant
    // to end.
    const { container } = render(
      <ClarificationPrompt
        clarifications={[ask(), ask({ requestId: 'req-2' }), ask({ requestId: 'req-3' })]}
        onAnswer={() => {}}
      />,
    );
    const region = container.firstElementChild;
    expect(region?.className, 'bounded').toMatch(/max-h-/);
    expect(region?.className, 'and scrollable within that bound').toMatch(/overflow-y-auto/);
  });

  it('answers the form that was filled in, not the first one on screen', () => {
    // The corollary of showing them all: `onAnswer` has to carry the request id
    // of the form that was submitted. Routing by position would answer the
    // oldest question with a later one's reply.
    const onAnswer = vi.fn();
    render(
      <ClarificationPrompt
        clarifications={[ask(), ask({ requestId: 'req-2' })]}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Work' })[1]!);
    fireEvent.click(screen.getAllByRole('button', { name: /send answers/i })[1]!);

    expect(onAnswer).toHaveBeenCalledWith('req-2', [{ id: 'q1', value: 'Work' }]);
  });

  it("keeps each form's draft to itself", () => {
    // They render together now, so a shared draft would put one person's answer
    // into another question — the ids are positional (`q1`), so it would not
    // even look wrong.
    const onAnswer = vi.fn();
    render(
      <ClarificationPrompt
        clarifications={[ask(), ask({ requestId: 'req-2' })]}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Personal' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: /send answers/i })[1]!);

    expect(onAnswer, 'the untouched form sends nothing').toHaveBeenCalledWith('req-2', []);
  });

  it('says how long is left, so a considered answer is not typed into a dead form', () => {
    // The gate is two minutes and the form said nothing about it. Somebody
    // thinking carefully about which account to pick could lose the lot with
    // no warning it was running out — and `timeoutMs` was being sent over the
    // wire and declared on the client the whole time, read by nobody.
    render(
      <ClarificationPrompt
        clarifications={[ask({ timeoutMs: 120_000, receivedAt: Date.now() })]}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByText(/2:00 left/)).toBeInTheDocument();
  });

  it('shows what is LEFT on a question inherited from before a reconnect', () => {
    // The server subtracts the elapsed time when it replays, so a page that
    // reconnects 90s into a two-minute gate is handed 30s, not 120s. Showing
    // the full gate here would promise time the run has no intention of
    // giving.
    render(
      <ClarificationPrompt
        clarifications={[ask({ timeoutMs: 30_000, receivedAt: Date.now() })]}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByText(/0:30 left/)).toBeInTheDocument();
  });

  it('says nothing about a deadline the run never stated', () => {
    // Inventing one would be a promise about what happens when it runs out
    // that nothing behind it intends to keep.
    render(<ClarificationPrompt clarifications={[ask()]} onAnswer={() => {}} />);
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });

  it('does not carry a draft from one questionnaire into the next', () => {
    // Question ids are positional (`q1`, `q2`), so an inherited answer does not
    // look stale — it looks like a reply to whatever now sits in that slot.
    const onAnswer = vi.fn();
    const view = render(<ClarificationPrompt clarifications={[ask()]} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }));

    view.rerender(
      <ClarificationPrompt
        clarifications={[{
          requestId: 'req-2',
          questions: [{ id: 'q1', prompt: 'Which folder?', kind: 'choice', options: ['Inbox', 'Sent'] }],
        }]}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /send answers/i }));

    expect(onAnswer, 'the new form starts empty').toHaveBeenLastCalledWith('req-2', []);
  });
});
