import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ContinueModal from './ContinueModal.js';
import { createHandoff, fetchHandoff, importConversation } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  createHandoff: vi.fn(),
  fetchHandoff: vi.fn(),
  importConversation: vi.fn(),
}));

const mockCreate = vi.mocked(createHandoff);
const mockFetch = vi.mocked(fetchHandoff);
const mockImport = vi.mocked(importConversation);

const transcript = {
  title: 'A chat',
  skillId: 'general',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ],
};

describe('ContinueModal', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockFetch.mockReset();
    mockImport.mockReset();
  });

  it('generates a code from the current transcript and shows the countdown', async () => {
    mockCreate.mockResolvedValue({ code: 'ABCD-EFGH', expiresAt: Date.now() + 15 * 60 * 1000 });
    render(<ContinueModal transcript={transcript} onClose={() => {}} onRedeemed={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Create a code/ }));

    await waitFor(() => expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument());
    expect(screen.getByText(/expires in/)).toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledWith({ title: 'A chat', skillId: 'general', messages: transcript.messages });
  });

  it('nudges the user to open a chat first when there is nothing to send', () => {
    render(<ContinueModal transcript={null} onClose={() => {}} onRedeemed={() => {}} />);
    // No transcript ⇒ defaults to the receive tab; switch to send to see the hint.
    fireEvent.click(screen.getByRole('button', { name: /Send this chat/ }));
    expect(screen.getByText(/Open a chat/i)).toBeInTheDocument();
  });

  it('redeems a code into a new conversation and reports its id', async () => {
    mockFetch.mockResolvedValue({ title: 'Ported', skillId: null, messages: transcript.messages, expiresAt: Date.now() + 1000 });
    mockImport.mockResolvedValue({ conversation: { id: 'new-convo', title: 'Ported', skillId: null } });
    const onRedeemed = vi.fn();
    render(<ContinueModal transcript={null} onClose={() => {}} onRedeemed={onRedeemed} />);

    fireEvent.change(screen.getByPlaceholderText('XXXX-XXXX'), { target: { value: 'abcd-efgh' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue this chat/ }));

    await waitFor(() => expect(onRedeemed).toHaveBeenCalledWith('new-convo'));
    expect(mockFetch).toHaveBeenCalledWith('abcd-efgh');
    expect(mockImport).toHaveBeenCalledWith({ title: 'Ported', skillId: null, messages: transcript.messages });
  });

  it('surfaces an error for an invalid or expired code', async () => {
    mockFetch.mockRejectedValue(new Error('That code is invalid or has expired.'));
    render(<ContinueModal transcript={null} onClose={() => {}} onRedeemed={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('XXXX-XXXX'), { target: { value: 'ZZZZ-ZZZZ' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue this chat/ }));

    await waitFor(() => expect(screen.getByText(/invalid or has expired/)).toBeInTheDocument());
    expect(mockImport).not.toHaveBeenCalled();
  });
});
