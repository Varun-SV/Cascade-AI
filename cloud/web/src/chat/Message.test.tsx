import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import Message from './Message.js';
import { fetchPendingMedia, saveFile } from '../lib/api.js';
import { _resetPendingMediaForTests } from '../lib/pendingMedia.js';
import type { ChatMessage } from './useChatSession.js';

vi.mock('../lib/api.js', () => ({
  uploadUrl: (id: string) => `/api/uploads/${id}`,
  fileDownloadUrl: (id: string) => `/api/files/${id}`,
  saveFile: vi.fn(),
  setFeedback: vi.fn(),
  clearFeedback: vi.fn(),
  fetchPendingMedia: vi.fn(),
}));

const mockFetchPending = vi.mocked(fetchPendingMedia);
const mockSaveFile = vi.mocked(saveFile);

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
    fireEvent.click(screen.getByText('Save as new branch'));
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

  it('renders <think> reasoning as a collapsed Thought process block, not inline in the answer', () => {
    render(
      <Message
        message={base({ id: 'a2', role: 'assistant', content: '<think>secret reasoning here</think>The visible answer.' })}
        onRegenerate={() => {}}
        onDelete={() => {}}
      />,
    );
    // The answer is shown; the reasoning is NOT leaked into it.
    expect(screen.getByText('The visible answer.')).toBeInTheDocument();
    expect(screen.queryByText(/secret reasoning here/)).not.toBeInTheDocument();
    // …but a Thoughts toggle exists and reveals the reasoning when expanded.
    const toggle = screen.getByText('Thought process');
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText(/secret reasoning here/)).toBeInTheDocument();
  });
});

// ── Generated media: unsaved until the user says otherwise ──
// The media twin of the text/office "unsaved artifact" cards: Download is
// free, Save is the metered action, and the badge says which state it is in.

describe('Message — generated media (unsaved)', () => {
  const withImage = base({
    id: 'a3', role: 'assistant',
    content: 'Here is the cat you asked for.\n\n![a friendly cat](/api/files/media-1)',
  });
  const pending = {
    id: 'media-1', name: 'cascade-cat.png', mime: 'image/png', size: 2048,
    conversationId: 'c1', createdAt: Date.now(), expiresAt: Date.now() + 23.5 * 60 * 60 * 1000,
  };

  beforeEach(() => {
    _resetPendingMediaForTests();
    mockFetchPending.mockReset();
    mockSaveFile.mockReset();
    mockFetchPending.mockResolvedValue({ media: [pending], usedBytes: 2048, limitBytes: 64 * 1024 * 1024 });
  });

  it('badges a freshly generated image as temporary, with the time left and both actions', async () => {
    render(<Message message={withImage} onRegenerate={() => {}} onDelete={() => {}} />);

    const card = await screen.findByTestId('generated-media-card');
    expect(card).toHaveTextContent('cascade-cat.png');
    // The distinction the user actually needs: this is NOT in their storage yet.
    expect(card).toHaveTextContent('Temporary');
    expect(card).toHaveTextContent(/Expires in 23h unless you save it/);
    // Download is free (a plain link to the bytes); Save is the metered one.
    expect(screen.getByRole('link', { name: /Download/ })).toHaveAttribute('href', '/api/files/media-1');
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled();
  });

  it('Save promotes it through the same /api/files save the file cards use', async () => {
    mockSaveFile.mockResolvedValue({
      file: { id: 'media-1', name: 'cascade-cat.png', mime: 'image/png', size: 2048, createdAt: Date.now(), conversationId: 'c1' },
      usedBytes: 2048, limitBytes: 10 * 1024 * 1024,
    });
    render(<Message message={withImage} onRegenerate={() => {}} onDelete={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Save/ }));

    // The id, not a re-upload of bytes the server is already holding — but the
    // same helper, route and quota check as every other saved artifact.
    await waitFor(() => expect(mockSaveFile).toHaveBeenCalledWith({ pendingMediaId: 'media-1' }));
    const card = await screen.findByTestId('generated-media-card');
    await waitFor(() => expect(card).toHaveTextContent('Saved to your Cascade files.'));
    expect(card).not.toHaveTextContent('Temporary');
    expect(screen.getByRole('button', { name: /Saved/ })).toBeDisabled();
  });

  it('surfaces a refused save (storage full) without losing the card', async () => {
    mockSaveFile.mockRejectedValue(new Error("Storage full — you've used 9.0 MB of your 10 MB free limit."));
    render(<Message message={withImage} onRegenerate={() => {}} onDelete={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Save/ }));

    const card = await screen.findByTestId('generated-media-card');
    await waitFor(() => expect(card).toHaveTextContent(/Storage full/));
    // Still offered — deleting a file and retrying has to be possible.
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled();
    expect(card).toHaveTextContent('Temporary');
  });

  it('shows no card for media that is already saved', async () => {
    // The server lists only UNSAVED media, so a saved image's id is absent —
    // a permanent file must not be badged as expiring.
    mockFetchPending.mockResolvedValue({ media: [], usedBytes: 0, limitBytes: 64 * 1024 * 1024 });
    render(<Message message={withImage} onRegenerate={() => {}} onDelete={() => {}} />);

    await waitFor(() => expect(mockFetchPending).toHaveBeenCalled());
    expect(screen.queryByTestId('generated-media-card')).not.toBeInTheDocument();
  });

  it('does not ask the server about media for a reply that has none', async () => {
    render(
      <Message
        message={base({ id: 'a4', role: 'assistant', content: 'Just a plain answer.' })}
        onRegenerate={() => {}}
        onDelete={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('Just a plain answer.')).toBeInTheDocument());
    expect(mockFetchPending).not.toHaveBeenCalled();
  });
});

