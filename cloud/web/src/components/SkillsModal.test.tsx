import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SkillsModal from './SkillsModal.js';
import type { Skill } from '../lib/types.js';

vi.mock('../lib/api.js', () => ({ createSkill: vi.fn(), deleteSkill: vi.fn(), updateSkill: vi.fn() }));

afterEach(cleanup);

const skills: Skill[] = [
  { id: 'general', name: 'General assistant', description: '', custom: false, usageCount: 0 },
  { id: 'code-reviewer', name: 'Code reviewer', description: 'Reviews diffs', custom: false, usageCount: 0 },
];

describe('SkillsModal', () => {
  it('puts a skill in use from its row', () => {
    const onUse = vi.fn();
    render(<SkillsModal skills={skills} onClose={vi.fn()} onChange={vi.fn()} activeSkillId="general" onUse={onUse} />);
    expect(screen.getByText('In use')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    expect(onUse).toHaveBeenCalledWith('code-reviewer');
  });

  it('waits for a working run to end, since the run already took its skill', () => {
    const onUse = vi.fn();
    render(<SkillsModal skills={skills} onClose={vi.fn()} onChange={vi.fn()} activeSkillId="general" onUse={onUse} useLocked />);
    const use = screen.getByRole('button', { name: 'Use' });
    expect(use).toBeDisabled();
    expect(use).toHaveAttribute('title', 'Available when this run ends');
    fireEvent.click(use);
    expect(onUse).not.toHaveBeenCalled();
  });
});
