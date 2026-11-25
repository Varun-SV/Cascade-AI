// ─────────────────────────────────────────────
//  Cascade Desktop — ChatGPT plan usage (Sign in with ChatGPT)
// ─────────────────────────────────────────────
//
//  The sign-in runs HERE, in the main process, with the SDK's own flow: the
//  system browser opens through `shell.openExternal` (never an in-app
//  webview), the loopback listener is this process's, and the tokens are read
//  and written only by the SDK's store under ~/.cascade-ai. What this module
//  hands the renderer is an account's email, label and state, never a token.
//
//  Electron-free on purpose (the pieces it needs come in as `deps`), so the
//  handlers can be tested without a window.

/** The slice of the SDK's ChatGptAuth this needs, structurally. */
export interface PlanAuth {
  status(): {
    accounts: PlanAccount[];
    active: PlanAccount | undefined;
    planReady: boolean;
    welcomePending: boolean;
    manageUsageUrl: string;
  };
  signIn(opts: {
    accountId?: string;
    forceConsent?: boolean;
    signal?: AbortSignal;
    openUrl: (url: string) => void | boolean | Promise<void | boolean>;
  }): Promise<{ account: PlanAccount; planUsageEnabled: boolean; showWelcome: boolean; newRegistration: boolean }>;
  signOut(accountId?: string): Promise<{ revocation: 'confirmed' | 'not_confirmed' | 'none'; message: string }>;
  switchAccount(id: string): { switched: boolean; needsSignIn: boolean; account: PlanAccount };
  markWelcomeShown(): void;
}

/** An account as the window may see it: no token, no ID token, no refresh token. */
export interface PlanAccount {
  id: string;
  email: string;
  label: string;
  active: boolean;
  signedIn: boolean;
  planUsageEnabled: boolean;
  needsSignIn: boolean;
  accessTokenExpiresAt?: string;
}

export interface PlanView {
  accounts: PlanAccount[];
  active: PlanAccount | null;
  /** Requests can use the plan now. */
  planReady: boolean;
  /** Show the one-time welcome (first sign-in with plan usage enabled; not yet dismissed). */
  welcomePending: boolean;
  signingIn: boolean;
  manageUsageUrl: string;
}

export type PlanResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface PlanDeps {
  auth: PlanAuth;
  /** `shell.openExternal`. */
  openExternal: (url: string) => void | Promise<void>;
  /** Lets the app pick up the change: the live config's provider list, the model list. */
  onChanged: () => void | Promise<void>;
  /** Tells the window (`chatgpt:changed`). */
  notify?: (channel: string, payload: unknown) => void;
}

/** The only address the window can ask this app to open for it: the ChatGPT usage page. */
export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** Keep a field a person's text can reach to the shape it must have; anything else is no account. */
const accountId = (v: unknown): string | undefined | null =>
  v === undefined ? undefined : typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;

export function createChatGptPlan(deps: PlanDeps) {
  let attempt: AbortController | null = null;

  const view = (): PlanView => {
    const s = deps.auth.status();
    return {
      accounts: s.accounts.map(strip),
      active: s.active ? strip(s.active) : null,
      planReady: s.planReady,
      welcomePending: s.welcomePending,
      signingIn: attempt !== null,
      manageUsageUrl: s.manageUsageUrl,
    };
  };
  const changed = async (): Promise<void> => {
    try { await deps.onChanged(); } catch { /* the sign-in itself stands */ }
    deps.notify?.('chatgpt:changed', view());
  };

  return {
    status: (): PlanView => view(),

    /** Continue with ChatGPT: the system browser, then the SDK's validation and save. */
    async signIn(raw?: { accountId?: unknown; enablePlan?: unknown }): Promise<PlanResult<{ planUsageEnabled: boolean; showWelcome: boolean; view: PlanView }>> {
      if (attempt) return { ok: false, error: 'A ChatGPT sign-in is already waiting in your browser.' };
      const id = accountId(raw?.accountId);
      if (id === null) return { ok: false, error: 'That account could not be read.' };
      const ctl = new AbortController();
      attempt = ctl;
      deps.notify?.('chatgpt:changed', view());
      try {
        const r = await deps.auth.signIn({
          ...(id ? { accountId: id } : {}),
          ...(raw?.enablePlan === true ? { forceConsent: true } : {}),
          signal: ctl.signal,
          openUrl: (url) => deps.openExternal(url),
        });
        attempt = null;
        await changed();
        return { ok: true, planUsageEnabled: r.planUsageEnabled, showWelcome: r.showWelcome, view: view() };
      } catch (err) {
        attempt = null;
        deps.notify?.('chatgpt:changed', view());
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    /** Stop waiting for the browser. */
    cancel(): PlanResult {
      attempt?.abort();
      return { ok: true };
    },

    async signOut(raw?: { accountId?: unknown }): Promise<PlanResult<{ message: string; revocationConfirmed: boolean; view: PlanView }>> {
      const id = accountId(raw?.accountId);
      if (id === null) return { ok: false, error: 'That account could not be read.' };
      try {
        const r = await deps.auth.signOut(id);
        await changed();
        return { ok: true, message: r.message, revocationConfirmed: r.revocation !== 'not_confirmed', view: view() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async switchAccount(raw?: { accountId?: unknown }): Promise<PlanResult<{ needsSignIn: boolean; view: PlanView }>> {
      const id = accountId(raw?.accountId);
      if (!id) return { ok: false, error: 'Choose an account.' };
      try {
        const r = deps.auth.switchAccount(id);
        if (r.switched) await changed();
        return { ok: true, needsSignIn: r.needsSignIn, view: view() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    /** "Got it" on the welcome. */
    dismissWelcome(): PlanResult {
      deps.auth.markWelcomeShown();
      deps.notify?.('chatgpt:changed', view());
      return { ok: true };
    },

    /** Manage usage: always the same ChatGPT page, whatever the window sends. */
    async openManageUsage(): Promise<PlanResult> {
      await deps.openExternal(MANAGE_USAGE_URL);
      return { ok: true };
    },
  };
}

function strip(a: PlanAccount): PlanAccount {
  return {
    id: a.id, email: a.email, label: a.label, active: a.active, signedIn: a.signedIn,
    planUsageEnabled: a.planUsageEnabled, needsSignIn: a.needsSignIn,
    ...(a.accessTokenExpiresAt ? { accessTokenExpiresAt: a.accessTokenExpiresAt } : {}),
  };
}

export type ChatGptPlan = ReturnType<typeof createChatGptPlan>;
