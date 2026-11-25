// ─────────────────────────────────────────────
//  Cascade AI CLI — a folder on this computer as a cloud run's workspace
// ─────────────────────────────────────────────
//
//  The terminal twin of the desktop app's service (app/electron/desktop-workspace.ts).
//  `cascade workspace serve [folder]` serves the folder with the SAME device the browser
//  relay paired (`cascade relay pair`: one key, one pinned server, one entry in the
//  account's device list); it registers nothing of its own. Each run that asks for a
//  workspace is asked about here: which tools, what the run is shown. A yes opens a
//  tool registry rooted at the folder (the SDK's executor judges each call's risk, jails
//  commands, checkpoints before the first change); a risky call asks again, here. The
//  folder's path never leaves this computer: only the label.
//
//  This file holds the decisions and the guards. What the person sees and types is the
//  `ui` the command passes in, so every guard is testable without a terminal.

import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  CALL_ASK_TIMEOUT_MS, activityText, buildLabel, consentWindowMs, displayText, sanitizeTools, summarizeCall, validateFolder,
  type FolderFs, type LabelMode,
} from './consent.js';

/** Where the server's workspace endpoints are: the browser relay's server, its own two paths. */
export const WORKSPACE_CONTROL_PATH = '/api/workspace-relay/control';
export const WORKSPACE_RUN_PATH = '/api/workspace-relay/run';

/** The paired device (src/cli/commands/relay.ts), read here and never written. */
export interface PairedDevice {
  serverUrl: string;
  deviceId: string;
  name: string;
  privateKeyPem: string;
  serverId: string;
  serverKey: string;
}

interface CheckpointRecord { n: number; changed?: number; after?: string; undone?: boolean }
interface CheckpointStore {
  begin(label: string): Promise<{ n: number } | null>;
  end(cp: { n: number }): Promise<unknown>;
  covers?(paths: string[]): Promise<boolean>;
  list(): CheckpointRecord[];
  undo(count?: number, force?: boolean): Promise<{ restored: string[]; removed: string[]; skipped: string[]; incomplete?: unknown[] }>;
}

type AskFn = (q: { tool: string; input: Record<string, unknown>; risk: { level: string; reason: string }; signal: AbortSignal }) => Promise<boolean>;

interface WorkspaceExecutorLike {
  definitions(): unknown;
  run(tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal; waiting?: () => void; worker?: string }): Promise<unknown>;
  finish(): Promise<void>;
}

/** The slice of the SDK this service uses; the command passes the real modules, tests fakes. */
export interface CliWorkspaceCore {
  relayEndpoints(serverUrl: string, info: { controlPath: string; runPath: string }): { controlUrl: string; runUrl: string };
  serveWorkspaceDevice(opts: {
    stored: { deviceId: string; privateKeyPem: string; serverId: string; serverKey: string };
    endpoints: { controlUrl: string; runUrl: string };
    askUser(run: { runId: string; userId: string; expiresAt: number; signal: AbortSignal; hint?: { sites?: string[]; chat?: string } }): Promise<{ tools: string[]; label: string } | null>;
    open(consent: { tools: string[]; label: string }, run: { runId: string; userId: string; expiresAt: number }): Promise<unknown>;
    onServing?(run: { runId: string; userId: string; expiresAt: number; label: string } | null): void;
    onClient?(client: { stop(reason?: string): void } | null): void;
    log(line: string): void;
    signal: AbortSignal;
  }): Promise<'stopped' | 'refused'>;
  createWorkspaceExecutor(opts: {
    registry: unknown; tools: readonly string[]; ask: AskFn; checkpoints?: unknown; privacy?: () => unknown; label?: string; log?(line: string): void;
  }): unknown;
  ToolRegistry: new (config: Record<string, unknown>, root: string) => { setIgnoredPaths(patterns: string[]): void; setSecretValues(read: () => string[]): void };
  /** Every credential in a config, by field name (src/core/cascade.ts). */
  secretValuesIn(config: unknown): string[];
  ConfigManager: new (root: string) => { load(): Promise<void>; getConfig(): { tools?: Record<string, unknown>; privacy?: { paths?: Array<{ pattern: string; policy: 'local-only' }> } }; getIgnore(): { getUserPatterns(): string[] }; getStore?(): { close?(): void } | undefined };
  PrivacyPaths: new (policies: Array<{ pattern: string; policy: 'local-only' }>, opts: { workspaceRoot: string }) => unknown;
  Checkpoints: new (root: string, dir: string) => CheckpointStore;
  statePath(root: string, ...parts: string[]): string;
  STATE: { checkpoints: string };
}

