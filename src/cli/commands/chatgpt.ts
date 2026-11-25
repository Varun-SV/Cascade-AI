// ─────────────────────────────────────────────
//  Cascade AI — `cascade chatgpt`: use your ChatGPT plan
// ─────────────────────────────────────────────
//
//  Sign in with ChatGPT, through OpenAI's official open-source flow. Distinct
//  from `cascade login`, which signs in to Cascade Cloud. CLI and desktop
//  only: the web app cannot offer this.

import fs from 'node:fs';
import chalk from 'chalk';
import {
  ChatGptAuth, chatGptAuth, openSystemBrowser, MANAGE_USAGE_URL, WELCOME_CLI, PLAN_USAGE_SCOPE,
  type ChatGptStatus, type PublicAccount, type SignInResult,
} from '../../auth/chatgpt/index.js';
import { ChatGptAuthError } from '../../auth/chatgpt/errors.js';
import { writeAtomic } from '../../auth/chatgpt/store.js';

/** What a person typed to pick an account: its number, client ID (or tail), email or label. */
export function resolveAccount(accounts: PublicAccount[], ref: string): PublicAccount | undefined {
  const r = ref.trim().toLowerCase();
  if (!r) return undefined;
  if (/^\d+$/.test(r)) return accounts[Number(r) - 1];
  const exact = accounts.find((a) => a.id.toLowerCase() === r || a.label.toLowerCase() === r);
  if (exact) return exact;
  const byTail = accounts.filter((a) => a.id.toLowerCase().endsWith(r));
  if (byTail.length === 1) return byTail[0];
  const byEmail = accounts.filter((a) => a.email.toLowerCase() === r);
  return byEmail.length === 1 ? byEmail[0] : undefined;
}

function expiryText(iso: string | undefined): string {
  if (!iso) return 'none';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms <= 0) return 'expired (renews on the next request)';
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `in ${Math.floor(m / 60)}h ${m % 60}m` : `in ${m}m`;
}

/** One account, as a status line. */
function accountText(a: PublicAccount): string {
  if (a.registrationInvalid) return `${a.label}: this registration is no longer recognised by OpenAI. Register again: cascade chatgpt signin`;
  if (a.needsSignIn) return `${a.label}: signed out. Sign in again: cascade chatgpt signin`;
  if (!a.planUsageEnabled) return `${a.label}: signed in, ChatGPT plan use NOT enabled. Enable it: cascade chatgpt signin --enable-plan`;
  return `${a.label}: signed in, ChatGPT plan use enabled`;
}

export function statusLines(s: ChatGptStatus): string[] {
  if (!s.active) {
    return s.accounts.length
      ? ['ChatGPT plan: no active account. Pick one: cascade chatgpt accounts', ...s.accounts.map((a, i) => `  ${i + 1}. ${accountText(a)}`)]
      : ['ChatGPT plan: not signed in. Use your plan: cascade chatgpt signin'];
  }
  const a = s.active;
  return [
    `ChatGPT plan: ${a.label}`,
    `  Plan usage     ${a.planUsageEnabled ? (a.signedIn ? 'enabled' : 'signed out') : 'not enabled'}`,
    `  Access token   ${a.signedIn ? expiryText(a.accessTokenExpiresAt) : 'none'}`,
    `  Accounts       ${s.accounts.length}${s.accounts.length > 1 ? ' (cascade chatgpt accounts)' : ''}`,
    `  Manage usage   ${MANAGE_USAGE_URL}`,
  ];
}

// ── Shared by the commands, /settings and the setup wizard (they return text) ──

