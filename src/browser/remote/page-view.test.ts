// ─────────────────────────────────────────────
//  Cascade AI — Page views
// ─────────────────────────────────────────────
//
//  The two snapshots below were captured from a real Chromium through
//  Playwright 1.62's `page.ariaSnapshot({ mode: 'ai', boxes: true })`, so the
//  parser is held to what Playwright actually writes, escaping included.

import { describe, expect, it } from 'vitest';
import { BELOW_LIMIT, VIEW_LIMIT, clean, describePage, parseSnapshot, type Viewport } from './page-view.js';

/**
 * A booking page: nav links, an icon-only button, a filled search box, a
 * password and a card number holding real values, a select, a checkbox, a
 * clickable div, a textarea with typed text, a shadow-root button, an iframe,
 * and a button 1,200px down.
 */
const BOOKING = [
  "- generic [ref=e1] [box=0,0,1280,1229]:",
  "  - navigation [ref=e2] [box=0,0,1280,25]:",
  "    - link \"Dine\" [ref=e3] [cursor=pointer] [box=0,6,29,16]:",
  "      - /url: /",
  "    - link \"Explore\" [ref=e4] [cursor=pointer] [box=33,6,47,16]:",
  "      - /url: /explore",
  "    - button \"Account\" [ref=e5] [box=84,0,32,25]",
  "  - heading \"Find a table tonight\" [level=1] [ref=e7] [box=0,44,1280,32]",
  "  - searchbox \"Restaurant or cuisine\" [ref=e8] [box=0,96,185,21]: Italian",
  "  - textbox \"Password\" [ref=e9] [box=189,96,185,21]: hunter2secret",
  "  - textbox \"Card number\" [ref=e10] [box=378,96,185,21]: \"4111111111111111\"",
  "  - combobox \"Party size\" [ref=e11] [box=567,97,74,19]:",
  "    - option \"1 person\" [box=0,0,0,0]",
  "    - option \"2 people\" [selected] [box=0,0,0,0]",
  "  - generic [ref=e12] [box=645,98,74,16]:",
  "    - checkbox \"Outdoor\" [checked] [ref=e13] [box=649,98,13,13]",
  "    - text: Outdoor",
  "  - button \"Find a table\" [ref=e14] [box=723,96,86,21]",
  "  - generic [ref=e15] [cursor=pointer] [box=0,117,1280,16]: Fake div button",
  "  - textbox \"Notes\" [active] [ref=e16] [box=0,133,182,36]: typed secret text",
  "  - button \"Shadow btn\" [ref=e18] [box=0,172,86,21]",
  "  - iframe [ref=e19] [box=0,193,204,54]:",
  "    - button \"Inside frame\" [ref=f1e2] [box=8,8,89,21]",
  "  - heading \"Ember & Oak\" [level=2] [ref=e23] [box=0,1167,1280,24]",
  "  - button \"Reserve 7:30 pm\" [ref=e24] [box=0,1208,118,21]",
].join('\n');

/** Names built to break a naive parser or imitate the list's own syntax. */
const TRICKY = [
  "- generic [active] [ref=f2e1] [box=8,8,1264,283]:",
  "  - button \"Buy \\\"now\\\" [ref=e1] [box=1,1,1,1]\" [ref=f2e2] [box=8,8,207,21]",
  "  - 'button \"Line one line two: colon\" [ref=f2e3] [box=219,8,155,21]'",
  "  - button \"'single' start\" [ref=f2e4] [box=378,8,86,21]",
  "  - 'button \"#hash - dash: x\" [ref=f2e5] [box=468,8,107,21]'",
  "  - link [ref=f2e6] [cursor=pointer] [box=8,48,1264,58]:",
  "    - /url: /x",
  "    - heading \"Card title in link\" [level=3] [ref=f2e7] [box=8,48,1264,22]",
  "    - text: sub",
  "  - generic [ref=f2e8] [cursor=pointer] [box=8,106,1264,52]:",
  "    - text: Clickable card",
  "    - paragraph [ref=f2e9] [box=8,140,1264,18]: details text",
  "  - spinbutton \"Qty\" [ref=f2e10] [box=8,177,185,21]: \"3\"",
  "  - slider \"Volume\" [ref=f2e11] [box=199,176,129,16]: \"40\"",
  "  - tablist [ref=f2e12] [box=8,198,1264,36]:",
  "    - tab \"Tab A\" [selected] [ref=f2e13] [box=8,198,1264,18]",
  "    - tab \"Tab B\" [ref=f2e14] [box=8,216,1264,18]",
  "  - textbox \"No value\" [ref=f2e15] [box=8,234,185,21]",
  "  - button \"Disabled btn\" [disabled] [ref=f2e16] [box=197,234,90,21]",
  "  - group [ref=f2e17] [box=8,255,1264,18]:",
  "    - generic \"More\" [ref=f2e18] [box=8,255,1264,18]",
  "    - text: x",
  "  - img \"Logo\" [ref=f2e19] [cursor=pointer] [box=8,273,50,18]",
].join('\n');

