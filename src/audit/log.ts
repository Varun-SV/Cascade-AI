// ─────────────────────────────────────────────
//  Cascade AI — Audit Logger
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type { AuditEntry } from '../types.js';
import type { MemoryStore } from '../memory/store.js';

export class AuditLogger {
  private store: MemoryStore;
  private sessionId: string;

  constructor(store: MemoryStore, sessionId: string) {
    this.store = store;
    this.sessionId = sessionId;
  }

  log(
    tierId: string,
    action: AuditEntry['action'],
    details: Record<string, unknown>,
  ): void {
    const entry: AuditEntry = {
      id: randomUUID(),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      tierId,
      action,
      details,
    };
    this.store.addAuditEntry(entry);
  }

  toolCall(tierId: string, toolName: string, input: Record<string, unknown>): void {
    this.log(tierId, 'tool_call', { toolName, input });
  }

  fileChange(tierId: string, filePath: string, operation: string): void {
    this.log(tierId, 'file_change', { filePath, operation });
  }

  agentDecision(tierId: string, decision: string, reasoning?: string): void {
    this.log(tierId, 'agent_decision', { decision, reasoning });
  }

  approval(tierId: string, toolName: string, approved: boolean): void {
    this.log(tierId, 'approval', { toolName, approved });
  }

  escalation(tierId: string, blocker: string, needs: string): void {
    this.log(tierId, 'escalation', { blocker, needs });
  }

  getLog(limit?: number): AuditEntry[] {
    return this.store.getAuditLog(this.sessionId, limit);
  }
}
