// ─────────────────────────────────────────────
//  Cascade AI — What the model is told a page looks like
// ─────────────────────────────────────────────
//
//  `browser_control` used to hand the model the page's innerText and leave it
//  to guess a CSS selector for anything it wanted to press. Text order is not
//  layout order, an icon-only button has no text at all, and a guessed selector
//  is the commonest way a browsing step fails.
//
//  This turns Playwright's AI snapshot — `page.ariaSnapshot({ mode: 'ai',
//  boxes: true })` — into a short list of the controls a person could use, each
//  under the ref Playwright itself resolves (`page.locator('aria-ref=e14')`).
//  The model acts by ref; selectors keep working beside it.
//
//  Three rules hold everywhere below, because the snapshot is written by the
//  page and read by a model that can be talked into things:
//
//    - NO VALUES. The snapshot carries what is typed into every field, and a
//      password field is shown in clear. A field reads "(filled, N chars)".
//    - NOTHING PAGE-WRITTEN CAN LOOK LIKE OURS. Names, titles and labels lose
//      brackets and double quotes, so a button called `[e1] button "Pay"` cannot
//      pass itself off as an entry, and a title cannot open a new view.
//    - BOUNDED. A page can hold thousands of controls; the list holds at most
//      VIEW_LIMIT on screen and BELOW_LIMIT further down, and counts the rest.
//
//  Pure, so the parsing is tested against snapshots captured from a real
//  Chromium rather than against the controller's fakes.

import { createHash } from 'node:crypto';

/** One line of the snapshot, as a tree. */
export interface SnapshotNode {
  role: string;
  name?: string;
  /** `[ref=e14]`, `[cursor=pointer]`, `[checked]`, `[level=2]`, … */
  attrs: Record<string, string | true>;
  /** Text after `role "name": ` — a field's VALUE for input roles. */
  inline?: string;
  /** Viewport-relative CSS pixels, already offset for any enclosing iframe. */
  box?: { x: number; y: number; w: number; h: number };
  /**
   * Inside an iframe: the part of the page the iframe shows, in the same
   * pixels. A control outside it is scrolled out of sight within the frame,
   * wherever its box lands on the page.
   */
  clip?: { x: number; y: number; w: number; h: number };
  children: SnapshotNode[];
}

/** The page's scroll state, from the page itself. */
export interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  scrollHeight: number;
}

/** What the model is shown, and which refs it may now use. */
export interface PageView {
  /** The block appended to the tool result. Starts with `PAGE_VIEW_MARK`. */
  text: string;
  /**
   * Every ref the list shows, and what it is called there — `button "Pay"`.
   * A ref outside this map is refused; the name is what a person approving
   * the action is shown.
   */
  labels: Map<string, string>;
  /**
   * What each listed ref is, in full — a digest of its role and all of its
   * name, not the cut one `labels` shows. A control renamed only past the cut
   * keeps its label; this is how it is told apart. Never shown.
   */
  identities: Map<string, string>;
  /**
   * Each listed select's options as the view shows them, and as the page
   * labels them: select_option is given the first, Playwright needs the
   * second — a name cut short, or with its brackets made parentheses, is no
   * option's label.
   */
  options: Map<string, Array<{ shown: string; label: string }>>;
  /**
   * The listed refs inside an iframe. Not told by the ref: Playwright gives
   * every document after the first its own prefix (`f4e2`), the page's own
   * included.
   */
  framed: Set<string>;
  /**
   * Where each control listed on screen is, for drawing its ref (`marked`).
   * Headings are listed to orient the model but not boxed: nothing to press.
   */
  marks: Array<{ ref: string; x: number; y: number; w: number; h: number }>;
}

/** Controls listed on screen, at most. */
export const VIEW_LIMIT = 80;
/** Controls listed below the visible area, at most. */
export const BELOW_LIMIT = 40;
/** Longest name kept for one control. */
const NAME_LIMIT = 80;
/** A select's options listed with it, at most, and the longest name kept for each. */
const OPTIONS_SHOWN = 10;
const OPTION_NAME_LIMIT = 40;