/** Continue with ChatGPT: open the browser, wait, validate, save. Returns what to show. */
export async function signInChatGpt(
  show: (text: string) => void,
  opts: { accountId?: string; forceConsent?: boolean; auth?: ChatGptAuth } = {},
): Promise<string> {
  const auth = opts.auth ?? chatGptAuth();
  try {
    const result: SignInResult = await auth.signIn({
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      ...(opts.forceConsent ? { forceConsent: true } : {}),
      openUrl: (url) => openSystemBrowser(url),
      onAuthUrl: (info) => {
        show('Opening your browser to continue with ChatGPT. Cascade waits here until you finish there.');
        // A URL that carries an ID-token hint is never printed; one that does not may be, for a machine with no browser.
        if (info.printable) show(`If it does not open, visit:\n  ${info.url}\nThat address reaches this computer only (${info.redirectUri}); on a remote machine use: cascade chatgpt import`);
      },
    });
    if (!result.planUsageEnabled) {
      return `Signed in as ${result.account.label}, but ChatGPT plan use was not enabled, so Cascade will not use it. `
        + 'Enable it with: cascade chatgpt signin --enable-plan. Or use another provider or an API key (cascade link, /settings).';
    }
    const lines = [`✓ Signed in as ${result.account.label}. Cascade will use your ChatGPT plan.`];
    if (result.showWelcome) {
      lines.push('', WELCOME_CLI);
      auth.markWelcomeShown();
    }
    return lines.join('\n');
  } catch (err) {
    return err instanceof ChatGptAuthError || err instanceof Error ? `Couldn't sign in with ChatGPT: ${err.message}` : String(err);
  }
}

