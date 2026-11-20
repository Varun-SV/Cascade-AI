// ─────────────────────────────────────────────
//  Cascade extension — the user's answer to a run, and answers kept for a chat
// ─────────────────────────────────────────────
//
//  What the consent window sends back, read as the consent a run gets. And, when the
//  user ticks "use this answer for this chat", that answer kept for the chat's later
//  runs: in session storage, so it goes when Chrome closes, and for a few hours at
//  most. The chat is named by the server's opaque key; it is the user's own choice to
//  trust their server that far.

import { parseSites } from '../../src/browser/relay/consent-input.js';
import { type UserConsent, DEFAULT_RUN_TABS, tabsAllowed } from '../../src/browser/relay/device.js';
import { makeConsent } from '../../src/browser/relay/egress-rules.js';

/** What the consent window sends. */
export interface ConsentForm {
  sites: string;
  /** Any public site, instead of (or as well as) the ones typed. */
  anyPublic: boolean;
  /** A private (incognito) window: signed out of everything, cleared when it closes. */
  incognito: boolean;
  /** Keep this answer for later runs from the same chat. */
  remember: boolean;
  /**
   * Still screenshots of the run's pages may go to the server, for the run's
   * report. Off unless ticked. Password, card and code fields are blurred.
   */
  screenshots?: boolean;
  /** How many tabs the run may have at once. Four unless the person picks. */
  maxTabs?: number;
}

export const MAX_SITES = 50;
/** How long a kept answer lasts, at most. Chrome closing clears it sooner. */
export const REMEMBER_MS = 8 * 60 * 60 * 1000;

const PRIVATE_REFUSED = "Sites on your private network can't be used from your own Chrome: the extension can't keep a run off them. Use the Cascade CLI or desktop app for those.";

/** The consent a form gives; null is a no; an error is asked again. */
export function consentFromForm(form: Pick<ConsentForm, 'sites' | 'anyPublic' | 'screenshots' | 'maxTabs'>): { consent: UserConsent } | { error: string } | null {
  const parsed = parseSites(form.sites);
  if (parsed && 'error' in parsed) return parsed;
  if (!parsed && !form.anyPublic) return null;
  const allowedOrigins = parsed?.consent.allowedOrigins ?? [];
  if (allowedOrigins.length > MAX_SITES) return { error: `Allow at most ${MAX_SITES} sites for one run.` };
  if (parsed?.consent.privateOrigins.length) return { error: PRIVATE_REFUSED };
  const anyPublic = form.anyPublic || parsed?.consent.anyPublic === true;
  // Checked here as the policy will read it: an answer it would refuse is asked again.
  const screenshots = form.screenshots === true;
  makeConsent(allowedOrigins, [], { anyPublic, screenshots });
  const maxTabs = tabsAllowed({ maxTabs: form.maxTabs ?? DEFAULT_RUN_TABS });
  return { consent: { allowedOrigins, privateOrigins: [], ...(anyPublic ? { anyPublic } : {}), ...(screenshots ? { screenshots } : {}), maxTabs } };
}

/** An answer kept for one chat's runs. */
export interface KeptAnswer { sites: string; anyPublic: boolean; incognito: boolean; screenshots: boolean; maxTabs?: number; until: number }

/** Where answers are kept: chrome.storage.session, or a stand-in in tests. */
export interface AnswerStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const KEY = 'keptAnswers';
/** Kept per server and chat: a chat on another server is another chat. */
export const keptKey = (server: string, chat: string): string => `${server}|${chat}`;

async function all(store: AnswerStore, now: number): Promise<Record<string, KeptAnswer>> {
  const raw = (await store.get(KEY))[KEY];
  const out: Record<string, KeptAnswer> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, Partial<KeptAnswer>>)) {
      if (v && typeof v.sites === 'string' && typeof v.until === 'number' && v.until > now) {
        out[k] = { sites: v.sites, anyPublic: v.anyPublic === true, incognito: v.incognito !== false, screenshots: v.screenshots === true, ...(typeof v.maxTabs === 'number' ? { maxTabs: tabsAllowed({ maxTabs: v.maxTabs }) } : {}), until: v.until };
      }
    }
  }
  return out;
}

export async function recallAnswer(store: AnswerStore, key: string, now: number): Promise<KeptAnswer | null> {
  return (await all(store, now))[key] ?? null;
}

export async function keepAnswer(store: AnswerStore, key: string, form: ConsentForm, now: number): Promise<void> {
  const kept = await all(store, now);
  kept[key] = { sites: form.sites, anyPublic: form.anyPublic, incognito: form.incognito, screenshots: form.screenshots === true, maxTabs: tabsAllowed({ maxTabs: form.maxTabs ?? DEFAULT_RUN_TABS }), until: now + REMEMBER_MS };
  await store.set({ [KEY]: kept });
}

export async function keptCount(store: AnswerStore, now: number): Promise<number> {
  return Object.keys(await all(store, now)).length;
}

export async function forgetAnswers(store: AnswerStore): Promise<void> {
  await store.set({ [KEY]: {} });
}
