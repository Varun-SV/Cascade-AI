// ─────────────────────────────────────────────
//  Cascade AI — Audit Logger (Enhanced)
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type { AuditEntry } from '../types.js';
import type { MemoryStore } from '../memory/store.js';

/** Structured log levels for audit entries */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Extended audit entry with log level */
export interface AuditEntryWithLevel extends AuditEntry {
  level: LogLevel;
}

export class AuditLogger {
  private store: MemoryStore;
  private sessionId: string;
  private minLevel: LogLevel;

  constructor(store: MemoryStore, sessionId: string, minLevel: LogLevel = 'info') {
    this.store = store;
    this.sessionId = sessionId;
    this.minLevel = minLevel;
  }

  // ── Level-aware logging ──────────────────────

  debug(tierId: string, action: AuditEntry['action'], details: Record<string, unknown>): void {
    this.logAt('debug', tierId, action, details);
  }

  info(tierId: string, action: AuditEntry['action'], details: Record<string, unknown>): void {
    this.logAt('info', tierId, action, details);
  }

  warn(tierId: string, action: AuditEntry['action'], details: Record<string, unknown>): void {
    this.logAt('warn', tierId, action, details);
  }

  error(tierId: string, err: Error | unknown, context: Record<string, unknown> = {}): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.logAt('error', tierId, 'error' as AuditEntry['action'], {
      message: e.message,
      name: e.name,
      stack: e.stack?.slice(0, 500),
      ...context,
    });
  }

  /** Backward-compatible generic log (defaults to info level) */
  log(
    tierId: string,
    action: AuditEntry['action'],
    details: Record<string, unknown>,
  ): void {
    this.logAt('info', tierId, action, details);
  }

  // ── Domain helpers ─────────────────────────

  toolCall(tierId: string, toolName: string, input: Record<string, unknown>): void {
    this.info(tierId, 'tool_call', { toolName, input });
  }

  fileChange(tierId: string, filePath: string, operation: string): void {
    this.info(tierId, 'file_change', { filePath, operation });
  }

  agentDecision(tierId: string, decision: string, reasoning?: string): void {
    this.info(tierId, 'agent_decision', { decision, reasoning });
  }

  approval(tierId: string, toolName: string, approved: boolean, decidedBy?: string): void {
    this.info(tierId, 'approval', { toolName, approved, decidedBy });
  }

  escalation(tierId: string, blocker: string, needs: string): void {
    this.warn(tierId, 'escalation', { blocker, needs });
  }

  getLog(limit?: number): AuditEntry[] {
    return this.store.getAuditLog(this.sessionId, limit);
  }

  // ── Structured JSON output ─────────────────

  /**
   * Formats an audit entry as a single-line JSON string (e.g. for log aggregation).
   */
  formatStructured(entry: AuditEntryWithLevel): string {
    return JSON.stringify({
      ts: entry.timestamp,
      level: entry.level,
      sessionId: entry.sessionId,
      tierId: entry.tierId,
      action: entry.action,
      ...entry.details,
    });
  }

  // ── Internal ───────────────────────────────

  private logAt(
    level: LogLevel,
    tierId: string,
    action: AuditEntry['action'],
    details: Record<string, unknown>,
  ): void {
    if (!this.shouldLog(level)) return;

    const entry: AuditEntry = {
      id: randomUUID(),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      tierId,
      action,
      details: { level, ...details },
    };
    this.store.addAuditEntry(entry);
  }

  private shouldLog(level: LogLevel): boolean {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return order.indexOf(level) >= order.indexOf(this.minLevel);
  }
}