describe('Message — receipt', () => {
  const why = {
    tier: 'T3', model: 'openai:gpt-mini',
    decisions: [], savedUsd: 0, savedPct: 0, totalCostUsd: 0, totalTokens: 0, durationMs: 0,
    costByTier: {}, tokensByTier: {},
    // T1 planned first, so it is first in insertion order — but T3 did the work.
    models: { T1: 'anthropic:claude-big', T2: 'openai:gpt-mid', T3: 'openai:gpt-mini' },
  };

  it('falls back to the report’s primary tier and model, not the first tier it lists', () => {
    render(<Message message={base({ role: 'assistant', content: 'done', why })} />);
    expect(screen.getByText('T3')).toBeInTheDocument();
    expect(screen.getByText(/gpt-mini/)).toBeInTheDocument();
    expect(screen.queryByText('T1')).not.toBeInTheDocument();
  });

  // A provider that reports no usage left the report with no tier, and the
  // receipt read "Cascade" though /why named the one tier and model.
  it('names the one tier that served the run when the report has no usage to rank by', () => {
    const noUsage = { ...why, tier: null, model: null, models: { T3: 'openai-compatible:stub-model' } };
    render(<Message message={base({ role: 'assistant', content: 'done', why: noUsage })} />);
    expect(screen.getByText('T3')).toBeInTheDocument();
    expect(screen.getByText(/stub-model/)).toBeInTheDocument();
  });

  it('prefers the reply’s own tier and model when it has them', () => {
    render(<Message message={base({ role: 'assistant', content: 'done', tier: 'T2', model: 'openai:gpt-mid', why })} />);
    expect(screen.getByText('T2')).toBeInTheDocument();
    expect(screen.getByText(/gpt-mid/)).toBeInTheDocument();
  });

  it('leads from a reply\'s /why to the report for every chat', () => {
    const onOpenSpend = vi.fn();
    render(<Message message={base({ role: 'assistant', content: 'done', why })} onOpenSpend={onOpenSpend} />);
    fireEvent.click(screen.getByRole('button', { name: /\/why/ }));
    fireEvent.click(screen.getByRole('button', { name: /All spending and savings/ }));
    expect(onOpenSpend).toHaveBeenCalledTimes(1);
  });

  it('still shows "stopped" and /why for a run stopped before its first token', () => {
    render(<Message message={base({ role: 'assistant', content: '', cancelled: true, why })} onDelete={() => {}} />);
    expect(screen.getByText('stopped')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /\/why/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Nothing to copy or rate on an empty reply.
    expect(screen.queryByLabelText('Copy')).not.toBeInTheDocument();
  });
});

describe('Message — the finished run’s tree', () => {
  const why = (trace: Array<{ id: string; role: string; label?: string; status: string }>) => ({
    tier: 'T2', model: 'openai:gpt-mid', decisions: [], savedUsd: 0, savedPct: 0, totalCostUsd: 0,
    totalTokens: 0, durationMs: 0, costByTier: {}, tokensByTier: {}, models: {}, trace,
  });

  it('folds an orchestrated run’s agents above the answer, and opens to the tree', () => {
    render(
      <Message
        message={base({
          id: 'a1', role: 'assistant', content: 'The report is ready.',
          why: why([
            { id: 'T2-1', role: 'T2', label: 'Pricing section', status: 'COMPLETED' },
            { id: 'T3-1', role: 'T3', label: 'fetch pricing pages', status: 'COMPLETED' },
            { id: 'T3-2', role: 'T3', label: 'build the table', status: 'COMPLETED' },
          ]),
        })}
      />,
    );
    const fold = screen.getByRole('button', { name: '1 manager · 2 workers' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('fetch pricing pages')).not.toBeInTheDocument();
    fireEvent.click(fold);
    expect(screen.getByText('fetch pricing pages')).toBeInTheDocument();
    expect(screen.getByText('Pricing section')).toBeInTheDocument();
  });

  it('counts sections when several managers worked', () => {
    render(
      <Message
        message={base({
          id: 'a2', role: 'assistant', content: 'Done.',
          why: why([
            { id: 'T2-1', role: 'T2', status: 'COMPLETED' },
            { id: 'T2-2', role: 'T2', status: 'COMPLETED' },
            { id: 'T3-1', role: 'T3', status: 'COMPLETED' },
          ]),
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Worked through 2 sections · 1 worker' })).toBeInTheDocument();
  });

  it('shows no fold for a direct answer, which had no managers', () => {
    render(
      <Message
        message={base({
          id: 'a3', role: 'assistant', content: 'Hi!',
          why: why([{ id: 'T3-1', role: 'T3', status: 'COMPLETED' }, { id: 'T3-2', role: 'T3', status: 'COMPLETED' }]),
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: /worker/ })).not.toBeInTheDocument();
  });

  it('opens its /why when asked from outside (the top bar’s saved figure)', () => {
    const msg = base({ id: 'a4', role: 'assistant', content: 'Answer.', tier: 'T2', why: why([]) });
    const { rerender } = render(<Message message={msg} />);
    expect(screen.getByRole('button', { name: /\/why/ })).toHaveAttribute('aria-expanded', 'false');
    rerender(<Message message={msg} whyRequest={1} />);
    expect(screen.getByRole('button', { name: /\/why/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('scrolls to that /why once it has opened, not to where it was about to', async () => {
    // What was on screen at each scroll: scrolling before the panel exists
    // lands on the receipt, and a long panel then opens below the viewport.
    const scrolledTo: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolledTo.push(this.textContent ?? ''); };
    // framer-motion restores the page scroll after measuring an auto height;
    // jsdom has no scrolling to restore.
    const scrollTo = window.scrollTo;
    window.scrollTo = () => {};
    try {
      const msg = base({
        id: 'a5', role: 'assistant', content: 'Answer.', tier: 'T2',
        why: { ...why([]), decisions: [{ at: '2026-09-29T00:00:00Z', kind: 'route', detail: 'kept on T2 for the table' }] },
      });
      const { rerender } = render(<Message message={msg} />);
      rerender(<Message message={msg} whyRequest={1} />);
      await waitFor(() => expect(scrolledTo).toHaveLength(1));
      expect(scrolledTo[0]).toContain('kept on T2 for the table');
      // Asked again while open, it scrolls straight there.
      rerender(<Message message={msg} whyRequest={2} />);
      await waitFor(() => expect(scrolledTo).toHaveLength(2));
      expect(scrolledTo[1]).toContain('kept on T2 for the table');
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      window.scrollTo = scrollTo;
    }
  });
});
