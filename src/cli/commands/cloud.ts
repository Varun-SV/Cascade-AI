// ─────────────────────────────────────────────
//  Cascade AI — Cloud account commands (native login)
// ─────────────────────────────────────────────
//
// `cascade login / logout / whoami / sessions` — sign in to Cascade Cloud from
// the terminal via the device-code flow and browse the chats you started on the
// web. No OAuth secret is involved; the CLI only ever holds a Cascade token.

import chalk from 'chalk';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { CloudClient, DEFAULT_CLOUD_URL, type CloudMessage } from '../../cloud/client.js';
import { encryptJSON, decryptJSON } from '../../cloud/keysync-crypto.js';
import { gatherSyncBundle, applySyncBundle, type SyncBundle } from '../../cloud/keysync.js';
import { ConfigManager } from '../../config/index.js';

function resolveServerUrl(flagServer?: string): string {
  return (flagServer || process.env['CASCADE_CLOUD_URL'] || DEFAULT_CLOUD_URL).replace(/\/$/, '');
}

/** Best-effort open of the approval page in the user's browser. */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* headless / no browser — the printed URL + code still work */
  }
}

function notSignedIn(): void {
  console.log(chalk.dim('\n  Not signed in. Run `cascade login` first.\n'));
  process.exitCode = 1;
}

/** Prompt for a passphrase without echoing it. Falls back to a plain read on non-TTY. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Emit the question once, then mask everything the user types.
    let masked = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!masked || !process.stdin.isTTY) process.stdout.write(s);
    };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
    masked = true;
  });
}

export async function loginCommand(opts: { server?: string } = {}): Promise<void> {
  const serverUrl = resolveServerUrl(opts.server);
  const client = new CloudClient(serverUrl);
  console.log(chalk.magenta('\n  ◈ Sign in to Cascade Cloud'));
  console.log(chalk.dim(`  ${serverUrl}\n`));
  try {
    const session = await client.runDeviceLogin((d) => {
      console.log(`  1. Open   ${chalk.cyan(d.verificationUri)}`);
      console.log(`  2. Enter  ${chalk.bold.yellow(d.userCode)}`);
      console.log(chalk.dim('\n  Waiting for you to approve…'));
      openBrowser(`${d.verificationUri}?code=${encodeURIComponent(d.userCode)}`);
    });
    const who = session.user.name || session.user.email || session.user.id;
    console.log(chalk.green(`\n  ✓ Signed in as ${who}\n`));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

export async function logoutCommand(): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) { console.log(chalk.dim('\n  Not signed in.\n')); return; }
  await client.logout();
  console.log(chalk.green('\n  ✓ Signed out.\n'));
}

export async function whoamiCommand(): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) return notSignedIn();
  try {
    const me = await client.me();
    console.log(`\n  ${chalk.bold(me.name || '—')}  ${chalk.dim(me.email || '')}${me.plan ? chalk.dim(`  · ${me.plan}`) : ''}\n`);
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

export async function sessionsCommand(): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) return notSignedIn();
  try {
    const convos = await client.listConversations();
    if (convos.length === 0) { console.log(chalk.dim('\n  No cloud chats yet.\n')); return; }
    console.log(chalk.magenta('\n  ◈ Your cloud chats\n'));
    for (const c of convos) {
      console.log(`  ${chalk.dim(c.id.slice(0, 8))}  ${c.title?.trim() || chalk.dim('(untitled)')}`);
    }
    console.log(chalk.dim('\n  cascade sessions show <id>   read a chat (id or its first characters)\n'));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

/** Short, copy-pasteable id (first 8 chars) for targeting branch/delete ops. */
function shortId(id: string | undefined): string {
  return (id ?? '').slice(0, 8);
}

/**
 * Render a cloud conversation's active path for the terminal. Pure so it's
 * unit-testable. Each turn shows its role, a short id (to target with `branch` /
 * `rm`), and — when the turn has alternatives — a `‹i/n›` marker so branches are
 * visible even in a plain terminal.
 */
export function formatCloudTranscript(messages: CloudMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const n = m.siblingIds?.length ?? 1;
    const i = m.siblingIds && m.id ? m.siblingIds.indexOf(m.id) + 1 : 1;
    const branch = n > 1 ? chalk.yellow(` ‹${i}/${n}›`) : '';
    const tag = m.id ? chalk.dim(` [${shortId(m.id)}]`) : '';
    const who = m.role === 'user' ? chalk.bold.cyan('You') : chalk.bold.magenta('Cascade');
    lines.push(`  ${who}${tag}${branch}`);
    lines.push('  ' + m.content.replace(/\n/g, '\n  ') + '\n');
  }
  return lines.join('\n');
}

/** Resolve a conversation by exact id or a unique-enough prefix. */
async function resolveConversation(client: CloudClient, idOrPrefix: string) {
  const convos = await client.listConversations();
  return convos.find((c) => c.id === idOrPrefix) ?? convos.find((c) => c.id.startsWith(idOrPrefix));
}

