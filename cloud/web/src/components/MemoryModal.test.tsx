import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import MemoryModal from './MemoryModal.js';
import type { Memory, MemoryCandidate } from '../lib/types.js';
import * as api from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  fetchMemories: vi.fn(), addMemory: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn(),
  fetchMemoryBuildChats: vi.fn(), acceptMemories: vi.fn(),
}));

afterEach(cleanup);

const mem = (id: string, content: string, category: string | null, extra: Partial<Memory> = {}): Memory => ({
  id, userId: 'u', content, category, durability: 'permanent', createdAt: 1, updatedAt: 1, ...extra,
});

const PROVIDERS = [{ type: 'anthropic', apiKey: 'k' }] as never;

/** A socket that answers the build events as the server does, and lets a test drive progress. */
function fakeSocket(candidates: MemoryCandidate[]) {
  const listeners = new Map<string, (p: unknown) => void>();
  let finish: (() => void) | null = null;
  const emitted: Array<[string, unknown]> = [];
  return {
    emitted,
    progress: (p: unknown) => listeners.get('memories:progress')?.(p),
    finish: () => finish?.(),
    emit: vi.fn((event: string, payload?: unknown, ack?: (r: unknown) => void) => {
      emitted.push([event, payload]);
      if (event === 'memories:estimate') ack?.({ chats: 1, inputTokens: 1000, outputTokens: 350, model: 'claude-x', costUsd: 0.02 });
      if (event === 'memories:build') finish = () => ack?.({ candidates, read: 1, total: 1, cancelled: false });
    }),
    on: (e: string, fn: (p: unknown) => void) => { listeners.set(e, fn); },
    off: (e: string) => { listeners.delete(e); },
  };
}

describe('MemoryModal', () => {
  beforeEach(() => {
    vi.mocked(api.fetchMemories).mockResolvedValue({ memories: [
      mem('1', 'Prefers TypeScript', 'preferences'),
      mem('2', 'Backend engineer in Lisbon', 'about-you', {
        source: 'chats', evidence: [{ conversationId: 'c1', quote: 'I am a backend engineer in Lisbon', at: 1 }],
        revisions: [{ content: 'Engineer', at: 0 }],
      }),
      mem('3', 'Old free-text one', 'work stuff'),
    ] });
  });

  it('shows memories under their categories, in order, with where each came from', async () => {
    render(<MemoryModal onClose={vi.fn()} />);
    const about = await screen.findByRole('region', { name: 'About you' });
    const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(sections).toEqual(['About you', 'Preferences', 'Other']);
    expect(within(about).getByText('Backend engineer in Lisbon')).toBeInTheDocument();
    // Its evidence and earlier wording, on asking.
    fireEvent.click(within(about).getByRole('button', { name: /From 1 chat · updated 1×/ }));
    expect(within(about).getByText('I am a backend engineer in Lisbon')).toBeInTheDocument();
    expect(within(about).getByText('Engineer')).toBeInTheDocument();
    // A label from before categories were fixed is kept, under Other.
    expect(within(screen.getByRole('region', { name: 'Other' })).getByText('work stuff')).toBeInTheDocument();
  });

  it('builds from chats: picks, shows the cost, runs with progress, and saves only what is kept', async () => {
    vi.mocked(api.fetchMemoryBuildChats).mockResolvedValue({ chats: [
      { id: 'c1', title: 'Go services', updatedAt: 2, turns: 4, worth: true },
      { id: 'c2', title: 'hi', updatedAt: 1, turns: 1, worth: false },
    ] });
    vi.mocked(api.acceptMemories).mockResolvedValue({ saved: [mem('9', 'Works on payments', 'projects')] });
    const socket = fakeSocket([
      { category: 'projects', content: 'Works on payments', durability: 'permanent', status: 'new', evidence: [{ conversationId: 'c1', quote: 'a payments team', at: 1 }] },
      { category: 'preferences', content: 'Prefers TypeScript', durability: 'permanent', status: 'known', matches: { id: '1', content: 'Prefers TypeScript' }, evidence: [{ conversationId: 'c1', quote: 'TypeScript', at: 1 }] },
    ]);
    render(<MemoryModal onClose={vi.fn()} socket={socket} providers={PROVIDERS} />);
    fireEvent.click(await screen.findByRole('button', { name: /Build from my chats/ }));

    // A short chat can't be chosen; the long one is chosen already.
    const go = await screen.findByLabelText('Go services', { exact: false });
    expect(go).toBeChecked();
    expect(screen.getByText('too short')).toBeInTheDocument();
    expect(await screen.findByText(/Reads 1 chat with claude-x, for about \$0\.02/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Build memories/ }));
    expect(socket.emitted.find(([e]) => e === 'memories:build')?.[1]).toEqual({ providers: PROVIDERS, conversationIds: ['c1'] });
    act(() => socket.progress({ read: 1, total: 1, found: 2 }));
    expect(screen.getByText(/1 of 1 chats read · 2 suggestions so far/)).toBeInTheDocument();
    act(() => socket.finish());

    // Review: the one already kept is unticked, and says so.
    const keepNew = await screen.findByRole('checkbox', { name: 'Keep: Works on payments' });
    expect(keepNew).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Keep: Prefers TypeScript' })).not.toBeChecked();
    expect(screen.getByText(/You already have this/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save 1 memory/ }));
    await waitFor(() => expect(api.acceptMemories).toHaveBeenCalledWith([
      { category: 'projects', content: 'Works on payments', durability: 'permanent', evidence: [{ conversationId: 'c1', quote: 'a payments team', at: 1 }] },
    ]));
    expect(await screen.findByText(/Saved 1 memory/)).toBeInTheDocument();
  });

  it('stopping a build asks the server to stop', async () => {
    vi.mocked(api.fetchMemoryBuildChats).mockResolvedValue({ chats: [{ id: 'c1', title: 'Go', updatedAt: 2, turns: 4, worth: true }] });
    const socket = fakeSocket([]);
    render(<MemoryModal onClose={vi.fn()} socket={socket} providers={PROVIDERS} />);
    fireEvent.click(await screen.findByRole('button', { name: /Build from my chats/ }));
    await screen.findByLabelText('Go', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: /Build memories/ }));
    fireEvent.click(screen.getByRole('button', { name: /Stop and review/ }));
    expect(socket.emitted.map(([e]) => e)).toContain('memories:cancel');
  });

  it('with no provider, says to add one rather than offering a build', async () => {
    render(<MemoryModal onClose={vi.fn()} socket={fakeSocket([])} providers={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: /Build from my chats/ }));
    expect(screen.getByText(/Add a provider key in Settings first/)).toBeInTheDocument();
  });
});
