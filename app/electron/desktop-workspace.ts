// ─────────────────────────────────────────────
//  Cascade Desktop — a folder on this computer as a cloud run's workspace
// ─────────────────────────────────────────────
//
// Off until the user turns it on in Settings. It serves with the SAME device the
// browser relay paired (desktop-relay.ts: one key, one pinned server, one entry in the
// account's device list); it registers nothing of its own. Each run that asks for a
// workspace is asked about here: which folder, which tools, what the run is shown.
// A yes opens a tool registry rooted at that folder (the SDK's executor judges each
// call's risk, jails commands, checkpoints before the first change); a risky call asks
// again, in this window. The folder's path never leaves this computer: only the label.

import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  CALL_ASK_TIMEOUT_MS, buildLabel, consentWindowMs, presetOf, sanitizeTools, summarizeCall, validateFolder,
  type FolderFs, type LabelMode,
} from './workspace-consent.js';
import type { StoredDesktopDevice } from './desktop-relay.js';

/** Where the server's workspace endpoints are: the browser relay's server, its own two paths. */
export const WORKSPACE_CONTROL_PATH = '/api/workspace-relay/control';
export const WORKSPACE_RUN_PATH = '/api/workspace-relay/run';

/** What is remembered between runs: the switch, and the last answer as the default for the next. */
export interface WorkspaceSettings {
  enabled: boolean;
  folder?: string;
  tools?: string[];
  labelMode?: LabelMode;
}

interface CheckpointRecord { n: number; changed?: number; after?: string; undone?: boolean }
interface CheckpointStore {
  begin(label: string): Promise<{ n: number } | null>;
  end(cp: { n: number }): Promise<unknown>;
  covers?(paths: string[]): Promise<boolean>;
  list(): CheckpointRecord[];
  undo(count?: number, force?: boolean): Promise<{ restored: string[]; removed: string[]; skipped: string[] }>;
}

type AskFn = (q: { tool: string; input: Record<string, unknown>; risk: { level: string; reason: string }; signal: AbortSignal }) => Promise<boolean>;

/** The slice of the SDK bundle (loadCore()) this service uses. */
export interface DesktopWorkspaceCore {
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
  ToolRegistry: new (config: Record<string, unknown>, root: string) => { setIgnoredPaths(patterns: string[]): void };
  ConfigManager: new (root: string) => { load(): Promise<void>; getConfig(): { tools?: Record<string, unknown>; privacy?: { paths?: Array<{ pattern: string; policy: 'local-only' }> } }; getIgnore(): { getUserPatterns(): string[] }; getStore?(): { close?(): void } | undefined };
  PrivacyPaths: new (policies: Array<{ pattern: string; policy: 'local-only' }>, opts: { workspaceRoot: string }) => unknown;
  Checkpoints: new (root: string, dir: string) => CheckpointStore;
  statePath(root: string, ...parts: string[]): string;
  STATE: { checkpoints: string };
}

