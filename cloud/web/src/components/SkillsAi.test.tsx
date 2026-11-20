import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SkillsModal from './SkillsModal.js';
import type { Skill } from '../lib/types.js';
import * as api from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  createSkill: vi.fn(async () => ({})), deleteSkill: vi.fn(), updateSkill: vi.fn(async () => ({})), fetchMemoryBuildChats: vi.fn(),
}));

afterEach(cleanup);

const PROVIDERS = [{ type: 'anthropic', apiKey: 'k' }] as never;
const mine: Skill = { id: 'k1', name: 'SQL Tutor', description: 'Teaches SQL', custom: true, usageCount: 2, systemPrompt: 'You teach SQL.' } as Skill;

/** A socket that answers the skill events; `hold` keeps an answer back until released. */
function fakeSocket(answers: Record<string, unknown>, hold = false) {
  const sent: Array<[string, unknown]> = [];
  let release: (() => void) | null = null;
  return {
    sent,
    release: () => release?.(),
    emit: vi.fn((event: string, payload?: unknown, ack?: (r: unknown) => void) => {
      sent.push([event, payload]);
      if (!ack) return;
      if (hold && event !== 'skills:suggest-estimate') { release = () => ack(answers[event]); return; }
      ack(answers[event]);
    }),
  };
}

