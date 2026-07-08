// ─────────────────────────────────────────────
//  Cascade AI — WebSocket (Socket.io)
// ─────────────────────────────────────────────

import { Server as SocketServer } from 'socket.io';
import parser from 'socket.io-msgpack-parser';
import type { Server as HttpServer } from 'node:http';
import type {
  CascadeEvent,
  PeerMessageEvent,
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

  emitPeerMessage(event: PeerMessageEvent): void {
    this.io.to(`session:${event.sessionId}`).emit('peer:message', event);
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
      socket.on('session:rate', (payload: { sessionId?: string; rating?: string }) => {
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
        const rating = payload?.rating === 'good' || payload?.rating === 'bad' ? payload.rating : null;
        if (sessionId && rating) {
          this.io.emit('session:rate', { sessionId, rating });
        }
      });
    });
  }

  onSessionRate(callback: (sessionId: string, rating: 'good' | 'bad') => void): void {
    this.io.on('connection', (socket) => {
      socket.on('session:rate', (payload: { sessionId?: string; rating?: string }) => {
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
        const rating = payload?.rating === 'good' || payload?.rating === 'bad' ? payload.rating as 'good' | 'bad' : null;
        if (sessionId && rating) callback(sessionId, rating);
      });
    });
  }

  onSessionHalt(callback: (sessionId: string) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('session:halt', (payload: { sessionId?: string }) => {
        if (typeof payload?.sessionId === 'string') {
          callback(payload.sessionId);
        }
      });
    });
  }

  /**
   * Boardroom plan decisions from a connected client. The desktop shows a
   * plan-review modal on `plan:approval-required` and answers here; the
   * server routes the decision into the paused run via resolvePlanApproval.
   */
  onPlanDecision(callback: (data: { sessionId: string; approved: boolean; note?: string; editedPlan?: unknown }) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('plan:decision', (payload: { sessionId?: string; approved?: boolean; note?: string; editedPlan?: unknown }) => {
        if (typeof payload?.sessionId === 'string' && typeof payload?.approved === 'boolean') {
          callback({
            sessionId: payload.sessionId,
            approved: payload.approved,
            note: typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : undefined,
            editedPlan: payload.editedPlan,
          });
        }
      });
    });
  }

  onSessionSteer(callback: (message: string, sessionId?: string, nodeId?: string) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('session:steer', (payload: { message?: string; sessionId?: string; nodeId?: string }) => {
        if (typeof payload?.message === 'string' && payload.message.trim()) {
          callback(payload.message.trim(), payload.sessionId, payload.nodeId);
        }
      });
    });
  }

  onConfigUpdate(callback: (data: {
    keys?: Record<string, string>;
    models?: Record<string, string>;
    budget?: { maxCostPerRun?: number; autoBias?: string };
  }) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('config:update', (payload: unknown) => {
        if (typeof payload === 'object' && payload !== null) {
          callback(payload as { keys?: Record<string, string>; models?: Record<string, string>; budget?: { maxCostPerRun?: number; autoBias?: string } });
        }
      });
    });
  }

  emitToSocket(socketId: string, event: string, data: unknown): void {
    this.io.sockets.sockets.get(socketId)?.emit(event, data);
  }

  onConfigGet(callback: (socketId: string) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('config:get', () => callback(socket.id));
    });
  }

  onCascadeRun(callback: (prompt: string, model: string, socketId: string, sessionId?: string, forceTier?: string) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('cascade:run', (payload: { prompt?: string; model?: string; sessionId?: string; forceTier?: string }) => {
        if (typeof payload?.prompt === 'string' && payload.prompt.trim()) {
          const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
            ? payload.sessionId.trim()
            : undefined;
          const forceTier = ['T1', 'T2', 'T3'].includes(payload.forceTier as string) ? payload.forceTier : undefined;
          callback(payload.prompt.trim(), payload.model ?? 'auto', socket.id, sessionId, forceTier);
        }
      });
    });
  }

  close(): void {
    this.io.close();
  }
}






