/**
 * Opens every view in a tool result. A line of its own, so the worker can find
 * a view and fold an old one away (`foldOldPageViews`).
 */
export const PAGE_VIEW_MARK = '[Page view';
/**
 * The longest snapshot read. The page decides how big its snapshot is, and
 * reading one means building its whole tree before the limits above apply;
 * an ordinary large page writes a few hundred thousand characters.
 */
export const SNAPSHOT_MAX_CHARS = 1_000_000;
/**
 * The longest view, in characters. The worker keeps a tool result under
 * 12,000 by cutting out its middle; a view that size would lose controls from
 * the middle of its list, unsaid, while their refs stayed good. Kept under it
 * here instead, with room for the step's own words, and what does not fit is
 * counted as not listed.
 */
export const VIEW_MAX_CHARS = 10_000;

/** Roles a person acts on. Anything else is listed only if it looks clickable. */
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'treeitem', 'listbox',
]);

/**
 * Roles whose inline text is something a PERSON typed. Shown as a length, never
 * as text — the snapshot reports a password field's contents in clear.
 */
const TYPED = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);

/** States worth a word in the list, in the order they are written. */
const STATES: Array<[string, string]> = [
  ['disabled', 'disabled'],
  ['checked', 'checked'],
  ['selected', 'selected'],
  ['pressed', 'pressed'],
  ['expanded', 'expanded'],
  ['active', 'focused'],
];

// ── Parsing ──────────────────────────────────

/**
 * Read Playwright's AI snapshot into a tree.
 *
 * The format is YAML-shaped and Playwright escapes it with two rules worth
 * knowing (`yamlEscapeKeyIfNeeded` / `yamlEscapeValueIfNeeded`): a key that
 * YAML would misread is wrapped in single quotes with `'` doubled, and a value
 * likewise in double quotes with backslash escapes. A name is always in
 * double quotes inside the key. A line this cannot read is skipped rather than
 * guessed at — a missing control costs the model a scroll, a misread one
 * could put the wrong label on a button.
 */
export function parseSnapshot(snapshot: string): SnapshotNode[] {
  const roots: SnapshotNode[] = [];
  /** Open ancestors: indent, node, the offset its children's boxes need, and the frame's visible part. */
  const stack: Array<{ indent: number; node: SnapshotNode; dx: number; dy: number; clip?: SnapshotNode['clip'] }> = [];

  for (const raw of snapshot.split('\n')) {
    const match = /^( *)- (.*)$/.exec(raw);
    if (!match) continue;
    const indent = match[1]!.length;
    const parsed = parseLine(match[2]!);
    if (!parsed) continue;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const dx = parent?.dx ?? 0;
    const dy = parent?.dy ?? 0;
    const clip = parent?.clip;
    const box = typeof parsed.attrs['box'] === 'string' ? readBox(parsed.attrs['box'], dx, dy) : undefined;
    const node: SnapshotNode = {
      role: parsed.role,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      attrs: parsed.attrs,
      ...(parsed.inline !== undefined ? { inline: parsed.inline } : {}),
      ...(box ? { box } : {}),
      ...(clip ? { clip } : {}),
      children: [],
    };
    (parent ? parent.node.children : roots).push(node);
    // An iframe's contents are boxed against the iframe's own viewport, so
    // they are moved by the iframe's position to land where they are seen —
    // and seen only through the iframe, so its box clips them.
    const into = node.role === 'iframe' && box
      ? { dx: box.x, dy: box.y, clip: clip ? intersect(clip, box) : box }
      : { dx, dy, ...(clip ? { clip } : {}) };
    stack.push({ indent, node, ...into });
  }
  return roots;
}