/** What the person is asked to decide for a run. */
export interface ConsentQuestion {
  runId: string;
  /** Which chat asked, when the run said. Printable text only. */
  chat: string | null;
  /** This device's name, and the folder's own name (never its path). */
  device: string;
  folderName: string;
  expiresAt: number;
  /** How long the question stays open. */
  windowMs: number;
  defaults: { tools: string[]; labelMode: LabelMode };
  /** Fires when the question is taken down: answered elsewhere, timed out, offer withdrawn, serving stopped. */
  signal: AbortSignal;
}

export interface CallQuestion {
  tool: string;
  /** The call, one printable line, credentials masked. */
  summary: string;
  risk: string;
  reason: string;
  label: string | null;
  timeoutMs: number;
  signal: AbortSignal;
}

/** The terminal, or a test's stand-in. */
export interface WorkspaceUi {
  /** Null (or a closed prompt) is a no. */
  askConsent(q: ConsentQuestion): Promise<{ tools: string[]; labelMode: LabelMode } | null>;
  askCall(q: CallQuestion): Promise<'allow' | 'deny' | 'all'>;
  /** A run began or ended being served. */
  served(run: { label: string } | null): void;
  /** The compact live line: the tool and a relative path or the command. */
  activity(line: string): void;
  /** A run's summary when it ends, for the undo offer. */
  runEnded(summary: WorkspaceRunSummary): void;
  notice(line: string): void;
}

export interface WorkspaceRunSummary {
  label: string;
  /** Files the run changed, made or deleted; null while unknown. */
  changed: number | null;
  /** The folder was checkpointed before the run's first change, so its changes can be undone here. */
  canUndo: boolean;
  undone: boolean;
  /** Why the run can't be undone, when it can't and changed something. */
  note: string | null;
}

