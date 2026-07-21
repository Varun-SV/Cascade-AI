// ─────────────────────────────────────────────
//  Cascade AI — session → memory distillation (opt-in)
// ─────────────────────────────────────────────
//
//  When `memory.rememberSessions` is on, a finished run's conversation is
//  distilled into a few durable `(entity, relation, value)` facts and written to
//  the project knowledge store — so future runs "remember" what mattered. It is
//  deliberately opt-in: session content is sensitive, auto-distilling every chat
//  would pollute the knowledge graph, and it costs an extra model call. With the
//  history-preserving world-state (facts_history), a bad distillation is undoable
//  from the Knowledge tab.

import type { ConversationMessage } from '../../types.js';

export interface DistilledFact {
  entity: string;
  relation: string;
  value: string;
}

/** A run is worth distilling only if the conversation carried real content. */
export function sessionWorthRemembering(
  history: ConversationMessage[],
  latestPrompt: string,
  output: string,
): boolean {
  const turns = history.length + (latestPrompt ? 1 : 0);
  const historyChars = history.reduce((n, m) => n + messageText(m.content).trim().length, 0);
  const substance = historyChars + (output?.trim().length ?? 0) + (latestPrompt?.trim().length ?? 0);
  // Skip trivial exchanges (a greeting, a one-liner) — nothing durable to learn.
  return turns >= 2 && substance >= 200;
}

/** Flatten a message's content (string or multimodal blocks) to plain text. */
function messageText(content: ConversationMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : block.type === 'image' ? '[image]' : ''))
    .join(' ');
}

/**
 * Build the transcript the distiller reads: recent history + the final turn,
 * capped so a long session doesn't blow the distiller's budget.
 */
export function buildSessionTranscript(
  history: ConversationMessage[],
  latestPrompt: string,
  output: string,
  maxChars = 6000,
): string {
  const lines = [
    ...history.slice(-12).map((m) => `${m.role}: ${messageText(m.content)}`),
    `user: ${latestPrompt}`,
    `assistant: ${output}`,
  ];
  const joined = lines.join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/**
 * Distill durable facts from a session transcript via one cheap model call.
 * `generate` returns the model's raw text; parsing is defensive (a JSON array of
 * triples anywhere in the reply). Never throws — returns [] on any problem.
 */
export async function distillSessionFacts(
  transcript: string,
  generate: (prompt: string) => Promise<string>,
): Promise<DistilledFact[]> {
  const prompt = `From this conversation, extract durable facts worth remembering about the USER and their PROJECT for future sessions.
Return ONLY a JSON array of {"entity","relation","value"} triples — e.g.
{"entity":"user","relation":"prefers","value":"TypeScript"} or
{"entity":"project","relation":"deploys_to","value":"Railway"}.
Capture stable preferences, decisions, and project facts. Ignore transient chit-chat,
one-off questions, and anything already obvious. At most 6 triples. If nothing durable, return [].

Conversation:
${transcript}`;
  try {
    const raw = await generate(prompt);
    const match = /\[[\s\S]*\]/.exec(raw);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    const out: DistilledFact[] = [];
    for (const f of parsed.slice(0, 6)) {
      if (
        f && typeof f.entity === 'string' && typeof f.relation === 'string' && typeof f.value === 'string'
        && f.entity.trim() && f.relation.trim() && f.value.trim()
      ) {
        out.push({ entity: f.entity.trim(), relation: f.relation.trim(), value: f.value.trim() });
      }
    }
    return out;
  } catch {
    return [];
  }
}