/** `role "name" [attr] [attr=v]` with an optional `: value` or `:` after it. */
function parseLine(line: string): { role: string; name?: string; attrs: Record<string, string | true>; inline?: string } | null {
  let key: string;
  let rest: string;
  if (line.startsWith("'")) {
    // A quoted key: runs to the first lone quote; '' is an escaped one.
    let i = 1;
    let out = '';
    for (; i < line.length; i++) {
      if (line[i] === "'") {
        if (line[i + 1] === "'") { out += "'"; i++; continue; }
        break;
      }
      out += line[i];
    }
    if (i >= line.length) return null;
    key = out;
    rest = line.slice(i + 1);
  } else {
    // Unquoted keys never hold ": " or end in ":" — those force quoting — so
    // the first of either ends the key.
    const at = line.search(/:( |$)/);
    key = at === -1 ? line : line.slice(0, at);
    rest = at === -1 ? '' : line.slice(at);
  }

  let inline: string | undefined;
  if (rest.startsWith(': ')) inline = readValue(rest.slice(2));
  else if (rest !== '' && rest !== ':') return null;

  const head = /^([a-z/][\w/-]*)/i.exec(key);
  if (!head) return null;
  const role = head[1]!;
  let pos = head[1]!.length;
  let name: string | undefined;
  if (key.slice(pos).startsWith(' "')) {
    const read = readQuoted(key, pos + 1);
    if (!read) return null;
    name = read.text;
    pos = read.end;
  }
  const attrs: Record<string, string | true> = {};
  const attrRe = / \[([a-z-]+)(?:=([^\]]*))?\]/gy;
  attrRe.lastIndex = pos;
  for (let m = attrRe.exec(key); m; m = attrRe.exec(key)) {
    attrs[m[1]!] = m[2] ?? true;
    pos = attrRe.lastIndex;
  }
  if (pos !== key.length) return null;
  return { role, ...(name !== undefined ? { name } : {}), attrs, ...(inline !== undefined ? { inline } : {}) };
}

/** A double-quoted string starting at `start`, JSON-style escapes. */
function readQuoted(s: string, start: number): { text: string; end: number } | null {
  if (s[start] !== '"') return null;
  let out = '';
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') return { text: out, end: i + 1 };
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) return null;
    if (n === 'n' || n === 'r' || n === 't' || n === 'b' || n === 'f') out += ' ';
    else if (n === 'x' || n === 'u') {
      const len = n === 'x' ? 2 : 4;
      const code = Number.parseInt(s.slice(i + 1, i + 1 + len), 16);
      if (Number.isNaN(code)) return null;
      out += String.fromCharCode(code);
      i += len;
    } else out += n;
  }
  return null;
}

/** A value after `: ` — double-quoted when YAML needed it, bare otherwise. */
function readValue(s: string): string {
  if (s.startsWith('"')) return readQuoted(s, 0)?.text ?? s;
  return s;
}

/** The part two boxes share; empty (zero size) when they do not meet. */
function intersect(a: NonNullable<SnapshotNode['clip']>, b: NonNullable<SnapshotNode['clip']>): NonNullable<SnapshotNode['clip']> {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

function readBox(v: string, dx: number, dy: number): { x: number; y: number; w: number; h: number } | undefined {
  const parts = v.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x: x + dx, y: y + dy, w, h };
}

// ── Choosing and describing controls ─────────

interface Entry {
  ref: string;
  node: SnapshotNode;
  /** Inside an iframe. See `PageView.framed`. */
  framed: boolean;
  box?: SnapshotNode['box'];
  heading: boolean;
  where: 'view' | 'below' | 'above';
}

/** An entry as the view shows it. */
interface Shown extends Entry {
  /** `button "Pay"` — the role and name, without the ref or states. */
  label: string;
  /** See `PageView.identities`. */
  identity: string;
  /** See `PageView.options`. */
  options?: Array<{ shown: string; label: string }>;
  line: string;
}

