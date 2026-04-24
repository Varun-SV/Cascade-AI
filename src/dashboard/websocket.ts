// ─────────────────────────────────────────────
//  Cascade AI — WebSocket (Socket.io)
// ─────────────────────────────────────────────

import { Server as SocketServer } from 'socket.io';
import parser from 'socket.io-msgpack-parser';
import type { Server as HttpServer } from 'node:http';
import type {
  CascadeEvent,
  PermissionDecisionPayload,
  PermissionRequest,
  RuntimeRefreshPayload,
  SessionSubscriptionPayload,
} from '../types.js';
import { verifyToken } from './auth.js';
import {
  normalizePermissionDecisionPayload,
  normalizeRuntimeRefreshPayload,
  normalizeSessionSubscriptionPayload,
} from './socket-protocol.js';

interface DashboardSocketOptions {
  authRequired: boolean;
  secret: string;
  corsOrigin?: string | string[];
}

export class DashboardSocket {
  private io: SocketServer;
  private authRequired: boolean;
  private secret: string;

  constructor(httpServer: HttpServer, options: DashboardSocketOptions) {
    const corsOrigin = options.corsOrigin ?? '*';
    this.io = new SocketServer(httpServer, {
      cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
      parser,
    });
    this.authRequired = options.authRequired;
    this.secret = options.secret;
    this.setupHandlers();
  }

  broadcastToRoom(room: string, event: string, data: unknown): void {
    this.io.to(room).emit(event, data);
  }

  broadcast(event: string, data: unknown): void {
    this.io.emit(event, data);
  }

  emitCascadeEvent(ev: CascadeEvent): void {
    this.io.emit('cascade:event', ev);
  }

  emitTierStatus(tierId: string, role: string, status: string, sessionId: string, action?: string): void {
    const payload = { tierId, role, status, action, timestamp: new Date().toISOString(), sessionId };
    this.io.emit('tier:status', payload);
    this.io.to(`session:${sessionId}`).emit('tier:status', payload);
  }

  emitStreamToken(tierId: string, text: string, sessionId: string): void {
    this.io.to(`session:${sessionId}`).emit('stream:token', { tierId, text, sessionId });
  }

  emitApprovalRequest(request: PermissionRequest): void {
    this.io.emit('permission:user-required', request);
  }

  onApprovalResponse(callback: (data: PermissionDecisionPayload) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('permission:decision', (payload: PermissionDecisionPayload) => {
        callback(normalizePermissionDecisionPayload(payload));
      });
    });
  }

  private setupHandlers(): void {
    this.io.on('connection', (socket) => {
      const token = typeof socket.handshake.auth?.token === 'string'
        ? socket.handshake.auth.token
        : undefined;
      const user = token ? verifyToken(token, this.secret) : null;

      if (this.authRequired && !user) {
        socket.emit('auth:error', { error: 'Unauthorized socket connection' });
        socket.disconnect(true);
        return;
      }

      socket.data.user = user ?? undefined;

      socket.emit('runtime:refresh', { scope: 'workspace' } satisfies RuntimeRefreshPayload);
      socket.emit('runtime:refresh', { scope: 'global' } satisfies RuntimeRefreshPayload);
      socket.on('runtime:refresh', (payload?: RuntimeRefreshPayload) => {
        this.io.emit('runtime:refresh', normalizeRuntimeRefreshPayload(payload));
      });
      socket.on('session:halt', (payload: { sessionId?: string }) => {
        this.io.emit('session:halt', payload);
      });
      socket.on('session:approve', (payload: { nodeId?: string }) => {
        this.io.emit('session:approve', payload);
      });
      socket.on('session:message-injected', (payload: { message?: string }) => {
        this.io.emit('session:message-injected', payload);
      });
      socket.on('join:session', (payload: SessionSubscriptionPayload) => {
        const { sessionId } = normalizeSessionSubscriptionPayload(payload);
        socket.join(`session:${sessionId}`);
      });
      socket.on('leave:session', (payload: SessionSubscriptionPayload) => {
        const { sessionId } = normalizeSessionSubscriptionPayload(payload);
        socket.leave(`session:${sessionId}`);
      });
    });
  }

  close(): void {
    this.io.close();
  }
}






























