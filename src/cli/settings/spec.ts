// ─────────────────────────────────────────────
//  Cascade AI — Every setting /settings shows
// ─────────────────────────────────────────────
//
//  One list, read by both the panel (/settings) and the shortcut
//  (/settings <name> <value>): what each setting is called, what it means in
//  plain words, how it is read from and written to the config, and when it
//  takes effect. Kept free of Ink so it can be tested on its own.

import type { CascadeConfig, ProviderType } from '../../types.js';
import { applyProviderApiKey } from '../../config/index.js';
import { validateConfig } from '../../config/validate.js';
import { listThemes } from '../themes/index.js';

export type SectionId = 'models' | 'account' | 'autonomy' | 'context' | 'budget' | 'tools' | 'privacy' | 'appearance';

export const SECTIONS: ReadonlyArray<{ id: SectionId; title: string }> = [
  { id: 'models', title: 'Models & keys' },
  { id: 'account', title: 'Account & sync' },
  { id: 'autonomy', title: 'Autonomy & approvals' },
  { id: 'context', title: 'Context & memory' },
  { id: 'budget', title: 'Budget' },
  { id: 'tools', title: 'Tools & browser' },
  { id: 'privacy', title: 'Privacy' },
  { id: 'appearance', title: 'Appearance' },
];

/** Something a setting does rather than a value it holds; the REPL carries it out. */
export type ActionId = 'models' | 'login' | 'logout' | 'sync-push' | 'sync-pull' | 'mcp' | 'checkpoints' | 'chatgpt-signin' | 'chatgpt-signout' | 'chatgpt-status';

export interface SettingItem {
  /** What /settings <id> <value> names it by. */
  id: string;
  section: SectionId;
  label: string;
  help: string;
  kind: 'toggle' | 'choice' | 'number' | 'text' | 'secret' | 'action';
  choices?: readonly string[];
  unit?: string;
  /** At least `min`, at most `max`; `integer` for whole numbers only. Kept to what the config schema accepts. */
  min?: number;
  max?: number;
  integer?: boolean;
  get?: (c: CascadeConfig) => unknown;
  set?: (c: CascadeConfig, value: unknown) => void;
  action?: ActionId;
  /** An action that asks for a passphrase first. */
  passphrase?: boolean;
  /** When a change takes effect: from the next run (default), or the next time Cascade starts. */
  applies?: 'next run' | 'restart';
}

const PROVIDER_KEYS: Array<{ type: ProviderType; label: string }> = [
  { type: 'anthropic', label: 'Anthropic key' },
  { type: 'openai', label: 'OpenAI key' },
  { type: 'gemini', label: 'Google Gemini key' },
];

/** `obj[path]` for a dotted path. */
function at(c: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), c);
}
/** Set `obj[path]`, making the objects on the way. `undefined` removes it. */
function put(c: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = c as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  if (value === undefined) delete o[last];
  else o[last] = value;
}
const field = (path: string, fallback?: unknown) => ({
  get: (c: CascadeConfig) => at(c, path) ?? fallback,
  set: (c: CascadeConfig, v: unknown) => put(c, path, v),
});