/**
 * Build the view the model reads, or null when the snapshot names controls
 * but gives none of them a ref — a Playwright that wrote its default snapshot
 * for `mode: 'ai'` — so the caller falls back to text and selectors instead
 * of showing an empty list as if it were true.
 *
 * A page with no controls at all — a canvas, an image, nothing yet — has a
 * view all the same, one that says so: it is still a page a screenshot can
 * show.
 */
export function describePage(input: {
  snapshot: string;
  url: string;
  title: string;
  viewport: Viewport | undefined;
  /** Counts views within a run, so the model can tell a fresh one from an old one. */
  number: number;
}): PageView | null {
  if (input.snapshot.length > SNAPSHOT_MAX_CHARS) return tooBig(input);
  const roots = parseSnapshot(input.snapshot);
  const entries: Entry[] = [];
  const hidden = valuesAround(roots);
  const typedAnywhere = textboxValues(roots);
  let sawRef = false;
  let sawControl = false;

  const visit = (node: SnapshotNode, insideClickable: boolean, framed: boolean): void => {
    const ref = typeof node.attrs['ref'] === 'string' ? node.attrs['ref'] : undefined;
    const interactive = INTERACTIVE.has(node.role);
    if (ref) sawRef = true;
    if (interactive) sawControl = true;
    const pointer = node.attrs['cursor'] === 'pointer';
    const heading = node.role === 'heading' && Number(node.attrs['level'] ?? 6) <= 3;
    // A clickable wrapper's own parts are not separate targets — unless they
    // are controls in their own right, like a button inside a clickable card.
    // A heading inside a link is the link's label, so it is not listed twice.
    const listed = Boolean(ref) && (interactive || ((heading || pointer) && !insideClickable));
    if (listed && ref) {
      const where = placement(node, input.viewport);
      // Described only if it is shown: a page can list thousands.
      if (where) entries.push({ ref, node, framed, where, heading: node.role === 'heading', ...(node.box ? { box: node.box } : {}) });
    }
    for (const child of node.children) visit(child, insideClickable || interactive || pointer, framed || node.role === 'iframe');
  };
  for (const root of roots) visit(root, false, false);
  if (sawControl && !sawRef) return null;

  const view = entries.filter((e) => e.where === 'view');
  const below = entries.filter((e) => e.where === 'below');
  const above = entries.filter((e) => e.where === 'above');

  const lines = viewHeader(input);
  // Room for the headings and the "Not listed" line, which are short.
  let room = VIEW_MAX_CHARS - lines.join('\n').length - 200;
  const fit = (list: Entry[], limit: number): Shown[] => {
    const out: Shown[] = [];
    for (const e of list.slice(0, limit)) {
      // Around a field, everything typed in it; anywhere else, what is typed
      // into a text box — a button can be named after one ("Send to …"), a
      // radio after the field its label holds — though not into a search, whose
      // words are what the results are about. Headings are the page's own.
      const values = [...(hidden.get(e.node) ?? []), ...(e.heading ? [] : typedAnywhere)];
      const shown = { ...e, ...describe(e.node, e.ref, scrubber(values)) };
      if (shown.line.length + 1 > room) break;
      room -= shown.line.length + 1;
      out.push(shown);
    }
    return out;
  };
  const shownView = fit(view, VIEW_LIMIT);
  const shownBelow = fit(below, BELOW_LIMIT);
  lines.push('', 'On screen:');
  if (shownView.length) lines.push(...shownView.map((e) => e.line));
  else lines.push('(no controls on screen)');
  if (shownBelow.length) lines.push('', 'Further down:', ...shownBelow.map((e) => e.line));

  const unlisted: string[] = [];
  if (view.length > shownView.length) unlisted.push(`${view.length - shownView.length} more on screen`);
  if (below.length > shownBelow.length) unlisted.push(`${below.length - shownBelow.length} further down`);
  if (above.length) unlisted.push(`${above.length} above`);
  if (unlisted.length) lines.push('', `Not listed: ${unlisted.join(', ')}. Scroll to see them.`);

  return {
    text: lines.join('\n'),
    labels: new Map([...shownView, ...shownBelow].map((e) => [e.ref, e.label])),
    identities: new Map([...shownView, ...shownBelow].map((e) => [e.ref, e.identity])),
    options: new Map([...shownView, ...shownBelow].flatMap((e) => (e.options ? [[e.ref, e.options] as const] : []))),
    framed: new Set([...shownView, ...shownBelow].filter((e) => e.framed).map((e) => e.ref)),
    marks: shownView.flatMap((e) => (e.box && !e.heading ? [{ ref: e.ref, x: e.box.x, y: e.box.y, w: e.box.w, h: e.box.h }] : [])),
  };
}

