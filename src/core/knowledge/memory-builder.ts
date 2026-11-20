// ─────────────────────────────────────────────
//  Cascade AI — Memories built from a person's chats
// ─────────────────────────────────────────────
//
//  The person picks the chats; each is read once by a cheap model, which
//  proposes memories about them. Nothing is saved here: what comes back are
//  CANDIDATES for the person to accept, edit or reject.
//
//  Shaped as evidence-backed claims (the EviCortex model) rather than loose
//  notes:
//
//  - A claim is one sentence in one of six categories, and says whether it
//    holds for good or only for now.
//  - Every claim carries evidence: the person's own words it was drawn from,
//    quoted, and the chat they are in. A claim whose quote isn't really in what
//    the person wrote is dropped, which is what keeps a model from inventing
//    things about someone.
//  - A claim close to one already kept is not a second copy: it is more
//    evidence for that one, or, when it differs, a proposed revision the person
//    decides on, the old wording kept beside the new.
//
//  Storage is behind `MemoryBackend`, so the same claims can live in the
//  server's database today and in EviCortex later.

import type { ConversationMessage, ModelInfo } from '../../types.js';
import { resolveModelPricing } from '../../utils/cost.js';
import { parseModelJson } from '../../utils/json-extract.js';

export const MEMORY_CATEGORIES = [
  { id: 'about-you', label: 'About you', hint: 'who they are: name, role, background, where they live, languages' },
  { id: 'preferences', label: 'Preferences', hint: 'how they like things done: tools, languages, style, format, tone' },
  { id: 'projects', label: 'Projects & work', hint: 'what they are building or working on, and decisions made about it' },
  { id: 'goals', label: 'Goals', hint: 'what they are aiming for, near or far' },
  { id: 'instructions', label: 'Instructions', hint: 'standing rules for the assistant: always or never do something' },
  { id: 'facts', label: 'Facts', hint: 'other lasting facts about them or their world' },
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]['id'];
const CATEGORY_IDS = MEMORY_CATEGORIES.map((c) => c.id) as readonly string[];

/**
 * The category a stored or proposed label means. The categories people typed
 * before there was a fixed list (STACK, STYLE, PROJECT, "session"…) are read
 * into the nearest one; anything else is a Fact.
 */
export function normalizeCategory(raw: unknown): MemoryCategory {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s_]+/g, '-') : '';
  if (CATEGORY_IDS.includes(s)) return s as MemoryCategory;
  if (/^(about|me|user|profile|identity|bio|personal|who)/.test(s)) return 'about-you';
  if (/(prefer|style|stack|tool|tone|format|taste|like)/.test(s)) return 'preferences';
  if (/(project|work|job|company|product|repo|code)/.test(s)) return 'projects';
  if (/(goal|plan|aim|ambition|target)/.test(s)) return 'goals';
  if (/(instruct|rule|always|never|policy|guideline)/.test(s)) return 'instructions';
  return 'facts';
}

export interface MemoryEvidence {
  /** The chat the words are from. */
  conversationId: string;
  /** The person's own words, as they wrote them. */
  quote: string;
  /** When they wrote them (ms). */
  at: number;
}

/** A memory as the person keeps it. */
export interface StoredMemory {
  id: string;
  content: string;
  category: string | null;
  durability: 'permanent' | 'volatile';
  evidence?: MemoryEvidence[];
}

/** Where memories are kept: the server's database now, EviCortex later. */
export interface MemoryBackend {
  list(userId: string): StoredMemory[] | Promise<StoredMemory[]>;
  add(userId: string, memory: Omit<StoredMemory, 'id'> & { source: string }): StoredMemory | Promise<StoredMemory>;
  /** Adds evidence to a kept memory, and with `content`, revises it (the old wording is kept). */
  revise(userId: string, id: string, change: { evidence: MemoryEvidence[]; content?: string; category?: string; durability?: 'permanent' | 'volatile' }): StoredMemory | null | Promise<StoredMemory | null>;
}

