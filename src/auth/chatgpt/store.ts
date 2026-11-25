// ─────────────────────────────────────────────
//  Cascade AI — Sign in with ChatGPT: host ID and credential store
// ─────────────────────────────────────────────
//
//  Two small files under ~/.cascade-ai (or CASCADE_GLOBAL_DIR), both 0600 in
//  a 0700 folder, written atomically:
//
//    chatgpt-host.json      this machine's stable ext_agent_host_id
//    chatgpt-accounts.json  one protected record per account registration
//                           (issued client_id + verified subject), and which
//                           of them is active
//
//  The CLI and the desktop app can run at once on the same folder, so every
//  change is a read-modify-write under a lock file: neither drops the
//  other's. Tokens never leave this file except as a bearer on a request to
//  OpenAI; nothing here logs them.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock } from '../../utils/file-lock.js';
import { GLOBAL_CONFIG_DIR } from '../../constants.js';
import { ACCOUNTS_FILE, CHATGPT_ISSUER, HOST_ID_FILE, PLAN_USAGE_SCOPE } from './constants.js';

/** Where the files live: `CASCADE_GLOBAL_DIR` when set (tests, portable installs), else `~/.cascade-ai`. */
export function chatGptDir(): string {
  const override = process.env['CASCADE_GLOBAL_DIR'];
  return override ? path.resolve(override) : path.join(os.homedir(), GLOBAL_CONFIG_DIR);
}

// ── Host ID ──────────────────────────────────

/**
 * This host's `ext_agent_host_id`: a UUIDv4 in `urn:uuid:` form, generated
 * once and kept. It is an opaque identifier, not a credential, and is chosen
 * before the first sign-in. A host that imports credentials keeps its own.
 */
export function getHostId(dir: string = chatGptDir()): string {
  const file = path.join(dir, HOST_ID_FILE);
  const read = (): string | undefined => {
    try {
      const v = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { ext_agent_host_id?: unknown }).ext_agent_host_id;
      return typeof v === 'string' && /^urn:uuid:[0-9a-f-]{36}$/i.test(v) ? v : undefined;
    } catch { return undefined; }
  };
  const existing = read();
  if (existing) return existing;

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Two processes starting together must agree on one value: create with
  // `wx` and, when the other got there first, read what it wrote.
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const body = JSON.stringify({ ext_agent_host_id: id, created_at: new Date().toISOString() }, null, 2);
  try {
    fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
    return id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = read();
      if (winner) return winner;
      // A file left unreadable: replace it, atomically.
      writeAtomic(file, body);
      return id;
    }
    throw err;
  }
}

// ── Records ──────────────────────────────────

/** One account registration, in the shape the spec's example gives, plus what Cascade needs to resume. */
export interface ChatGptAccount {
  email: string;
  issuer: string;
  /** The verified ID-token `sub`. Not a workspace identifier. */
  subject: string;
  /** The ISSUED client ID (`oaiapp_…`), never `dynamic_agent_client`. */
  client_id: string;
  ext_agent_host_id: string;
  /** Kept so a later sign-in can send it as `id_token_hint`. May be expired. */
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type: 'Bearer';
  expires_in: number;
  scopes: string[];
  /** UTC time this app received the current token response. */
  saved_at: string;
  /** The token endpoint's hint for the earliest useful refresh time, when it gave one. */
  earliest_refresh_at?: string;
  /** Tokens were cleared (signed out, or the refresh token is no longer usable): sign in again. */
  needs_sign_in?: boolean;
  /** Why `needs_sign_in` is set, for the status line. */
  signed_out_reason?: 'signed_out' | 'refresh_failed' | 'registration_invalid';
  /**
   * OpenAI no longer recognises this issued client (`invalid_client` on refresh).
   * The next sign-in registers afresh with `dynamic_agent_client`, under this
   * host's same host ID, instead of re-authorizing the dead client.
   */
  registration_invalid?: boolean;
}

export interface ChatGptStoreFile {
  version: 1;
  /** `client_id` of the active registration. */
  active?: string;
  /** The first-sign-in welcome was shown and dismissed. */
  welcome_shown?: boolean;
  accounts: ChatGptAccount[];
}

export interface PublicAccount {
  /** The issued client ID: the stable key of this registration. */
  id: string;
  email: string;
  /** Distinct, stable label: the email, plus the client ID's tail when two registrations share an email. */
  label: string;
  active: boolean;
  signedIn: boolean;
  planUsageEnabled: boolean;
  needsSignIn: boolean;
  signedOutReason?: 'signed_out' | 'refresh_failed' | 'registration_invalid';
  /** The registration itself is dead: signing in again registers a new one. */
  registrationInvalid?: boolean;
  /** ISO time the current access token expires, when there is one. */
  accessTokenExpiresAt?: string;
}

const emptyStore = (): ChatGptStoreFile => ({ version: 1, accounts: [] });

const isAccount = (a: unknown): a is ChatGptAccount => {
  if (!a || typeof a !== 'object') return false;
  const r = a as Record<string, unknown>;
  return typeof r['client_id'] === 'string' && typeof r['subject'] === 'string'
    && typeof r['email'] === 'string' && Array.isArray(r['scopes']);
};

