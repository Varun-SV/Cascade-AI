// ─────────────────────────────────────────────
//  Cascade Cloud Server — Socket.IO wiring
// ─────────────────────────────────────────────

import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { ZodError } from 'zod';
import { parseCookies, verifySessionToken, SESSION_COOKIE_NAME } from './auth/session.js';
import type { CloudEnv } from './env.js';
import type { CloudStore } from './db.js';
import { formatZodError, parseChatRunPayload, runChatTurn, type ChatRunResult, type RunSocket } from './runs.js';

interface CloudSocketData {
  userId: string;
}

type ChatRunAck = (
  res:
    | {
        conversationId: string;
        output: string;
        costUsd: number;
        totalTokens: number;
        tier: string | null;
        model: string | null;
        savedUsd: number;
        savedPct: number;
        cancelled: boolean;
      }
    | { error: string },
) => void;

/**
 * How long a dropped connection's runs are held before being abandoned.
 *
 * A multi-tier run takes minutes, and for every one of those minutes a single
 * dropped websocket frame used to end it: `disconnect` aborted the run outright,
 * and Socket.IO fires that on a missed heartbeat, a proxy idle-timeout, or any
 * transient network blip — not only on a closed tab. The client reconnects
 * (`reconnection: true`), but it reconnects as a NEW socket, so nothing brought
 * the run back; the user saw a run that simply died while their page sat there
 * connected. Reported as "I tried stopping it, navigating away, and leaving it
 * to run, and in all three cases the response just died" — three different
 * actions collapsing onto this one abort.
 *
 * Holding the run is safe because the answer does not depend on the socket:
 * `runChatTurn` persists the assistant message via `store.addMessage` BEFORE it
 * emits anything, so a run allowed to finish is readable on the conversation
 * whether or not the emit lands. Aborting is what threw the answer away.
 *
 * The window is bounded so a genuinely-gone client still stops the spend, and
 * per-user concurrency/quota in entitlements.ts is unchanged.
 */
const RECONNECT_GRACE_MS = 90_000;

/**
 * A run's transport, decoupled from the connection that started it.
 *
 * `runChatTurn` needs exactly three things from a socket — `emit`, `on`, `off`
 * — which is why `RunSocket` in runs.ts names that surface instead of taking
 * socket.io's `Socket`. Handing it one of these rather than the raw socket is
 * what lets a run outlive the connection that began it: on reconnect the
 * transport is re-pointed and every later emit, plus the client-answer
 * listeners for `context:decision` and `escalation:decide`, follow the user to
 * the new socket.
 *
 * Listeners are tracked rather than merely forwarded because rebinding has to
 * move them: a listener registered on the old socket is dead weight once that
 * socket is gone, and the interactive gates are precisely the case where the
 * server is waiting on an answer only the CURRENT page can give.
 *
 * Emits with no current socket are dropped, which is the pre-existing
 * behaviour for a disconnected client and is safe for the same reason holding
 * the run is: `runChatTurn` persists the assistant message before it emits
 * anything, so the answer is on the conversation either way.
 */
export class RebindableTransport implements RunSocket {
  private current: Socket | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(socket: Socket) { this.current = socket; }

