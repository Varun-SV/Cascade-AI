// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — Model lifecycle (what providers have retired or are retiring)
// ─────────────────────────────────────────────────────────────────────────────
//
//  Cascade Auto must not hand a section of a run to a model its provider has
//  shut down or is about to. The dead-model store (dead-models.ts) learns that
//  a model 404s, but only AFTER a call fails — and a T3 wave fires its workers
//  concurrently, so the whole wave pays for the lesson. Worse, some models do
//  not 404 at all: Google's Gemini 2.x answers existing customers and refuses
//  new ones ("no longer available to new users"), so the same pick works on
//  one account and fails the run on the next. This table is what the
//  providers have already published, consulted BEFORE selection.
//
//  Status, per the providers' own terms:
//    retired     — shut down; every call fails.
//    deprecated  — still served, shutdown date announced, provider recommends
//                  moving off it ("likely to be less reliable", Anthropic).
//    restricted  — still served to some accounts only (existing customers).
//    superseded  — the id is silently routed to a newer model, so Cascade's
//                  price and benchmark for it describe the wrong model.
//
//  Every status keeps the model out of Auto. None of them stops a user who
//  PINS the model: a pin is an explicit choice, and selectForTier(override)
//  never consults this table. Auto still falls back to an excluded model when
//  nothing else is usable, because a run that might work beats one that
//  cannot start.
//
//  Statuses apply to the provider's OWN API. Azure, Bedrock, Vertex and
//  OpenAI-compatible gateways publish their own schedules, so an entry names
//  the providers it covers.
//
//  Sources (read 2026-10-28):
//    Anthropic  https://platform.claude.com/docs/en/about-claude/model-deprecations
//    OpenAI     https://developers.openai.com/api/docs/deprecations
//    Google     https://ai.google.dev/gemini-api/docs/deprecations
//               https://discuss.ai.google.dev/t/deprecation-shutdown-date-for-gemini-2-5-pro-conflicting-information/183251

import type { ModelInfo, ProviderType } from '../../types.js';

export type LifecycleStatus = 'retired' | 'deprecated' | 'restricted' | 'superseded';

export interface LifecycleEntry {
  /** Matched against the model's bare id (provider prefix and `models/` stripped). */
  match: RegExp;
  providers: ProviderType[];
  status: LifecycleStatus;
  /** ISO date the provider shuts it down (past for `retired`), when announced. */
  shutdown?: string;
  /** The provider's recommended replacement. */
  replacement?: string;
}

// An optional dated snapshot suffix: gpt-4o-2024-08-06, claude-…-20250929.
const SNAP = '(?:-\\d{4}-\\d{2}-\\d{2}|-\\d{8})?';
/** Escape every regex metacharacter, so an id is matched literally. */
const escapeRegExp = (id: string) => id.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const exact = (...ids: string[]) =>
  new RegExp(`^(?:${ids.map(escapeRegExp).join('|')})${SNAP}$`, 'i');