export interface CliWorkspaceDeps {
  core: CliWorkspaceCore;
  /** The folder to serve, as typed. Checked when serving starts and again whenever a run opens it. */
  folder: string;
  device: PairedDevice;
  ui: WorkspaceUi;
  /** The tools and label shown as the default answer. */
  defaults?: { tools?: string[]; labelMode?: LabelMode };
  fs?: FolderFs;
  hostname?: () => string;
  now?: () => number;
  /** How long a question about one call waits for the person. */
  callTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface CliWorkspaceStatus {
  connected: boolean;
  serving: { runId: string; label: string; allowAll: boolean } | null;
  lastRun: WorkspaceRunSummary | null;
  error: string | null;
}

const DEFAULT_TOOLS: string[] = ['file_list', 'file_read', 'glob', 'grep'];

/** The run a service has the folder open for, until it has finished. */
interface ServedRun { runId: string; label: string; folder: string; allowAll: boolean; live: boolean; store: CheckpointStore | null; cp: { n: number } | null; owner: AbortController | null; secrets: () => string[] }

/** The checks of validateFolder, against the real disk. */
export function defaultFolderFs(): FolderFs {
  return {
    home: () => os.homedir(),
    realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  };
}

export function createCliWorkspace(deps: CliWorkspaceDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const { ui } = deps;
  const folderFs: FolderFs = deps.fs ?? defaultFolderFs();
  const hostname = deps.hostname ?? os.hostname;
  const callTimeout = deps.callTimeoutMs ?? CALL_ASK_TIMEOUT_MS;
  const defaultTools = sanitizeTools(deps.defaults?.tools).length ? sanitizeTools(deps.defaults?.tools) : DEFAULT_TOOLS;
  const defaultLabel: LabelMode = deps.defaults?.labelMode === 'folder' ? 'folder' : 'device';

  /** Every open question's way out, so stopping closes them all. */
  const consentAsks = new Set<{ close(): void }>();
  const callAsks = new Set<{ resolve(yes: boolean): void }>();
  /** An undo of the last run is putting files back. */
  let undoing = false;
  let serving: AbortController | null = null;
  let client: { stop(reason?: string): void } | null = null;
  let connected = false;
  let error: string | null = null;
  /** The label each run's consent chose, until its executor is opened. */
  const chosen = new Map<string, { folder: string; label: string }>();
  /** The run being served, and what its checkpoint was. */
  let current: ServedRun | null = null;
  let last: (WorkspaceRunSummary & { folder: string; n: number | null }) | null = null;
  /** Resolves when the serving loop ends. */
  let loop: Promise<void> = Promise.resolve();

  const status = (): CliWorkspaceStatus => ({
    connected, error,
    serving: current?.live ? { runId: current.runId, label: current.label, allowAll: current.allowAll } : null,
    lastRun: last ? { label: last.label, changed: last.changed, canUndo: last.canUndo, undone: last.undone, note: last.note } : null,
  });

  const closeCallAsks = (yes: boolean): void => { for (const c of [...callAsks]) c.resolve(yes); };

  const stopServing = (): void => {
    serving?.abort();
    serving = null;
    client = null;
    connected = false;
    for (const a of [...consentAsks]) a.close();
    closeCallAsks(false);
  };

  // ── Consent: which tools, what the run is shown ───────────────────────────

  const askUser = (r: { runId: string; expiresAt: number; signal: AbortSignal; hint?: { sites?: string[]; chat?: string } }): Promise<{ tools: string[]; label: string } | null> =>
    new Promise((resolve) => {
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const handle = { close: () => finish(null) };
      const finish = (answer: { tools: unknown; labelMode?: unknown } | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        consentAsks.delete(handle);
        ac.abort();
        if (!answer) { resolve(null); return; }
        // Checked again here whatever the prompt returned: the folder must still be one a run may have.
        const v = validateFolder(deps.folder, folderFs);
        const tools = sanitizeTools(answer.tools);
        if ('error' in v || !tools.length) { resolve(null); return; }
        const mode: LabelMode = answer.labelMode === 'folder' ? 'folder' : 'device';
        const label = buildLabel(mode, deps.device.name || hostname(), v.folder);
        chosen.set(r.runId, { folder: v.folder, label });
        resolve({ tools, label });
      };
      consentAsks.add(handle);
      // Unanswered within the offer's time (and never past ten minutes) is a no; so is the offer being withdrawn.
      const windowMs = consentWindowMs(r.expiresAt, now());
      timer = setTimeout(() => finish(null), windowMs);
      r.signal.addEventListener('abort', () => finish(null), { once: true });
      const v = validateFolder(deps.folder, folderFs);
      if ('error' in v) { finish(null); return; }
      ui.askConsent({
        runId: r.runId, chat: r.hint?.chat ? displayText(r.hint.chat, { max: 120 }) : null,
        device: displayText(deps.device.name || hostname(), { max: 80 }),
        folderName: displayText(v.folder.split(/[\\/]/).filter(Boolean).pop() ?? v.folder, { max: 80 }),
        expiresAt: r.expiresAt, windowMs, defaults: { tools: defaultTools, labelMode: defaultLabel }, signal: ac.signal,
      }).then(finish, () => finish(null));
    });

  // ── Per-call approval ─────────────────────────────────────────────────────

  const askCall: AskFn = (q) =>
    new Promise<boolean>((resolve) => {
      // "Allow everything for this run" was chosen earlier in this terminal.
      if (current?.allowAll) { resolve(true); return; }
      // Withdrawn before it got here (the executor was still taking its checkpoint): an
      // abort listener added now would never hear it, and the question would sit open.
      if (q.signal.aborted) { resolve(false); return; }
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const handle = { resolve: (yes: boolean) => done(yes) };
      const done = (yes: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        callAsks.delete(handle);
        ac.abort();
        resolve(yes);
      };
      callAsks.add(handle);
      // Unanswered, or the run withdrew the call: refused.
      timer = setTimeout(() => done(false), callTimeout);
      q.signal.addEventListener('abort', () => done(false), { once: true });
      const secrets = current?.secrets() ?? [];
      ui.askCall({
        tool: q.tool, summary: displayText(summarizeCall(q.tool, q.input), { max: 1000, secrets }),
        risk: q.risk.level, reason: displayText(q.risk.reason, { max: 300, secrets }), label: current?.label ?? null,
        timeoutMs: callTimeout, signal: ac.signal,
      }).then((answer) => {
        if (answer === 'all' && current) {
          current.allowAll = true;
          // Whatever else is waiting is part of "everything".
          closeCallAsks(true);
          return;
        }
        done(answer === 'allow' || answer === 'all');
      }, () => done(false));
    });

  // ── Opening the folder ────────────────────────────────────────────────────

  const open = async (consent: { tools: string[]; label: string }, run: { runId: string }, owner: AbortController | null = null): Promise<unknown> => {
    const c = chosen.get(run.runId);
    chosen.delete(run.runId);
    if (!c) throw new Error('no consent was given for this run');
    // An undo is putting files back and rewriting the checkpoint list: a run working in
    // the folder now would have its changes and its checkpoint overwritten.
    if (undoing) throw new Error('an undo of the last run is still putting files back on this computer; try again in a moment');
    // A run (perhaps from a service since stopped) is still finishing: its last calls and
    // its checkpoint aren't done, and another run's checkpoint would take them in.
    if (current) throw new Error('the previous run is still finishing on this computer; try again in a moment');
    // The folder may have changed since it was chosen.
    const v = validateFolder(c.folder, folderFs);
    if ('error' in v) throw new Error(v.error);
    const { core } = deps;
    const mgr = new core.ConfigManager(v.folder);
    const release = (): void => { try { mgr.getStore?.()?.close?.(); } catch { /* nothing to release */ } };
    // Its own config, local-only rules included: unreadable means no workspace, not one without them.
    await mgr.load();
    // Stopped (and maybe started again) while the folder's config loaded: this
    // service no longer serves, and must not replace a newer run's state.
    if (owner && serving !== owner) { release(); throw new Error('serving was turned off'); }
    if (undoing) { release(); throw new Error('an undo of the last run is still putting files back on this computer; try again in a moment'); }
    if (current) { release(); throw new Error('the previous run is still finishing on this computer; try again in a moment'); }
    const cfg = mgr.getConfig();
    release();
    const registry = new core.ToolRegistry({ ...(cfg.tools ?? {}), enabledTools: consent.tools, browserEnabled: false }, v.folder);
    // The folder's .cascadeignore, as a local run applies it: what it protects, no run reads or changes.
    registry.setIgnoredPaths(mgr.getIgnore().getUserPatterns());
    // The credentials this computer has configured are scrubbed from commands'
    // environment wherever they sit (a proxy URL holding a key, say), as in a local run.
    const secrets = (): string[] => core.secretValuesIn(cfg);
    registry.setSecretValues(secrets);
    const privacy = new core.PrivacyPaths(cfg.privacy?.paths ?? [], { workspaceRoot: v.folder });
    const store = new core.Checkpoints(v.folder, core.statePath(v.folder, core.STATE.checkpoints));
    const run_: ServedRun = { runId: run.runId, label: consent.label, folder: v.folder, allowAll: false, live: false, store, cp: null, owner, secrets };
    current = run_;
    const checkpoints = {
      begin: async (label: string) => { const cp = await store.begin(label); if (cp) run_.cp = { n: cp.n }; return cp; },
      end: (cp: { n: number }) => store.end(cp),
      ...(store.covers ? { covers: (p: string[]) => store.covers!(p) } : {}),
    };
    const executor = core.createWorkspaceExecutor({
      registry, tools: consent.tools, ask: askCall, checkpoints, privacy: () => privacy, label: consent.label, log,
    }) as WorkspaceExecutorLike;
    // The live line: what each call is, as it starts. A tool, a relative path or a command.
    return {
      definitions: () => executor.definitions(),
      finish: () => executor.finish(),
      run: (tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal; waiting?: () => void; worker?: string }) => {
        try { ui.activity(activityText(tool, input, v.folder, run_.secrets())); } catch { /* the line is a courtesy */ }
        return executor.run(tool, input, opts);
      },
    };
  };

