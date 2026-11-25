// ─────────────────────────────────────────────
//  Cascade AI — `cascade workspace`: a folder on this machine, for your cloud runs
// ─────────────────────────────────────────────
//
//  A run on Cascade Cloud can do its coding work (read, write, edit and delete files,
//  search, shell, git, run code) in a folder on your own computer instead of one the
//  server hosts. The server hosts no files. This command serves a folder, the way the
//  desktop app can:
//
//    cascade workspace serve [folder]   stay connected, and ask here before any run gets the folder
//    cascade workspace status           whether this machine is paired, and which server it would serve
//
//  It serves with the device `cascade relay pair` registered: one key, one pinned server.
//  Nothing is served without a yes in this terminal, for that run, with the tools you
//  choose. Risky calls (deleting, installing, sending things off the machine, rewriting
//  git history) ask again. The folder's path is never sent: only a name you picked.

import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import { CloudClient } from '../../cloud/client.js';
import { relayEndpoints } from '../../browser/relay/serve.js';
import { serveWorkspaceDevice } from '../../workspace/device.js';
import { createWorkspaceExecutor } from '../../workspace/executor.js';
import { Checkpoints } from '../../core/checkpoints.js';
import { PrivacyPaths } from '../../core/privacy/paths.js';
import { ConfigManager } from '../../config/index.js';
import { STATE, statePath } from '../../config/project-state.js';
import { ToolRegistry } from '../../tools/registry.js';
import { secretValuesIn } from '../../core/cascade.js';
import { loadRelayDevice } from './relay.js';
import { claimStopSignals } from '../exit-guard.js';
import { PRESETS, buildLabel, presetOf, validateFolder, type LabelMode, type ToolPreset } from '../workspace/consent.js';
import {
  createCliWorkspace, defaultFolderFs, type CallQuestion, type CliWorkspaceCore, type ConsentQuestion, type PairedDevice, type WorkspaceRunSummary, type WorkspaceUi,
} from '../workspace/service.js';

/** Where questions are asked: this terminal, or a test's streams. */
export interface TerminalIo { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; terminal?: boolean }

const PRESET_KEYS: ToolPreset[] = ['read', 'edit', 'all'];

/** The SDK modules the service drives, as the CLI has them. */
export const realCore: CliWorkspaceCore = {
  relayEndpoints,
  serveWorkspaceDevice: serveWorkspaceDevice as unknown as CliWorkspaceCore['serveWorkspaceDevice'],
  createWorkspaceExecutor: createWorkspaceExecutor as unknown as CliWorkspaceCore['createWorkspaceExecutor'],
  ToolRegistry: ToolRegistry as unknown as CliWorkspaceCore['ToolRegistry'],
  secretValuesIn,
  ConfigManager: ConfigManager as unknown as CliWorkspaceCore['ConfigManager'],
  PrivacyPaths: PrivacyPaths as unknown as CliWorkspaceCore['PrivacyPaths'],
  Checkpoints: Checkpoints as unknown as CliWorkspaceCore['Checkpoints'],
  statePath,
  STATE,
};

export interface TerminalUiOptions {
  io?: TerminalIo;
  /** Ctrl-C at a prompt: readline takes the keystroke itself, so the process's own handler never hears it. */
  onInterrupt(): void;
  /** `--yes-read-only`: a run's ask is answered "read only" without asking. Nothing else is. */
  yesReadOnly?: boolean;
  /** Asked for each run's undo when it ends with changes; the answer is the person's. */
  undo?: () => Promise<{ ok: true; restored: number; removed: number; skipped: number } | { error: string }>;
  print?: (line: string) => void;
  /** Serving is stopping: no new undo question is asked, and one that is open is taken down. */
  stopping?: AbortSignal;
}

/**
 * Questions in this terminal, one at a time: two asked at once are answered in turn. A
 * question is taken down (and reads as a no) when the service stops asking.
 */
