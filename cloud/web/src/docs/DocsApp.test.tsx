import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// The chat app is not under test, and the 3D scene has no WebGL in jsdom: its failure to
// start is what the hero is built for (the static mark stays).
vi.mock('../App.js', () => ({ default: () => <div data-testid="chat-app">chat app</div> }));
vi.mock('./heroScene.js', () => ({ createDocsHero: () => null }));

import Root from '../Root.js';

function go(url: string) {
  window.history.replaceState(null, '', url);
}
async function open(url: string) {
  go(url);
  render(<Root />);
  return screen.findByTestId('docs');
}
const h1 = () => screen.getByRole('heading', { level: 1 });

beforeEach(() => {
  // jsdom has neither; the theme code and framer-motion ask for the first.
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => { cleanup(); go('/'); document.title = ''; });

describe('routing', () => {
  it('serves the chat app outside /docs', async () => {
    go('/');
    render(<Root />);
    expect(await screen.findByTestId('chat-app')).toBeInTheDocument();
    expect(screen.queryByTestId('docs')).toBeNull();
  });

  it('shows the docs home at /docs, with no sign-in or chat app', async () => {
    await open('/docs');
    expect(screen.getByTestId('docs-home')).toBeInTheDocument();
    expect(h1()).toHaveTextContent('Everything about Cascade.');
    expect(screen.queryByTestId('chat-app')).toBeNull();
    expect(document.title).toBe('Cascade docs');
  });

  it('opens a topic straight from its address, as a deep link does', async () => {
    await open('/docs/workspaces');
    expect(h1()).toHaveTextContent('Workspaces');
    expect(document.title).toBe('Workspaces · Cascade docs');
    // The page is its own: its outline lists its headings.
    expect(screen.getByRole('navigation', { name: 'On this page' })).toHaveTextContent('Tool presets');
  });

  it('tells a missing topic from a page, and offers a way on', async () => {
    await open('/docs/not-a-page');
    expect(screen.getByTestId('docs-missing')).toHaveTextContent('not-a-page');
    expect(screen.getByRole('link', { name: 'Docs home' })).toHaveAttribute('href', '/docs');
  });

  it('lands /docs#privacy on the privacy page and rewrites the address', async () => {
    await open('/docs#privacy');
    expect(h1()).toHaveTextContent('Privacy and security');
    await waitFor(() => expect(window.location.pathname).toBe('/docs/privacy'));
    expect(window.location.hash).toBe('');
  });

  it('maps the other old section ids too', async () => {
    await open('/docs#tiers');
    expect(h1()).toHaveTextContent('How tiers route');
  });

  it('opens the heading a deep link names', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    await open('/docs/workspaces#tool-presets');
    expect(h1()).toHaveTextContent('Workspaces');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('sidebar navigation', () => {
  it('moves between pages without a page load, and back and forward work', async () => {
    await open('/docs/overview');
    const sidebar = screen.getByRole('complementary', { name: 'Documentation' });
    fireEvent.click(within(sidebar).getByRole('link', { name: 'Browser relay' }));
    await waitFor(() => expect(h1()).toHaveTextContent('Browser relay'));
    expect(window.location.pathname).toBe('/docs/browser-relay');
    expect(within(sidebar).getByRole('link', { name: 'Browser relay' })).toHaveAttribute('aria-current', 'page');
    expect(within(sidebar).getByRole('link', { name: 'What is Cascade' })).not.toHaveAttribute('aria-current');

    act(() => { window.history.back(); });
    await waitFor(() => expect(h1()).toHaveTextContent('What is Cascade'));
    expect(window.location.pathname).toBe('/docs/overview');

    act(() => { window.history.forward(); });
    await waitFor(() => expect(h1()).toHaveTextContent('Browser relay'));
  });

  it('groups the pages by section', async () => {
    await open('/docs');
    const sidebar = screen.getByRole('complementary', { name: 'Documentation' });
    for (const title of ['Getting started', 'Using Cascade', 'Your computer', 'CLI reference', 'Configuration', 'Self-hosting', 'Help']) {
      expect(within(sidebar).getByRole('heading', { name: title })).toBeInTheDocument();
    }
  });

  it('links to the previous and next page at the bottom', async () => {
    await open('/docs/quick-start');
    expect(screen.getByTestId('docs-prev')).toHaveAttribute('href', '/docs/overview');
    expect(screen.getByTestId('docs-next')).toHaveAttribute('href', '/docs/desktop-app');
    fireEvent.click(screen.getByTestId('docs-next'));
    await waitFor(() => expect(h1()).toHaveTextContent('Desktop app'));
  });

  it('lets a modified click through, so a link can open in a new tab', async () => {
    await open('/docs/quick-start');
    const next = screen.getByTestId('docs-next');
    // After React has looked at the click: was it left for the browser? (jsdom cannot navigate,
    // so the default is cancelled here, once it has been recorded.)
    let leftToBrowser = false;
    const after = (e: Event) => { leftToBrowser = !e.defaultPrevented; e.preventDefault(); };
    document.addEventListener('click', after);
    fireEvent.click(next, { ctrlKey: true });
    document.removeEventListener('click', after);
    expect(leftToBrowser).toBe(true);
    expect(h1()).toHaveTextContent('Quick start');

    leftToBrowser = true;
    document.addEventListener('click', after);
    fireEvent.click(next);
    document.removeEventListener('click', after);
    expect(leftToBrowser).toBe(false);
    await waitFor(() => expect(h1()).toHaveTextContent('Desktop app'));
  });

  it('turns the sidebar into a drawer on a phone', async () => {
    await open('/docs/overview');
    expect(screen.queryByTestId('docs-drawer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open the menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Documentation menu' });
    fireEvent.click(within(drawer).getByRole('link', { name: 'Workspaces' }));
    await waitFor(() => expect(h1()).toHaveTextContent('Workspaces'));
    expect(screen.queryByTestId('docs-drawer')).toBeNull();
  });

  it('closes the drawer with Escape', async () => {
    await open('/docs/overview');
    fireEvent.click(screen.getByRole('button', { name: 'Open the menu' }));
    await screen.findByTestId('docs-drawer');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('docs-drawer')).toBeNull());
  });
});

describe('search', () => {
  it('opens with Ctrl+K and filters as you type', async () => {
    await open('/docs');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Search the docs' });
    fireEvent.change(input, { target: { value: 'undo' } });
    const results = screen.getByRole('listbox', { name: 'Results' });
    const options = within(results).getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]).toHaveTextContent(/undo/i);
    const before = options.length;

    fireEvent.change(input, { target: { value: 'undo checkpoint' } });
    expect(within(results).getAllByRole('option').length).toBeLessThanOrEqual(before);
    expect(within(results).getAllByRole('option')[0]).toHaveTextContent(/Checkpoints and undo/);

    fireEvent.change(input, { target: { value: 'zzzqqq nothing' } });
    expect(within(results).queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByTestId('docs-search-empty')).toBeInTheDocument();
  });

  it('also opens with Cmd+K, and closes with Escape', async () => {
    await open('/docs');
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    const input = await screen.findByRole('combobox', { name: 'Search the docs' });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('docs-search')).toBeNull());
  });

  it('finds a page by a word in its text, and opens it with the keyboard', async () => {
    await open('/docs');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Search the docs' });
    fireEvent.change(input, { target: { value: 'WORKSPACE_RELAY' } });
    const first = within(screen.getByRole('listbox', { name: 'Results' })).getAllByRole('option')[0]!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByTestId('docs-search')).toBeNull());
    expect(window.location.pathname).toMatch(/^\/docs\/(workspaces|server-environment|self-hosting|troubleshooting)$/);
    expect(window.location.hash === '' || window.location.hash.startsWith('#')).toBe(true);
  });

  it('opens a result by click, at its heading', async () => {
    await open('/docs');
    fireEvent.click(screen.getAllByRole('button', { name: /Search/ })[0]!);
    const input = await screen.findByRole('combobox', { name: 'Search the docs' });
    fireEvent.change(input, { target: { value: 'tool presets' } });
    const option = within(screen.getByRole('listbox', { name: 'Results' })).getAllByRole('option')[0]!;
    expect(option).toHaveTextContent('Tool presets');
    fireEvent.click(option);
    await waitFor(() => expect(window.location.pathname).toBe('/docs/workspaces'));
    expect(window.location.hash).toBe('#tool-presets');
  });
});

