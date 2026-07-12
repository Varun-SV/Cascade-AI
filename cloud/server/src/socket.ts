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

type ChatRunAck = (res: { conversationId: string; output: string; costUsd: number } | { error: string }) => void;

export function attachSocket(httpServer: HttpServer, env: CloudEnv, store: CloudStore): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
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
    // One run per connection at a time — overlapping runs on the same
    // socket would otherwise race on conversationHistory reads/writes and
    // interleave stream:token events from two Cascade instances.
    let runInFlight = false;

    socket.on('chat:run', async (payload: unknown, ack?: ChatRunAck) => {
      if (runInFlight) {
        ack?.({ error: 'A run is already in progress on this connection.' });
        return;
      }
      runInFlight = true;
      try {
        const parsed = parseChatRunPayload(payload);
        const userId = (socket.data as CloudSocketData).userId;
        const result: ChatRunResult = await runChatTurn(parsed, { env, store, userId, socket });
        ack?.(result);
      } catch (err) {
        const message = err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : err instanceof Error ? err.message : String(err);
        ack?.({ error: message });
      } finally {
        runInFlight = false;
      }
    });
  });

  return io;
}