/** Where a control sits, or null for one that takes no space (hidden). */
function placement(node: SnapshotNode, viewport: Viewport | undefined): Entry['where'] | null {
  const { box, clip } = node;
  // No boxes at all (a snapshot taken without them): keep document order and
  // call everything on screen, rather than drop every control.
  if (!box) return 'view';
  if (box.w <= 0 || box.h <= 0) return null;
  // Scrolled out of sight inside its frame: reached by scrolling, as one
  // further down the page is — not drawn over whatever the page shows there.
  if (clip && intersect(clip, box).w * intersect(clip, box).h === 0) return 'below';
  if (!viewport) return 'view';
  if (box.y >= viewport.height) return 'below';
  if (box.y + box.h <= 0) return 'above';
  if (box.x >= viewport.width || box.x + box.w <= 0) return null;
  return 'view';
}

function describe(
  node: SnapshotNode,
  ref: string,
  scrub: (text: string) => string,
): { label: string; identity: string; options?: Shown['options']; line: string } {
  const role = INTERACTIVE.has(node.role) || node.role === 'heading'
    ? node.role
    : node.role === 'generic' ? 'clickable' : `clickable ${node.role}`;
  // A field is named by its name alone: its inline text and its children are
  // what was typed into it.
  const raw = TYPED.has(node.role) ? node.name ?? '' : node.name || node.inline || textWithin(node, IDENTITY_TEXT_MAX);
  const scrubbed = scrub(raw);
  const label = clean(scrubbed, NAME_LIMIT);
  // All of the name, where the label is cut: a control that keeps the label's
  // first eighty characters can still have become another. What scrubbing
  // reads is compared as scrubbed — a value typed since is not a new name —
  // and the rest as the page wrote it.
  const identity = createHash('sha256')
    .update(`${node.role}\0${scrubbed}\0`)
    .update(raw.length > SCRUB_TEXT_MAX ? raw.slice(SCRUB_TEXT_MAX, IDENTITY_TEXT_MAX) : '')
    .digest('base64');
  const named = `${role}${label ? ` "${label}"` : ''}`;
  let line = `[${ref}] ${named}`;

  const notes: string[] = [];
  let listedOptions: Shown['options'];
  if (node.role === 'heading' && typeof node.attrs['level'] === 'string') notes.push(`level ${node.attrs['level']}`);
  if (TYPED.has(node.role)) {
    const chosen = chosenOption(node);
    if (chosen) {
      // A native select's choice is one of the page's own option labels, not
      // something a person typed.
      line += `: "${clean(scrub(chosen.name ?? ''), NAME_LIMIT)}"`;
      // And what else it offers, by the text select_option takes: a closed
      // select's options take no space, so they are not listed on their own.
      const options = optionsOf(node);
      listedOptions = options.slice(0, OPTIONS_SHOWN)
        .map((o) => ({ shown: clean(scrub(o.name ?? ''), OPTION_NAME_LIMIT), label: o.name ?? '' }));
      const listed = listedOptions.map((o) => `"${o.shown}"`);
      if (options.length > OPTIONS_SHOWN) listed.push(`and ${options.length - OPTIONS_SHOWN} more`);
      notes.push(`options ${listed.join(', ')}`);
    } else {
      const typed = [...fieldValue(node)].length;
      notes.push(typed ? `filled, ${typed} char${typed === 1 ? '' : 's'}` : 'empty');
    }
  } else if (node.role === 'slider' && node.inline) {
    notes.push(`at ${clean(node.inline, 20)}`);
  }
  for (const [attr, word] of STATES) {
    if (node.attrs[attr] === true || node.attrs[attr] === 'true') notes.push(word);
  }
  if (notes.length) line += ` (${notes.join(', ')})`;
  return { label: named, identity, ...(listedOptions ? { options: listedOptions } : {}), line };
}