export function createTerminalUi(opts: TerminalUiOptions): WorkspaceUi & { idle(): Promise<void> } {
  const io: TerminalIo = opts.io ?? { input: process.stdin, output: process.stdout };
  const print = opts.print ?? ((line: string) => console.log(line));
  let queue: Promise<unknown> = Promise.resolve();

  /** Asks one line. `fallback` is what a closed or taken-down prompt answers. */
  function ask<T>(header: () => void, question: string, signal: AbortSignal, onLine: (text: string, done: (v: T) => void, again: () => void) => void, fallback: T): Promise<T> {
    const turn = queue.then(() => new Promise<T>((settle) => {
      if (signal.aborted) { settle(fallback); return; }
      // Shown when its turn comes, not when it was asked: two questions never interleave.
      header();
      let settled = false;
      const done = (v: T): void => { if (!settled) { settled = true; settle(v); rl.close(); } };
      const rl = readline.createInterface({ input: io.input, output: io.output, ...(io.terminal !== undefined ? { terminal: io.terminal } : {}) });
      rl.on('SIGINT', () => { print(chalk.dim('\n  Declined.')); done(fallback); opts.onInterrupt(); });
      rl.on('close', () => { if (!settled) { settled = true; settle(fallback); } });
      signal.addEventListener('abort', () => { print(chalk.dim('\n  (that question lapsed)')); done(fallback); }, { once: true });
      const prompt = (): void => rl.question(question, (text) => onLine(text, done, prompt));
      prompt();
    }));
    queue = turn.then(() => {}, () => {});
    return turn;
  }

  const ui: WorkspaceUi & { idle(): Promise<void> } = {
    idle: () => queue.then(() => {}),

    askConsent(q: ConsentQuestion) {
      if (opts.yesReadOnly) {
        print(chalk.dim(`\n  A cloud run asked for this workspace: allowed as read only (--yes-read-only).`));
        return Promise.resolve({ tools: [...PRESETS.read.tools], labelMode: q.defaults.labelMode });
      }
      const mins = Math.max(1, Math.round(q.windowMs / 60_000));
      const labels = (mode: LabelMode): string => buildLabel(mode, q.device, path.join(path.sep, q.folderName));
      // The preset `--tools` named, offered as "y". Enter stays a no.
      const defKey = presetOf(q.defaults.tools);
      const defNum = defKey ? PRESET_KEYS.indexOf(defKey) + 1 : null;
      const header = (): void => {
        print(chalk.magenta('\n  ◈ A cloud run wants this workspace'));
        print(chalk.dim(`  ${q.chat ? `"${q.chat}" · ` : ''}run ${q.runId} · folder "${q.folderName}" on ${q.device} · this question lapses in about ${mins} min`));
        PRESET_KEYS.forEach((k, i) => print(`    ${i + 1}  ${PRESETS[k].title}${k === defKey ? chalk.dim('  (y)') : ''}`));
        print(chalk.dim('  The run is shown a name you pick below, never the folder\'s path. Risky calls ask again here.'));
      };
      type Pick = { key: ToolPreset } | null;
      const question = defNum
        ? `  Allow with which tools? 1, 2 or 3, or y for ${defNum} (Enter to say no): `
        : '  Allow with which tools? 1, 2 or 3 (Enter to say no): ';
      return ask<Pick>(header, question, q.signal, (text, done, again) => {
        const t = text.trim();
        if (!t) { print(chalk.dim('  Declined.')); done(null); return; }
        if (defKey && /^y(es)?$/i.test(t)) { done({ key: defKey }); return; }
        const n = Number.parseInt(t, 10);
        const key = PRESET_KEYS[n - 1];
        if (!key || String(n) !== t) { print(chalk.yellow(`  Type 1, 2 or 3${defNum ? ', or y' : ''}, or press Enter to say no.`)); again(); return; }
        done({ key });
      }, null).then(async (pick) => {
        if (!pick) return null;
        print(chalk.green(`  Allowed: ${PRESETS[pick.key].title.toLowerCase()}.`));
        const defaultMode = q.defaults.labelMode;
        const mode = await ask<LabelMode>(
          () => {},
          `  What should the run call it? 1 "${labels('device')}"  2 "${labels('folder')}" [${defaultMode === 'device' ? 1 : 2}]: `,
          q.signal,
          (text, done) => done(text.trim() === '2' ? 'folder' : text.trim() === '1' ? 'device' : defaultMode),
          defaultMode,
        );
        return { tools: [...PRESETS[pick.key].tools], labelMode: mode };
      });
    },

    askCall(q: CallQuestion) {
      const secs = Math.round(q.timeoutMs / 1000);
      const header = (): void => {
        print(chalk.yellow(`\n  ⚠ ${q.label ? `${q.label}: ` : ''}${q.tool} — ${q.reason || q.risk}`));
        print(`    ${q.summary}`);
      };
      return ask<'allow' | 'deny' | 'all'>(header, `  Allow this call? [y]es / [N]o / [a]ll for this run (no answer in ${secs}s is no): `, q.signal, (text, done) => {
        const t = text.trim().toLowerCase();
        if (t === 'y' || t === 'yes') done('allow');
        else if (t === 'a' || t === 'all') { print(chalk.dim('  Everything else this run asks is allowed, until it ends.')); done('all'); }
        else done('deny');
      }, 'deny');
    },

    served(run) {
      print(run ? chalk.green(`\n  ▶ Serving "${run.label}" to a cloud run. Press Ctrl-C to stop.`) : '');
    },

    activity(line) {
      print(chalk.dim(`  · ${line}`));
    },

    runEnded(s: WorkspaceRunSummary) {
      print(chalk.dim(`\n  ■ "${s.label}" ended${s.changed === null ? '' : s.changed === 0 ? ': it changed nothing' : `: it changed ${s.changed} file${s.changed === 1 ? '' : 's'}`}.`));
      if (s.note && !s.canUndo) print(chalk.dim(`  ${s.note}`));
      if (!s.canUndo || !opts.undo) return;
      const later = (): void => print(chalk.dim('  Kept. To undo later, run `cascade` in that folder and type /undo.'));
      // Stopping: no question that would hold the exit up.
      if (opts.stopping?.aborted) { later(); return; }
      const undo = opts.undo;
      // Asked in its turn, after any question already open. Enter is no, and a lapse is no.
      const lapse = new AbortController();
      const timer = setTimeout(() => lapse.abort(), 120_000);
      const onStop = (): void => lapse.abort();
      opts.stopping?.addEventListener('abort', onStop, { once: true });
      void ask<boolean>(() => {}, '  Undo what it changed now? [y/N] ', lapse.signal, (text, done) => done(/^\s*y(es)?\s*$/i.test(text)), false).then(async (yes) => {
        clearTimeout(timer);
        opts.stopping?.removeEventListener('abort', onStop);
        if (!yes) { later(); return; }
        // A failed restore (a file it can't write, say) is said here; serving goes on.
        let r: Awaited<ReturnType<typeof undo>>;
        try { r = await undo(); } catch (err) { r = { error: `The undo failed: ${err instanceof Error ? err.message : String(err)}` }; }
        print('error' in r ? chalk.yellow(`  ${r.error}`) : chalk.green(`  ✓ Undone: ${r.restored} restored, ${r.removed} removed${r.skipped ? `, ${r.skipped} left as you changed them` : ''}.`));
      }).catch(() => {});
    },

    notice(line) {
      print(chalk.dim(`  ${line}`));
    },
  };
  return ui;
}

