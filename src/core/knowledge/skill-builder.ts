// ─────────────────────────────────────────────
//  Cascade AI — Skills written with a model's help
// ─────────────────────────────────────────────
//
//  A skill is a name, a short description and instructions (the system prompt
//  a chat follows while it is active). Three ways a model helps write one:
//
//  - draft:   from a sentence or two of what the person wants.
//  - refine:  an existing skill, changed as the person asks.
//  - suggest: skills for tasks the person keeps coming back to, read from
//             their own chats. A suggestion must name at least two of the
//             chats it came from, by their ids in the digest it was shown:
//             one chat is a task, not a habit, and an id the model invents
//             is dropped with its suggestion.
//
//  Nothing here saves anything: the host shows the result, and the person
//  keeps, edits or drops it.

import type { ConversationMessage } from '../../types.js';
import { parseModelJson } from '../../utils/json-extract.js';

/** The limits the cloud store enforces; a draft is cut to fit them. */
export const SKILL_LIMITS = { name: 60, description: 200, instructions: 8000 } as const;

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

export interface SkillSuggestion extends SkillDraft {
  /** Why it is suggested, in a sentence: the task the person keeps repeating. */
  why: string;
  /** The chats it came from (ids from the digest), at least two. */
  chats: string[];
}

export interface ChatForSkills {
  id: string;
  title?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: ConversationMessage['content'] }>;
}

const clean = (s: unknown, max: number): string =>
  typeof s === 'string' ? s.replace(/\r\n/g, '\n').trim().slice(0, max) : '';

const oneLine = (s: unknown, max: number): string =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';

function textOf(content: ConversationMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
}

/** A draft from the model's answer, cut to the store's limits; null when it has no name or instructions. */
export function parseSkillDraft(raw: string): SkillDraft | null {
  const o = parseModelJson<Record<string, unknown>>(raw, 'object');
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const name = oneLine(o['name'], SKILL_LIMITS.name);
  const instructions = clean(o['instructions'] ?? o['systemPrompt'], SKILL_LIMITS.instructions);
  if (!name || !instructions) return null;
  return { name, description: oneLine(o['description'], SKILL_LIMITS.description), instructions };
}

const SHAPE = `Answer with JSON only:
{"name": "...", "description": "...", "instructions": "..."}
- name: 2 to 5 words, title case, at most ${SKILL_LIMITS.name} characters.
- description: one sentence on what it is for, at most ${SKILL_LIMITS.description} characters.
- instructions: the system prompt the assistant follows while the skill is active, in the second person ("You are…", "When the user…"). Concrete: its role, how it works through a request, what it asks when something is unclear, the format of its answers, and what it must not do. Plain text with short paragraphs or "-" lists, no markdown headings, under ${Math.round(SKILL_LIMITS.instructions / 3)} characters.`;

/** The prompt that drafts a skill from what the person wants. */
export function draftSkillPrompt(want: string): string {
  return `You write "skills" for an AI assistant: reusable personas a person switches on for a chat.

The person wants a skill for:
"""
${want.trim().slice(0, 2000)}
"""

Write it. Keep to what they asked for; do not add duties they did not ask for.
${SHAPE}`;
}

/** The prompt that changes an existing skill as the person asks. */
export function refineSkillPrompt(skill: SkillDraft, change: string): string {
  return `You edit "skills" for an AI assistant: reusable personas a person switches on for a chat.

The skill now:
name: ${skill.name}
description: ${skill.description || '(none)'}
instructions:
"""
${skill.instructions.slice(0, SKILL_LIMITS.instructions)}
"""

The person wants this changed:
"""
${change.trim().slice(0, 2000)}
"""

Make that change and keep everything else as it is, unless it contradicts the change. Return the whole skill.
${SHAPE}`;
}

/** Most chats read for suggestions, newest first; the digest is cut to fit. */
export const SUGGEST_MAX_CHATS = 80;
const DIGEST_CHARS = 36_000;
const PER_CHAT_CHARS = 600;

/**
 * What the model reads to suggest skills: per chat, its id, title and the
 * opening of what the person asked. The assistant's replies are left out:
 * a skill is for what the person keeps asking for.
 */
export function chatDigest(chats: ChatForSkills[]): { text: string; ids: Set<string> } {
  const ids = new Set<string>();
  const parts: string[] = [];
  let used = 0;
  for (const chat of chats.slice(0, SUGGEST_MAX_CHATS)) {
    const asked = chat.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content).replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!asked.length) continue;
    const entry = `[${chat.id}] ${oneLine(chat.title ?? '', 80) || '(untitled)'}\n${asked.join(' / ').slice(0, PER_CHAT_CHARS)}`;
    if (used + entry.length > DIGEST_CHARS) break;
    parts.push(entry);
    ids.add(chat.id);
    used += entry.length;
  }
  return { text: parts.join('\n\n'), ids };
}

/** The prompt that suggests skills for tasks repeated across the person's chats. */
export function suggestSkillsPrompt(digest: string, existing: readonly string[]): string {
  return `You suggest "skills" for an AI assistant: reusable personas a person switches on for a chat.

Below are the person's chats: each starts with its id in brackets, then its title, then what they asked.
Find tasks they come back to in at least TWO different chats, where a standing set of instructions would save them repeating themselves. At most 5. None is fine.
${existing.length ? `They already have skills named: ${existing.slice(0, 50).join('; ')}. Do not suggest those again.\n` : ''}
Answer with a JSON array only:
[{"name": "...", "description": "...", "instructions": "...", "why": "...", "chats": ["id", "id"]}]
- name, description, instructions: as for any skill. Instructions in the second person, concrete, under ${Math.round(SKILL_LIMITS.instructions / 3)} characters.
- why: one sentence naming the repeated task.
- chats: the ids, from the brackets, of the chats it came from. At least two.

Chats:
${digest}`;
}

/** Suggestions from the model's answer: each must name at least two chats it was shown. */
export function parseSkillSuggestions(raw: string, shown: ReadonlySet<string>, existing: readonly string[] = []): SkillSuggestion[] {
  const arr = parseModelJson<unknown[]>(raw, 'array');
  if (!Array.isArray(arr)) return [];
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  const out: SkillSuggestion[] = [];
  for (const item of arr) {
    if (out.length >= 5) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const draft = parseSkillDraft(JSON.stringify(o));
    if (!draft || taken.has(draft.name.toLowerCase())) continue;
    const chats = Array.isArray(o['chats']) ? [...new Set(o['chats'].filter((c): c is string => typeof c === 'string' && shown.has(c)))] : [];
    if (chats.length < 2) continue;
    taken.add(draft.name.toLowerCase());
    out.push({ ...draft, why: oneLine(o['why'], 240), chats });
  }
  return out;
}

/** About what a suggestion pass reads and writes, for the estimate shown before it runs. */
export function estimateSuggest(chats: ChatForSkills[]): { chats: number; inputTokens: number; outputTokens: number } {
  const { text, ids } = chatDigest(chats);
  return { chats: ids.size, inputTokens: Math.ceil(text.length / 4) + 500, outputTokens: 2500 };
}