describe('Skills with AI', () => {
  it('writes a new skill from what it is for, filling the form to edit before Create', async () => {
    const socket = fakeSocket({ 'skills:draft': { draft: { name: 'PR security review', description: 'Reviews diffs.', instructions: 'You review PRs for security.' } } });
    render(<SkillsModal skills={[]} onClose={vi.fn()} onChange={vi.fn()} socket={socket} providers={PROVIDERS} />);
    fireEvent.click(screen.getByRole('button', { name: /New skill/ }));
    fireEvent.change(screen.getByLabelText(/Write it with AI/), { target: { value: 'review my PRs for security' } });
    fireEvent.click(screen.getByRole('button', { name: /Write it$/ }));
    await waitFor(() => expect(screen.getByDisplayValue('PR security review')).toBeInTheDocument());
    expect(socket.sent[0]).toEqual(['skills:draft', { providers: PROVIDERS, want: 'review my PRs for security' }]);
    expect(screen.getByDisplayValue('You review PRs for security.')).toBeInTheDocument();
    // Nothing saved until Create.
    expect(api.createSkill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    await waitFor(() => expect(api.createSkill).toHaveBeenCalledWith({ name: 'PR security review', description: 'Reviews diffs.', systemPrompt: 'You review PRs for security.' }));
  });

  it('improves an existing skill: the change is shown beside what it replaces, applied only on "Use this"', async () => {
    const socket = fakeSocket({ 'skills:refine': {
      draft: { name: 'SQL Tutor', description: 'Teaches SQL', instructions: 'You teach SQL, strictly.' },
      before: { name: 'SQL Tutor', description: 'Teaches SQL', instructions: 'You teach SQL.' },
    } });
    render(<SkillsModal skills={[mine]} onClose={vi.fn()} onChange={vi.fn()} socket={socket} providers={PROVIDERS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
    fireEvent.change(screen.getByLabelText(/Improve with AI/), { target: { value: 'be stricter' } });
    fireEvent.click(screen.getByRole('button', { name: /Improve$/ }));
    const proposed = await screen.findByRole('region', { name: 'Proposed' });
    expect(within(proposed).getByText('You teach SQL, strictly.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Now' })).getByText('You teach SQL.')).toBeInTheDocument();
    // The form still holds the skill as it is, and Save waits for a decision.
    expect(screen.getByDisplayValue('You teach SQL.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Use this/ }));
    expect(screen.getByDisplayValue('You teach SQL, strictly.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.updateSkill).toHaveBeenCalledWith('k1', { name: 'SQL Tutor', description: 'Teaches SQL', systemPrompt: 'You teach SQL, strictly.' }));
  });

  it('shows the model\'s error, and Stop asks the server to stop', async () => {
    const failing = fakeSocket({ 'skills:draft': { error: 'Your provider refused the request. Check its key in Settings.' } });
    const { unmount } = render(<SkillsModal skills={[]} onClose={vi.fn()} onChange={vi.fn()} socket={failing} providers={PROVIDERS} />);
    fireEvent.click(screen.getByRole('button', { name: /New skill/ }));
    fireEvent.change(screen.getByLabelText(/Write it with AI/), { target: { value: 'a tutor' } });
    fireEvent.click(screen.getByRole('button', { name: /Write it$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/refused the request/);
    unmount();

    const slow = fakeSocket({ 'skills:draft': { cancelled: true } }, true);
    render(<SkillsModal skills={[]} onClose={vi.fn()} onChange={vi.fn()} socket={slow} providers={PROVIDERS} />);
    fireEvent.click(screen.getByRole('button', { name: /New skill/ }));
    fireEvent.change(screen.getByLabelText(/Write it with AI/), { target: { value: 'a tutor' } });
    fireEvent.click(screen.getByRole('button', { name: /Write it$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Stop/ }));
    expect(slow.sent.map(([e]) => e)).toContain('skills:cancel');
    act(() => slow.release());
  });

  it('suggests skills from chats: picks, prices, and adds one to the form to edit', async () => {
    vi.mocked(api.fetchMemoryBuildChats).mockResolvedValue({ chats: [
      { id: 'c1', title: 'PR review 1', updatedAt: 3, turns: 2, worth: true },
      { id: 'c2', title: 'PR review 2', updatedAt: 2, turns: 1, worth: false },
      { id: 'c3', title: 'Empty', updatedAt: 1, turns: 0, worth: false },
    ] });
    const socket = fakeSocket({
      'skills:suggest-estimate': { chats: 2, inputTokens: 900, outputTokens: 2500, model: 'claude-x', costUsd: 0.04 },
      'skills:suggest': { suggestions: [{
        name: 'PR security review', description: 'Reviews diffs.', instructions: 'You review PRs.', why: 'You asked for this in two chats.',
        chats: [{ id: 'c1', title: 'PR review 1' }, { id: 'c2', title: 'PR review 2' }],
      }] },
    });
    render(<SkillsModal skills={[]} onClose={vi.fn()} onChange={vi.fn()} socket={socket} providers={PROVIDERS} />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest from my chats/ }));
    // A chat with nothing asked in it isn't offered.
    expect(await screen.findByLabelText('PR review 1', { exact: false })).toBeChecked();
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();
    expect(await screen.findByText(/Reads 2 chats with claude-x, for about \$0\.04/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Suggest skills/ }));
    const list = await screen.findByRole('list', { name: 'Suggested skills' });
    expect(within(list).getByText('You asked for this in two chats.')).toBeInTheDocument();
    expect(within(list).getByText('PR review 2')).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Add PR security review' }));
    expect(screen.getByDisplayValue('PR security review')).toBeInTheDocument();
    expect(screen.getByDisplayValue('You review PRs.')).toBeInTheDocument();
    expect(api.createSkill).not.toHaveBeenCalled();
  });

  it('without a provider, offers no AI help', () => {
    render(<SkillsModal skills={[]} onClose={vi.fn()} onChange={vi.fn()} socket={fakeSocket({})} providers={[]} />);
    expect(screen.queryByRole('button', { name: /Suggest from my chats/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New skill/ }));
    expect(screen.queryByLabelText(/Write it with AI/)).not.toBeInTheDocument();
  });

  describe('Codex on 1bdf892', () => {
    it('Improve works on the form as it is, unsaved edits included', async () => {
      const socket = fakeSocket({ 'skills:refine': {
        draft: { name: 'SQL Tutor', description: 'Teaches SQL', instructions: 'edited, then stricter' },
        before: { name: 'SQL Tutor', description: 'Teaches SQL', instructions: 'edited' },
      } });
      render(<SkillsModal skills={[mine]} onClose={vi.fn()} onChange={vi.fn()} socket={socket} providers={PROVIDERS} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
      fireEvent.change(screen.getByDisplayValue('You teach SQL.'), { target: { value: 'edited' } });
      fireEvent.change(screen.getByLabelText(/Improve with AI/), { target: { value: 'be stricter' } });
      fireEvent.click(screen.getByRole('button', { name: /Improve$/ }));
      await screen.findByRole('region', { name: 'Proposed' });
      expect(socket.sent[0]).toEqual(['skills:refine', { providers: PROVIDERS, skillId: 'k1', change: 'be stricter', current: { name: 'SQL Tutor', description: 'Teaches SQL', instructions: 'edited' } }]);
    });

    it('an answer for a form that was left is dropped, never written into another skill', async () => {
      const socket = fakeSocket({ 'skills:draft': { draft: { name: 'Late', description: 'd', instructions: 'late text' } } }, true);
      render(<SkillsModal skills={[mine]} onClose={vi.fn()} onChange={vi.fn()} socket={socket} providers={PROVIDERS} />);
      fireEvent.click(screen.getByRole('button', { name: /New skill/ }));
      fireEvent.change(screen.getByLabelText(/Write it with AI/), { target: { value: 'a tutor' } });
      fireEvent.click(screen.getByRole('button', { name: /Write it$/ }));
      // Off to edit another skill while it writes: the writing is stopped.
      fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
      expect(socket.sent.map(([e]) => e)).toContain('skills:cancel');
      await act(async () => { socket.release(); });
      expect(screen.getByDisplayValue('You teach SQL.')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('late text')).not.toBeInTheDocument();
    });

    it('a dropped connection ends the wait with a message, not "writing…" for ever', async () => {
      const listeners = new Map<string, () => void>();
      const socket = {
        emit: vi.fn(),
        on: (e: string, fn: () => void) => { listeners.set(e, fn); },
        off: (e: string) => { listeners.delete(e); },
      };
      render(<SkillsModal skills={[]} onClose={vi.fn()} onChange={vi.fn()} socket={socket} providers={PROVIDERS} />);
      fireEvent.click(screen.getByRole('button', { name: /New skill/ }));
      fireEvent.change(screen.getByLabelText(/Write it with AI/), { target: { value: 'a tutor' } });
      fireEvent.click(screen.getByRole('button', { name: /Write it$/ }));
      expect(screen.getByText(/Your model is writing it/)).toBeInTheDocument();
      await act(async () => { listeners.get('disconnect')?.(); });
      expect(screen.queryByText(/Your model is writing it/)).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/connection dropped/);
    });

    it('adding one suggestion keeps the others: saving it, or cancelling, goes back to them', async () => {
      vi.mocked(api.fetchMemoryBuildChats).mockResolvedValue({ chats: [
        { id: 'c1', title: 'A', updatedAt: 2, turns: 1, worth: true },
        { id: 'c2', title: 'B', updatedAt: 1, turns: 1, worth: true },
      ] });
      vi.mocked(api.createSkill).mockClear();
      const two = [
        { name: 'One', description: 'd1', instructions: 'i1', why: 'w1', chats: [{ id: 'c1', title: 'A' }, { id: 'c2', title: 'B' }] },
        { name: 'Two', description: 'd2', instructions: 'i2', why: 'w2', chats: [{ id: 'c1', title: 'A' }, { id: 'c2', title: 'B' }] },
      ];
      const socket = fakeSocket({ 'skills:suggest-estimate': { chats: 2, inputTokens: 1, outputTokens: 1, model: 'm', costUsd: 0.01 }, 'skills:suggest': { suggestions: two } });
      render(<SkillsModal skills={[]} onClose={vi.fn()} onChange={vi.fn()} socket={socket} providers={PROVIDERS} />);
      fireEvent.click(screen.getByRole('button', { name: /Suggest from my chats/ }));
      await screen.findByText(/Reads 2 chats/);
      fireEvent.click(screen.getByRole('button', { name: /Suggest skills/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Add One' }));
      // Cancel: back to both.
      fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
      expect(screen.getByRole('button', { name: 'Add One' })).toBeInTheDocument();
      // Save one: it leaves the list, the other stays to add.
      fireEvent.click(screen.getByRole('button', { name: 'Add One' }));
      fireEvent.click(screen.getByRole('button', { name: /Create/ }));
      await waitFor(() => expect(api.createSkill).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole('button', { name: 'Add Two' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add One' })).not.toBeInTheDocument();
      // Only one paid pass.
      expect(socket.sent.filter(([e]) => e === 'skills:suggest')).toHaveLength(1);
    });
  });
});
