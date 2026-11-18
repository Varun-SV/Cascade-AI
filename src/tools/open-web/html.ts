// ─────────────────────────────────────────────
//  Cascade AI — Open Web: reading a page's HTML
// ─────────────────────────────────────────────
//
//  A page as a model wants it: the title, the main content with its headings,
//  lists, code and tables, and the links in it. Menus, footers, cookie banners
//  and the like are left out.
//
//  A small tokenizer and tree rather than regular expressions over the whole
//  document: it is linear in the input, so a hostile page can't make it slow,
//  and it tolerates the broken markup real pages are full of.

/** What is kept of an element. */
interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Array<Node | string>;
  parent: Node | null;
  depth: number;
}

/** The page, read. */
export interface ReadablePage {
  title: string;
  /** The main content as text: `#` headings, `-` list items, fenced code. */
  text: string;
  /** Links in the main content, absolute, in order, without duplicates. */
  links: Array<{ text: string; url: string }>;
  /** The page's own description, when it gives one. */
  description?: string;
}

/** Past this, a page is read only up to here: plenty for any article. */
export const MAX_HTML_CHARS = 3_000_000;
const MAX_NODES = 60_000;
/** Deeper than this, elements are kept flat: unclosed tags nest without end, and the tree is walked recursively. */
const MAX_DEPTH = 256;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Their content is not markup, and none of it is reading matter. */
const RAW = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes']);
/** Dropped whole, with everything in them. */
const DROPPED = new Set(['svg', 'math', 'canvas', 'nav', 'footer', 'aside', 'form', 'button', 'select', 'dialog', 'object', 'video', 'audio', 'picture', 'map']);
const DROPPED_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar', 'tablist']);
/** Names that mark page furniture, matched against a class or id one word at a time. */
const FURNITURE = new Set([
  'nav', 'navbar', 'menu', 'footer', 'sidebar', 'cookie', 'cookies', 'consent', 'banner', 'advert', 'ad', 'ads',
  'promo', 'share', 'sharing', 'social', 'related', 'comments', 'subscribe', 'newsletter', 'popup', 'modal',
  'breadcrumb', 'breadcrumbs', 'skip', 'masthead', 'toolbar', 'signup', 'paywall', 'outbrain', 'taboola',
]);
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'pre', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'figure', 'figcaption', 'hr', 'br', 'details', 'summary', 'caption', 'address',
]);
/** Opening one of these closes an open one of the same kind first: `<p>a<p>b`. */
const SELF_CLOSING_SIBLINGS: Record<string, readonly string[]> = {
  p: ['p'], li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'],
};
const KEPT_ATTRS = new Set(['id', 'class', 'role', 'href', 'hidden', 'aria-hidden', 'name', 'property', 'content', 'style']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
  trade: '™', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', times: '×',
  deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', shy: '', zwj: '', zwnj: '', thinsp: ' ', ensp: ' ', emsp: ' ',
};