export const SETTINGS: SettingItem[] = [
  // ── Models & keys ──
  { id: 'models', section: 'models', label: 'Models for T1, T2, T3', help: 'Pick the model each tier uses, or leave it on Auto.', kind: 'action', action: 'models' },
  ...PROVIDER_KEYS.map(({ type, label }): SettingItem => ({
    id: `key.${type}`, section: 'models', label, kind: 'secret',
    help: `Your ${label.replace(/ key$/, '')} API key. Saved in Cascade's own key store on this machine (~/.cascade-ai), for every project.`,
    get: (c) => c.providers.find((p) => p.type === type)?.apiKey,
    set: (c, v) => {
      if (typeof v === 'string' && v) applyProviderApiKey(c.providers as never, type, v);
      else c.providers = c.providers.filter((p) => p.type !== type);
    },
  })),
  // ChatGPT plan (Sign in with ChatGPT). Distinct from the Cascade Cloud sign-in under Account & sync.
  { id: 'chatgpt', section: 'models', label: 'ChatGPT plan: Continue with ChatGPT', help: 'Use your ChatGPT plan for eligible requests, with usage included in your plan. Opens your browser. Not the same as signing in to Cascade Cloud.', kind: 'action', action: 'chatgpt-signin' },
  { id: 'chatgpt-status', section: 'models', label: 'ChatGPT plan: status and usage', help: 'Which ChatGPT account is active, whether plan usage is on, and where to manage usage (https://chatgpt.com/settings/usage).', kind: 'action', action: 'chatgpt-status' },
  { id: 'chatgpt-signout', section: 'models', label: 'ChatGPT plan: sign out', help: 'Revoke the ChatGPT session and clear its tokens on this machine.', kind: 'action', action: 'chatgpt-signout' },
  { id: 'ollama', section: 'models', label: 'Ollama address', help: 'Where your local Ollama runs, e.g. http://localhost:11434. Empty: not used.', kind: 'text',
    get: (c) => c.providers.find((p) => p.type === 'ollama')?.baseUrl,
    set: (c, v) => {
      const others = c.providers.filter((p) => p.type !== 'ollama');
      c.providers = typeof v === 'string' && v ? [...others, { ...(c.providers.find((p) => p.type === 'ollama') ?? { type: 'ollama' as const }), baseUrl: v }] : others;
    } },
  { id: 'cascadeAuto', section: 'models', label: 'Cascade Auto routing', help: 'Let Cascade choose models per task from benchmarks and price.', kind: 'toggle', ...field('cascadeAuto', true) },
  { id: 'autoBias', section: 'models', label: 'Auto picks for', help: 'What Auto weighs most when it picks a model.', kind: 'choice', choices: ['balanced', 'quality', 'cost'], ...field('autoBias', 'balanced') },

  // ── Account & sync ──
  { id: 'login', section: 'account', label: 'Sign in to Cascade Cloud', help: 'Continue your web chats here and sync settings between machines.', kind: 'action', action: 'login' },
  { id: 'logout', section: 'account', label: 'Sign out', help: 'Sign out of Cascade Cloud on this machine.', kind: 'action', action: 'logout' },
  { id: 'sync-push', section: 'account', label: 'Sync: upload this machine\'s keys', help: 'Encrypted here with a passphrase the server never sees.', kind: 'action', action: 'sync-push', passphrase: true },
  { id: 'sync-pull', section: 'account', label: 'Sync: get my keys on this machine', help: 'Download and decrypt what you uploaded from another machine.', kind: 'action', action: 'sync-pull', passphrase: true },
  { id: 'rememberSessions', section: 'account', label: 'Remember sessions', help: 'Keep what you worked on, so a later session can recall it.', kind: 'toggle', ...field('memory.rememberSessions', false) },

  // ── Autonomy & approvals ──
  { id: 'autonomy', section: 'autonomy', label: 'Mode', help: 'auto: Cascade works on its own and asks only before something /undo can\'t take back (deleting, pushing, installing, outside the project…). manual: it asks before every change.', kind: 'choice', choices: ['manual', 'auto'], ...field('autonomy', 'manual') },
  { id: 'planApproval', section: 'autonomy', label: 'Show me the plan first', help: 'never; complex: for big tasks; all / always: every task.', kind: 'choice', choices: ['never', 'complex', 'all', 'always'], ...field('planApproval', 'never') },
  { id: 'approvalTimeout', section: 'autonomy', label: 'Wait for my answer', help: 'How long a question waits for you before Cascade says no and carries on.', kind: 'number', unit: 'min', min: 1, integer: true,
    get: (c) => Math.round((c.approvalTimeoutMs ?? 600_000) / 60_000), set: (c, v) => { c.approvalTimeoutMs = Number(v) * 60_000; } },
  { id: 'approvalAdvice', section: 'autonomy', label: 'Tier advice on risky calls', help: 'Have T2 and T1 add their view to a question before it reaches you (a model call each).', kind: 'toggle', ...field('approvalAdvice', false) },
  { id: 'checkpoints', section: 'autonomy', label: 'Checkpoints and /undo', help: 'Every run is recorded before and after, so /undo can take it back. See what can be undone.', kind: 'action', action: 'checkpoints' },

  // ── Context & memory ──
  { id: 'extendedContext', section: 'context', label: 'Extended context', help: 'Compact a long conversation or big input to fit the model, instead of failing.', kind: 'toggle', ...field('extendedContext.enabled', false) },
  { id: 'contextMultiplier', section: 'context', label: 'Extended context up to', help: 'How many times the model\'s window it may compact down from.', kind: 'number', unit: '×', min: 1, max: 5, ...field('extendedContext.maxMultiplier', 2) },
  { id: 'maxSessionMessages', section: 'context', label: 'Messages kept in a session', help: 'Older messages are summarized past this.', kind: 'number', min: 10, integer: true, ...field('memory.maxSessionMessages', 1000) },
  { id: 'autoSummarizeAt', section: 'context', label: 'Summarize past', help: 'Tokens of conversation before it is summarized.', kind: 'number', unit: 'tokens', min: 1000, integer: true, ...field('memory.autoSummarizeAt', 150_000) },
  { id: 'retentionDays', section: 'context', label: 'Keep sessions for', help: 'Days before old sessions are deleted from this machine.', kind: 'number', unit: 'days', min: 1, integer: true, ...field('memory.retentionDays', 90) },
  { id: 'facts', section: 'context', label: 'Learn facts about the project', help: 'Note lasting facts from runs, to use in later ones.', kind: 'toggle', ...field('knowledge.factsExtraction', true) },
  { id: 'codeIndex', section: 'context', label: 'Code index', help: 'Index the project\'s code for code_search.', kind: 'toggle', applies: 'restart', ...field('codeIndex.enabled', true) },

  // ── Budget ──
  { id: 'maxCostPerRun', section: 'budget', label: 'Most a run may cost', help: 'A run stops starting new work past this. Empty: no cap.', kind: 'number', unit: 'USD', min: 0.01, ...field('budget.maxCostPerRunUsd') },
  { id: 'sessionBudget', section: 'budget', label: 'Most a session may cost', help: 'Empty: no cap.', kind: 'number', unit: 'USD', min: 0.01, ...field('budget.sessionBudgetUsd') },
  { id: 'dailyBudget', section: 'budget', label: 'Most a day may cost', help: 'Empty: no cap.', kind: 'number', unit: 'USD', min: 0.01, ...field('budget.dailyBudgetUsd') },
  { id: 'maxTokensPerRun', section: 'budget', label: 'Most tokens a run may use', help: 'Empty: the default (200,000).', kind: 'number', unit: 'tokens', min: 1000, integer: true, ...field('budget.maxTokensPerRun') },
  { id: 'warnAt', section: 'budget', label: 'Warn me at', help: 'Percent of a cap at which Cascade warns you.', kind: 'number', unit: '%', min: 1, max: 100, ...field('budget.warnAtPct', 80) },

  // ── Tools & browser ──
  { id: 'browser', section: 'tools', label: 'Browser', help: 'Let runs open web pages in a browser.', kind: 'toggle', applies: 'restart', ...field('tools.browserEnabled', false) },
  { id: 'agentBrowserControl', section: 'tools', label: 'Browser control', help: 'Let runs click and type on pages (still asked before anything you can\'t take back).', kind: 'toggle', applies: 'restart', ...field('tools.agentBrowserControl', false) },
  { id: 'toolCreation', section: 'tools', label: 'Let Cascade make tools', help: 'Runs may write small tools of their own, run in a sandbox.', kind: 'toggle', applies: 'restart', ...field('enableToolCreation', false) },
  { id: 'processJail', section: 'tools', label: 'Shell sandbox', help: 'auto: use bwrap or sandbox-exec where installed; off: none.', kind: 'choice', choices: ['auto', 'bwrap', 'sandbox-exec', 'off'], applies: 'restart', ...field('tools.processJail', 'auto') },
  { id: 'searxng', section: 'tools', label: 'SearXNG address', help: 'Your own SearXNG for web search. Empty: the free default.', kind: 'text', applies: 'restart', ...field('tools.webSearch.searxngUrl') },
  { id: 'braveKey', section: 'tools', label: 'Brave Search key', help: 'For web search through Brave.', kind: 'secret', applies: 'restart', ...field('tools.webSearch.braveApiKey') },
  { id: 'tavilyKey', section: 'tools', label: 'Tavily key', help: 'For web search through Tavily.', kind: 'secret', applies: 'restart', ...field('tools.webSearch.tavilyApiKey') },
  { id: 'mcp', section: 'tools', label: 'MCP servers', help: 'See your MCP servers. Add one with `cascade mcp connect <url>`.', kind: 'action', action: 'mcp' },

  // ── Privacy ──
  { id: 'telemetry', section: 'privacy', label: 'Anonymous usage stats', help: 'Counts of features used and errors; never your prompts, files or results.', kind: 'toggle', applies: 'restart', ...field('telemetry.enabled', false) },

  // ── Appearance ──
  { id: 'theme', section: 'appearance', label: 'Theme', help: 'Colours of the terminal interface.', kind: 'choice', get: (c) => c.theme, set: (c, v) => { c.theme = String(v); } },
  { id: 'altScreen', section: 'appearance', label: 'Full-screen mode', help: 'Draw in the terminal\'s alternate screen, like vim; the shell comes back as it was when you quit.', kind: 'toggle', applies: 'restart', ...field('altScreen', false) },
];

