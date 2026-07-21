import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import Message from './Message.js';
import type { ChatMessage } from './useChatSession.js';

const base = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm2', role: 'user', content: 'hello', ...over,
});

describe('Message — branching affordances', () => {
  it('shows the < n/m > navigator only when a message has siblings, and steps between them', () => {
    const onSelectSibling = vi.fn();
    render(
      <Message
        message={base({ id: 'm2', siblingIds: ['m1', 'm2'] })}
        onSelectSibling={onSelectSibling}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    // 2 of 2, since m2 is the second sibling.
    expect(screen.getByText('2/2')).toBeInTheDocument();
    // Prev jumps to the earlier sibling; there is no next.
    fireEvent.click(screen.getByLabelText('Previous version'));
    expect(onSelectSibling).toHaveBeenCalledWith('m1');
    expect(screen.getByLabelText('Next version')).toBeDisabled();
  });

  it('hides the navigator for a lone message', () => {
    render(<Message message={base({ siblingIds: ['m2'] })} onSelectSibling={() => {}} onEdit={() => {}} />);
    expect(screen.queryByText(/\/\d/)).not.toBeInTheDocument();
  });

  it('editing a user turn opens an editor and submits the new text', () => {
    const onEdit = vi.fn();
    render(<Message message={base({ content: 'original' })} onEdit={onEdit} onDelete={() => {}} />);
    fireEvent.click(screen.getByLabelText('Edit'));
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.value).toBe('original');
    fireEvent.change(box, { target: { value: 'revised' } });
    fireEvent.click(screen.getByText('Save & submit'));
    expect(onEdit).toHaveBeenCalledWith('revised');
  });

  it('delete fires the subtree-delete callback', () => {
    const onDelete = vi.fn();
    render(<Message message={base({})} onEdit={() => {}} onDelete={onDelete} />);
    fireEvent.click(screen.getByLabelText('Delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('an assistant reply offers regenerate + delete', () => {
    const onRegenerate = vi.fn();
    render(
      <Message
        message={base({ id: 'a1', role: 'assistant', content: 'an answer' })}
        onRegenerate={onRegenerate}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('Regenerate'));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Delete')).toBeInTheDocument();
  });
});