export async function sessionShowCommand(idOrPrefix: string): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) return notSignedIn();
  try {
    const match = await resolveConversation(client, idOrPrefix);
    if (!match) { console.log(chalk.red(`\n  No chat matching "${idOrPrefix}".\n`)); process.exitCode = 1; return; }
    const msgs = await client.getMessages(match.id);
    console.log(chalk.magenta(`\n  ◈ ${match.title?.trim() || '(untitled)'}\n`));
    console.log(formatCloudTranscript(msgs));
    if (msgs.some((m) => (m.siblingIds?.length ?? 1) > 1)) {
      console.log(chalk.dim('  cascade sessions branch <chat> <message>   switch to another version'));
    }
    console.log(chalk.dim('  cascade sessions rm <chat> <message>       delete a message + its replies\n'));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

/** Resolve a message id (or prefix) within an active path to a full id. */
function resolveMessage(msgs: CloudMessage[], idOrPrefix: string): string | undefined {
  return msgs.find((m) => m.id === idOrPrefix)?.id ?? msgs.find((m) => m.id?.startsWith(idOrPrefix))?.id;
}

export async function sessionBranchCommand(chat: string, message: string): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) return notSignedIn();
  try {
    const match = await resolveConversation(client, chat);
    if (!match) { console.log(chalk.red(`\n  No chat matching "${chat}".\n`)); process.exitCode = 1; return; }
    // The target message may be on an inactive branch, so resolve against ALL
    // messages, not just the active path (getMessages returns the active path).
    const active = await client.getMessages(match.id);
    const targetId = resolveMessage(active, message) ?? message;
    const next = await client.selectBranch(match.id, targetId);
    console.log(chalk.magenta(`\n  ◈ Switched branch — ${match.title?.trim() || '(untitled)'}\n`));
    console.log(formatCloudTranscript(next));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

export async function sessionRemoveMessageCommand(chat: string, message: string): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) return notSignedIn();
  try {
    const match = await resolveConversation(client, chat);
    if (!match) { console.log(chalk.red(`\n  No chat matching "${chat}".\n`)); process.exitCode = 1; return; }
    const active = await client.getMessages(match.id);
    const targetId = resolveMessage(active, message) ?? message;
    const next = await client.deleteMessage(match.id, targetId);
    console.log(chalk.green('\n  ✓ Deleted that message and its replies.\n'));
    if (next.length) console.log(formatCloudTranscript(next));
    else console.log(chalk.dim('  (the conversation is now empty)\n'));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

export async function sessionRenameCommand(chat: string, title: string): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) return notSignedIn();
  try {
    const match = await resolveConversation(client, chat);
    if (!match) { console.log(chalk.red(`\n  No chat matching "${chat}".\n`)); process.exitCode = 1; return; }
    await client.renameConversation(match.id, title);
    console.log(chalk.green(`\n  ✓ Renamed to "${title}".\n`));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

export async function sessionDeleteCommand(chat: string): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) return notSignedIn();
  try {
    const match = await resolveConversation(client, chat);
    if (!match) { console.log(chalk.red(`\n  No chat matching "${chat}".\n`)); process.exitCode = 1; return; }
    await client.deleteConversation(match.id);
    console.log(chalk.green(`\n  ✓ Deleted "${match.title?.trim() || '(untitled)'}".\n`));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────
//  Key sync — settings that follow your account
// ─────────────────────────────────────────────
//
// Encrypt this device's settings (LLM keys, web-search keys, MCP tokens, prefs)
// with a passphrase and relay them through your Cascade account. The server
// only ever sees ciphertext it can't read. See docs/key-sync.md.

export async function syncPushCommand(): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) return notSignedIn();
  const cm = new ConfigManager(process.cwd());
  await cm.load();
  const bundle = gatherSyncBundle(cm.getConfig());
  console.log(chalk.magenta('\n  ◈ Sync your settings to your account'));
  console.log(chalk.dim('  Encrypted on this device with a passphrase we never see.\n'));
  const pass = await promptHidden('  Passphrase: ');
  if (!pass) { console.log(chalk.dim('\n  Cancelled.\n')); return; }
  try {
    const blob = await encryptJSON(bundle, pass);
    const r = await client.pushSecrets(blob);
    console.log(chalk.green(`\n  ✓ Synced (v${r.version}). Run \`cascade sync pull\` on another device.\n`));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

export async function syncPullCommand(): Promise<void> {
  const client = CloudClient.fromSession();
  if (!client) return notSignedIn();
  let blob;
  try {
    ({ blob } = await client.pullSecrets());
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
    return;
  }
  if (!blob) { console.log(chalk.dim('\n  Nothing synced to your account yet. Run `cascade sync push` first.\n')); return; }
  console.log(chalk.magenta('\n  ◈ Apply your synced settings to this device\n'));
  const pass = await promptHidden('  Passphrase: ');
  if (!pass) { console.log(chalk.dim('\n  Cancelled.\n')); return; }
  try {
    const bundle = await decryptJSON<SyncBundle>(blob, pass);
    const cm = new ConfigManager(process.cwd());
    await cm.load();
    await cm.updateConfig(applySyncBundle(bundle, cm.getConfig()));
    console.log(chalk.green('\n  ✓ Applied your synced settings. Your keys are ready here.\n'));
  } catch {
    // AES-GCM's auth-tag check is what fails on a wrong passphrase.
    console.log(chalk.red('\n  Could not decrypt — check your passphrase and try again.\n'));
    process.exitCode = 1;
  }
}
