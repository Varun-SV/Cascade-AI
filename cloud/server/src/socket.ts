// ─────────────────────────────────────────────
//  Cascade Cloud Server — Socket.IO wiring
// ─────────────────────────────────────────────

import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { ZodError } from 'zod';
import { parseCookies, verifySessionToken, SESSION_COOKIE_NAME } from './auth/session.js';
import type { CloudEnv } from './env.js';
import type { CloudStore } from './db.js';
import { formatZodError, parseChatRunPayload, runChatTurn, type ChatRunResult } from './runs.js';

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
  const orphanedRuns = new Map<string, { controllers: Set<AbortController>; timer: NodeJS.Timeout }>();

  io.use((socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    const session = token ? verifySessionToken(token, env.SESSION_SECRET) : null;
    if (!session) { next(new Error('unauthorized')); return; }
    (socket.data as CloudSocketData).userId = session.userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
    // This user is back. Whatever was held for them survives — a reconnect is
    // the client saying it still wants the result.
    const reconnectedUserId = (socket.data as CloudSocketData).userId;
    const held = orphanedRuns.get(reconnectedUserId);
    if (held) {
      clearTimeout(held.timer);
      orphanedRuns.delete(reconnectedUserId);
    }

    // In-flight runs on THIS connection, so `chat:stop` (and a disconnect) can
    // abort them — otherwise a runaway run keeps burning the budget with no way
    // to halt it. Concurrency and daily quota are still enforced per-user inside
    // runChatTurn via entitlements.ts.
    const activeRuns = new Set<AbortController>();

    socket.on('chat:run', async (payload: unknown, ack?: ChatRunAck) => {
      const controller = new AbortController();
      activeRuns.add(controller);
      try {
        const parsed = parseChatRunPayload(payload);
        const userId = (socket.data as CloudSocketData).userId;
        const result: ChatRunResult = await runChatTurn(parsed, {
          env, store, userId, socket, signal: controller.signal,
        });
        ack?.(result);
      } catch (err) {
        const message = err instanceof ZodError ? formatZodError(err) : err instanceof Error ? err.message : String(err);
        ack?.({ error: message });
      } finally {
        activeRuns.delete(controller);
      }
    });

    // Stop every run in flight on this connection. The run resolves with its
    // partial output, which still gets persisted and acked normally.
    socket.on('chat:stop', () => {
      for (const c of activeRuns) c.abort();
    });

    // Connection lost. That is NOT the same as "the user left": a missed
    // heartbeat, a proxy timeout, or a network blip fires this too, and the
    // client is already reconnecting. Hold the runs for the grace window and
    // abort only if nobody comes back — see RECONNECT_GRACE_MS.
    socket.on('disconnect', () => {
      const userId = (socket.data as CloudSocketData).userId;
      const inFlight = [...activeRuns];
      activeRuns.clear();
      if (inFlight.length === 0) return;

      // A second disconnect while the first is still held must not drop the
      // first set on the floor: merge, and restart the clock from the latest.
      const existing = orphanedRuns.get(userId);
      if (existing) clearTimeout(existing.timer);
      const controllers = existing?.controllers ?? new Set<AbortController>();
      for (const c of inFlight) controllers.add(c);

      const timer = setTimeout(() => {
        orphanedRuns.delete(userId);
        for (const c of controllers) c.abort();
      }, graceMs);
      // Never hold the process open for a grace window: a shutting-down server
      // should exit, and the abort is pointless once it has.
      timer.unref?.();
      orphanedRuns.set(userId, { controllers, timer });
    });
  });

  return io;
}