export interface DesktopWorkspaceDeps {
  core: DesktopWorkspaceCore;
  /** The signed-in account: its id and server; null when signed out. */
  cloud(): { userId: string; serverUrl: string } | null;
  /** The device the browser relay paired: read here, never written. */
  device: { load(): StoredDesktopDevice | null };
  vault: { decrypt(blob: string): string };
  settings: { load(): WorkspaceSettings; save(s: WorkspaceSettings): void };
  /** To the app's window. */
  notify(channel: 'workspace:ask' | 'workspace:ask-closed' | 'workspace:call-ask' | 'workspace:call-ask-closed' | 'workspace:status', payload: unknown): void;
  fs?: FolderFs;
  hostname?: () => string;
  now?: () => number;
  /** How long a question about one call waits for the person. */
  callTimeoutMs?: number;
  log?: (line: string) => void;
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

export interface DesktopWorkspaceStatus {
  paired: boolean;
  enabled: boolean;
  connected: boolean;
  name: string | null;
  server: string | null;
  /** The run being served now: the label it is shown. */
  serving: { runId: string; label: string; allowAll: boolean } | null;
  /** The run that was served last, for Undo. Cleared when another run starts. */
  lastRun: WorkspaceRunSummary | null;
  /** What is offered as the default next time (local to this window: the path is shown to its owner only). */
  defaults: { folder: string | null; tools: string[]; labelMode: LabelMode; preset: string | null };
  error: string | null;
}

export type WorkspaceAnswer = { folder: string; tools: string[]; labelMode?: LabelMode };

interface Ask { id: number; runId: string; resolve(c: WorkspaceAnswer | null): void; payload: Record<string, unknown> | null }
interface CallAsk { id: number; resolve(yes: boolean): void; payload: Record<string, unknown> | null }

const DEFAULT_TOOLS: string[] = ['file_list', 'file_read', 'glob', 'grep'];

export function createDesktopWorkspace(deps: DesktopWorkspaceDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const folderFs: FolderFs = deps.fs ?? {
    home: () => os.homedir(),
    realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  };
  const hostname = deps.hostname ?? os.hostname;
  const callTimeout = deps.callTimeoutMs ?? CALL_ASK_TIMEOUT_MS;

  const asks = new Map<number, Ask>();
  const callAsks = new Map<number, CallAsk>();
  let nextAsk = 1;
  let nextCall = 1;
  let serving: AbortController | null = null;
  let client: { stop(reason?: string): void } | null = null;
  let connected = false;
  let error: string | null = null;
  /** The folder each run's consent chose, until its executor is opened: never sent anywhere. */
  const chosen = new Map<string, { folder: string; label: string }>();
  /** The run being served, and what its checkpoint was. */
  let current: { runId: string; label: string; folder: string; allowAll: boolean; live: boolean; store: CheckpointStore | null; cp: { n: number } | null; owner: AbortController | null } | null = null;
  let last: (WorkspaceRunSummary & { folder: string; n: number | null }) | null = null;

  const ownerSignedIn = (d: StoredDesktopDevice): boolean => {
    const c = deps.cloud();
    return !!c && c.userId === d.accountId && c.serverUrl === d.serverUrl;
  };
  const problem = (d: StoredDesktopDevice | null, enabled: boolean): string | null => {
    if (!enabled || !d || ownerSignedIn(d)) return null;
    return deps.cloud()
      ? 'This app was paired for another Cascade Cloud account. Sign in to that one, or remove this app as a device.'
      : 'Sign in to Cascade Cloud, with the account this app was paired for, to serve runs.';
  };

  const status = (): DesktopWorkspaceStatus => {
    const d = deps.device.load();
    const s = deps.settings.load();
    const tools = sanitizeTools(s.tools);
    return {
      paired: !!d, enabled: !!s.enabled, connected, name: d?.name ?? null, server: d?.serverUrl ?? null,
      serving: current?.live ? { runId: current.runId, label: current.label, allowAll: current.allowAll } : null,
      lastRun: last ? { label: last.label, changed: last.changed, canUndo: last.canUndo, undone: last.undone, note: last.note } : null,
      defaults: { folder: s.folder ?? null, tools: tools.length ? tools : DEFAULT_TOOLS, labelMode: s.labelMode ?? 'device', preset: presetOf(tools.length ? tools : DEFAULT_TOOLS) },
      error: error ?? problem(d, !!s.enabled),
    };
  };
  const publish = (): void => deps.notify('workspace:status', status());

  const stopServing = (): void => {
    serving?.abort();
    serving = null;
    client = null;
    connected = false;
    for (const a of [...asks.values()]) a.resolve(null);
    for (const c of [...callAsks.values()]) c.resolve(false);
  };

  // ── Consent: which folder, which tools ────────────────────────────────────

  const askUser = (r: { runId: string; expiresAt: number; signal: AbortSignal; hint?: { sites?: string[]; chat?: string } }): Promise<{ tools: string[]; label: string } | null> =>
    new Promise((resolve) => {
      const id = nextAsk++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (c: WorkspaceAnswer | null): void => {
        if (!asks.delete(id)) return;
        clearTimeout(timer);
        deps.notify('workspace:ask-closed', { id });
        if (!c) { resolve(null); return; }
        // Checked again here whatever the window sent: the folder must be one a run may have.
        const v = validateFolder(c.folder, folderFs);
        const tools = sanitizeTools(c.tools);
        if ('error' in v || !tools.length) { resolve(null); return; }
        const mode: LabelMode = c.labelMode === 'folder' ? 'folder' : 'device';
        const d = deps.device.load();
        const label = buildLabel(mode, d?.name ?? hostname(), v.folder);
        chosen.set(r.runId, { folder: v.folder, label });
        deps.settings.save({ ...deps.settings.load(), folder: v.folder, tools, labelMode: mode });
        publish();
        resolve({ tools, label });
      };
      asks.set(id, { id, runId: r.runId, resolve: done, payload: null });
      // Unanswered within the offer's time is a no; so is the offer being withdrawn.
      timer = setTimeout(() => done(null), consentWindowMs(r.expiresAt, now()));
      r.signal.addEventListener('abort', () => done(null), { once: true });
      const s = deps.settings.load();
      const d = deps.device.load();
      const payload = {
        id, runId: r.runId, expiresAt: r.expiresAt,
        // Which computer is asking: the run's own hint, when it sent one.
        chat: r.hint?.chat ?? null,
        device: d?.name ?? hostname(),
        defaults: { folder: s.folder ?? null, tools: sanitizeTools(s.tools).length ? sanitizeTools(s.tools) : DEFAULT_TOOLS, labelMode: s.labelMode ?? 'device' },
      };
      // Kept while open: a window opened later (or reloaded) asks for it with pending().
      asks.get(id)!.payload = payload;
      deps.notify('workspace:ask', payload);
    });

  // ── Per-call approval ─────────────────────────────────────────────────────

  const askCall: AskFn = (q) =>
    new Promise<boolean>((resolve) => {
      // "Allow everything for this run" was chosen earlier on this machine.
      if (current?.allowAll) { resolve(true); return; }
      const id = nextCall++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (yes: boolean): void => {
        if (!callAsks.delete(id)) return;
        clearTimeout(timer);
        deps.notify('workspace:call-ask-closed', { id });
        resolve(yes);
      };
      callAsks.set(id, { id, resolve: done, payload: null });
      // Unanswered, or the run withdrew the call: refused.
      timer = setTimeout(() => done(false), callTimeout);
      q.signal.addEventListener('abort', () => done(false), { once: true });
      const payload = {
        id, tool: q.tool, summary: summarizeCall(q.tool, q.input), risk: q.risk.level, reason: q.risk.reason,
        label: current?.label ?? null, expiresAt: now() + callTimeout,
      };
      callAsks.get(id)!.payload = payload;
      deps.notify('workspace:call-ask', payload);
    });

  // ── Opening the folder ────────────────────────────────────────────────────

  const open = async (consent: { tools: string[]; label: string }, run: { runId: string }, owner: AbortController | null = null): Promise<unknown> => {
    const c = chosen.get(run.runId);
    chosen.delete(run.runId);
    if (!c) throw new Error('no folder was chosen for this run');
    // The folder may have changed since it was chosen.
    const v = validateFolder(c.folder, folderFs);
    if ('error' in v) throw new Error(v.error);
    const { core } = deps;
    const mgr = new core.ConfigManager(v.folder);
    // Its own config, local-only rules included: unreadable means no workspace, not one without them.
    await mgr.load();
    const cfg = mgr.getConfig();
    try { mgr.getStore?.()?.close?.(); } catch { /* nothing to release */ }
    const registry = new core.ToolRegistry({ ...(cfg.tools ?? {}), enabledTools: consent.tools, browserEnabled: false }, v.folder);
    // The folder's .cascadeignore, as a local run applies it: what it protects, no run reads or changes.
    registry.setIgnoredPaths(mgr.getIgnore().getUserPatterns());
    const privacy = new core.PrivacyPaths(cfg.privacy?.paths ?? [], { workspaceRoot: v.folder });
    const store = new core.Checkpoints(v.folder, core.statePath(v.folder, core.STATE.checkpoints));
    const run_: NonNullable<typeof current> = { runId: run.runId, label: consent.label, folder: v.folder, allowAll: false, live: false, store, cp: null, owner };
    current = run_;
    const checkpoints = {
      begin: async (label: string) => { const cp = await store.begin(label); if (cp) run_.cp = { n: cp.n }; return cp; },
      end: (cp: { n: number }) => store.end(cp),
      ...(store.covers ? { covers: (p: string[]) => store.covers!(p) } : {}),
    };
    return core.createWorkspaceExecutor({
      registry, tools: consent.tools, ask: askCall, checkpoints, privacy: () => privacy, label: consent.label, log,
    });
  };

  const onServing = (run: { runId: string; label: string } | null, owner: AbortController | null = null): void => {
    // A service turned off and replaced may still be finishing its run: what it
    // reports is about its own run, never the one a newer service has open.
    if (current && current.owner !== owner) return;
    if (run) {
      // Opened for this run: the indicator shows.
      if (current && current.runId === run.runId) { current.live = true; last = null; publish(); }
      return;
    }
    // The run is over (ended, stopped, or withdrawn): what it changed is in its checkpoint now.
    const ended = current;
    current = null;
    for (const c of [...callAsks.values()]) c.resolve(false);
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
      } catch { note = 'The run\'s checkpoint could not be read.'; }
      last = { label: ended.label, changed, canUndo, undone: false, note, folder: ended.folder, n: ended.cp?.n ?? null };
    }
    publish();
  };

  // ── Serving ───────────────────────────────────────────────────────────────

  const serve = (d: StoredDesktopDevice): void => {
    serving?.abort();
    const ctl = new AbortController();
    serving = ctl;
    let privateKeyPem: string;
    try { privateKeyPem = deps.vault.decrypt(d.privateKeyEnc); } catch {
      error = 'This app\'s device key could not be read. Remove this app as a device in Settings → Cloud runs and pair it again.';
      publish();
      return;
    }
    void deps.core.serveWorkspaceDevice({
      stored: { deviceId: d.deviceId, privateKeyPem, serverId: d.serverId, serverKey: d.serverKey },
      endpoints: deps.core.relayEndpoints(d.serverUrl, { controlPath: WORKSPACE_CONTROL_PATH, runPath: WORKSPACE_RUN_PATH }),
      askUser, signal: ctl.signal,
      // Bound to this service: one turned off can't open a run, nor end a newer one's.
      open: (consent, run) => {
        if (serving !== ctl) return Promise.reject(new Error('serving was turned off'));
        return open(consent, run, ctl);
      },
      onServing: (run) => onServing(run, ctl),
      onClient: (c) => { if (serving === ctl) client = c; },
      log: (line) => {
        log(line);
        if (line.startsWith('connected')) { connected = true; error = null; publish(); }
        else if (line.startsWith('disconnected')) { connected = false; publish(); }
      },
    }).then((outcome) => {
      if (serving !== ctl) return;
      connected = false;
      if (outcome === 'refused') error = 'Cascade Cloud does not accept this app as a workspace device. It may have been removed: turn this off, remove and pair the app again in Settings → Cloud runs.';
      publish();
    }, (e: unknown) => {
      if (serving !== ctl) return;
      connected = false;
      error = e instanceof Error ? e.message : String(e);
      publish();
    });
  };

  const api = {
    status,

    /** Serves, with the device the browser relay paired. Not paired, or another account: it says so. */
    enable(): DesktopWorkspaceStatus {
      const d = deps.device.load();
      if (!d) throw new Error('This app is not paired with Cascade Cloud yet. Pair it in Settings → Cloud runs first.');
      if (!ownerSignedIn(d)) throw new Error(problem(d, true)!);
      deps.settings.save({ ...deps.settings.load(), enabled: true });
      error = null;
      serve(d);
      publish();
      return status();
    },

    /** Stops serving now: the connection closes and a run on it ends. What was chosen is kept. */
    disable(): DesktopWorkspaceStatus {
      stopServing();
      deps.settings.save({ ...deps.settings.load(), enabled: false });
      error = null;
      publish();
      return status();
    },

    /** The user's Stop: the run's access ends at once, and it is not offered the workspace again. */
    stop(): { ok: true } | { error: string } {
      if (!current || !client) return { error: 'No run is using a workspace on this computer.' };
      client.stop('stopped on this computer');
      for (const c of [...callAsks.values()]) c.resolve(false);
      return { ok: true };
    },

    /** The folder's name and whether a run may have it, for the picker's answer. */
    checkFolder(folder: unknown): { ok: true; folder: string; name: string } | { error: string } {
      const v = validateFolder(folder, folderFs);
      if ('error' in v) return v;
      return { ok: true, folder: v.folder, name: v.folder.split(/[\\/]/).filter(Boolean).pop() ?? v.folder };
    },

    /** Forgets the remembered folder and tools. */
    clearDefaults(): DesktopWorkspaceStatus {
      const { enabled } = deps.settings.load();
      deps.settings.save({ enabled });
      publish();
      return status();
    },

    /**
     * The user's answer to a consent question: a folder, the tools, how the run sees
     * it. Null is a no. An answer that isn't an allowed folder and at least one tool
     * is asked again.
     */
    answer(id: number, a: { folder?: unknown; tools?: unknown; labelMode?: unknown } | null): { ok: true } | { error: string } {
      const ask = asks.get(id);
      if (!ask) return { error: 'This request is over.' };
      if (!a) { ask.resolve(null); return { ok: true }; }
      const v = validateFolder(a.folder, folderFs);
      if ('error' in v) return v;
      const tools = sanitizeTools(a.tools);
      if (!tools.length) return { error: 'Choose at least one tool, or say no.' };
      ask.resolve({ folder: v.folder, tools, labelMode: a.labelMode === 'folder' ? 'folder' : 'device' });
      return { ok: true };
    },

    /** The user's answer to a question about one call. "all" allows what else the run asks about, until it ends. */
    answerCall(id: number, answer: 'allow' | 'deny' | 'all'): { ok: true } | { error: string } {
      const c = callAsks.get(id);
      if (!c) return { error: 'This request is over.' };
      if (answer === 'all' && current) {
        current.allowAll = true;
        // Whatever else is waiting is part of "everything".
        for (const other of [...callAsks.values()]) other.resolve(true);
        publish();
        return { ok: true };
      }
      c.resolve(answer === 'allow');
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
      if (mine.undone) { last = { ...last, undone: true, canUndo: false, note: 'Already undone (from Cascade).' }; publish(); return { error: 'That run\'s changes were already undone.' }; }
      if (all.filter((c) => !c.undone).at(-1)?.n !== last.n) return { error: 'A newer checkpoint exists for this folder, so undoing the run from here could put back more than it changed. Use /undo in Cascade for that folder.' };
      const r = await store.undo(1);
      last = { ...last, undone: true, canUndo: false, note: r.skipped.length ? `${r.skipped.length} file(s) changed since the run were left as they are.` : null };
      publish();
      return { ok: true, restored: r.restored.length, removed: r.removed.length, skipped: r.skipped.length };
    },

    dismissLastRun(): void { last = null; publish(); },

    /** The questions still open, for a window that opened (or reloaded) after they were asked. */
    pending(): { asks: unknown[]; calls: unknown[] } {
      return {
        asks: [...asks.values()].map((a) => a.payload).filter(Boolean),
        calls: [...callAsks.values()].map((c) => c.payload).filter(Boolean),
      };
    },

    /** At start: serve if the user left it on, the app is still paired, and its account is the one signed in. */
    resume(): void {
      const d = deps.device.load();
      if (deps.settings.load().enabled && d && ownerSignedIn(d)) serve(d);
      publish();
    },

    /** Signed out, or in as someone else: stop, and serve again only for the pairing's own account. */
    accountChanged(): void {
      stopServing();
      error = null;
      this.resume();
    },

    /** The browser relay's pairing was removed or replaced: the key this serves with is gone. */
    deviceChanged(): void {
      stopServing();
      error = null;
      if (deps.device.load()) this.resume(); else { deps.settings.save({ ...deps.settings.load(), enabled: false }); publish(); }
    },

    /** Quitting: end everything. */
    shutdown(): void { stopServing(); },
  };
  return api;
}

export type DesktopWorkspace = ReturnType<typeof createDesktopWorkspace>;