export async function signOutChatGpt(accountId?: string, auth: ChatGptAuth = chatGptAuth()): Promise<string> {
  try {
    const r = await auth.signOut(accountId);
    return `${r.revocation === 'not_confirmed' ? '! ' : '✓ '}${r.message}`;
  } catch (err) {
    return `Couldn't sign out: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function chatGptStatusText(auth: ChatGptAuth = chatGptAuth()): string {
  return statusLines(auth.status()).join('\n');
}

// ── Commands ──

const out = (t: string): void => console.log(`  ${t.split('\n').join('\n  ')}`);

export async function chatgptSigninCommand(opts: { account?: string; new?: boolean; enablePlan?: boolean }): Promise<void> {
  const auth = chatGptAuth();
  const s = auth.status();
  let accountId: string | undefined;
  if (opts.account) {
    const a = resolveAccount(s.accounts, opts.account);
    if (!a) { console.log(chalk.red(`\n  No ChatGPT account matches "${opts.account}". See: cascade chatgpt accounts\n`)); process.exitCode = 1; return; }
    accountId = a.id;
  } else if (!opts.new && s.active && (s.active.needsSignIn || opts.enablePlan || !s.active.planUsageEnabled)) {
    // The active account lost its tokens, or is missing plan usage: sign in to the same registration.
    accountId = s.active.id;
  } else if (!opts.new && s.active?.signedIn && s.active.planUsageEnabled) {
    console.log(chalk.dim(`\n  Already signed in as ${s.active.label}. Add another account: cascade chatgpt signin --new\n`));
    return;
  }
  console.log(chalk.magenta('\n  ◈ Continue with ChatGPT\n'));
  const text = await signInChatGpt((t) => out(chalk.dim(t)), { ...(accountId ? { accountId } : {}), ...(opts.enablePlan ? { forceConsent: true } : {}) });
  console.log(`\n${text.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
  if (text.startsWith("Couldn't")) process.exitCode = 1;
}

export async function chatgptSignoutCommand(opts: { account?: string }): Promise<void> {
  const auth = chatGptAuth();
  let id: string | undefined;
  if (opts.account) {
    id = resolveAccount(auth.status().accounts, opts.account)?.id;
    if (!id) { console.log(chalk.red(`\n  No ChatGPT account matches "${opts.account}".\n`)); process.exitCode = 1; return; }
  }
  const text = await signOutChatGpt(id, auth);
  console.log(`\n  ${text}\n`);
  if (text.startsWith("Couldn't")) process.exitCode = 1;
}

export function chatgptStatusCommand(): void {
  console.log(`\n${statusLines(chatGptAuth().status()).map((l) => `  ${l}`).join('\n')}\n`);
}

export function chatgptAccountsCommand(action?: string, ref?: string): void {
  const auth = chatGptAuth();
  const s = auth.status();
  if (action === 'use' || action === 'switch') {
    const a = ref ? resolveAccount(s.accounts, ref) : undefined;
    if (!a) { console.log(chalk.red(`\n  Say which account: cascade chatgpt accounts use <number|email|id>\n`)); process.exitCode = 1; return; }
    const r = auth.switchAccount(a.id);
    console.log(r.switched
      ? chalk.green(`\n  ✓ Now using ${a.label}.\n`)
      : chalk.yellow(`\n  ${a.label} is signed out or has no plan access. Sign in first: cascade chatgpt signin --account ${a.id}\n`));
    return;
  }
  if (!s.accounts.length) { console.log(chalk.dim('\n  No ChatGPT accounts yet. Add one: cascade chatgpt signin\n')); return; }
  console.log('');
  s.accounts.forEach((a, i) => console.log(`  ${a.active ? chalk.green('●') : ' '} ${i + 1}. ${accountText(a)}`));
  console.log(chalk.dim('\n  Switch: cascade chatgpt accounts use <number|email>   Add: cascade chatgpt signin --new\n'));
}

const EXPORT_WARNING = [
  'This file holds your ChatGPT sign-in credentials (including a refresh token).',
  'Anyone with it can use your ChatGPT plan until you sign out or disconnect Cascade in ChatGPT settings.',
  'Move it only over a secure channel such as SSH, then delete it. The machine that imports it',
  'keeps its own host ID and owns later refreshes; stop using this account here once it is moved.',
].join('\n');

/** For a machine with no browser: sign in where there is one, then move the protected record. */
export function chatgptExportCommand(opts: { account?: string; out?: string; stdout?: boolean }): void {
  const auth = chatGptAuth();
  try {
    let id: string | undefined;
    if (opts.account) {
      id = resolveAccount(auth.status().accounts, opts.account)?.id;
      if (!id) throw new Error(`No ChatGPT account matches "${opts.account}".`);
    }
    const body = JSON.stringify(auth.exportAccount(id), null, 2);
    console.error(chalk.yellow(`\n  Warning\n${EXPORT_WARNING.split('\n').map((l) => `  ${l}`).join('\n')}\n`));
    if (opts.stdout) { process.stdout.write(`${body}\n`); return; }
    const file = opts.out ?? 'cascade-chatgpt-account.json';
    if (fs.existsSync(file)) throw new Error(`${file} already exists. Choose another with --out.`);
    // Owner-only from the first byte.
    writeAtomic(file, body);
    console.log(chalk.green(`  ✓ Wrote ${file} (owner-only).`));
    console.log(chalk.dim(`  On the other machine: scp ${file} host:  then  cascade chatgpt import ${file}\n  Or in one step:        cascade chatgpt export --stdout | ssh host 'cascade chatgpt import -'\n`));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

export function chatgptImportCommand(file: string): void {
  try {
    const raw = file === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(file, 'utf-8');
    const a = chatGptAuth().importAccount(JSON.parse(raw));
    console.error(chalk.yellow(`\n  ${EXPORT_WARNING.split('\n')[0]} Delete ${file === '-' ? 'any copy you made' : file} now.`));
    console.log(chalk.green(`\n  ✓ Imported ${a.label} under this machine's own host ID. This machine now renews the sign-in.`));
    console.log(chalk.dim(`  Plan usage: ${a.planUsageEnabled ? 'enabled' : `not enabled (the sign-in lacks ${PLAN_USAGE_SCOPE})`}\n`));
  } catch (err) {
    console.log(chalk.red(`\n  Could not import: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

/**
 * Whether requests go to the ChatGPT plan: a tier is pinned to one of its
 * models, or it is the only provider the config has. The status line says
 * "Using ChatGPT plan" exactly then.
 */
export function usesChatGptPlan(config: { models?: { t1?: string; t2?: string; t3?: string }; providers: Array<{ type: string }> }): boolean {
  if (!config.providers.some((p) => p.type === 'chatgpt')) return false;
  const pinned = [config.models?.t1, config.models?.t2, config.models?.t3].filter((m): m is string => !!m && m !== 'auto');
  if (pinned.some((m) => m.startsWith('chatgpt:'))) return true;
  return config.providers.length === 1;
}
