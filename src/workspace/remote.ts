// ─────────────────────────────────────────────
//  Cascade AI — A run's tools, served by a workspace on the user's machine
// ─────────────────────────────────────────────
//
//  The run's side of a workspace (docs/design/workspace-env.md). Given the
//  connection the hub hands the run once the machine has claimed it, this waits
//  for the machine's `ready`, then gives the run one tool per tool the user
//  allowed, with the schema the machine's own registry gives it. Calling one sends
//  the call to the machine and resolves with what it returned there.
//
//  The run never names a path on the machine beyond what a tool takes as input,
//  and is never shown a tool the machine won't run.

import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { BaseTool } from '../tools/base.js';
import type { ToolDefinition, ToolExecuteOptions } from '../types.js';
import { type ServerRunFrame, MAX_CHANGED, MAX_INPUT_BYTES, MAX_IN_FLIGHT, WORKSPACE_PROTOCOL, readDeviceFrame } from './protocol.js';

const READY_TIMEOUT_MS = 30_000;
/** Long enough for a build or a test run; the machine's own tools time out sooner. */
const CALL_TIMEOUT_MS = 15 * 60_000;
const OPEN = 1;

/** What a run's workspace connection needs to be: a WebSocket, or anything shaped like one. */
export type WorkspaceSocket = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  on(event: 'message', fn: (raw: unknown) => void): unknown;
  on(event: 'close' | 'error', fn: () => void): unknown;
};

export interface RemoteWorkspace {
  /** What the machine calls this workspace. Never its path. */
  readonly label: string;
  /** One per tool the user allowed. Register them in the run's registry. */
  readonly tools: BaseTool[];
  /** Resolves with why, once the workspace is gone. It is never resumed. */
  readonly closed: Promise<string>;
  /** Told when a call waits for the person's answer on the machine. */
  onWaiting(fn: (call: { id: string; tool: string; worker?: string }) => void): void;
  close(reason?: string): void;
}

export class WorkspaceUnavailable extends Error {}

/**
 * Waits for the machine's `ready`, then gives the run its tools. Pass the socket
 * as soon as it is made, before it opens: the machine's `ready` can arrive in the
 * same read as the connection opening, and is lost to a listener added after.
 */