// Themes are known only once the module that lists them has loaded.
const themeItem = SETTINGS.find((s) => s.id === 'theme')!;
themeItem.choices = listThemes().map((t) => t.name);

/** The setting a name means: its id, or one label that contains it. */
export function findSetting(name: string): SettingItem | undefined {
  const q = name.toLowerCase();
  const word = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return SETTINGS.find((s) => s.id.toLowerCase() === q)
    ?? SETTINGS.find((s) => s.label.toLowerCase() === q)
    ?? SETTINGS.find((s) => word.test(s.label.toLowerCase()))
    ?? SETTINGS.find((s) => s.label.toLowerCase().includes(q));
}

/** A word that looks like a key, whatever it was typed after. */
const LOOKS_LIKE_KEY = /^(?:sk-|sk_|xai-|gsk_|ghp_|gho_|github_pat_|AIza|pk-|rk-|hf_)\S{8,}$|^[A-Za-z0-9_\-+/=.]{32,}$/;

/**
 * A /settings command as it may be shown and kept: a value typed for a key
 * ("/settings key.openai sk-…"), or anything that looks like one, is masked.
 * The panel refuses keys typed on the command line, but the line itself is
 * echoed into the chat, which later runs send to the model and /export saves.
 */
export function redactSecrets(line: string): string {
  const m = /^(\/settings\s+)(\S+)(\s+[\s\S]*)?$/i.exec(line.trim());
  if (!m) return line;
  const [, head, name, rest] = m;
  const masked = (words: string) => words.replace(/\S+/g, (w) => (LOOKS_LIKE_KEY.test(w) ? '••••' : w));
  if (LOOKS_LIKE_KEY.test(name!)) return `${head}•••• ${rest ? masked(rest).trim() : ''}`.trim();
  if (!rest?.trim()) return line.trim();
  return findSetting(name!)?.kind === 'secret' ? `${head}${name} ••••` : `${head}${name} ${masked(rest).trim()}`;
}

