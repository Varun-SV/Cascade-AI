// ─────────────────────────────────────────────
//  Cascade AI — which id a run-end reports
// ─────────────────────────────────────────────
//
//  One property, and it was wrong in review: the identifier handed to the
//  run-end hook has to be the SAME one the tools saw, or every consumer keyed
//  on it silently matches nothing.
//
//  A chat session and a run are different things. `sessionId` is the
//  conversation and can hold many runs — which is why the server keeps
//  `sessionTaskIds` at all — while `Cascade.run()` mints a fresh random
//  `taskId` per run, and it is the taskId that reaches tools as
//  `ToolExecuteOptions.sessionId`. The browser module stores that taskId, so a
//  run-end reporting the chat id cleaned up nothing: a finished run kept its
//  Stop banner armed and held its browser lease until the deadlock ceiling.
//
//  The browser-module tests cannot catch this. They call agentRunEnded('run-A')
//  with synthetic ids that match by construction, so the mismatch only exists
//  where the two layers meet — here.

import { describe, it, expect } from 'vitest';
import { DashboardServer } from './server.js';
import type { CascadeConfig } from '../types.js';

const config = {
  version: '1.0',
  defaultIdentityId: 'default',
  providers: [],
  models: {},
  tools: { shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false },
  hooks: {},
  dashboard: { port: 4899, auth: false, teamMode: 'single' },
  telemetry: { enabled: false },
  memory: { maxSessionMessages: 10, autoSummarizeAt: 1000, retentionDays: 1 },
  theme: 'cascade',
  workspace: {
    cascadeMdPath: 'CASCADE.md', configPath: '.cascade/config.json',
    keystorePath: '.cascade/keystore.enc', auditLogPath: '.cascade/audit.log',
  },
} as unknown as CascadeConfig;

/** Enough store for persistRunEnd; it only writes. */
const store = {
  addMessage: () => {},
  updateRun: () => {},
  endRun: () => {},
  getSession: () => undefined,
  addRun: () => {},
} as unknown as never;

type Ended = { sessionId: string; taskId?: string };

/** Reaches a private method deliberately: the identifier choice IS the bug, and
 *  the alternative is standing up a socket server to observe one argument. */
function endRun(server: DashboardServer, args: unknown[]): void {
  (server as unknown as { persistRunEnd: (...a: unknown[]) => void }).persistRunEnd(...args);
}

describe('run-end reports the run, not the conversation', () => {
  it('hands over the Cascade task id when the run produced a result', () => {
    const server = new DashboardServer(config, store, '/tmp');
    const seen: Ended[] = [];
    server.onRunEnded((ids) => seen.push(ids));

    endRun(server, ['chat-session-1', 'title', 'prompt', 'reply', 'COMPLETED', { taskId: 'task-abc' }]);

    expect(seen[0]?.taskId, 'the id tools actually saw').toBe('task-abc');
    expect(seen[0]?.sessionId, 'the conversation, carried separately').toBe('chat-session-1');
    expect(seen[0]?.taskId).not.toBe(seen[0]?.sessionId);
  });

  it('names the run that actually failed, not the one before it', () => {
    // This test used to pre-record a task id and then assert the fallback found
    // it — manufacturing a state production never produced, and so proving the
    // wrong thing. In production nothing recorded a task id until AFTER a run
    // succeeded, so on a failed run the list held the PREVIOUS run's id (on a
    // continuing chat) or nothing at all (on the first). The fallback did not
    // merely fail to identify the run — it confidently named a different one.
    //
    // Runs are recorded at START now, via Cascade's `run:started`. Modelled
    // here as two runs on one chat: the first completes, the second fails.
    const server = new DashboardServer(config, store, '/tmp');
    const seen: Ended[] = [];
    server.onRunEnded((ids) => seen.push(ids));
    const started = (t: string) =>
      (server as unknown as { recordSessionTask: (s: string, t: string) => void })
        .recordSessionTask('chat-2', t);

    started('task-first');
    endRun(server, ['chat-2', 'title', 'prompt', 'reply', 'COMPLETED', { taskId: 'task-first' }]);
    started('task-second');
    endRun(server, ['chat-2', 'title', 'prompt', undefined, 'FAILED']);

    expect(seen[1]?.taskId, 'the failed run, not the one that succeeded before it').toBe('task-second');
  });

  it('omits the task id rather than substituting the session id', () => {
    // The whole defect was one id standing in for the other. When the taskId is
    // genuinely unknown, saying nothing is correct; passing the chat id would
    // put the caller right back where it started, with an id that matches
    // nothing and no way to tell.
    const server = new DashboardServer(config, store, '/tmp');
    const seen: Ended[] = [];
    server.onRunEnded((ids) => seen.push(ids));

    endRun(server, ['chat-session-3', 'title', 'prompt', undefined, 'FAILED']);

    expect(seen[0]?.sessionId).toBe('chat-session-3');
    expect(seen[0]?.taskId).toBeUndefined();
  });
});
