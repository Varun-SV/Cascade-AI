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

/**
 * The Settings save as it arrives over the socket.
 *
 * `endpoints` is declared because the panel has always SENT it — the desktop
 * and web Settings views post one payload to both the Electron IPC bridge and
 * this socket. Leaving it off the type here did not make it absent from the
 * wire; it just hid the endpoint a key was typed beside from the code writing
 * that key, which is how a public-host key ended up stored against a gateway.
 */
export interface ConfigUpdatePayload {
  keys?: Record<string, string | undefined>;
  endpoints?: Record<string, string | undefined>;
  models?: Record<string, string>;
  budget?: { maxCostPerRun?: number; autoBias?: string };
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

  /** How many sockets are currently in a room — 0 means nobody can answer. */
  roomSize(room: string): number {
    return this.io.sockets.adapter.rooms.get(room)?.size ?? 0;
  }

  /** Is this exact connection still live? A reconnect issues a NEW socket id. */
  hasSocket(socketId: string): boolean {
    return this.io.sockets.sockets.has(socketId);
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

  /**
   * `extra` exists because this signature is positional: every field the tier
   * emits that is not named here is silently dropped on this path, while the
   * other two forwarders spread the whole event through. That asymmetry is how
   * a field can reach the web dashboard from one code path and not another.
   */
  emitTierStatus(
    tierId: string, role: string, status: string, sessionId: string, action?: string,
    extra?: Record<string, unknown>,
  ): void {
    const payload = { tierId, role, status, action, timestamp: new Date().toISOString(), sessionId, ...extra };
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

  /**
   * A client subscribed to a session's room.
   *
   * The host uses this to replay a gate the run is already parked on. Socket.IO
   * does not buffer room emissions, so a prompt broadcast while the renderer was
   * reconnecting is simply gone; without a replay the section waits out its full
   * timeout with the user sitting in front of a screen that never asked.
   */
  onJoinSession(callback: (sessionId: string, socketId: string) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('join:session', (payload: SessionSubscriptionPayload) => {
        const { sessionId } = normalizeSessionSubscriptionPayload(payload);
        if (sessionId) callback(sessionId, socket.id);
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

  /**
   * A section escalated and the run is parked waiting for an answer. The
   * desktop shows the escalation modal on `escalation:decision-required` and
   * answers here.
   *
   * Unlike a plan decision, silence is NOT taken as consent — the SDK fails
   * the section on timeout — so this handler only ever forwards a real choice.
   */
  onEscalationDecision(callback: (data: { sessionId: string; requestId?: string; action: 'retry' | 'skip' | 'guidance'; note?: string }) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('escalation:decide', (payload: { sessionId?: string; requestId?: string; action?: string; note?: string }) => {
        const action = payload?.action;
        if (typeof payload?.sessionId !== 'string') return;
        if (action !== 'retry' && action !== 'skip' && action !== 'guidance') return;
        callback({
          sessionId: payload.sessionId,
          // Identifies WHICH parked section this answers — sections in a wave
          // run concurrently, so more than one can be waiting.
          requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
          action,
          note: typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : undefined,
        });
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

  onConfigUpdate(callback: (data: ConfigUpdatePayload) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('config:update', (payload: unknown) => {
        if (typeof payload === 'object' && payload !== null) {
          callback(payload as ConfigUpdatePayload);
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






