/** How a setting's value is shown. A secret shows only that it is set, and its last four characters. */
export function display(item: SettingItem, config: CascadeConfig): string {
  if (item.kind === 'action') return '';
  const v = item.get?.(config);
  if (item.kind === 'secret') return typeof v === 'string' && v ? `set ••••${v.slice(-4)}` : 'not set';
  if (item.kind === 'toggle') return v ? 'on' : 'off';
  if (v === undefined || v === null || v === '') return item.kind === 'number' ? 'no cap' : '—';
  if (item.kind === 'number') return `${typeof v === 'number' ? v.toLocaleString('en-US') : String(v)}${item.unit ? ` ${item.unit}` : ''}`;
  return String(v);
}

/** Read what a person typed for a setting. An empty number or text clears it. */
export function parseValue(item: SettingItem, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim();
  switch (item.kind) {
    case 'toggle': {
      if (/^(on|true|yes|1|enable|enabled)$/i.test(text)) return { ok: true, value: true };
      if (/^(off|false|no|0|disable|disabled)$/i.test(text)) return { ok: true, value: false };
      return { ok: false, error: `${item.label} is on or off.` };
    }
    case 'choice': {
      const choice = item.choices?.find((c) => c.toLowerCase() === text.toLowerCase());
      return choice ? { ok: true, value: choice } : { ok: false, error: `${item.label} is one of: ${item.choices?.join(', ')}.` };
    }
    case 'number': {
      if (!text) return { ok: true, value: undefined };
      const n = Number(text.replace(/[,_$%]/g, ''));
      const range = [item.min !== undefined ? `at least ${item.min}` : '', item.max !== undefined ? `at most ${item.max}` : ''].filter(Boolean).join(' and ');
      if (!Number.isFinite(n) || (item.min !== undefined && n < item.min) || (item.max !== undefined && n > item.max) || (item.integer && !Number.isInteger(n))) {
        return { ok: false, error: `${item.label} is a ${item.integer ? 'whole number' : 'number'}${range ? ` ${range}` : ''}.` };
      }
      return { ok: true, value: n };
    }
    case 'text':
      if (text && /address|url/i.test(item.label) && !/^https?:\/\/\S+$/i.test(text)) return { ok: false, error: `${item.label} is a web address, starting http:// or https://.` };
      return { ok: true, value: text || undefined };
    case 'secret':
      if (/\s/.test(text)) return { ok: false, error: 'A key has no spaces in it.' };
      return { ok: true, value: text || undefined };
    default:
      return { ok: false, error: `${item.label} is something to do, not a value: choose it in /settings.` };
  }
}