export interface ChatForMemory {
  id: string;
  title?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: ConversationMessage['content']; createdAt: number }>;
}

/** A proposed memory, waiting for the person's yes. */
export interface MemoryCandidate {
  category: MemoryCategory;
  content: string;
  durability: 'permanent' | 'volatile';
  evidence: MemoryEvidence[];
  /** new: nothing like it is kept. known: it is kept already; this is more evidence. revision: a kept one says it differently. */
  status: 'new' | 'known' | 'revision';
  /** The kept memory it matches, for `known` and `revision`. */
  matches?: { id: string; content: string };
}

const MAX_PER_CHAT = 8;
const MAX_CONTENT = 280;
const MAX_QUOTE = 240;

function textOf(content: ConversationMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
}

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** What the person wrote in a chat, for checking a quote against. */
function userWords(chat: ChatForMemory): string {
  return squash(chat.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n'));
}

/** Whether a chat has anything of the person's own to learn from. */
export function chatWorthReading(chat: ChatForMemory): boolean {
  return userWords(chat).length >= 40;
}

/**
 * The transcript the model reads: the person's turns in full where they fit, the
 * assistant's cut short (memories are about the person, not what was said to them),
 * the most recent kept when it is too long.
 */
export function chatTranscript(chat: ChatForMemory, maxChars = 9000): string {
  const lines = chat.messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const t = textOf(m.content).trim();
      return m.role === 'user' ? `USER: ${t}` : `ASSISTANT: ${t.length > 400 ? `${t.slice(0, 400)}…` : t}`;
    });
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}

export function memoryPrompt(chat: ChatForMemory): string {
  const cats = MEMORY_CATEGORIES.map((c) => `- "${c.id}": ${c.hint}`).join('\n');
  return `Read this conversation between a person (USER) and an assistant. List what is worth remembering ABOUT THE PERSON for future conversations.

Categories:
${cats}

Rules:
- Only what the person said or clearly showed about themselves. Nothing the assistant said, nothing about other people's private lives, no passwords, keys, card or ID numbers, health or other sensitive details unless the person plainly asked to be remembered that way.
- Lasting things, not one-off questions or chit-chat. A request for help is not a memory; a preference or fact revealed in it can be.
- Each memory is one short sentence about the person, written in the second person ("You prefer TypeScript", "You are building Cascade, a multi-tier AI tool").
- "durable": true when it should hold for good, false when it is true now but expected to change (a current project, a deadline).
- "quote": the person's OWN words it comes from, copied exactly from a USER line, at most 200 characters.
- At most ${MAX_PER_CHAT}. If there is nothing worth keeping, return [].

Return ONLY a JSON array of {"category","memory","durable","quote"}.

Conversation:
${chatTranscript(chat)}`;
}

/**
 * The memories one chat yields, each with the person's words as evidence. One
 * model call; never throws. A memory whose quote isn't in what the person wrote
 * is dropped: the quote is the evidence, and a made-up one is no evidence.
 */
export async function extractFromChat(chat: ChatForMemory, generate: (prompt: string) => Promise<string>): Promise<MemoryCandidate[]> {
  if (!chatWorthReading(chat)) return [];
  let raw: string;
  try { raw = await generate(memoryPrompt(chat)); } catch { return []; }
  const parsed = parseModelJson<unknown[]>(raw, 'array');
  if (!Array.isArray(parsed)) return [];
  const words = userWords(chat);
  const lastUserAt = [...chat.messages].reverse().find((m) => m.role === 'user')?.createdAt ?? Date.now();
  const out: MemoryCandidate[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_PER_CHAT) break;
    const r = item as { category?: unknown; memory?: unknown; durable?: unknown; quote?: unknown };
    const content = typeof r.memory === 'string' ? r.memory.trim().replace(/\s+/g, ' ') : '';
    const quote = typeof r.quote === 'string' ? r.quote.trim().replace(/^["“]|["”]$/g, '') : '';
    if (!content || content.length > MAX_CONTENT * 2 || !quote) continue;
    if (!words.includes(squash(quote))) continue;
    const at = chat.messages.find((m) => m.role === 'user' && squash(textOf(m.content)).includes(squash(quote)))?.createdAt ?? lastUserAt;
    out.push({
      category: normalizeCategory(r.category),
      content: content.slice(0, MAX_CONTENT),
      durability: r.durable === false ? 'volatile' : 'permanent',
      evidence: [{ conversationId: chat.id, quote: quote.slice(0, MAX_QUOTE), at }],
      status: 'new',
    });
  }
  return out;
}

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'be', 'you', 'your', 'yours', 'i', 'my', 'me', 'at', 'as', 'it', 'that', 'this', 'by', 'from']);
function terms(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9+#.\s-]/g, ' ').split(/\s+/).map((w) => w.replace(/[.-]+$/, '')).filter((w) => w && !STOP.has(w)));
}

