// ─────────────────────────────────────────────
//  Cascade Cloud Server — Socket.IO wiring
// ─────────────────────────────────────────────

import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { ZodError } from 'zod';
import { parseCookies, verifySessionToken, SESSION_COOKIE_NAME } from './auth/session.js';
import type { CloudEnv } from './env.js';
import type { CloudStore } from './db.js';
import { parseChatRunPayload, runChatTurn, type ChatRunResult } from './runs.js';

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

export function attachSocket(httpServer: HttpServer, env: CloudEnv, store: CloudStore): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    // Images travel over REST (POST /api/uploads), so run payloads stay small;
    // a modest ceiling keeps a malformed/oversized frame from exhausting memory.
    maxHttpBufferSize: 2 * 1024 * 1024,
  });

  io.use((socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    const session = token ? verifySessionToken(token, env.SESSION_SECRET) : null;
    if (!session) { next(new Error('unauthorized')); return; }
    (socket.data as CloudSocketData).userId = session.userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
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
        const message = err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : err instanceof Error ? err.message : String(err);
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

    // Tab closed / navigated away — don't leave an orphaned run spending tokens
    // for a client that will never see the result.
    socket.on('disconnect', () => {
      for (const c of activeRuns) c.abort();
      activeRuns.clear();
    });
  });

  return io;
}