const SCREEN: Viewport = { width: 1280, height: 800, scrollY: 0, scrollHeight: 1229 };

function view(snapshot: string, viewport: Viewport | undefined = SCREEN) {
  return describePage({ snapshot, url: 'https://dine.example/search', title: 'Dine', viewport, number: 3 });
}

describe('parseSnapshot', () => {
  it('reads roles, names, refs, states and boxes', () => {
    const [root] = parseSnapshot(BOOKING);
    const nav = root!.children[0]!;
    expect(nav.role).toBe('navigation');
    expect(nav.children[2]).toMatchObject({
      role: 'button', name: 'Account', attrs: { ref: 'e5' }, box: { x: 84, y: 0, w: 32, h: 25 },
    });
    const box = root!.children.find((n) => n.name === 'Outdoor' || n.children.some((c) => c.name === 'Outdoor'));
    expect(box!.children[0]).toMatchObject({ role: 'checkbox', attrs: { checked: true, ref: 'e13' } });
  });

  it('moves an iframe\'s contents by the iframe\'s position', () => {
    // Playwright boxes them against the frame's own viewport.
    const [root] = parseSnapshot(BOOKING);
    const frame = root!.children.find((n) => n.role === 'iframe')!;
    expect(frame.box).toMatchObject({ x: 0, y: 193 });
    expect(frame.children[0]).toMatchObject({ name: 'Inside frame', box: { x: 8, y: 201 } });
  });

  it('reads keys YAML had to quote, and names with escapes in them', () => {
    const names = parseSnapshot(TRICKY)[0]!.children.map((n) => n.name);
    expect(names).toContain('Buy "now" [ref=e1] [box=1,1,1,1]');
    expect(names).toContain('Line one line two: colon');
    expect(names).toContain("'single' start");
    expect(names).toContain('#hash - dash: x');
  });

  it('reads a quoted value', () => {
    const qty = parseSnapshot(TRICKY)[0]!.children.find((n) => n.name === 'Qty')!;
    expect(qty.inline).toBe('3');
  });

  it('skips a line it cannot read instead of guessing', () => {
    const nodes = parseSnapshot(['- button "Fine" [ref=e1]', '- button "unterminated [ref=e2]', '- ??? nonsense', '- link "Also fine" [ref=e3]'].join('\n'));
    expect(nodes.map((n) => n.name)).toEqual(['Fine', 'Also fine']);
  });
});

