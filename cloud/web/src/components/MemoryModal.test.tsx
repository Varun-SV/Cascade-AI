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
    disconnect: () => listeners.get('disconnect')?.(undefined),
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

  it('closing the panel mid-build stops the build; two updates to one memory are never both ticked (Codex on bca3626)', async () => {
    vi.mocked(api.fetchMemoryBuildChats).mockResolvedValue({ chats: [{ id: 'c1', title: 'Go', updatedAt: 2, turns: 4, worth: true }] });
    const running = fakeSocket([]);
    const first = render(<MemoryModal onClose={vi.fn()} socket={running} providers={PROVIDERS} />);
    fireEvent.click(await screen.findByRole('button', { name: /Build from my chats/ }));
    await screen.findByLabelText('Go', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: /Build memories/ }));
    first.unmount();
    expect(running.emitted.map(([e]) => e)).toContain('memories:cancel');

    const target = { id: '1', content: 'Building Cascade with TypeScript' };
    const ev = [{ conversationId: 'c1', quote: 'q', at: 1 }];
    const socket = fakeSocket([
      { category: 'projects', content: 'Building Cascade with Rust', durability: 'permanent', status: 'revision', matches: target, evidence: ev },
      { category: 'projects', content: 'Building Cascade with Go', durability: 'permanent', status: 'revision', matches: target, evidence: ev },
    ]);
    render(<MemoryModal onClose={vi.fn()} socket={socket} providers={PROVIDERS} />);
    fireEvent.click(await screen.findByRole('button', { name: /Build from my chats/ }));
    await screen.findByLabelText('Go', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: /Build memories/ }));
    act(() => socket.finish());
    const rust = await screen.findByRole('checkbox', { name: 'Keep: Building Cascade with Rust' });
    const go = screen.getByRole('checkbox', { name: 'Keep: Building Cascade with Go' });
    expect(rust).toBeChecked();
    expect(go).not.toBeChecked();
    expect(screen.getAllByText(/updates it too: keep one/).length).toBe(2);
    fireEvent.click(go);
    expect(go).toBeChecked();
    expect(rust).not.toBeChecked();
  });

  it('a dropped connection ends the build with a message, never a spinner forever (Codex on 411b9d6)', async () => {
    vi.mocked(api.fetchMemoryBuildChats).mockResolvedValue({ chats: [{ id: 'c1', title: 'Go', updatedAt: 2, turns: 4, worth: true }] });
    const socket = fakeSocket([]);
    render(<MemoryModal onClose={vi.fn()} socket={socket} providers={PROVIDERS} />);
    fireEvent.click(await screen.findByRole('button', { name: /Build from my chats/ }));
    await screen.findByLabelText('Go', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: /Build memories/ }));
    expect(screen.getByText(/Reading your chats/)).toBeInTheDocument();
    act(() => socket.disconnect());
    expect(screen.queryByText(/Reading your chats/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/connection dropped/);
    expect(screen.getByRole('button', { name: /Build memories/ })).toBeInTheDocument();
  });

  it('a cancelled edit leaves nothing behind for the next save (Codex on 556f88d)', async () => {
    vi.mocked(api.updateMemory).mockImplementation(async (id, content, category, durability) => ({ memory: mem(id, content, category ?? null, { durability }) }));
    render(<MemoryModal onClose={vi.fn()} />);
    const prefs = await screen.findByRole('region', { name: 'Preferences' });
    fireEvent.click(within(prefs).getByRole('button', { name: 'Edit memory' }));
    fireEvent.change(within(prefs).getByRole('combobox', { name: 'Category' }), { target: { value: 'goals' } });
    fireEvent.change(within(prefs).getByRole('combobox', { name: 'How long should this hold?' }), { target: { value: 'volatile' } });
    fireEvent.click(within(prefs).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(prefs).getByRole('button', { name: 'Edit memory' }));
    fireEvent.change(within(prefs).getByRole('textbox', { name: 'Memory' }), { target: { value: 'Prefers TypeScript, always' } });
    fireEvent.click(within(prefs).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateMemory).toHaveBeenCalledWith('1', 'Prefers TypeScript, always', 'preferences', 'permanent'));
  });

  it('a save that fails part way keeps what was saved out of the retry, so nothing is saved twice (Codex on 556f88d)', async () => {
    vi.mocked(api.fetchMemoryBuildChats).mockResolvedValue({ chats: [{ id: 'c1', title: 'Go', updatedAt: 2, turns: 4, worth: true }] });
    const ev = [{ conversationId: 'c1', quote: 'q', at: 1 }];
    const many: MemoryCandidate[] = Array.from({ length: 250 }, (_, k) => ({ category: 'facts', content: `Fact ${k}`, durability: 'permanent', status: 'new', evidence: ev }));
    const sent: number[] = [];
    vi.mocked(api.acceptMemories).mockReset()
      .mockImplementationOnce(async (items) => { sent.push(items.length); return { saved: items.map((it, k) => mem(`n${k}`, it.content, it.category)) }; })
      .mockImplementationOnce(async (items) => { sent.push(items.length); throw new Error('network down'); })
      .mockImplementationOnce(async (items) => { sent.push(items.length); return { saved: items.map((it, k) => mem(`m${k}`, it.content, it.category)) }; });
    const socket = fakeSocket(many);
    render(<MemoryModal onClose={vi.fn()} socket={socket} providers={PROVIDERS} />);
    fireEvent.click(await screen.findByRole('button', { name: /Build from my chats/ }));
    await screen.findByLabelText('Go', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: /Build memories/ }));
    act(() => socket.finish());
    fireEvent.click(await screen.findByRole('button', { name: /Save 250 memories/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Saved 200; the rest could not be. network down/);
    fireEvent.click(screen.getByRole('button', { name: /Save 50 memories/ }));
    expect(await screen.findByText(/Saved 250 memories/)).toBeInTheDocument();
    expect(sent).toEqual([200, 50, 50]);
  });
});