  emit(event: string, payload: unknown): unknown {
    return this.current?.emit(event, payload);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
    return this.current?.on(event, listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): unknown {
    this.listeners.get(event)?.delete(listener);
    return this.current?.off(event, listener);
  }

  /** Point this run at a different connection, or at none. */
  rebind(next: Socket | null): void {
    for (const [event, set] of this.listeners) {
      for (const listener of set) {
        this.current?.off(event, listener);
        next?.on(event, listener);
      }
    }
    this.current = next;
  }
}

/**
 * One in-flight run: how to abort it, how to talk to it, and whether it is over.
 *
 * `done` exists because a finished run is still referenced by whichever set it
 * was in when it completed, and parking or adopting one is never right.
 */
interface LiveRun {
  controller: AbortController;
  transport: RebindableTransport;
  done: boolean;
}

export interface SocketOptions {
  /** Overridable for tests, which cannot wait out the real grace window. */
  reconnectGraceMs?: number;
}

export function attachSocket(
  httpServer: HttpServer,
  env: CloudEnv,
  store: CloudStore,
  options: SocketOptions = {},
): SocketIOServer {
  const graceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    // Images travel over REST (POST /api/uploads), so run payloads stay small;
    // a modest ceiling keeps a malformed/oversized frame from exhausting memory.
    maxHttpBufferSize: 2 * 1024 * 1024,
    // Socket.IO's default is 20s, which a busy run can miss: the heartbeat is
    // answered on the event loop, and aggregating a large multi-section result
    // blocks it for longer than that. A missed pong then "disconnects" a client
    // that never went anywhere. 60s is well inside any sane proxy idle timeout
    // while leaving room for a stalled tick.
    pingTimeout: 60_000,
  });

  /**
   * Runs whose socket dropped, awaiting a reconnect. Keyed by userId because a
   * reconnect arrives as a new socket — the old socket id is gone, and the user
   * is the only identity that survives the gap. Scoped to this server instance
   * so tests attaching several do not share state.
   */
  const orphanedRuns = new Map<string, { runs: Set<LiveRun>; timer: NodeJS.Timeout }>();

  io.use((socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    const session = token ? verifySessionToken(token, env.SESSION_SECRET) : null;
    if (!session) { next(new Error('unauthorized')); return; }
    (socket.data as CloudSocketData).userId = session.userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket.data as CloudSocketData).userId;

    // In-flight runs on THIS connection, so `chat:stop` (and a disconnect) can
    // abort them — otherwise a runaway run keeps burning the budget with no way
    // to halt it. Concurrency and daily quota are still enforced per-user inside
    // runChatTurn via entitlements.ts.
    const activeRuns = new Set<LiveRun>();

    // This user is back. Whatever was held for them survives — a reconnect is
    // the client saying it still wants the result.
    //
    // Adopting is the whole point, and clearing the timer is only half of it.
    // Held runs move INTO this connection's `activeRuns`, and their transports
    // are re-pointed at this socket. Without the first, `chat:stop` on the
    // replacement socket had nothing to abort and a second disconnect saw no
    // in-flight run, so it started no grace timer and the run could spend
    // without any remaining way to halt it — the bounded-spend guarantee above
    // inverted by the very block meant to preserve the run. Without the second,
    // every later `stream:token`, the terminal `session:complete`, and the
    // `context:decision` / `escalation:decide` listeners stayed bound to the
    // dead socket, so the reconnected page waited forever on a run that was
    // talking to nobody.
    const held = orphanedRuns.get(userId);
    if (held) {
      clearTimeout(held.timer);
      orphanedRuns.delete(userId);
      for (const run of held.runs) {
        if (run.done) continue;
        run.transport.rebind(socket);
        activeRuns.add(run);
      }
    }

    // Tell the replacement page whether anything is still running for it. A
    // client that reconnects mid-run cannot know on its own: the ack for
    // `chat:run` was bound to the connection that went away and will never
    // arrive, so `active: 0` is the only signal that says "your run is over,
    // stop waiting for it" — and `active: 1` is what tells it to keep waiting
    // for the `session:complete` that now really is coming.
    socket.emit('run:resumed', { active: activeRuns.size });

    socket.on('chat:run', async (payload: unknown, ack?: ChatRunAck) => {
      // The run holds a transport, not this socket. Same structural surface
      // (`RunSocket` in runs.ts — emit plus on/off), so runChatTurn is
      // unchanged; the difference is that it can be re-pointed at whatever
      // connection the user currently has.
      const run: LiveRun = { controller: new AbortController(), transport: new RebindableTransport(socket), done: false };
      activeRuns.add(run);
      try {
        const parsed = parseChatRunPayload(payload);
        const result: ChatRunResult = await runChatTurn(parsed, {
          env, store, userId, socket: run.transport, signal: run.controller.signal,
        });
        ack?.(result);
      } catch (err) {
        const message = err instanceof ZodError ? formatZodError(err) : err instanceof Error ? err.message : String(err);
        ack?.({ error: message });
      } finally {
        // Marked done BEFORE leaving the set: a disconnect racing this must not
        // park a finished run, or the grace timer fires 90s later against a
        // controller nobody is waiting on and a reconnect adopts a corpse.
        run.done = true;
        activeRuns.delete(run);
        run.transport.rebind(null);
      }
    });

    // Stop every run in flight on this connection. The run resolves with its
    // partial output, which still gets persisted and acked normally.
    socket.on('chat:stop', () => {
      for (const r of activeRuns) r.controller.abort();
    });

    // Connection lost. That is NOT the same as "the user left": a missed
    // heartbeat, a proxy timeout, or a network blip fires this too, and the
    // client is already reconnecting. Hold the runs for the grace window and
    // abort only if nobody comes back — see RECONNECT_GRACE_MS.
    socket.on('disconnect', () => {
      const inFlight = [...activeRuns].filter((r) => !r.done);
      activeRuns.clear();
      // Nothing more may be written to a socket that is gone; the listeners go
      // with it, and both come back on adoption.
      for (const r of inFlight) r.transport.rebind(null);
      if (inFlight.length === 0) return;

      // A second disconnect while the first is still held must not drop the
      // first set on the floor: merge, and restart the clock from the latest.
      const existing = orphanedRuns.get(userId);
      if (existing) clearTimeout(existing.timer);
      const runs = existing?.runs ?? new Set<LiveRun>();
      for (const r of inFlight) runs.add(r);

      const timer = setTimeout(() => {
        orphanedRuns.delete(userId);
        for (const r of runs) r.controller.abort();
      }, graceMs);
      // Never hold the process open for a grace window: a shutting-down server
      // should exit, and the abort is pointless once it has.
      timer.unref?.();
      orphanedRuns.set(userId, { runs, timer });
    });
  });

  return io;
}