// ── The commands ─────────────────────────────

function signedIn(): CloudClient | null {
  const client = CloudClient.fromSession();
  if (!client) {
    console.log(chalk.dim('\n  Not signed in. Run `cascade login` first.\n'));
    process.exitCode = 1;
  }
  return client;
}

function fail(err: unknown): void {
  console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
  process.exitCode = 1;
}

/** The paired device, when this machine is signed in and paired (printing why not when it isn't). */
function pairedDevice(client: CloudClient): PairedDevice | null {
  const stored = loadRelayDevice(client.server);
  if (!stored) {
    console.log(chalk.dim('\n  This machine is not paired with Cascade Cloud yet. Run `cascade relay pair` first.\n'));
    process.exitCode = 1;
    return null;
  }
  return stored;
}

export interface WorkspaceServeOptions {
  /** The tools offered as the default answer: read, edit or all. */
  tools?: string;
  /** What the run is shown by default: "device" (Workspace on <name>) or "folder" (the folder's name). */
  label?: string;
  yesReadOnly?: boolean;
}

export async function workspaceServeCommand(folderArg: string | undefined, opts: WorkspaceServeOptions = {}): Promise<void> {
  const resolved = path.resolve(folderArg ?? process.cwd());
  const checked = validateFolder(resolved, defaultFolderFs());
  if ('error' in checked) { fail(new Error(checked.error)); return; }
  const preset = opts.tools ?? 'read';
  if (!(PRESET_KEYS as string[]).includes(preset)) { fail(new Error('--tools is read, edit or all.')); return; }
  if (opts.label !== undefined && opts.label !== 'device' && opts.label !== 'folder') { fail(new Error('--label is device or folder.')); return; }
  const client = signedIn();
  if (!client) return;
  const stored = pairedDevice(client);
  if (!stored) return;
  // Still one of this account's devices (not removed on the server, nor paired for another account).
  try {
    const devices = await client.listRelayDevices();
    if (!devices.some((d) => d.id === stored.deviceId)) {
      console.log(chalk.red('\n  This machine\'s pairing is not one of this account\'s devices (it was removed, or paired for another account).\n  Run `cascade relay forget`, then `cascade relay pair`.\n'));
      process.exitCode = 1;
      return;
    }
  } catch (err) { fail(err); return; }

  const stopping = new AbortController();
  const labelMode: LabelMode = opts.label === 'folder' ? 'folder' : 'device';
  let svc: ReturnType<typeof createCliWorkspace> | null = null;
  const onSignal = (): void => {
    if (stopping.signal.aborted) { process.exit(130); }
    stopping.abort();
    svc?.shutdown();
  };
  const ui = createTerminalUi({
    onInterrupt: onSignal,
    stopping: stopping.signal,
    ...(opts.yesReadOnly ? { yesReadOnly: true } : {}),
    undo: () => svc!.undoLastRun(),
  });
  svc = createCliWorkspace({
    core: realCore, folder: checked.folder, device: stored, ui,
    defaults: { tools: [...PRESETS[preset as ToolPreset].tools], labelMode },
  });
  // The first Ctrl-C (or SIGTERM) stops serving and waits for the run's calls to drain and
  // its checkpoint to be written; the second leaves at once.
  const release = claimStopSignals(onSignal);
  const label = buildLabel(labelMode, stored.name, checked.folder);
  console.log(chalk.magenta(`\n  ◈ Serving ${label} to Cascade Cloud — Ctrl+C to stop`));
  console.log(chalk.dim(`  Folder: ${checked.folder} (its path is never sent) · server: ${stored.serverUrl}`));
  console.log(chalk.dim(opts.yesReadOnly
    ? '  Runs that ask are given read-only access without a question (--yes-read-only). Anything more is never granted without asking.'
    : '  Each run that asks is put to you here first. Say no by pressing Enter.'));
  try {
    const outcome = await svc.start();
    await svc.finished();
    if (outcome === 'refused') {
      console.log(chalk.red('\n  Cascade Cloud does not accept this device any more. It may have been removed: `cascade relay forget`, then `cascade relay pair`.\n'));
      process.exitCode = 1;
    } else {
      await ui.idle();
      const f = svc.lastFolder();
      const last = svc.status().lastRun;
      if (last?.canUndo && f) console.log(chalk.dim(`\n  The last run's changes can still be undone: run \`cascade\` in ${f} and type /undo.`));
      console.log(chalk.dim('\n  Stopped.\n'));
    }
  } catch (err) { fail(err); } finally {
    svc.shutdown();
    release();
  }
}

export async function workspaceStatusCommand(): Promise<void> {
  const client = CloudClient.fromSession();
  console.log(chalk.magenta('\n  ◈ Workspace serving'));
  if (!client) {
    console.log(chalk.dim('  Not signed in. Run `cascade login`, then `cascade relay pair`.\n'));
    return;
  }
  const stored = loadRelayDevice(client.server);
  console.log(chalk.dim(`  Server: ${client.server}`));
  if (!stored) {
    console.log(chalk.dim('  This machine is not paired. Run `cascade relay pair` first.\n'));
    return;
  }
  console.log(`  Paired as "${stored.name}"`);
  try {
    const mine = (await client.listRelayDevices()).find((d) => d.id === stored.deviceId);
    console.log(mine ? chalk.green('  This device is registered with your account.') : chalk.yellow('  This device is not in your account\'s list any more: `cascade relay forget`, then pair again.'));
  } catch {
    console.log(chalk.dim('  (Could not reach the server to check the registration.)'));
  }
  console.log(chalk.dim('  Run `cascade workspace serve [folder]` to serve a folder to your cloud runs.\n'));
}