/** HTML entities to characters. Exported for tests. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const name = body.toLowerCase();
    // Own entries only: `&constructor;` must not find Object's own.
    return Object.hasOwn(NAMED, name) ? NAMED[name]! : whole;
  });
}

const isNameChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** `A`–`Z` to `a`–`z`, nothing else: the same length, the same offsets. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** The document as a tree. Linear in its length. */
export function parseHtml(input: string): Node {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  // ASCII letters only, so every offset in `lower` is the same in `html`:
  // full Unicode lowercasing turns some letters (İ) into two.
  const lower = asciiLower(html);
  const root: Node = { tag: '#root', attrs: {}, children: [], parent: null, depth: 0 };
  let current = root;
  let nodes = 0;
  let i = 0;
  const n = html.length;

  const close = (tag: string): void => {
    for (let at: Node | null = current; at && at !== root; at = at.parent) {
      if (at.tag === tag) { current = at.parent ?? root; return; }
    }
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { current.children.push(html.slice(i)); break; }
    if (lt > i) current.children.push(html.slice(i, lt));
    i = lt;
    if (lower.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = html.charCodeAt(i + 1);
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      const end = html.indexOf('>', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (next === 47 /* / */) {
      let j = i + 2;
      while (j < n && isNameChar(html.charCodeAt(j))) j++;
      const tag = lower.slice(i + 2, j);
      const end = html.indexOf('>', j);
      i = end === -1 ? n : end + 1;
      if (tag) close(tag);
      continue;
    }
    if (!((next >= 97 && next <= 122) || (next >= 65 && next <= 90))) {
      // A lone '<' in text.
      current.children.push('<');
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n && isNameChar(html.charCodeAt(j))) j++;
    const tag = lower.slice(i + 1, j);
    const attrs: Record<string, string> = {};
    let selfClosed = false;
    // Attributes, with quoted values that may hold '>'.
    while (j < n) {
      const c = html.charCodeAt(j);
      if (c === 62 /* > */) { j++; break; }
      if (c === 47 /* / */ && html.charCodeAt(j + 1) === 62) { selfClosed = true; j += 2; break; }
      if (isSpace(c) || c === 47) { j++; continue; }
      const nameStart = j;
      while (j < n && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 61 && html.charCodeAt(j) !== 62 && html.charCodeAt(j) !== 47) j++;
      const name = lower.slice(nameStart, j);
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      let value = '';
      if (html.charCodeAt(j) === 61 /* = */) {
        j++;
        while (j < n && isSpace(html.charCodeAt(j))) j++;
        const q = html.charCodeAt(j);
        if (q === 34 || q === 39) {
          const end = html.indexOf(q === 34 ? '"' : "'", j + 1);
          value = html.slice(j + 1, end === -1 ? n : end);
          j = end === -1 ? n : end + 1;
        } else {
          const start = j;
          while (j < n && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 62) j++;
          value = html.slice(start, j);
        }
      }
      if (name && KEPT_ATTRS.has(name)) attrs[name] = decodeEntities(value);
      if (j === nameStart) j++;
    }
    i = j;
    if (RAW.has(tag)) {
      const end = lower.indexOf(`</${tag}`, i);
      if (end === -1) { i = n; continue; }
      const gt = html.indexOf('>', end);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    if (++nodes > MAX_NODES) break;
    // Own entries only: a <constructor> tag must not find Object's own.
    const closes = Object.hasOwn(SELF_CLOSING_SIBLINGS, tag) ? SELF_CLOSING_SIBLINGS[tag] : undefined;
    if (closes && closes.includes(current.tag)) current = current.parent ?? root;
    const node: Node = { tag, attrs, children: [], parent: current, depth: current.depth + 1 };
    current.children.push(node);
    if (!VOID.has(tag) && !selfClosed && node.depth < MAX_DEPTH) current = node;
  }
  return root;
}

function find(node: Node, test: (n: Node) => boolean, out: Node[] = []): Node[] {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (test(child)) out.push(child);
    find(child, test, out);
  }
  return out;
}

function textOf(node: Node | string): string {
  if (typeof node === 'string') return node;
  let s = '';
  for (const c of node.children) s += textOf(c);
  return s;
}

const words = (value: string | undefined): string[] => (value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Page furniture, hidden content and the like: left out of what is read. */
function isFurniture(node: Node): boolean {
  if (DROPPED.has(node.tag)) return true;
  if ('hidden' in node.attrs || node.attrs['aria-hidden'] === 'true') return true;
  if (node.attrs['role'] && DROPPED_ROLES.has(node.attrs['role'].toLowerCase())) return true;
  const style = (node.attrs['style'] ?? '').replace(/\s+/g, '').toLowerCase();
  if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
  if (node.tag === 'header' && node.parent?.tag !== 'article') return true;
  if (node.tag === 'article' || node.tag === 'main' || node.tag === 'body') return false;
  for (const w of [...words(node.attrs['class']), ...words(node.attrs['id'])]) if (FURNITURE.has(w)) return true;
  return false;
}

function prune(node: Node): void {
  node.children = node.children.filter((c) => typeof c === 'string' || !isFurniture(c));
  for (const c of node.children) if (typeof c !== 'string') prune(c);
}

const squash = (s: string): string => s.replace(/\s+/g, ' ');

/** Scores elements by the paragraphs in them, as reader modes do; the best holds the article. */
function mainContent(body: Node): Node {
  const explicit = find(body, (n) => n.tag === 'article' || n.tag === 'main' || n.attrs['role'] === 'main');
  if (explicit.length) {
    // The one with the most text: a page can mark several small cards as articles.
    let best = explicit[0]!;
    let bestLen = squash(textOf(best)).length;
    for (const e of explicit.slice(1)) {
      const len = squash(textOf(e)).length;
      if (len > bestLen * 1.2) { best = e; bestLen = len; }
    }
    if (bestLen > 200) return best;
  }
  const scores = new Map<Node, number>();
  for (const p of find(body, (x) => x.tag === 'p' || x.tag === 'pre' || x.tag === 'blockquote' || x.tag === 'td' || x.tag === 'li')) {
    const text = squash(textOf(p)).trim();
    if (text.length < 25) continue;
    const score = 1 + (text.split(',').length - 1) + Math.min(Math.floor(text.length / 100), 3);
    const parent = p.parent;
    if (parent) scores.set(parent, (scores.get(parent) ?? 0) + score);
    const grand = parent?.parent;
    if (grand) scores.set(grand, (scores.get(grand) ?? 0) + score / 2);
  }
  let best: Node = body;
  let bestScore = 0;
  for (const [node, score] of scores) {
    const all = squash(textOf(node)).length || 1;
    const linked = find(node, (x) => x.tag === 'a').reduce((sum, a) => sum + squash(textOf(a)).length, 0);
    const adjusted = score * (1 - Math.min(linked / all, 1));
    if (adjusted > bestScore) { best = node; bestScore = adjusted; }
  }
  return best;
}

function absolute(href: string, base: string | undefined): string | null {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The tree as text: blocks on their own lines, headings and list items marked. */
function render(root: Node, base: string | undefined, links: ReadablePage['links']): string {
  const out: string[] = [];
  let line = '';
  const seen = new Set<string>();
  const flush = (): void => {
    const t = line.trim();
    if (t) out.push(t);
    line = '';
  };
  const blank = (): void => { flush(); if (out.length && out[out.length - 1] !== '') out.push(''); };
  const walk = (node: Node | string, inPre: boolean): void => {
    if (typeof node === 'string') {
      const t = decodeEntities(node);
      line += inPre ? t : squash(t);
      return;
    }
    const tag = node.tag;
    if (tag === 'br') { if (inPre) line += '\n'; else flush(); return; }
    if (tag === 'hr') { blank(); return; }
    if (tag === 'pre') {
      blank();
      const code = decodeEntities(textOf(node)).replace(/\s+$/, '');
      if (code.trim()) {
        // One by one: spread into a call, a long block's lines pass the
        // engine's argument limit.
        out.push('```');
        for (const l of code.split('\n')) out.push(l);
        out.push('```', '');
      }
      return;
    }
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      blank();
      const t = squash(decodeEntities(textOf(node))).trim();
      if (t) out.push(`${'#'.repeat(Number(heading[1]))} ${t}`, '');
      return;
    }
    if (tag === 'img') return;
    const block = BLOCK.has(tag);
    if (tag === 'li') { flush(); line = '- '; }
    else if (tag === 'p' || tag === 'blockquote' || tag === 'table' || tag === 'figure') blank();
    else if (block && tag !== 'td' && tag !== 'th') flush();
    if (tag === 'td' || tag === 'th') line += line.trim() ? ' | ' : '';
    if (tag === 'a' && node.attrs['href']) {
      const url = absolute(node.attrs['href'], base);
      const text = squash(decodeEntities(textOf(node))).trim();
      if (url && text && !seen.has(url) && !url.startsWith(`${base ?? ''}#`)) { seen.add(url); links.push({ text: text.slice(0, 120), url }); }
    }
    for (const c of node.children) walk(c, inPre);
    if (tag === 'tr') flush();
    else if (tag === 'p' || tag === 'blockquote' || tag === 'table' || tag === 'figure') blank();
    else if (block && tag !== 'td' && tag !== 'th') flush();
  };
  walk(root, false);
  flush();
  // Lines that are only a list mark, and runs of blank lines.
  const kept: string[] = [];
  for (const l of out) {
    if (l === '-') continue;
    if (l === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(l);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}

/** A page's HTML, read: its title, main content and links. */
export function readHtml(html: string, url?: string): ReadablePage {
  const root = parseHtml(html);
  const titleNode = find(root, (x) => x.tag === 'title')[0];
  const metas = find(root, (x) => x.tag === 'meta');
  const meta = (key: string): string | undefined =>
    metas.find((m) => (m.attrs['property'] ?? m.attrs['name'])?.toLowerCase() === key)?.attrs['content'];
  const body = find(root, (x) => x.tag === 'body')[0] ?? root;
  const h1 = find(body, (x) => x.tag === 'h1')[0];
  const title = squash(decodeEntities(titleNode ? textOf(titleNode) : meta('og:title') ?? (h1 ? textOf(h1) : ''))).trim();
  prune(body);
  const main = mainContent(body);
  const links: ReadablePage['links'] = [];
  // Relative links resolve against the page's <base href> where it gives one
  // (the first, as browsers take it), itself resolved against the address.
  const baseHref = find(root, (x) => x.tag === 'base' && typeof x.attrs['href'] === 'string')[0]?.attrs['href'];
  const base = (baseHref !== undefined ? absolute(baseHref, url) : null) ?? url;
  const text = render(main, base, links);
  const description = meta('description') ?? meta('og:description');
  return { title, text, links, ...(description ? { description: squash(description).trim() } : {}) };
}
