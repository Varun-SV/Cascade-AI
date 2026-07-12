// ─────────────────────────────────────────────
//  Cascade Cloud Server — Socket.IO wiring
// ─────────────────────────────────────────────
//
// Auth + connection handling only. The actual `chat:run` -> createCascade
// pipeline is task #26 (Cloud run pipeline + socket streaming); this stub
// establishes the authenticated socket surface it will hang off of.

import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { parseCookies, verifySessionToken, SESSION_COOKIE_NAME } from './auth/session.js';
import type { CloudEnv } from './env.js';
import type { CloudStore } from './db.js';

interface CloudSocketData {
  userId: string;
}

export function attachSocket(httpServer: HttpServer, env: CloudEnv, _store: CloudStore): SocketIOServer {
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
    socket.on('chat:run', (_payload: unknown, ack?: (res: { error: string }) => void) => {
      ack?.({ error: 'chat:run is not implemented yet — see task #26' });
    });
  });

  return io;
}