type ViewPlace = { url: string; title: string; viewport: Viewport | undefined; number: number };

/** A view's first lines: which view it is, the page, and where it is scrolled to. */
function viewHeader(input: ViewPlace): string[] {
  const title = clean(input.title, 120);
  const lines = [`${PAGE_VIEW_MARK} ${input.number}]`, `Page: ${title ? `${title} — ` : ''}${clean(input.url, 300)}`];
  if (input.viewport) {
    const v = input.viewport;
    lines.push(`Viewport ${v.width}×${v.height}, scrolled ${Math.round(v.scrollY).toLocaleString('en-US')} of ${Math.round(v.scrollHeight).toLocaleString('en-US')}`);
  }
  return lines;
}

/** The view of a page too big to list: where it is, and what to do instead. */
function tooBig(input: ViewPlace): PageView {
  const lines = viewHeader(input);
  lines.push('', 'This page is too large to list its controls. Use extract_text to read it, and CSS selectors to act on it.');
  return { text: lines.join('\n'), labels: new Map(), identities: new Map(), options: new Map(), framed: new Set(), marks: [] };
}

/**
 * A label for a control with no name of its own: the text it contains, read
 * until it is longer than `limit`.
 */
function textWithin(node: SnapshotNode, limit: number): string {
  const parts: string[] = [];
  let length = 0;
  const walk = (n: SnapshotNode): void => {
    if (length > limit) return;
    if (n.role.startsWith('/')) return;
    const text = n.name || (TYPED.has(n.role) ? '' : n.inline);
    if (text) { parts.push(text); length += text.length + 1; }
    // A field inside contributes its name, never what is typed in it.
    if (TYPED.has(n.role)) return;
    for (const c of n.children) walk(c);
  };
  for (const c of node.children) walk(c);
  return parts.join(' ');
}

/** The option a native select shows as chosen. */
function chosenOption(node: SnapshotNode): SnapshotNode | undefined {
  return node.role === 'combobox' ? optionsOf(node).find((o) => o.attrs['selected']) : undefined;
}

/** A list's options, wherever its groups put them. */
function optionsOf(node: SnapshotNode): SnapshotNode[] {
  const found: SnapshotNode[] = [];
  const walk = (n: SnapshotNode): void => {
    for (const c of n.children) {
      if (c.role === 'option') found.push(c);
      else walk(c);
    }
  };
  walk(node);
  return found;
}

/**
 * What is typed into a field. Playwright writes it inline, or — when the
 * field shows a placeholder, or is a content-editable box — as text lines
 * under it. A list's own options are the page's, not typed.
 */
function fieldValue(node: SnapshotNode): string {
  return typedParts(node).join('');
}

function typedParts(node: SnapshotNode): string[] {
  const parts: string[] = node.inline !== undefined ? [node.inline] : [];
  const walk = (n: SnapshotNode): void => {
    for (const c of n.children) {
      if (c.role.startsWith('/') || c.role === 'option' || c.role === 'listbox') continue;
      if (c.name) parts.push(c.name);
      if (c.inline !== undefined) parts.push(c.inline);
      walk(c);
    }
  };
  walk(node);
  return parts;
}

