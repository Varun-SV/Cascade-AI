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
  children: SnapshotNode[];
}

/** The page's scroll state, from the page itself. */
export interface Viewport {
  width: number;
  height: number;
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

/**
 * Opens every view in a tool result. A line of its own, so the worker can find
 * a view and fold an old one away (`foldOldPageViews`).
 */
export const PAGE_VIEW_MARK = '[Page view';

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
  /** Open ancestors: indent, node, and the offset its children's boxes need. */
  const stack: Array<{ indent: number; node: SnapshotNode; dx: number; dy: number }> = [];

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
    const box = typeof parsed.attrs['box'] === 'string' ? readBox(parsed.attrs['box'], dx, dy) : undefined;
    const node: SnapshotNode = {
      role: parsed.role,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      attrs: parsed.attrs,
      ...(parsed.inline !== undefined ? { inline: parsed.inline } : {}),
      ...(box ? { box } : {}),
      children: [],
    };
    (parent ? parent.node.children : roots).push(node);
    // An iframe's contents are boxed against the iframe's own viewport, so
    // they are moved by the iframe's position to land where they are seen.
    const into = node.role === 'iframe' && box ? { dx: box.x, dy: box.y } : { dx, dy };
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

function readBox(v: string, dx: number, dy: number): { x: number; y: number; w: number; h: number } | undefined {
  const parts = v.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x: x + dx, y: y + dy, w, h };
}

// ── Choosing and describing controls ─────────

interface Entry {
  ref: string;
  box?: SnapshotNode['box'];
  heading: boolean;
  /** `button "Pay"` — the role and name, without the ref or states. */
  label: string;
  line: string;
  where: 'view' | 'below' | 'above';
}

/**
 * Build the view the model reads, or null when the snapshot has no refs — an
 * older Playwright, or a page with nothing in it — so the caller can fall back
 * to text and selectors instead of showing an empty list as if it were true.
 */
export function describePage(input: {
  snapshot: string;
  url: string;
  title: string;
  viewport: Viewport | undefined;
  /** Counts views within a run, so the model can tell a fresh one from an old one. */
  number: number;
}): PageView | null {
  const roots = parseSnapshot(input.snapshot);
  const entries: Entry[] = [];
  let sawRef = false;

  const visit = (node: SnapshotNode, insideClickable: boolean): void => {
    const ref = typeof node.attrs['ref'] === 'string' ? node.attrs['ref'] : undefined;
    if (ref) sawRef = true;
    const interactive = INTERACTIVE.has(node.role);
    const pointer = node.attrs['cursor'] === 'pointer';
    const heading = node.role === 'heading' && Number(node.attrs['level'] ?? 6) <= 3;
    // A clickable wrapper's own parts are not separate targets — unless they
    // are controls in their own right, like a button inside a clickable card.
    // A heading inside a link is the link's label, so it is not listed twice.
    const listed = Boolean(ref) && (interactive || ((heading || pointer) && !insideClickable));
    if (listed && ref) {
      const where = placement(node.box, input.viewport);
      if (where) entries.push({ ref, ...describe(node, ref), where, heading: node.role === 'heading', ...(node.box ? { box: node.box } : {}) });
    }
    for (const child of node.children) visit(child, insideClickable || interactive || pointer);
  };
  for (const root of roots) visit(root, false);
  if (!sawRef) return null;

  const view = entries.filter((e) => e.where === 'view');
  const below = entries.filter((e) => e.where === 'below');
  const above = entries.filter((e) => e.where === 'above');
  const shownView = view.slice(0, VIEW_LIMIT);
  const shownBelow = below.slice(0, BELOW_LIMIT);

  const lines: string[] = [`${PAGE_VIEW_MARK} ${input.number}]`];
  const title = clean(input.title, 120);
  lines.push(`Page: ${title ? `${title} — ` : ''}${clean(input.url, 300)}`);
  if (input.viewport) {
    const v = input.viewport;
    lines.push(`Viewport ${v.width}×${v.height}, scrolled ${Math.round(v.scrollY).toLocaleString('en-US')} of ${Math.round(v.scrollHeight).toLocaleString('en-US')}`);
  }
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
    marks: shownView.flatMap((e) => (e.box && !e.heading ? [{ ref: e.ref, x: e.box.x, y: e.box.y, w: e.box.w, h: e.box.h }] : [])),
  };
}

/** Where a control sits, or null for one that takes no space (hidden). */
function placement(box: SnapshotNode['box'], viewport: Viewport | undefined): Entry['where'] | null {
  // No boxes at all (a snapshot taken without them): keep document order and
  // call everything on screen, rather than drop every control.
  if (!box) return 'view';
  if (box.w <= 0 || box.h <= 0) return null;
  if (!viewport) return 'view';
  if (box.y >= viewport.height) return 'below';
  if (box.y + box.h <= 0) return 'above';
  if (box.x >= viewport.width || box.x + box.w <= 0) return null;
  return 'view';
}

function describe(node: SnapshotNode, ref: string): { label: string; line: string } {
  const role = INTERACTIVE.has(node.role) || node.role === 'heading'
    ? node.role
    : node.role === 'generic' ? 'clickable' : `clickable ${node.role}`;
  const label = clean(node.name || (TYPED.has(node.role) ? '' : node.inline ?? '') || textWithin(node), NAME_LIMIT);
  const named = `${role}${label ? ` "${label}"` : ''}`;
  let line = `[${ref}] ${named}`;

  const notes: string[] = [];
  if (node.role === 'heading' && typeof node.attrs['level'] === 'string') notes.push(`level ${node.attrs['level']}`);
  if (TYPED.has(node.role)) {
    const chosen = node.role === 'combobox' ? node.children.find((c) => c.role === 'option' && c.attrs['selected']) : undefined;
    if (chosen) {
      // A native select's choice is one of the page's own option labels, not
      // something a person typed.
      line += `: "${clean(chosen.name ?? '', NAME_LIMIT)}"`;
    } else {
      const typed = node.inline ?? '';
      notes.push(typed.length ? `filled, ${typed.length} char${typed.length === 1 ? '' : 's'}` : 'empty');
    }
  } else if (node.role === 'slider' && node.inline) {
    notes.push(`at ${clean(node.inline, 20)}`);
  }
  for (const [attr, word] of STATES) {
    if (node.attrs[attr] === true || node.attrs[attr] === 'true') notes.push(word);
  }
  if (notes.length) line += ` (${notes.join(', ')})`;
  return { label: named, line };
}

/** A label for a control with no name of its own: the text it contains. */
function textWithin(node: SnapshotNode): string {
  const parts: string[] = [];
  const walk = (n: SnapshotNode): void => {
    if (parts.join(' ').length > NAME_LIMIT) return;
    if (n.role.startsWith('/')) return;
    if (n.name) parts.push(n.name);
    else if (n.inline && !TYPED.has(n.role)) parts.push(n.inline);
    for (const c of n.children) walk(c);
  };
  for (const c of node.children) walk(c);
  return parts.join(' ');
}

/**
 * Page-written text made safe to show: one line, bounded, and unable to
 * imitate the list's own syntax (`[ref]` and `"name"`).
 */
export function clean(text: string, limit: number): string {
  const flat = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}
