// ─────────────────────────────────────────────
//  Cascade AI — Inter-Tier Message Schema (Zod)
// ─────────────────────────────────────────────

import { z } from 'zod';

export const StatusUpdateSchema = z.object({
  progressPct: z.number().min(0).max(100),
  currentAction: z.string(),
  status: z.enum(['IN_PROGRESS', 'BLOCKED', 'ESCALATING']),
});

export const T3SubtaskSpecSchema = z.object({
  subtaskId: z.string(),
  subtaskTitle: z.string(),
  description: z.string(),
  expectedOutput: z.string(),
  constraints: z.array(z.string()),
  peerT3Ids: z.array(z.string()),
});

export const T1ToT2AssignmentSchema = z.object({
  sectionId: z.string(),
  sectionTitle: z.string(),
  description: z.string(),
  expectedOutput: z.string(),
  constraints: z.array(z.string()),
  t3Subtasks: z.array(T3SubtaskSpecSchema),
});

export const T2ToT3AssignmentSchema = z.object({
  subtaskId: z.string(),
  subtaskTitle: z.string(),
  description: z.string(),
  expectedOutput: z.string(),
  constraints: z.array(z.string()),
  peerT3Ids: z.array(z.string()),
  parentT2: z.string(),
});

export const T3ResultSchema = z.object({
  subtaskId: z.string(),
  status: z.enum(['COMPLETED', 'FAILED', 'ESCALATED']),
  output: z.union([z.string(), z.record(z.unknown())]),
  testResults: z.object({
    checksRun: z.array(z.string()),
    passed: z.array(z.string()),
    failed: z.array(z.string()),
  }),
  issues: z.array(z.string()),
  peerSyncsUsed: z.array(z.string()),
  correctionAttempts: z.number(),
});

export const T2ResultSchema = z.object({
  sectionId: z.string(),
  sectionTitle: z.string(),
  status: z.enum(['COMPLETED', 'PARTIAL', 'FAILED', 'ESCALATED']),
  t3Results: z.array(T3ResultSchema),
  sectionSummary: z.string(),
  issues: z.array(z.string()),
});

export const EscalationSchema = z.object({
  raisedBy: z.string(),
  sectionId: z.string().optional(),
  subtaskId: z.string().optional(),
  attempted: z.array(z.string()),
  blocker: z.string(),
  needs: z.string(),
});

export const PeerSyncSchema = z.object({
  senderT3Id: z.string(),
  recipientT3Id: z.string(),
  syncType: z.enum(['SHARE_OUTPUT', 'RESOLVE_CONFLICT', 'DIVIDE_WORK', 'CHECK_ASSUMPTION', 'SIGNAL_READY']),
  content: z.union([z.string(), z.record(z.unknown())]),
});

export const CascadeMessageSchema = z.object({
  version: z.literal('1.0'),
  from: z.string(),
  to: z.string(),
  type: z.enum(['TASK_ASSIGNMENT', 'STATUS_UPDATE', 'RESULT', 'ESCALATION', 'PEER_SYNC']),
  taskId: z.string(),
  timestamp: z.string(),
  payload: z.record(z.unknown()),
});

export type CascadeMessageParsed = z.infer<typeof CascadeMessageSchema>;