/**
 * Controls a label can wrap together with a text field ("Other: ___"), whose
 * name the browser then builds from the field's value.
 */
const LABELLED_AROUND = new Set(['checkbox', 'radio', 'switch']);

/**
 * For each control whose name a browser may build from a field's value, the
 * values to keep out of it: the field's ancestors — a clickable label or card
 * holds its field's text as its own — and a checkbox or radio beside it, as
 * one labelled "Other:" around a text field is named "Other: " plus whatever
 * is typed there. Nowhere else: a results page that says "Results
 * for Italian" is the page's own text, and hiding a search wherever it
 * appeared would hide the answer.
 */
function valuesAround(roots: SnapshotNode[]): Map<SnapshotNode, string[]> {
  const found = new Map<SnapshotNode, Set<string>>();
  const keep = (n: SnapshotNode, values: string[]): void => {
    const set = found.get(n) ?? new Set<string>();
    values.forEach((v) => set.add(v));
    found.set(n, set);
  };
  // Each parent's checkboxes and radios, found once: a page can give one
  // parent thousands of fields, and looking again for each is quadratic.
  const labelled = new Map<SnapshotNode, SnapshotNode[]>();
  const labelledIn = (parent: SnapshotNode): SnapshotNode[] => {
    let list = labelled.get(parent);
    if (!list) labelled.set(parent, list = parent.children.filter((c) => LABELLED_AROUND.has(c.role)));
    return list;
  };
  const walk = (n: SnapshotNode, ancestors: SnapshotNode[]): void => {
    if (TYPED.has(n.role) && !chosenOption(n)) {
      const values = [...new Set([fieldValue(n), ...typedParts(n)].map((v) => v.replace(/\s+/g, ' ').trim()))]
        .filter((v) => v.length > 0);
      if (values.length) {
        keep(n, values);
        ancestors.forEach((a) => keep(a, values));
        const parent = ancestors.at(-1);
        if (parent) for (const s of labelledIn(parent)) if (s !== n) keep(s, values);
      }
      return;
    }
    for (const c of n.children) walk(c, [...ancestors, n]);
  };
  roots.forEach((r) => walk(r, []));
  return new Map([...found].map(([n, set]) => [n, [...set].sort((a, b) => b.length - a.length)]));
}

/** Below this length a typed value is hidden only where it stands alone. */
const SHORT_VALUE = 3;
/**
 * How much of a control's text is scrubbed for its name, before it is cut to
 * `NAME_LIMIT`: scrubbing reads all of what it is given, and a page decides
 * how much text a control holds.
 */
const SCRUB_TEXT_MAX = 2_000;
/** How much of a control's text its identity covers. See `PageView.identities`. */
const IDENTITY_TEXT_MAX = 100_000;
/**
 * Past this many typed values around one control, its name is hidden whole
 * rather than value by value: each value is a pass over the text.
 */
const SCRUB_VALUES_MAX = 256;

/**
 * Takes the given typed values out of page-written text, of which it returns
 * the first `SCRUB_TEXT_MAX` characters. A short one — an age, initials, two
 * digits of a code — goes where it stands as a word or number of its own:
 * inside a longer one it says nothing, and hiding it there would hide the
 * page's own words.
 */
