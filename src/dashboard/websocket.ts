// ─────────────────────────────────────────────
//  Cascade AI — WebSocket (Socket.io)
// ─────────────────────────────────────────────

import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { CascadeEvent } from '../types.js';

export class DashboardSocket {
  private io: SocketServer;

  constructor(httpServer: HttpServer, corsOrigin: string | string[] = '*') {
    this.io = new SocketServer(httpServer, {
      cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
    });
    this.setupHandlers();
  }

  broadcast(event: string, data: unknown): void {
    this.io.emit(event, data);
  }

  broadcastToRoom(room: string, event: string, data: unknown): void {
    this.io.to(room).emit(event, data);
  }

  emitCascadeEvent(ev: CascadeEvent): void {
    this.io.emit('cascade:event', ev);
  }

  emitTierStatus(tierId: string, role: string, status: string, action?: string): void {
    this.io.emit('tier:status', { tierId, role, status, action, timestamp: new Date().toISOString() });
  }

  emitStreamToken(tierId: string, text: string): void {
    this.io.emit('stream:token', { tierId, text });
  }

  emitApprovalRequest(request: unknown): void {
    this.io.emit('tool:approval-request', request);
  }

  onApprovalResponse(callback: (data: { id: string; approved: boolean }) => void): void {
    this.io.on('connection', (socket) => {
      socket.on('tool:approval-response', callback);
    });
  }

  private setupHandlers(): void {
    this.io.on('connection', (socket) => {
      socket.emit('runtime:refresh', { scope: 'workspace' });
      socket.emit('runtime:refresh', { scope: 'global' });
      socket.on('runtime:refresh', (scope?: 'workspace' | 'global') => {
        this.io.emit('runtime:refresh', { scope: scope ?? 'workspace' });
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
      socket.on('join:session', (sessionId: string) => {
        socket.join(`session:${sessionId}`);
      });
      socket.on('leave:session', (sessionId: string) => {
        socket.leave(`session:${sessionId}`);
      });
      socket.on('join:tenant', (tenantId: string) => {
        socket.join(`tenant:${tenantId}`);
      });
    });
  }

  close(): void {
    this.io.close();
  }
}