describe('code blocks', () => {
  function stubClipboard(impl: (t: string) => Promise<void>) {
    const writeText = vi.fn(impl);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  }

  it('copies the code and says so', async () => {
    const writeText = stubClipboard(async () => {});
    await open('/docs/cli');
    const button = screen.getAllByRole('button', { name: 'Copy code' })[0]!;
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toBe('npm install -g cascade-ai');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('says so when the clipboard refuses and there is no fallback', async () => {
    stubClipboard(async () => { throw new Error('denied'); });
    const exec = vi.fn(() => false);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    await open('/docs/cli');
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy code' })[0]!);
    expect(await screen.findByText('Press Ctrl+C')).toBeInTheDocument();
  });
});

describe('page furniture', () => {
  it('renders callouts as notes a screen reader can name', async () => {
    await open('/docs/workspaces');
    const notes = screen.getAllByRole('note');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toHaveAttribute('data-callout');
  });

  it('renders tables inside a scrollable, named region', async () => {
    await open('/docs/workspaces');
    const regions = screen.getAllByRole('region', { name: 'Table' });
    expect(regions[0]!.querySelector('table')).not.toBeNull();
  });

  it('shows the static mark when the 3D scene cannot start', async () => {
    await open('/docs');
    const hero = await screen.findByTestId('docs-hero');
    await waitFor(() => expect(hero).toHaveAttribute('data-live', '0'));
    expect(hero.querySelector('svg')).not.toBeNull();
  });

  it('cycles the theme from the header', async () => {
    await open('/docs');
    const button = screen.getByRole('button', { name: /^Theme:/ });
    expect(button).toHaveAccessibleName('Theme: follow system');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: /^Theme:/ })).toHaveAccessibleName('Theme: light');
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: /^Theme:/ }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('goes back to the app from the header', async () => {
    await open('/docs/faq');
    fireEvent.click(screen.getByRole('link', { name: 'Open Cascade' }));
    expect(await screen.findByTestId('chat-app')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });
});