function scrubber(values: string[] | undefined): (text: string) => string {
  const unique = [...new Set(values ?? [])].filter((v) => v.length > 0);
  if (!unique.length) return (text) => text.slice(0, SCRUB_TEXT_MAX);
  if (unique.length > SCRUB_VALUES_MAX) return () => '•••';
  // One pass for all of them, the longest first where two start together.
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const long = unique.filter((v) => v.length >= SHORT_VALUE).sort((a, b) => b.length - a.length).map(escape);
  const short = unique.filter((v) => v.length < SHORT_VALUE).sort((a, b) => b.length - a.length).map(escape);
  const pattern = new RegExp([
    ...(long.length ? [`(?:${long.join('|')})`] : []),
    ...(short.length ? [`(?<![\\p{L}\\p{N}])(?:${short.join('|')})(?![\\p{L}\\p{N}])`] : []),
  ].join('|'), 'gu');
  return (text) => {
    const read = text.slice(0, SCRUB_TEXT_MAX).replace(/\s+/g, ' ');
    // Where the text is cut, a value can start before the cut and go on past
    // it, so it is never there whole to be matched. Whatever at the end could
    // be the start of one goes, and everything after it.
    const until = text.length > SCRUB_TEXT_MAX ? runsOffAt(read, unique) : read.length;
    let out = '';
    let from = 0;
    for (const m of read.matchAll(pattern)) {
      if (m.index >= until) break;
      out += `${read.slice(from, m.index)}•••`;
      from = m.index + m[0].length;
    }
    if (until === read.length) return out + read.slice(from);
    return from < read.length ? `${out}${read.slice(from, Math.max(from, until))}•••` : out;
  };
}

/**
 * Where the end of `text` could be the start of one of `values`: the earliest
 * point from which what is left begins a value. Its length when none does.
 */
function runsOffAt(text: string, values: string[]): number {
  let at = text.length;
  for (const value of values) at = Math.min(at, text.length - overlap(text, value));
  return at;
}

/**
 * The longest end of `text` that `value` starts with. Linear in the shorter
 * of the two (Knuth–Morris–Pratt): a page decides both.
 */
function overlap(text: string, value: string): number {
  const p = value.slice(0, text.length);
  const back = new Array<number>(p.length).fill(0);
  for (let i = 1, k = 0; i < p.length; i++) {
    while (k > 0 && p[i] !== p[k]) k = back[k - 1]!;
    if (p[i] === p[k]) k++;
    back[i] = k;
  }
  let k = 0;
  for (let i = text.length - p.length; i < text.length; i++) {
    while (k > 0 && (k === p.length || text[i] !== p[k])) k = back[k - 1]!;
    if (text[i] === p[k]) k++;
  }
  return k;
}

/**
 * What is typed into the page's text boxes, long enough to hide by itself.
 * Not searches or comboboxes: a query, or a choice from a list, is what the
 * page goes on to show, and hiding it everywhere would hide the answer.
 */
function textboxValues(roots: SnapshotNode[]): string[] {
  const found = new Set<string>();
  const walk = (n: SnapshotNode): void => {
    if (n.role === 'textbox') {
      for (const v of [fieldValue(n), ...typedParts(n)]) {
        const value = v.replace(/\s+/g, ' ').trim();
        if (value.length >= SHORT_VALUE) found.add(value);
      }
      return;
    }
    for (const c of n.children) walk(c);
  };
  roots.forEach(walk);
  return [...found];
}

/**
 * Page-written text made safe to show: one line, bounded, and unable to
 * imitate the list's own syntax (`[ref]` and `"name"`). Invisible characters
 * go too — direction overrides and zero-width marks — so what a person is
 * shown in an approval reads as the text it is, in the order it is stored.
 */
export function clean(text: string, limit: number): string {
  const flat = wellFormed(text)
    // Full-width brackets and quotes read as the plain ones, and are then
    // replaced like them.
    .normalize('NFKC')
    // Invisible format characters: direction overrides, zero-width marks,
    // and the tag characters text can be hidden in.
    .replace(/\p{Cf}+/gu, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  // Cut by character, not by UTF-16 unit: half an emoji is a lone surrogate,
  // which some providers refuse in a request, and this text stays in the run's
  // history for every request after it.
  const chars = [...flat];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('').trimEnd()}…` : flat;
}

/** Text with any lone UTF-16 surrogate replaced, so it can always be sent. */
export function wellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}