function parseStore(raw: string): ChatGptStoreFile {
  const parsed = JSON.parse(raw) as Partial<ChatGptStoreFile>;
  if (!parsed || typeof parsed !== 'object' || (parsed.accounts !== undefined && !Array.isArray(parsed.accounts))) {
    throw new Error('it is not a list of accounts');
  }
  const accounts = (parsed.accounts ?? []).filter(isAccount);
  return {
    version: 1,
    ...(typeof parsed.active === 'string' && accounts.some((a) => a.client_id === parsed.active) ? { active: parsed.active } : {}),
    ...(parsed.welcome_shown === true ? { welcome_shown: true } : {}),
    accounts,
  };
}

/** The store; missing or unreadable reads as empty (never throws). */
export function readStore(dir: string = chatGptDir()): ChatGptStoreFile {
  try {
    return parseStore(fs.readFileSync(path.join(dir, ACCOUNTS_FILE), 'utf-8'));
  } catch {
    return emptyStore();
  }
}

/** Atomic, owner-only write: a file of this writer's own, then a rename. */
export function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // rename keeps the tmp file's 0600; chmod again in case an older, looser file existed.
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

/**
 * Change the store: read it and write it back holding its lock, so two
 * processes each start from what the other wrote. A file that is there but
 * cannot be read is an error, not an empty store: writing over it would lose
 * every account in it.
 */
export function updateStore<T = void>(
  dir: string,
  change: (store: ChatGptStoreFile) => T,
): T {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, ACCOUNTS_FILE);
  return withLock(`${file}.lock`, 'save the ChatGPT account', () => {
    let store = emptyStore();
    try {
      store = parseStore(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`The ChatGPT account was not saved: ${file} cannot be read (${err instanceof Error ? err.message : String(err)}). Fix the file, or move it aside to start afresh.`);
      }
    }
    const result = change(store);
    writeAtomic(file, JSON.stringify(store, null, 2));
    return result;
  });
}

// ── Reading a record ─────────────────────────

export function findAccount(store: ChatGptStoreFile, id: string | undefined): ChatGptAccount | undefined {
  return id ? store.accounts.find((a) => a.client_id === id) : undefined;
}

/** The active registration, or undefined when there is none. */
export function activeAccount(store: ChatGptStoreFile): ChatGptAccount | undefined {
  return findAccount(store, store.active);
}

export const hasPlanScope = (a: Pick<ChatGptAccount, 'scopes'>): boolean => a.scopes.includes(PLAN_USAGE_SCOPE);

/** Holds a refresh token and has not been marked unusable. */
export const isSignedIn = (a: ChatGptAccount): boolean => Boolean(a.refresh_token) && a.needs_sign_in !== true;

/** Signed in AND approved for ChatGPT plan usage: what inference requires. */
export const canUsePlan = (a: ChatGptAccount | undefined): a is ChatGptAccount =>
  Boolean(a && isSignedIn(a) && hasPlanScope(a));

export function expiresAtMs(a: Pick<ChatGptAccount, 'saved_at' | 'expires_in'>): number {
  const saved = Date.parse(a.saved_at);
  return (Number.isFinite(saved) ? saved : 0) + Math.max(0, a.expires_in) * 1000;
}

/** Distinct labels: the email, with the registration's tail when an email repeats. */
export function accountLabel(store: ChatGptStoreFile, a: ChatGptAccount): string {
  const same = store.accounts.filter((x) => x.email.toLowerCase() === a.email.toLowerCase());
  return same.length > 1 ? `${a.email} (${a.client_id.slice(-6)})` : a.email;
}

export function toPublic(store: ChatGptStoreFile, a: ChatGptAccount): PublicAccount {
  return {
    id: a.client_id,
    email: a.email,
    label: accountLabel(store, a),
    active: store.active === a.client_id,
    signedIn: isSignedIn(a),
    planUsageEnabled: hasPlanScope(a),
    needsSignIn: a.needs_sign_in === true || !a.refresh_token,
    ...(a.signed_out_reason ? { signedOutReason: a.signed_out_reason } : {}),
    ...(a.registration_invalid ? { registrationInvalid: true } : {}),
    ...(a.access_token ? { accessTokenExpiresAt: new Date(expiresAtMs(a)).toISOString() } : {}),
  };
}

/** Whether the plan is usable right now on this machine: a quick, local, token-free check. */
export function chatGptPlanReady(dir: string = chatGptDir()): boolean {
  return canUsePlan(activeAccount(readStore(dir)));
}

/** The issuer every stored registration must have been issued by. */
export const EXPECTED_ISSUER = CHATGPT_ISSUER;

/**
 * A registration with its usable tokens removed. Signing out also drops the ID
 * token (the spec clears access, refresh and ID tokens); a refresh token that
 * stopped working keeps it, because it only names the account for the next
 * sign-in's `id_token_hint` and grants nothing.
 */
export function withoutTokens(a: ChatGptAccount, reason: 'signed_out' | 'refresh_failed' | 'registration_invalid'): ChatGptAccount {
  const { access_token: _a, refresh_token: _r, id_token: idToken, earliest_refresh_at: _e, ...rest } = a;
  return {
    ...rest,
    ...(reason !== 'signed_out' && idToken ? { id_token: idToken } : {}),
    needs_sign_in: true,
    signed_out_reason: reason,
    ...(reason === 'registration_invalid' ? { registration_invalid: true } : {}),
  };
}