/** How alike two memories read, 0–1 (shared words over all words). */
export function similarity(a: string, b: string): number {
  const x = terms(a);
  const y = terms(b);
  if (!x.size || !y.size) return squash(a) === squash(b) ? 1 : 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/** At or above: the same memory. */
export const SAME = 0.8;
/** At or above, in the same category: the same subject said differently, a revision to decide on. */
export const RELATED = 0.45;

/**
 * Candidates from many chats, merged among themselves and set against what the
 * person keeps: the same memory found in several chats is one candidate with all
 * its evidence; one already kept is `known`; one a kept memory says differently is
 * a `revision`. In category order, the best-evidenced first.
 */
export function reconcile(existing: StoredMemory[], found: MemoryCandidate[]): MemoryCandidate[] {
  const merged: MemoryCandidate[] = [];
  for (const c of found) {
    const twin = merged.find((m) => m.category === c.category && similarity(m.content, c.content) >= SAME);
    if (twin) {
      for (const e of c.evidence) if (!twin.evidence.some((x) => x.conversationId === e.conversationId && x.quote === e.quote)) twin.evidence.push(e);
      if (c.durability === 'permanent') twin.durability = 'permanent';
    } else {
      merged.push({ ...c, evidence: [...c.evidence] });
    }
  }
  for (const c of merged) {
    let best: { m: StoredMemory; s: number } | null = null;
    for (const m of existing) {
      const s = similarity(m.content, c.content);
      if (!best || s > best.s) best = { m, s };
    }
    if (!best) continue;
    if (best.s >= SAME) {
      c.status = 'known';
      c.matches = { id: best.m.id, content: best.m.content };
    } else if (best.s >= RELATED && normalizeCategory(best.m.category) === c.category) {
      c.status = 'revision';
      c.matches = { id: best.m.id, content: best.m.content };
    }
  }
  const order = (c: MemoryCandidate): number => CATEGORY_IDS.indexOf(c.category);
  return merged.sort((a, b) => order(a) - order(b) || b.evidence.length - a.evidence.length);
}

/** What reading these chats will cost, roughly: one call each, its prompt and a short reply. */
export function estimateBuild(chats: ChatForMemory[]): { chats: number; inputTokens: number; outputTokens: number } {
  const worth = chats.filter(chatWorthReading);
  const promptOverhead = 450;
  const inputTokens = worth.reduce((n, c) => n + Math.ceil(chatTranscript(c).length / 4) + promptOverhead, 0);
  return { chats: worth.length, inputTokens, outputTokens: worth.length * 350 };
}

/**
 * What a build would cost on `model`, in USD, from `estimateBuild`'s tokens.
 * Null when the model has no known price: an estimate of $0 would mislead.
 */
export function estimateBuildCostUsd(est: { inputTokens: number; outputTokens: number }, model: ModelInfo | undefined): number | null {
  if (!model) return null;
  // One call per chat, each a few thousand tokens: a banded model is priced on
  // a call's size, never on the build's total.
  const price = resolveModelPricing(model, { inputTokens: 10_000 });
  if (price.unknown) return null;
  return (est.inputTokens / 1000) * price.input + (est.outputTokens / 1000) * price.output;
}

