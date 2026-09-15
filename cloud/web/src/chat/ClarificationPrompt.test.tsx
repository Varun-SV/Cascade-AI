// ─────────────────────────────────────────────
//  Cascade Cloud — the questionnaire
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
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

  it('asks one at a time and says how many are behind it', () => {
    // A queue nobody can see looks like a stuck run — the same rule the
    // approval prompt follows.
    render(
      <ClarificationPrompt
        clarifications={[ask(), ask({ requestId: 'req-2' }), ask({ requestId: 'req-3' })]}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByText(/2 more waiting/i)).toBeInTheDocument();
    expect(screen.getAllByText('Which account?'), 'one form, not three').toHaveLength(1);
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
