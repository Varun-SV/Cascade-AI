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
  protected label: string;

  constructor(role: TierRole, id?: string, parentId?: string) {
    super();
    this.role = role;
    this.id = id ?? `${role}_${randomUUID().slice(0, 8)}`;
    this.parentId = parentId;
    this.label = this.id;
  }

  getStatus(): TierStatus {
    return this.status;
  }

  protected setStatus(status: TierStatus): void {
    this.status = status;
    const timestamp = new Date().toISOString();
    const event = {
      tierId: this.id,
      role: this.role,
      parentId: this.parentId,
      label: this.label,
      status,
      timestamp,
    };
    this.emit('status', event);
    this.emit('tier:status', event);
  }

  protected setLabel(label: string): void {
    this.label = label;
  }

  protected sendStatusUpdate(update: StatusUpdate): void {
    const timestamp = new Date().toISOString();
    const message = this.buildMessage('STATUS_UPDATE', this.parentId ?? 'T1', update as unknown as Record<string, unknown>);
    this.emit('message', message);
    this.emit('tier:status', {
      tierId: this.id,
      role: this.role,
      parentId: this.parentId,
      label: this.label,
      status: this.status,
      currentAction: update.currentAction,
      progressPct: update.progressPct,
      timestamp,
    });
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