export const MODEL_LIFECYCLE: readonly LifecycleEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  { match: /^claude-(?:[12]|instant|3)/i, providers: ['anthropic'], status: 'retired', replacement: 'claude-sonnet-5-5' },
  { match: exact('claude-opus-4', 'claude-sonnet-4'), providers: ['anthropic'], status: 'retired', shutdown: '2026-06-15' },
  { match: exact('claude-opus-4-1'), providers: ['anthropic'], status: 'retired', shutdown: '2026-08-05', replacement: 'claude-opus-4-8' },
  { match: exact('claude-sonnet-4-5'), providers: ['anthropic'], status: 'deprecated', shutdown: '2026-11-30', replacement: 'claude-sonnet-5-5' },
  { match: exact('claude-mythos-preview'), providers: ['anthropic'], status: 'deprecated', replacement: 'claude-mythos-5-1' },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  { match: exact('gpt-4.1-nano', 'gpt-4o-2024-05-13', 'o1', 'o1-pro', 'o3-mini', 'o4-mini'), providers: ['openai'], status: 'retired', shutdown: '2026-10-23', replacement: 'gpt-5.6-luna' },
  {
    match: /^(?:gpt-5(?:\.1)?-chat-latest|gpt-5(?:\.[12])?-codex(?:-max|-mini)?|o3-deep-research|o4-mini-deep-research|gpt-4o(?:-mini)?-search-preview)/i,
    providers: ['openai'], status: 'retired', shutdown: '2026-07-23', replacement: 'gpt-5.6-sol',
  },
  { match: /^gpt-5\.[23]-chat-latest$/i, providers: ['openai'], status: 'retired', shutdown: '2026-08-10', replacement: 'gpt-5.6-sol' },
  { match: /^gpt-4\.5/i, providers: ['openai'], status: 'retired', shutdown: '2025-07-14' },
  { match: exact('o3', 'o3-pro', 'gpt-5', 'gpt-5-pro', 'gpt-5-mini', 'gpt-5-nano'), providers: ['openai'], status: 'deprecated', shutdown: '2026-12-11', replacement: 'gpt-5.6-sol' },
  { match: exact('gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'), providers: ['openai'], status: 'deprecated', shutdown: '2027-01-14', replacement: 'gpt-6-luna' },
  { match: exact('gpt-5.1', 'gpt-5.3-codex', 'gpt-5.4-nano'), providers: ['openai'], status: 'deprecated', shutdown: '2027-04-01', replacement: 'gpt-6-luna' },

  // ── Google Gemini (Gemini Developer API) ───────────────────────────────────
  { match: /^gemini-(?:1\.|2\.0-)/i, providers: ['gemini'], status: 'retired', shutdown: '2026-06-01', replacement: 'gemini-3.6-flash' },
  { match: /^gemini-2\.5-.*preview/i, providers: ['gemini'], status: 'retired', replacement: 'gemini-3.6-flash' },
  { match: /^gemini-3-pro-preview$/i, providers: ['gemini'], status: 'retired', shutdown: '2026-03-09', replacement: 'gemini-3.1-pro-preview' },
  { match: /^gemini-3\.1-flash-lite-preview$/i, providers: ['gemini'], status: 'retired', shutdown: '2026-05-25', replacement: 'gemini-3.1-flash-lite' },
  // No shutdown date, but limited to existing customers and gone from AI
  // Studio: a new key gets "no longer available to new users".
  { match: /^gemini-2\.5-(?:pro|flash|flash-lite)$/i, providers: ['gemini'], status: 'restricted', replacement: 'gemini-3.8-flash' },
  // Calls are auto-routed to the newer model, not served by the named one.
  { match: /^gemini-3\.7-flash$/i, providers: ['gemini'], status: 'superseded', replacement: 'gemini-3.8-flash' },
  { match: /^gemini-3\.5-flash$/i, providers: ['gemini'], status: 'superseded', replacement: 'gemini-3.6-flash' },
  { match: /^gemini-3-flash-preview$/i, providers: ['gemini'], status: 'deprecated', replacement: 'gemini-3.6-flash' },
  { match: /^gemini-3\.1-flash-lite$/i, providers: ['gemini'], status: 'deprecated', shutdown: '2027-05-07', replacement: 'gemini-3.5-flash-lite' },
];

/** The bare id a provider knows the model by: no `provider:`/`vendor/` or `models/` prefix. */
function bareId(model: Pick<ModelInfo, 'id' | 'baseModelId'>): string {
  const raw = (model.baseModelId ?? model.id).trim();
  return raw.replace(/^models\//i, '').replace(/^[a-z-]+:/i, '').replace(/^.*\//, '').toLowerCase();
}

/** The provider's published lifecycle entry for this model, or null when it is active. */
export function lifecycleOf(model: Pick<ModelInfo, 'id' | 'baseModelId' | 'provider'>): LifecycleEntry | null {
  const id = bareId(model);
  for (const entry of MODEL_LIFECYCLE) {
    if (entry.providers.includes(model.provider) && entry.match.test(id)) return entry;
  }
  return null;
}

/** True when Cascade Auto should not choose this model on its own. Pinning is unaffected. */
export function excludedFromAuto(model: Pick<ModelInfo, 'id' | 'baseModelId' | 'provider'>): boolean {
  return lifecycleOf(model) !== null;
}

/** One line for /why and `cascade models`: why Auto passes this model over. */
export function describeLifecycle(entry: LifecycleEntry): string {
  const when = entry.shutdown ? ` (${entry.status === 'retired' ? 'shut down' : 'shuts down'} ${entry.shutdown})` : '';
  const instead = entry.replacement ? `; provider recommends ${entry.replacement}` : '';
  const what: Record<LifecycleStatus, string> = {
    retired: 'retired by its provider',
    deprecated: 'deprecated by its provider',
    restricted: 'limited to existing customers by its provider',
    superseded: 'routed to a newer model by its provider',
  };
  return `${what[entry.status]}${when}${instead}`;
}
