import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import Menu, { placeMenu } from './Menu.js';

// Stacking is CSS, which jsdom doesn't lay out, so this reads the layers where
// they are declared.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const layer = (source: string, pattern: RegExp) => Number(pattern.exec(source)?.[1]);

describe('Menu layer', () => {
  it('opens above the phone drawer and ordinary windows, below the prompts a run waits on', () => {
    const menu = layer(read('../index.css'), /\.cz-menu \{[^}]*?\bz-\[(\d+)\]/);
    const modal = layer(read('./Modal.tsx'), /zIndexClassName = 'z-(\d+)'/);
    const context = layer(read('../chat/ContextApprovalDialog.tsx'), /fixed inset-0 z-(\d+)/);
    const escalation = layer(read('../chat/EscalationModal.tsx'), /zIndexClassName="z-\[(\d+)\]"/);
    expect([menu, modal, context, escalation].every(Number.isFinite)).toBe(true);
    expect(menu).toBeGreaterThan(modal);
    expect(menu).toBeLessThan(context);
    expect(menu).toBeLessThan(escalation);
  });
});

describe('placeMenu', () => {
  const viewport = { width: 1024, height: 800 };
  const size = { width: 240, height: 300 };

  it('opens below its button when it fits there', () => {
    expect(placeMenu({ top: 40, bottom: 70, left: 20 }, size, viewport)).toEqual({ x: 20, y: 76, maxHeight: 716 });
  });

  it('opens above a button near the bottom, ending just above it', () => {
    expect(placeMenu({ top: 760, bottom: 790, left: 20 }, size, viewport)).toEqual({ x: 20, y: 454, maxHeight: 746 });
  });

  it('is never taller than the side it opens on, so a long menu scrolls instead of running off the screen', () => {
    const tall = placeMenu({ top: 760, bottom: 790, left: 20 }, { width: 240, height: 1200 }, viewport);
    expect(tall).toEqual({ x: 20, y: 8, maxHeight: 746 });
  });

  it('keeps clear of the right edge', () => {
    expect(placeMenu({ top: 40, bottom: 70, left: 900 }, size, viewport).x).toBe(1024 - 240 - 8);
  });
});

describe('Menu', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('moves when its contents grow after it opens, as the account menu does when its gauges load', () => {
    // Fires only for what the menu actually watches.
    let resized = () => {};
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: () => void) {}
      observe() { resized = this.cb; }
      disconnect() { resized = () => {}; }
    });
    vi.stubGlobal('innerHeight', 800);
    let height = 200;
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () => ({ top: 760, bottom: 790, left: 20, right: 60, width: 40, height: 30, x: 20, y: 760, toJSON: () => ({}) });

    render(<Menu anchor={anchor} label="Account" onClose={() => {}} items={[{ kind: 'action', label: 'Sign out', onSelect: () => {} }]} />);
    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(menu.style.top).toBe('554px');

    height = 500;
    act(() => resized());
    expect(menu.style.top).toBe('254px');
    expect(menu.style.maxHeight).toBe('746px');
  });
});
