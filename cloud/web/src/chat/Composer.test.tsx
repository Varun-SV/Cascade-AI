import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import Composer from './Composer.js';
import { CHECKING, type BrowserAllowanceView } from './browserAllowance.js';

vi.mock('../lib/api.js', () => ({
  uploadImage: vi.fn(),
  uploadDocument: vi.fn(),
  fetchMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
  setMcpServerEnabled: vi.fn(),
}));

function renderWith(browserAllowance: BrowserAllowanceView) {
  render(
    <Composer
      skills={[]}
      skillId=""
      onSkillChange={vi.fn()}
      hasProviders
      busy={false}
      onSend={vi.fn()}
      onStop={vi.fn()}
      routingMode="auto"
      onRoutingModeChange={vi.fn()}
      forceTier="auto"
      onForceTierChange={vi.fn()}
      webSearch={false}
      onWebSearchChange={vi.fn()}
      browserMode={false}
      onBrowserModeChange={vi.fn()}
      browserAvailable
      browserAllowance={browserAllowance}
    />,
  );
  // The Browser switch lives in the Tools menu.
  fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
  return screen.getByRole('menuitemcheckbox', { name: /browser/i }) as HTMLButtonElement;
}

afterEach(cleanup);

describe('the Browser chip', () => {
  it('can be pressed while today’s allowance is still being read', () => {
    const chip = renderWith(CHECKING);
    expect(chip.disabled).toBe(false);
    expect(chip.getAttribute('title')).toContain('Checking how many browser sessions are left today');
  });

  it('can be pressed once the read says sessions remain', () => {
    expect(renderWith({ used: 1, limit: 5 }).disabled).toBe(false);
  });

  it('can stay enabled once they are used up because the quota is checked on session open', () => {
    const chip = renderWith({ used: 5, limit: 5 });
    expect(chip.disabled).toBe(false);
    expect(chip.getAttribute('title')).toContain("you'll be asked to upgrade");
  });

  it('can be pressed where the deployment rations nothing', () => {
    expect(renderWith(null).disabled).toBe(false);
  });
});

function renderComposer(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props = {
    skills: [{ id: 'general', name: 'General assistant' }, { id: 'code-reviewer', name: 'Code reviewer' }] as never,
    skillId: 'general',
    onSkillChange: vi.fn(),
    hasProviders: true,
    busy: false,
    onSend: vi.fn(),
    onStop: vi.fn(),
    routingMode: 'auto' as const,
    onRoutingModeChange: vi.fn(),
    forceTier: 'auto' as const,
    onForceTierChange: vi.fn(),
    webSearch: false,
    onWebSearchChange: vi.fn(),
    browserMode: false,
    onBrowserModeChange: vi.fn(),
    browserAvailable: true,
    browserAllowance: null,
    ...over,
  };
  render(<Composer {...props} />);
  return props;
}

describe('the composer menus', () => {
  it('Fast answer applies to the next message only', () => {
    const { onSend } = renderComposer();
    fireEvent.click(screen.getByRole('button', { name: /^Auto/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Fast answer/ }));
    // Switched on, it shows as a chip beside the menus.
    expect(screen.getByRole('button', { name: 'Remove Fast answer' })).toBeInTheDocument();
    const box = screen.getByLabelText('Message Cascade');
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: 'second' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(vi.mocked(onSend).mock.calls.map(([input]) => [input.prompt, input.fast])).toEqual([['first', true], ['second', false]]);
    expect(screen.queryByRole('button', { name: 'Remove Fast answer' })).not.toBeInTheDocument();
  });

  it('shows a billed capability that is on, with its own way off', () => {
    const { onBrowserModeChange } = renderComposer({ browserMode: true });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Browser' }));
    expect(onBrowserModeChange).toHaveBeenCalledWith(false);
  });

  it('picks a skill from the + menu, and the chip puts General back', () => {
    const { onSkillChange } = renderComposer({ skillId: 'code-reviewer' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Code reviewer' }));
    expect(onSkillChange).toHaveBeenLastCalledWith('general');
    fireEvent.click(screen.getByRole('button', { name: 'Attach and skills' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'General assistant' }));
    expect(onSkillChange).toHaveBeenLastCalledWith('general');
  });

  it('sets routing and tier from the mode menu', () => {
    const { onRoutingModeChange, onForceTierChange } = renderComposer();
    fireEvent.click(screen.getByRole('button', { name: /^Auto/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Quality/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'T2 only' }));
    expect(onRoutingModeChange).toHaveBeenCalledWith('quality');
    expect(onForceTierChange).toHaveBeenCalledWith('T2');
  });
});
