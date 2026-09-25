import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import Composer from './Composer.js';
import { CHECKING, type BrowserAllowanceView } from './browserAllowance.js';

vi.mock('../lib/api.js', () => ({ uploadImage: vi.fn(), uploadDocument: vi.fn() }));

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
      uiMode="advanced"
    />,
  );
  return screen.getByRole('button', { name: /browser/i }) as HTMLButtonElement;
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