  const onServing = (run: { runId: string; label: string } | null, owner: AbortController | null = null): void => {
    // A service stopped and replaced may still be finishing its run: what it
    // reports is about its own run, never the one a newer service has open.
    if (current && current.owner !== owner) return;
    if (run) {
      // Opened for this run: the indicator shows.
      if (current && current.runId === run.runId) { current.live = true; last = null; ui.served({ label: run.label }); }
      return;
    }
    // The run is over (ended, stopped, or withdrawn): what it changed is in its checkpoint now.
    const ended = current;
    current = null;
    closeCallAsks(false);
    if (ended?.live) {
      let changed: number | null = null;
      let note: string | null = null;
      let canUndo = false;
      try {
        const rec = ended.cp ? ended.store?.list().find((x) => x.n === ended.cp!.n) : undefined;
        changed = rec?.changed ?? (ended.cp ? null : 0);
        canUndo = !!ended.cp && (rec?.changed ?? 1) > 0;
        if (!ended.cp) note = 'Nothing was changed, so there is nothing to undo.';
        else if (rec?.changed === 0) note = 'The run changed nothing.';
        else if (rec && !rec.after) { canUndo = false; note = 'This run\'s checkpoint is incomplete, so its changes can\'t be undone from here. Use /undo --force in Cascade for that folder if you are sure.'; }
      } catch { note = 'The run\'s checkpoint could not be read.'; }
      last = { label: ended.label, changed, canUndo, undone: false, note, folder: ended.folder, n: ended.cp?.n ?? null };
      ui.runEnded({ label: last.label, changed, canUndo, undone: false, note });
    }
  };