/** The next value of a toggle or choice, for Enter in the panel. */
export function nextValue(item: SettingItem, config: CascadeConfig): unknown {
  const v = item.get?.(config);
  if (item.kind === 'toggle') return !v;
  if (item.kind === 'choice' && item.choices?.length) {
    const i = item.choices.indexOf(String(v));
    return item.choices[(i + 1) % item.choices.length];
  }
  return v;
}

/** What to say once a setting has changed. */
export function changedText(item: SettingItem, config: CascadeConfig): string {
  const shown = display(item, config);
  const when = item.applies === 'restart' ? ' Takes effect the next time you start Cascade.' : '';
  return `${item.label}: ${shown}.${when}`;
}

/**
 * The config as it would be with this change, checked against the schema
 * Cascade validates on load, before anything is changed or saved: a value
 * the schema refuses must never reach the file, where it would stop the
 * next start.
 */
export function tryChange(config: CascadeConfig, item: SettingItem, value: unknown): { ok: true } | { ok: false; error: string } {
  const candidate = structuredClone(config);
  item.set?.(candidate, value);
  try {
    validateConfig(candidate);
    return { ok: true };
  } catch (err) {
    const issue = (err as { issues?: Array<{ message?: string }> }).issues?.[0]?.message;
    return { ok: false, error: `${item.label} can't be ${display(item, candidate)}: ${issue ?? (err instanceof Error ? err.message.split('\n')[0] : String(err))}` };
  }
}