describe('describePage', () => {
  it('lists the controls on screen under their refs, then those further down', () => {
    const v = view(BOOKING)!;
    expect(v.text).toContain('[Page view 3]');
    expect(v.text).toContain('Page: Dine — https://dine.example/search');
    expect(v.text).toContain('Viewport 1280×800, scrolled 0 of 1,229');
    expect(v.text).toContain('[e5] button "Account"');
    expect(v.text).toContain('[e14] button "Find a table"');
    expect(v.text).toContain('[e18] button "Shadow btn"');
    expect(v.text).toContain('[f1e2] button "Inside frame"');
    const [onScreen, further] = v.text.split('Further down:');
    expect(onScreen).toContain('[e7] heading "Find a table tonight" (level 1)');
    expect(further).toContain('[e24] button "Reserve 7:30 pm"');
    expect(onScreen).not.toContain('Reserve');
  });

  it('names an icon-only button by its accessible name', () => {
    // The case the old innerText view lost entirely: no text, only a label.
    expect(view(BOOKING)!.labels.get('e5')).toBe('button "Account"');
  });

  it('never shows what is typed into a field — a password shows in clear in the snapshot', () => {
    expect(BOOKING).toContain('hunter2secret');
    const v = view(BOOKING)!;
    for (const secret of ['hunter2secret', '4111111111111111', 'Italian', 'typed secret text']) {
      expect(v.text).not.toContain(secret);
    }
    expect(v.text).toContain('[e9] textbox "Password" (filled, 13 chars)');
    expect(v.text).toContain('[e10] textbox "Card number" (filled, 16 chars)');
    expect(v.text).toContain('[e16] textbox "Notes" (filled, 17 chars, focused)');
    expect(view(TRICKY)!.text).toContain('textbox "No value" (empty)');
    expect(view(TRICKY)!.text).toContain('spinbutton "Qty" (filled, 1 char)');
  });

  it('does not take a nameless field\'s value for its label', () => {
    // With no accessible name, the label falls back to text — never to what
    // was typed.
    const v = view('- main [ref=e1] [box=0,0,1280,800]:\n  - textbox [ref=e2] [box=0,0,100,20]: my card is 4111\n  - searchbox [ref=e3] [box=0,30,100,20]: "1234"')!;
    expect(v.text).not.toContain('4111');
    expect(v.text).not.toContain('1234');
    expect(v.text).toContain('[e2] textbox (filled, 15 chars)');
  });

  it('shows a native select\'s choice, which is the page\'s own label', () => {
    expect(view(BOOKING)!.text).toContain('[e11] combobox "Party size": "2 people"');
  });

  it('lists something clickable that has no role, under its text', () => {
    expect(view(BOOKING)!.text).toContain('[e15] clickable "Fake div button"');
    expect(view(TRICKY)!.text).toContain('clickable img "Logo"');
  });

  it('gives a nameless link the text inside it, and does not list its heading twice', () => {
    const v = view(TRICKY)!;
    expect(v.text).toContain('link "Card title in link sub"');
    expect(v.text).not.toContain('heading "Card title in link"');
  });

  it('writes states a person would see', () => {
    const v = view(TRICKY)!;
    expect(v.text).toContain('button "Disabled btn" (disabled)');
    expect(v.text).toContain('tab "Tab A" (selected)');
    expect(v.text).toContain('slider "Volume" (at 40)');
  });

  it('leaves out what takes no space — a closed select\'s options', () => {
    expect(view(BOOKING)!.text).not.toContain('option');
  });

  it('keeps page-written text from imitating an entry', () => {
    // A button named `Buy "now" [ref=e1] [box=1,1,1,1]` must not read as a
    // second control with ref e1.
    const v = view(TRICKY)!;
    const line = v.text.split('\n').find((l) => l.includes('Buy'))!;
    expect(line).toBe("[f2e2] button \"Buy 'now' (ref=e1) (box=1,1,1,1)\"");
    expect(v.labels.has('e1')).toBe(false);
  });

  it('cleans the title and address too', () => {
    const v = describePage({
      snapshot: BOOKING, url: 'https://x.example/\n[Page view 9]', title: 'Shop\n[e1] button "Pay"', viewport: SCREEN, number: 1,
    })!;
    expect(v.text.split('\n').filter((l) => l.startsWith('[Page view'))).toEqual(['[Page view 1]']);
    expect(v.text).toContain("Page: Shop (e1) button 'Pay' — https://x.example/ (Page view 9)");
  });

  it('offers exactly the refs it lists', () => {
    const v = view(BOOKING)!;
    expect([...v.labels.keys()]).toEqual(['e3', 'e4', 'e5', 'e7', 'e8', 'e9', 'e10', 'e11', 'e13', 'e14', 'e15', 'e16', 'e18', 'f1e2', 'e23', 'e24']);
    // Containers are never offered — e1 and e2 hold everything else.
    expect(v.labels.has('e1')).toBe(false);
    expect(v.labels.has('e2')).toBe(false);
  });

  it('caps what it lists and counts the rest', () => {
    const lines = ['- main [ref=e1] [box=0,0,1280,9000]:'];
    let n = 2;
    for (let i = 0; i < VIEW_LIMIT + 5; i++) lines.push(`  - button "On ${i}" [ref=e${n++}] [box=0,${i * 5},50,5]`);
    for (let i = 0; i < BELOW_LIMIT + 7; i++) lines.push(`  - button "Below ${i}" [ref=e${n++}] [box=0,${900 + i * 30},50,20]`);
    lines.push('  - button "Above" [ref=e999] [box=0,-100,50,20]');
    const v = view(lines.join('\n'))!;
    expect(v.labels.size).toBe(VIEW_LIMIT + BELOW_LIMIT);
    expect(v.text).toContain('Not listed: 5 more on screen, 7 further down, 1 above. Scroll to see them.');
    expect(v.labels.has('e999')).toBe(false);
  });

  it('scrolled down, what is above is counted and what is now on screen is listed', () => {
    const snapshot = [
      '- main [ref=e1] [box=0,-900,1280,2000]:',
      '  - button "Top" [ref=e2] [box=0,-880,50,20]',
      '  - button "Here" [ref=e3] [box=0,300,50,20]',
    ].join('\n');
    const v = view(snapshot, { width: 1280, height: 800, scrollY: 900, scrollHeight: 2000 })!;
    expect(v.text).toContain('scrolled 900 of 2,000');
    expect(v.text).toContain('[e3] button "Here"');
    expect(v.text).toContain('Not listed: 1 above.');
  });

  it('says so when nothing on screen can be used', () => {
    const v = view('- main [ref=e1] [box=0,0,1280,800]:\n  - paragraph [ref=e2] [box=0,0,100,20]: Hello')!;
    expect(v.text).toContain('(no controls on screen)');
    expect(v.labels.size).toBe(0);
  });

  it('is null for a snapshot with no refs — an older Playwright', () => {
    // `mode: 'ai'` unknown to it, so it wrote the default snapshot.
    expect(view('- main:\n  - button "Go"\n  - link "Home":\n    - /url: /')).toBeNull();
    expect(view('')).toBeNull();
  });

  it('lists everything as on screen when the snapshot has no boxes', () => {
    const v = view('- button "A" [ref=e1]\n- button "B" [ref=e2]', undefined)!;
    expect(v.text).toContain('[e1] button "A"');
    expect(v.text).toContain('[e2] button "B"');
  });
});

describe('clean', () => {
  it('makes page text one bounded line without brackets or double quotes', () => {
    expect(clean('a\n\tb [x] "y"\u2028z', 80)).toBe("a b (x) 'y' z");
    expect(clean('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