export function openRemoteWorkspace(socket: WorkspaceSocket, opts: { readyTimeoutMs?: number; callTimeoutMs?: number } = {}): Promise<RemoteWorkspace> {
  const callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
  return new Promise((resolveOpen, rejectOpen) => {
    const pending = new Map<string, { tool: string; worker?: string; resolve(out: CallResult): void; reject(e: Error): void }>();
    const waiters: ((call: { id: string; tool: string }) => void)[] = [];
    let over = false;
    let opened = false;
    let finish!: (why: string) => void;
    const closed = new Promise<string>((r) => { finish = r; });
    const send = (frame: ServerRunFrame): void => { if (socket.readyState === OPEN) socket.send(JSON.stringify(frame)); };
    const end = (why: string): void => {
      if (over) return;
      over = true;
      clearTimeout(readyTimer);
      for (const p of pending.values()) p.reject(new WorkspaceUnavailable(`The workspace is no longer available (${why}).`));
      pending.clear();
      try { socket.close(1000, why.slice(0, 100)); } catch { /* already closing */ }
      if (!opened) rejectOpen(new WorkspaceUnavailable(why));
      finish(why);
    };
    const readyTimer = setTimeout(() => end('the machine did not open the workspace in time'), opts.readyTimeoutMs ?? READY_TIMEOUT_MS);

    const call = (tool: string, input: Record<string, unknown>, signal?: AbortSignal, worker?: string): Promise<CallResult> => new Promise((resolve, reject) => {
      if (over) { reject(new WorkspaceUnavailable('The workspace is no longer available.')); return; }
      if (signal?.aborted) { reject(new Error(`${tool} was not run: the run was cancelled.`)); return; }
      if (pending.size >= MAX_IN_FLIGHT) { reject(new Error('Too many calls at once on the workspace; try again when one has finished.')); return; }
      let body: string;
      const id = randomBytes(12).toString('base64url');
      try { body = JSON.stringify({ v: WORKSPACE_PROTOCOL, t: 'call', id, tool, input, ...(worker ? { worker } : {}) } satisfies ServerRunFrame); } catch { reject(new Error(`${tool}: its input could not be sent.`)); return; }
      if (Buffer.byteLength(body) > MAX_INPUT_BYTES) { reject(new Error(`${tool}: its input is too large to send to the workspace.`)); return; }
      const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); pending.delete(id); };
      const onAbort = (): void => { done(); send({ v: WORKSPACE_PROTOCOL, t: 'cancel', id }); reject(new Error(`${tool} was cancelled.`)); };
      const timer = setTimeout(() => { done(); send({ v: WORKSPACE_PROTOCOL, t: 'cancel', id }); reject(new Error(`${tool} took too long on the workspace and was cancelled.`)); }, callTimeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, { tool, ...(worker ? { worker } : {}), resolve: (out) => { done(); resolve(out); }, reject: (e) => { done(); reject(e); } });
      socket.send(body);
    });

    socket.on('message', (raw) => {
      if (over) return;
      const f = readDeviceFrame(String(raw));
      if (!f) { end('the machine sent something that is not a workspace frame'); return; }
      if (f.t === 'ready') {
        if (opened) { end('the machine opened the workspace twice'); return; }
        opened = true;
        clearTimeout(readyTimer);
        resolveOpen({
          label: f.label,
          tools: f.tools.map((d) => new RemoteWorkspaceTool(d, call)),
          closed,
          onWaiting: (fn) => { waiters.push(fn); },
          close: (reason = 'the run is over') => end(reason),
        });
        return;
      }
      if (!opened) { end('the machine answered before opening the workspace'); return; }
      const p = pending.get(f.id);
      if (!p) return; // cancelled, or timed out, before it answered
      if (f.t === 'status') { for (const w of waiters) w({ id: f.id, tool: p.tool, ...(p.worker ? { worker: p.worker } : {}) }); return; }
      if (f.ok) p.resolve({ output: f.output, ...(f.changed ? { changed: f.changed } : {}) }); else p.reject(new Error(f.error));
    });
    socket.on('close', () => end('the workspace connection closed'));
    socket.on('error', () => end('the workspace connection failed'));
  });
}

interface CallResult { output: string; changed?: string[] }

/** A worker's id as the protocol carries it: the id's own characters, at most 64. Absent when nothing is left. */
export const workerId = (tierId: unknown): string | undefined => {
  const id = typeof tierId === 'string' ? tierId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) : '';
  return id || undefined;
};

/** The note changedNote() ends a tool result with, at its very end. */
const CHANGED_NOTE_AT_END = /\n\n(\[Files in the workspace changed since you read them: [^\n]* — read them again before relying on them\.\])$/;

/**
 * A tool result split into what the tool returned and the change note after it, so
 * whatever shortens the result for a model's context can keep the note whole: the
 * machine has already counted those files as reported.
 */
export function splitChangedNote(text: string): { rest: string; note: string | null } {
  const m = CHANGED_NOTE_AT_END.exec(text);
  return m ? { rest: text.slice(0, m.index), note: m[1]! } : { rest: text, note: null };
}

/** What the run's model is told when files it read have changed on the machine. */
export function changedNote(changed: string[]): string {
  const shown = changed.slice(0, MAX_CHANGED);
  return `[Files in the workspace changed since you read them: ${shown.join(', ')} — read them again before relying on them.]`;
}

/** One tool of the run's, run on the machine. */
class RemoteWorkspaceTool extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  override readonly remote = true;

  constructor(def: ToolDefinition, private readonly call: (tool: string, input: Record<string, unknown>, signal?: AbortSignal, worker?: string) => Promise<CallResult>) {
    super();
    this.name = def.name;
    this.description = `${def.description}\n\n(Runs in the user's workspace on their own machine.)`;
    this.inputSchema = def.inputSchema;
  }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    // The caller's tier id is the worker: the machine keeps what each one has read.
    const { output, changed } = await this.call(this.name, input, options.signal, workerId(options.tierId));
    return changed?.length ? `${output}\n\n${changedNote(changed)}` : output;
  }
}
