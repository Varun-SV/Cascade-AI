// ─────────────────────────────────────────────
//  Cascade AI — Abstract Tier Base
// ─────────────────────────────────────────────

import EventEmitter from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  CascadeMessage,
  StatusUpdate,
  TierRole,
  TierStatus,
} from '../../types.js';

export abstract class BaseTier extends EventEmitter {
  readonly id: string;
  readonly role: TierRole;
  protected status: TierStatus = 'IDLE';
  protected parentId?: string;
  protected taskId: string = '';

  constructor(role: TierRole, id?: string, parentId?: string) {
    super();
    this.role = role;
    this.id = id ?? `${role}_${randomUUID().slice(0, 8)}`;
    this.parentId = parentId;
  }

  getStatus(): TierStatus {
    return this.status;
  }

  protected setStatus(status: TierStatus): void {
    this.status = status;
    this.emit('status', { tierId: this.id, status, timestamp: new Date().toISOString() });
  }

  protected sendStatusUpdate(update: StatusUpdate): void {
    const message = this.buildMessage('STATUS_UPDATE', this.parentId ?? 'T1', update as unknown as Record<string, unknown>);
    this.emit('message', message);
  }

  protected buildMessage(
    type: CascadeMessage['type'],
    to: string,
    payload: Record<string, unknown>,
  ): CascadeMessage {
    return {
      version: '1.0',
      from: this.id,
      to,
      type,
      taskId: this.taskId,
      timestamp: new Date().toISOString(),
      payload: payload as unknown as CascadeMessage['payload'],
    };
  }

  protected log(message: string, data?: unknown): void {
    this.emit('log', { tierId: this.id, role: this.role, message, data, timestamp: new Date().toISOString() });
  }
}