  // ── Serving ───────────────────────────────────────────────────────────────

  const api = {
    status,

    /**
     * Serves, with the device the browser relay paired. Resolves when serving ends: for
     * `stop()`, or when the server turns this device away.
     */
    start(): Promise<'stopped' | 'refused'> {
      const v = validateFolder(deps.folder, folderFs);
      if ('error' in v) throw new Error(v.error);
      serving?.abort();
      const ctl = new AbortController();
      serving = ctl;
      error = null;
      const d = deps.device;
      const p = deps.core.serveWorkspaceDevice({
        stored: { deviceId: d.deviceId, privateKeyPem: d.privateKeyPem, serverId: d.serverId, serverKey: d.serverKey },
        endpoints: deps.core.relayEndpoints(d.serverUrl, { controlPath: WORKSPACE_CONTROL_PATH, runPath: WORKSPACE_RUN_PATH }),
        askUser, signal: ctl.signal,
        // Bound to this service: one stopped can't open a run, nor end a newer one's.
        open: (consent, run) => {
          if (serving !== ctl) return Promise.reject(new Error('serving was turned off'));
          return open(consent, run, ctl);
        },
        onServing: (run) => onServing(run, ctl),
        onClient: (c) => { if (serving === ctl) client = c; },
        log: (line) => {
          log(line);
          if (serving !== ctl) return;
          if (line.startsWith('connected')) { connected = true; error = null; ui.notice(line); }
          else if (line.startsWith('disconnected')) { connected = false; ui.notice(line); }
        },
      }).then((outcome) => {
        if (serving === ctl) {
          connected = false;
          if (outcome === 'refused') error = 'Cascade Cloud does not accept this device. It may have been removed: run `cascade relay forget`, then `cascade relay pair`.';
        }
        return outcome;
      }, (e: unknown) => {
        if (serving === ctl) { connected = false; error = e instanceof Error ? e.message : String(e); }
        throw e;
      });
      loop = p.then(() => undefined, () => undefined);
      return p;
    },

    /** Resolves once the serving loop has ended and its last run's checkpoint is closed. */
    finished(): Promise<void> { return loop; },

    /** Stops serving now: the connection closes and a run on it ends. */
    stop(): void { stopServing(); },

    /** The user's Stop: the run's access ends at once, and it is not offered the workspace again. */
    stopRun(): { ok: true } | { error: string } {
      if (!current || !client) return { error: 'No run is using the workspace.' };
      client.stop('stopped on this computer');
      closeCallAsks(false);
      return { ok: true };
    },

    /** Puts the last run's changes back, from the checkpoint taken before its first one. */
    async undoLastRun(): Promise<{ ok: true; restored: number; removed: number; skipped: number } | { error: string }> {
      if (!last || !last.canUndo || last.n === null) return { error: 'There is nothing to undo.' };
      if (last.undone) return { error: 'That run\'s changes were already undone.' };
      if (current) return { error: 'A run is using the folder now. Stop it first.' };
      const v = validateFolder(last.folder, folderFs);
      if ('error' in v) return v;
      const store = new deps.core.Checkpoints(v.folder, deps.core.statePath(v.folder, deps.core.STATE.checkpoints));
      // undo(1) puts back the newest checkpoint not yet undone: it must be this run's own.
      const all = store.list();
      const mine = all.find((c) => c.n === last!.n);
      if (!mine) return { error: 'That run\'s checkpoint is gone, so there is nothing to undo from here.' };
      if (mine.undone) { last = { ...last, undone: true, canUndo: false, note: 'Already undone (from Cascade).' }; return { error: 'That run\'s changes were already undone.' }; }
      if (all.filter((c) => !c.undone).at(-1)?.n !== last.n) return { error: 'A newer checkpoint exists for this folder, so undoing the run from here could put back more than it changed. Use /undo in Cascade for that folder.' };
      if (undoing) return { error: 'An undo is already running.' };
      // The run this undo is for: another run can start and end while it works, and
      // its summary then replaces this one, which must be left as it is.
      const target = last;
      const update = (next: NonNullable<typeof last>): void => { if (last === target) last = next; };
      undoing = true;
      let r: Awaited<ReturnType<CheckpointStore['undo']>>;
      try { r = await store.undo(1); } finally { undoing = false; }
      // The run's last snapshot was never written: nothing was put back.
      if (r.incomplete?.length) {
        update({ ...target, note: 'This run\'s checkpoint is incomplete, so its changes could not be undone from here. Use /undo --force in Cascade for that folder if you are sure.' });
        return { error: 'The run\'s checkpoint is incomplete, so nothing was undone.' };
      }
      update({ ...target, undone: true, canUndo: false, note: r.skipped.length ? `${r.skipped.length} file(s) changed since the run were left as they are.` : null });
      return { ok: true, restored: r.restored.length, removed: r.removed.length, skipped: r.skipped.length };
    },

    dismissLastRun(): void { last = null; },

    /** The folder the last run worked in, for telling the person where to undo. */
    lastFolder(): string | null { return last?.folder ?? null; },

    /** Quitting: end everything. */
    shutdown(): void { stopServing(); },
  };
  return api;
}

export type CliWorkspace = ReturnType<typeof createCliWorkspace>;
