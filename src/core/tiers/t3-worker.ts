// ─────────────────────────────────────────────
//  Cascade AI — T3 Worker
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConversationMessage,
  GenerateOptions,
  ModelInfo,
  PermissionRequest,
  T2ToT3Assignment,
  T3Result,
  ToolCall,
  ToolDefinition,
} from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { BaseTier } from './base.js';
import { ContextManager } from '../context/manager.js';
import { AuditLogger } from '../../audit/log.js';
import { MemoryStore } from '../../memory/store.js';
import type { PeerBus } from '../peer/bus.js';
import type { PermissionEscalator } from '../permissions/escalator.js';
import type { ToolCreator, GeneratedToolSpec } from '../../tools/tool-creator.js';
import {
  parseTextToolCalls,
  toToolCall,
  buildTextToolSystemPrompt,
} from '../../tools/text-tool-parser.js';

/**
 * Thrown by executeTool() when the underlying tool error indicates an
 * unrecoverable condition (rate limit, auth failure, forbidden) — the
 * agent loop should NOT keep retrying and the worker should escalate
 * fast with the real reason intact.
 */
export class CriticalToolError extends Error {
  constructor(message: string, public readonly toolName: string) {
    super(message);
    this.name = 'CriticalToolError';
  }
}

/**
 * Thrown by runAgentLoop() when the worker is stuck producing an artifact
 * that verifyArtifacts() rejects on consecutive iterations. Carries any
 * partial output the worker had built so the caller can surface it
 * instead of just the bare error string.
 */
export class WorkerStallError extends Error {
  constructor(message: string, public readonly partialOutput: string) {
    super(message);
    this.name = 'WorkerStallError';
  }
}

const T3_SYSTEM_PROMPT = `You are a T3 Worker agent in the Cascade AI system. Your job is to execute a specific subtask completely and accurately.

Rules:
- Execute the subtask completely — do not stop partway through.
- Use tools when needed. Ask for approval only when the tool registry requires it.
- If the task asks for a file or artifact, you must actually create it in the workspace, verify that it exists, and inspect it before claiming success.
- Use the "web_search" tool to find current information, documentation, news, or general web data.
- Use the "pdf_create" tool for PDF requests.
- Use the "run_code" tool for any file types (Excel, Zip, csv, etc.) or complex processing not covered by other tools. Always cleanup after code execution.
- If you are not making meaningful progress, stop and escalate rather than looping or padding the response.
- Use the "peer_message" tool to communicate with other T3 workers if your tasks have dependencies or shared state. You can send updates or wait for signals.
- Return structured output that directly addresses the expected output specification.`;

export class T3Worker extends BaseTier {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private context: ContextManager;
  private assignment?: T2ToT3Assignment;
  private peerSyncBuffer: Array<{ fromId: string; content: unknown; timestamp: string }> = [];
  private store?: MemoryStore;
  private audit?: AuditLogger;
  private tools: ToolDefinition[] = [];
  /** 0 = top-level worker (may request reinforcements); 1 = a spawned reinforcement (may not). */
  private reinforcementDepth = 0;
  /** Sibling-worker requests this worker made via request_workers (T3→T2). */
  private pendingReinforcements: T2ToT3Assignment[] = [];
  /** @deprecated — kept only as fallback when no escalator is attached */
  private sessionApprovals: Map<string, boolean> = new Map();
  private peerBus?: PeerBus;
  private permissionEscalator?: PermissionEscalator;
  private toolCreator?: ToolCreator;

  setPeerBus(bus: PeerBus): void {
    this.peerBus = bus;
    this.peerBus.register(this.id);

    // Listen for targeted messages from peers
    this.peerBus.on(`message:${this.id}`, (msg) => {
      this.log(`Peer message from ${msg.fromId}: ${msg.type}`);
      this.receivePeerSync(msg.fromId, msg.payload);
    });

    // A peer created a runtime tool — register it locally and refresh our tool
    // list so we can use it without regenerating the same capability.
    this.peerBus.on('broadcast', (msg) => {
      const payload = msg?.payload as { type?: string; spec?: GeneratedToolSpec } | undefined;
      if (payload?.type === 'TOOL_CREATED' && payload.spec && this.toolCreator) {
        this.toolCreator.registerSpec(payload.spec);
        this.tools = this.toolRegistry.getToolDefinitions();
        this.log(`Registered peer tool "${payload.spec.name}" from broadcast.`);
      }
    });
  }

  setPermissionEscalator(escalator: PermissionEscalator): void {
    this.permissionEscalator = escalator;
  }

  /** Marks this worker as a spawned reinforcement (depth 1 — cannot request more). */
  markAsReinforcement(): void {
    this.reinforcementDepth = 1;
  }

  setToolCreator(creator: ToolCreator): void {
    this.toolCreator = creator;
  }

  constructor(router: CascadeRouter, toolRegistry: ToolRegistry, parentId: string) {
    super('T3', undefined, parentId);
    this.router = router;
    this.toolRegistry = toolRegistry;
    this.context = new ContextManager();
  }

  setStore(store: MemoryStore, sessionId: string): void {
    this.store = store;
    this.audit = new AuditLogger(store, sessionId);
  }

  async execute(assignment: T2ToT3Assignment, taskId: string, signal?: AbortSignal): Promise<T3Result> {
    this.signal = signal;
    this.assignment = assignment;
    this.taskId = taskId;
    this.setLabel(assignment.subtaskTitle);
    this.setStatus('ACTIVE');

    this.tools = this.toolRegistry.getToolDefinitions();
    // T3→T2 reinforcement: surface request_workers to top-level workers only, when enabled.
    if (this.reinforcementDepth === 0 && this.router.getReinforcementsConfig?.()?.enabled) {
      this.tools = [...this.tools, {
        name: 'request_workers',
        description: 'Ask your manager to spawn additional sibling workers for sub-problems you discover are too large or parallelizable to finish alone. Use sparingly — only when the work genuinely needs to fan out.',
        inputSchema: {
          type: 'object',
          properties: {
            subtasks: {
              type: 'array',
              description: 'New sibling subtasks for your manager to spawn.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  expectedOutput: { type: 'string' },
                },
                required: ['title', 'description'],
              },
            },
          },
          required: ['subtasks'],
        },
      }];
    }

    // ── Step 0: Wait for dependencies ──────────
    if (assignment.dependsOn?.length && this.peerBus) {
      this.sendStatusUpdate({
        progressPct: 0,
        currentAction: `Waiting for dependencies: ${assignment.dependsOn.join(', ')}`,
        status: 'IN_PROGRESS',
      });

      const depOutputs: string[] = [];
      for (const depId of assignment.dependsOn) {
        try {
          // Bounded wait: the wave scheduler only starts us after our deps have
          // completed, so this normally resolves immediately. The 60s cap is a
          // safety net for genuinely-missing/cross-bus deps.
          const dep = await this.peerBus.waitFor(depId, 60_000);
          if (dep.status === 'FAILED' || dep.status === 'ESCALATED') {
            // Publish a terminal status for OUR subtask before bailing, so our
            // own dependents unblock at once instead of each waiting out the full
            // peer timeout — that per-link stacking was the apparent "deadlock".
            this.peerBus.publish(this.id, assignment.subtaskId, `Blocked by failed dependency: ${depId}`, 'FAILED');
            return this.buildResult(
              'ESCALATED',
              `Dependency ${depId} failed — cannot proceed`,
              { checksRun: [], passed: [], failed: [] },
              [`Blocked by failed dependency: ${depId}`],
              0,
            );
          }
          depOutputs.push(`[From ${dep.fromId} - ${dep.subtaskId}]:\n${dep.output}`);
        } catch (err) {
          this.peerBus.publish(this.id, assignment.subtaskId, `Dependency timeout: ${depId}`, 'FAILED');
          return this.buildResult(
            'ESCALATED',
            `Dependency timeout: ${depId}`,
            { checksRun: [], passed: [], failed: [] },
            [err instanceof Error ? err.message : String(err)],
            0,
          );
        }
      }

      // Inject dependency outputs into context
      if (depOutputs.length) {
        await this.context.addMessage({
          role: 'user',
          content: `Context from completed dependencies:\n\n${depOutputs.join('\n\n')}\n\nNow execute your subtask using this context where relevant.`,
        });
      }
    }

    this.sendStatusUpdate({
      progressPct: 5,
      currentAction: `Starting subtask: ${assignment.subtaskTitle}`,
      status: 'IN_PROGRESS',
    });

    this.log(`T3 executing subtask: ${assignment.subtaskTitle}`);

    // ── Step 0.5: T3 File-Intent Coordination ──
    // Announce files this subtask plans to write so siblings can avoid conflicts.
    if (this.peerBus && this.peerBus.getMembers().length > 1) {
      await this.coordinateFileIntents(assignment);
    }

    const systemPrompt = this.buildSystemPrompt(assignment);

    await this.context.addMessage({
      role: 'user',
      content: this.buildInitialPrompt(assignment),
    });

    let output = '';
    let toolCalls: ToolCall[] = [];
    let correctionAttempts = 0;
    const checksRun: string[] = [];
    const passed: string[] = [];
    const failed: string[] = [];
    const issues: string[] = [];

    try {
      const result = await this.runAgentLoop(systemPrompt, this.tools);
      output = result.output;
      toolCalls = result.toolCalls;

      this.sendStatusUpdate({ progressPct: 65, currentAction: 'Verifying required artifacts', status: 'IN_PROGRESS' });

      const artifactCheck = await this.verifyArtifacts(assignment);
      if (!artifactCheck.ok) {
        correctionAttempts = 1;
        issues.push(...artifactCheck.issues);
        output = await this.correctOutput(output, artifactCheck.issues);
        const retryArtifactCheck = await this.verifyArtifacts(assignment);
        if (!retryArtifactCheck.ok) {
          issues.push(...retryArtifactCheck.issues);
          this.setStatus('FAILED');
          // ── Publish failure to peers ──
          this.peerBus?.publish(this.id, assignment.subtaskId, output, 'ESCALATED');
          return this.buildResult('ESCALATED', output, { checksRun, passed, failed }, issues, correctionAttempts);
        }
      }

      this.sendStatusUpdate({ progressPct: 70, currentAction: 'Self-testing output', status: 'IN_PROGRESS' });

      const testResult = await this.selfTest(assignment, output);
      checksRun.push(...testResult.checksRun);
      passed.push(...testResult.passed);
      failed.push(...testResult.failed);

      if (testResult.failed.length > 0) {
        correctionAttempts = 1;
        issues.push(`Initial check failed: ${testResult.failed.join(', ')}`);
        const corrected = await this.correctOutput(output, testResult.failed);
        output = corrected;
        const retest = await this.selfTest(assignment, output);
        passed.push(...retest.passed);
        if (retest.failed.length > 0) {
          failed.push(...retest.failed);
          this.setStatus('FAILED');
          this.peerBus?.publish(this.id, assignment.subtaskId, output, 'ESCALATED');
          return this.buildResult('ESCALATED', output, { checksRun, passed, failed }, issues, correctionAttempts);
        }
      }

      // ── Reflection / self-critique (goal-alignment, opt-in) ──
      const reflectCfg = this.router.getReflectionConfig?.() ?? { enabled: false, maxRounds: 1 };
      if (reflectCfg.enabled) {
        this.sendStatusUpdate({ progressPct: 85, currentAction: 'Reflecting on output via T2-Critic', status: 'IN_PROGRESS' });
        output = await this.reflectAndImprove(assignment, output, reflectCfg.maxRounds);
      }

      // ── Project World State Update ──
      const db = this.router.getWorldStateDB();
      if (db) {
        try {
          db.addEntry(this.id, `Completed: ${assignment.subtaskTitle}. Output length: ${output.length} chars.`);
        } catch (e) {
          this.log('Failed to write to World State DB');
        }
      }

      this.setStatus('COMPLETED', output);
      this.sendStatusUpdate({ progressPct: 100, currentAction: 'Subtask complete', status: 'IN_PROGRESS', output });

      // ── Publish success to peers ─────────────
      this.peerBus?.publish(this.id, assignment.subtaskId, output, 'COMPLETED');

      return this.buildResult('COMPLETED', output, { checksRun, passed, failed }, issues, correctionAttempts);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Preserve partial output when the worker stalled mid-generation, and
      // mark critical/unrecoverable errors so T2/T1 can surface them clearly
      // instead of being swallowed under a generic "Execution error" prefix.
      if (err instanceof WorkerStallError) {
        issues.push(`Stalled: ${errMsg}`);
        const finalOutput = err.partialOutput || output || errMsg;
        this.setStatus('FAILED', finalOutput);
        this.peerBus?.publish(this.id, assignment.subtaskId, finalOutput, 'FAILED');
        return this.buildResult('ESCALATED', finalOutput, { checksRun, passed, failed }, issues, correctionAttempts);
      }
      if (err instanceof CriticalToolError) {
        issues.push(`[CRITICAL_TOOL_ERROR] ${err.toolName}: ${errMsg}`);
        const finalOutput = output || `Tool "${err.toolName}" failed unrecoverably: ${errMsg}`;
        this.setStatus('FAILED', finalOutput);
        this.peerBus?.publish(this.id, assignment.subtaskId, finalOutput, 'FAILED');
        return this.buildResult('ESCALATED', finalOutput, { checksRun, passed, failed }, issues, correctionAttempts);
      }
      issues.push(`Execution error: ${errMsg}`);
      const finalOutput = output || errMsg;
      this.setStatus('FAILED', finalOutput);
      this.peerBus?.publish(this.id, assignment.subtaskId, finalOutput, 'FAILED');
      return this.buildResult('ESCALATED', finalOutput, { checksRun, passed, failed }, issues, correctionAttempts);
    }
  }

  sendToPeer(toId: string, content: unknown): void {
    this.peerBus?.send(this.id, toId, 'SHARE_OUTPUT', this.assignment?.subtaskId ?? '', content);
  }

  async requestFromPeer(peerId: string, subtaskId: string): Promise<string> {
    if (!this.peerBus) throw new Error('No PeerBus attached');
    const output = await this.peerBus.waitFor(subtaskId);
    return output.output;
  }

  async syncWithPeers(barrierName: string): Promise<void> {
    if (!this.peerBus) return;
    const total = this.peerBus.getMembers().length;
    await this.peerBus.barrier(this.id, barrierName, total);
  }

  receivePeerSync(fromId: string, content: unknown): void {
    this.peerSyncBuffer.push({ fromId, content, timestamp: new Date().toISOString() });
    this.emit('peer-sync-received', { fromId, content });
    
    // Notify the agent proactively so it doesn't have to guess when to poll
    this.context.addMessage({
      role: 'user',
      content: `[SYSTEM_NOTIFICATION]: You received a new peer message from ${fromId}. Use the "peer_message" tool with action="receive" to read it.`
    }).catch(() => {});
  }

  // ── Private ──────────────────────────────────

  private async runAgentLoop(
    systemPrompt: string,
    tools: ToolDefinition[],
  ): Promise<{ output: string; toolCalls: ToolCall[] }> {
    const allToolCalls: ToolCall[] = [];
    let iterations = 0;
    let stalledArtifactIterations = 0;
    const MAX_ITERATIONS = 15;
    const requiresArtifact = this.requiresArtifact();
    // `tools` is reassigned when a dynamic tool is created — must be a let
    tools = [...tools];

    // Cascade Auto: route this specific subtask to the benchmark-best model for
    // its type (coding → Claude, writing → GPT/Gemini, …). Returns null when
    // Cascade Auto is off, in which case the shared tier model is used.
    let subtaskModel: ModelInfo | undefined;
    try {
      const subtaskText = `${this.assignment?.subtaskTitle ?? ''} ${this.assignment?.description ?? ''} ${this.assignment?.expectedOutput ?? ''}`;
      subtaskModel = (await this.router.selectModelForSubtask('T3', subtaskText)) ?? undefined;
      if (subtaskModel) {
        this.log(`Cascade Auto: routing this subtask to ${subtaskModel.provider}:${subtaskModel.id}`);
      }
    } catch { /* fall back to the tier model */ }

    // Detect tool-use mode against the EFFECTIVE model (per-subtask override if
    // any, else the tier default).
    const effectiveModel = subtaskModel ?? this.router.getModelForTier('T3');
    const useTextTools = effectiveModel?.supportsToolUse === false && tools.length > 0;
    const textToolSuffix = useTextTools ? buildTextToolSystemPrompt(tools) : '';

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // ── Cancellation checkpoint (before every LLM call) ──────────────
      this.throwIfCancelled();

      const options: GenerateOptions = {
        messages: this.context.getMessages(),
        systemPrompt: this.systemPromptOverride + systemPrompt
          + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : '')
          + textToolSuffix,
        // Don't pass tools array when model can't use them natively
        tools: useTextTools ? undefined : (tools.length ? tools : undefined),
        maxTokens: 4096,
        ...(subtaskModel ? { model: subtaskModel } : {}),
        featureTag: this.assignment?.sectionTitle,
      };

      const result = await this.router.generate(
        'T3',
        options,
        (chunk) => {
          this.emit('stream:token', { tierId: this.id, text: chunk.text });
        },
      );

      // For text-tool mode: parse <tool_call> blocks and inject as native tool calls
      let effectiveToolCalls = result.toolCalls ?? [];
      if (useTextTools && effectiveToolCalls.length === 0) {
        const textCalls = parseTextToolCalls(result.content);
        effectiveToolCalls = textCalls.map((tc, i) => toToolCall(tc, i));
      }
      const effectiveResult = { ...result, toolCalls: effectiveToolCalls };

      await this.context.addMessage({ role: 'assistant', content: result.content, toolCalls: effectiveToolCalls });

      if (!effectiveResult.toolCalls?.length) {
        if (requiresArtifact) {
          const artifactCheck = await this.verifyArtifacts(this.assignment!);
          if (artifactCheck.ok) {
            return { output: result.content, toolCalls: allToolCalls };
          }

          stalledArtifactIterations += 1;
          if (stalledArtifactIterations >= 2) {
            const partial = result.content || '';
            if (stalledArtifactIterations === 2) {
              throw new WorkerStallError(
                `Worker stalled waiting for artifact creation. Requesting dynamic tool generation from T2 Manager for: ${this.assignment?.subtaskTitle ?? 'unknown task'}`,
                partial,
              );
            }
            throw new WorkerStallError(
              'Artifact-producing task stalled without creating or verifying the required files',
              partial,
            );
          }
          await this.context.addMessage({
            role: 'user',
            content: `You have not yet created and verified the required artifact. Issues: ${artifactCheck.issues.join('; ')}. Use tools to create the file in the workspace, verify it exists, and inspect the result before concluding.`,
          });
          continue;
        }
        return { output: result.content, toolCalls: allToolCalls };
      }

      stalledArtifactIterations = 0;

      if (effectiveResult.finishReason === 'stop' && effectiveResult.toolCalls.length === 0) {
        if (requiresArtifact) {
          const artifactCheck = await this.verifyArtifacts(this.assignment!);
          if (artifactCheck.ok) {
            return { output: result.content, toolCalls: allToolCalls };
          }
        } else {
          return { output: result.content, toolCalls: allToolCalls };
        }
      }

      for (const tc of effectiveResult.toolCalls) {
        allToolCalls.push(tc);
        const toolResult = await this.executeTool(tc);
        await this.context.addMessage({
          role: 'tool',
          content: toolResult,
          toolCallId: tc.id,
        });
      }
    }

    const lastMsg = this.context.getMessages().slice().reverse().find((m) => m.role === 'assistant');
    return {
      output: typeof lastMsg?.content === 'string' ? lastMsg.content : '',
      toolCalls: allToolCalls,
    };
  }

  /**
   * Lightweight argument check against the tool's JSON Schema: required fields
   * present and enum values in range. Not a full validator — just the two
   * failure modes weak models hit most. Returns an error message, or null if OK.
   */
  private validateToolInput(tc: ToolCall): string | null {
    const def = this.tools.find(t => t.name === tc.name);
    const schema = def?.inputSchema as {
      properties?: Record<string, { enum?: unknown[] }>;
      required?: string[];
    } | undefined;
    if (!schema) return null;

    const required = Array.isArray(schema.required) ? schema.required : [];
    const missing = required.filter(k => tc.input[k] === undefined || tc.input[k] === null || tc.input[k] === '');
    if (missing.length) {
      return `Tool error: missing required parameter(s) for "${tc.name}": ${missing.join(', ')}. Expected: ${JSON.stringify(schema)}. Supply them and call the tool again.`;
    }

    if (schema.properties) {
      for (const [k, prop] of Object.entries(schema.properties)) {
        const allowed = Array.isArray(prop?.enum) ? prop.enum : null;
        if (allowed && tc.input[k] !== undefined && !allowed.includes(tc.input[k])) {
          return `Tool error: invalid value for "${k}" in "${tc.name}": ${JSON.stringify(tc.input[k])}. Must be one of ${JSON.stringify(allowed)}.`;
        }
      }
    }
    return null;
  }

  private async executeTool(tc: ToolCall): Promise<string> {
    // T3→T2 reinforcement: handle locally (record the request for the manager) —
    // it is a signal, not a real side-effecting tool, so it skips registry
    // validation and approval.
    if (tc.name === 'request_workers') {
      const msg = this.recordReinforcements(tc.input);
      this.emit('tool:result', { id: tc.id, tierId: this.id, toolName: tc.name, output: msg, durationMs: 0 });
      return msg;
    }

    // Reject malformed calls early (before any approval prompt) with a clear,
    // self-correcting message — weaker models often omit required parameters or
    // pass an out-of-range enum value, which otherwise fails opaquely at run time.
    const validationError = this.validateToolInput(tc);
    if (validationError) {
      this.emit('tool:result', { id: tc.id, tierId: this.id, toolName: tc.name, error: validationError, durationMs: 0 });
      return validationError;
    }

    const needsApproval = this.toolRegistry.requiresApproval(tc.name);

    if (needsApproval) {
      // ── Hierarchical permission escalation: T3 → T2 → T1 → User ──
      if (this.permissionEscalator) {
        const req: PermissionRequest = {
          id: `${this.id}-${tc.id}`,
          requestedBy: this.id,
          parentT2Id: this.parentId ?? 'root',
          toolName: tc.name,
          input: tc.input,
          isDangerous: this.toolRegistry.isDangerous(tc.name),
          subtaskContext: this.assignment?.subtaskTitle ?? 'Unknown subtask',
          sectionContext: this.assignment?.subtaskTitle ?? 'Unknown section',
        };
        const decision = await this.permissionEscalator.requestPermission(req);
        if (!decision.approved) return `Tool ${tc.name} was denied (decided by ${decision.decidedBy}).`;
      } else {
        // ── Fallback: legacy direct approval event (used when escalator not wired) ──
        if (this.sessionApprovals.has(tc.name)) {
          const wasApproved = this.sessionApprovals.get(tc.name)!;
          if (!wasApproved) return `Tool ${tc.name} was denied by user.`;
        } else {
          // Time-box this fallback too (default 10 min → deny) so a missing or
          // unanswered approval prompt can't hang the worker indefinitely.
          const LEGACY_APPROVAL_TIMEOUT_MS = 600_000;
          const legacyDecision = await new Promise<{ approved: boolean; always?: boolean }>((resolve) => {
            const eventName = `tool:approval-response:${this.id}-${tc.id}`;
            const timer = setTimeout(() => {
              this.removeAllListeners(eventName);
              resolve({ approved: false });
            }, LEGACY_APPROVAL_TIMEOUT_MS);
            timer.unref?.();
            this.emit('tool:approval-request', {
              id: `${this.id}-${tc.id}`,
              tierId: this.id,
              toolName: tc.name,
              input: tc.input,
              description: `T3 (${this.assignment?.subtaskTitle}) wants to run "${tc.name}"`,
              isDangerous: this.toolRegistry.isDangerous(tc.name),
            });
            this.once(eventName, (d: { approved: boolean; always?: boolean }) => {
              clearTimeout(timer);
              resolve(d);
            });
          });
          if (legacyDecision.always) this.sessionApprovals.set(tc.name, legacyDecision.approved);
          if (!legacyDecision.approved) return `Tool ${tc.name} was denied by user.`;
        }
      }
    }

    // Emit tool:use before execution so the TUI can display the active tool
    this.sendStatusUpdate({
      progressPct: 50,
      currentAction: `Using tool: ${tc.name}`,
      status: 'IN_PROGRESS',
    });

    this.emit('tool:call', { id: tc.id, tierId: this.id, toolName: tc.name, input: tc.input });
    const toolStartMs = Date.now();

    try {
      const result = await this.toolRegistry.execute(tc.name, tc.input, {
        tierId: this.id,
        sessionId: this.taskId,
        requireApproval: false,
        saveSnapshot: async (path, content) => {
          this.store?.addFileSnapshot(this.taskId, path, content);
        },
        sendPeerSync: (to, syncType, content) => {
          this.peerBus?.send(this.id, to, syncType, this.assignment?.subtaskId ?? '', content);
        },
        getPeerMessages: () => {
          const msgs = [...this.peerSyncBuffer];
          this.peerSyncBuffer = [];
          return msgs;
        },
      });
      if (this.audit) {
        this.audit.toolCall(this.id, tc.name, tc.input);
        if (this.isFileOperation(tc.name)) {
          this.audit.fileChange(this.id, (tc.input['path'] as string | undefined) ?? 'unknown', tc.name);
        }
      }
      const durationMs = Date.now() - toolStartMs;
      this.emit('tool:result', { id: tc.id, tierId: this.id, toolName: tc.name, output: typeof result === 'string' ? result : JSON.stringify(result), durationMs });
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      const durationMs = Date.now() - toolStartMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emit('tool:result', { id: tc.id, tierId: this.id, toolName: tc.name, error: errMsg, durationMs });
      // Unrecoverable conditions (rate-limit, auth, forbidden) — throw a
      // CriticalToolError so the agent loop stops retrying and the worker
      // escalates fast with the real reason intact (used to loop 15× then
      // emit a generic failure).
      if (/\b(429|rate.?limit|authentication|api.?key|forbidden|401|403)\b/i.test(errMsg)) {
        throw new CriticalToolError(errMsg, tc.name);
      }
      // Try to recover via a sibling tool or a synthesized one before giving up;
      // returns the original error string if no fallback succeeds.
      return await this.adaptiveFallback(tc, `Tool error: ${errMsg}`);
    }
  }

  /**
   * Adaptive fallback cascade — invoked when executeTool() fails.
   * Strategy order:
   *   1. Find a semantically similar registered tool and retry with same input
   *   2. Synthesize a new tool via ToolCreator (if available) and run it
   *   3. Return the original error so the agent loop can decide what to do next
   */
  private async adaptiveFallback(tc: ToolCall, originalError: string): Promise<string> {
    // Strategy 1: alternative tool with overlapping purpose
    const altTool = this.findAlternativeTool(tc.name);
    if (altTool) {
      this.log(`Adaptive fallback: trying alternative tool "${altTool}" for failed "${tc.name}"`);
      this.sendStatusUpdate({ progressPct: 50, currentAction: `Fallback: trying ${altTool}`, status: 'IN_PROGRESS' });
      try {
        const result = await this.toolRegistry.execute(altTool, tc.input, {
          tierId: this.id,
          sessionId: this.taskId,
          requireApproval: false,
        });
        const str = typeof result === 'string' ? result : JSON.stringify(result);
        if (!str.startsWith('Tool error:') && !str.startsWith('Error:')) {
          return `[Fallback via ${altTool}]: ${str}`;
        }
      } catch { /* fall through to next strategy */ }
    }

    // Strategy 2: synthesize a new tool via ToolCreator
    if (this.toolCreator) {
      this.log(`Adaptive fallback: requesting dynamic tool synthesis for "${tc.name}"`);
      this.sendStatusUpdate({ progressPct: 55, currentAction: `Synthesizing fallback tool for: ${tc.name}`, status: 'IN_PROGRESS' });
      try {
        const newToolName = await this.toolCreator.createTool(
          `Replacement for "${tc.name}" — original failed with: ${originalError.slice(0, 150)}`,
          this.assignment?.subtaskTitle ?? tc.name,
        );
        if (newToolName) {
          this.log(`Adaptive fallback: synthesized "${newToolName}", retrying`);
          const result = await this.toolRegistry.execute(newToolName, tc.input, {
            tierId: this.id,
            sessionId: this.taskId,
            requireApproval: false,
          });
          const str = typeof result === 'string' ? result : JSON.stringify(result);
          if (!str.startsWith('Tool error:')) return `[Synthesized ${newToolName}]: ${str}`;
        }
      } catch { /* fall through */ }
    }

    return originalError;
  }

  /**
   * Find a registered tool whose name/description semantically overlaps with
   * the failing tool. Returns the best candidate name, or null if none found.
   */
  private findAlternativeTool(failedToolName: string): string | null {
    const failedKeywords = failedToolName.toLowerCase().split(/[_\-\s]+/);
    const allTools = this.toolRegistry.getToolDefinitions();
    let bestScore = 0;
    let bestName: string | null = null;

    for (const tool of allTools) {
      if (tool.name === failedToolName) continue;
      const toolWords = tool.name.toLowerCase().split(/[_\-\s]+/);
      const score = failedKeywords.filter(k => toolWords.includes(k)).length;
      if (score > bestScore && score >= 1) {
        bestScore = score;
        bestName = tool.name;
      }
    }
    return bestName;
  }

  /**
   * Announce which files this T3 plans to edit, then acquire locks on them
   * before competing siblings can claim them. T3s working on different files
   * proceed in full parallel; T3s on the same file serialize automatically.
   */
  private async coordinateFileIntents(assignment: T2ToT3Assignment): Promise<void> {
    if (!this.peerBus) return;
    // Only coordinate locks for tasks that will actually WRITE files. A read or
    // analyze task that merely mentions a filename in prose (e.g. "is the README
    // a novel idea?") must not lock it — locking phantom or read-only paths
    // previously caused waits that could stall the whole run for minutes.
    const haystack = `${assignment.description}\n${assignment.expectedOutput}`;
    if (!/\b(create|write|save|generate|produce|output|edit|update|modify|append|overwrite|rewrite)\b/i.test(haystack)) {
      return;
    }
    const plannedFiles = this.extractArtifactPaths(assignment);
    if (!plannedFiles.length) return;

    // Broadcast intent so siblings are aware
    this.peerBus.broadcast(this.id, {
      type: 'FILE_INTENT',
      subtaskId: assignment.subtaskId,
      files: plannedFiles,
    });

    // Give siblings 500ms to announce their intents
    await new Promise(r => setTimeout(r, 500));

    // Acquire locks on all planned files (deterministic order to avoid deadlock).
    // Lock coordination is best-effort and time-boxed: a stuck or never-released
    // lock must never hang the actual work, so any wait failure falls through to
    // proceeding without the lock.
    const sortedFiles = [...plannedFiles].sort();
    for (const filePath of sortedFiles) {
      try {
        if (this.peerBus.isFileLocked(filePath)) {
          this.log(`[T3] Waiting for file lock: ${filePath}`);
          this.sendStatusUpdate({
            progressPct: 5,
            currentAction: `Waiting for peer to finish editing: ${filePath}`,
            status: 'IN_PROGRESS',
          });
          await this.peerBus.waitForFileRelease(filePath, 10_000).catch(() => { /* proceed unlocked */ });
        }
        await this.peerBus.lockFile(this.id, filePath, 10_000).catch(() => { /* proceed unlocked */ });
      } catch (err) {
        this.log(`[T3] Lock coordination skipped for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Register cleanup: release all locks when this worker finishes
    const origPublish = this.peerBus.publish.bind(this.peerBus);
    const bus = this.peerBus;
    const workerId = this.id;
    const cleanup = () => {
      for (const f of sortedFiles) bus.releaseFile(workerId, f);
    };
    this.once('completed', cleanup);
    this.once('failed', cleanup);
    this.peerBus.publish = (fromId, subtaskId, output, status) => {
      if (fromId === this.id) cleanup();
      // Restore original after first call for this worker
      this.peerBus!.publish = origPublish;
      origPublish(fromId, subtaskId, output, status);
    };
  }

  private requiresArtifact(): boolean {
    const haystack = `${this.assignment?.description ?? ''}
${this.assignment?.expectedOutput ?? ''}`;
    return /\b[\w./-]+\.(pdf|md|html|txt|json|csv|py|js|ts|tsx|jsx|docx?|png|jpg|jpeg|svg|gif)\b/i.test(haystack)
      || /save (?:a|the)? file|create (?:a|the)? file|write (?:a|the)? file/i.test(haystack);
  }

  private extractArtifactPaths(assignment: T2ToT3Assignment): string[] {
    const haystack = `${assignment.description}
${assignment.expectedOutput}`;
    const matches = haystack.match(/\b[\w./-]+\.(pdf|md|html|txt|json|csv|py|js|ts|tsx|jsx|docx?|png|jpg|jpeg|svg|gif)\b/gi) ?? [];
    return [...new Set(matches.map((m) => m.trim()))];
  }

  private async verifyArtifacts(assignment: T2ToT3Assignment): Promise<{ ok: boolean; issues: string[] }> {
    const artifactPaths = this.extractArtifactPaths(assignment);
    if (!artifactPaths.length) return { ok: true, issues: [] };

    const issues: string[] = [];
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    for (const artifactPath of artifactPaths) {
      const absolutePath = path.resolve(process.cwd(), artifactPath);
      try {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) {
          issues.push(`Expected artifact is not a file: ${artifactPath}`);
          continue;
        }
        if (stat.size <= 0) {
          issues.push(`Artifact is empty: ${artifactPath}`);
          continue;
        }

        if (!/\.pdf$/i.test(artifactPath)) {
          const content = await fs.readFile(absolutePath, 'utf-8');
          if (!content.trim()) {
            issues.push(`Artifact content is empty: ${artifactPath}`);
            continue;
          }
        } else if (stat.size < 100) {
          issues.push(`PDF artifact looks too small to be valid: ${artifactPath}`);
          continue;
        }

        // Semantic checks
        const ext = path.extname(absolutePath).toLowerCase();
        try {
          if (ext === '.ts' || ext === '.tsx') {
            await execAsync(`npx tsc --noEmit ${absolutePath}`, { timeout: 10000 });
          } else if (ext === '.js' || ext === '.jsx') {
            await execAsync(`node --check ${absolutePath}`, { timeout: 10000 });
          } else if (ext === '.py') {
            await execAsync(`python -m py_compile ${absolutePath}`, { timeout: 10000 });
          }
        } catch (err: any) {
          const stderr = err?.stderr || String(err);
          const stdout = err?.stdout || '';
          issues.push(`Semantic error in ${artifactPath}:\n${stderr}\n${stdout}`);
        }
      } catch {
        issues.push(`Required artifact was not created: ${artifactPath}`);
      }
    }

    return { ok: issues.length === 0, issues };
  }

  /**
   * Reflection / self-critique: critique the output against the broader GOAL
   * (not just the subtask spec the self-test checks) and revise once if it falls
   * short. Two cheap calls per round — a JSON verdict, then a rewrite only if
   * needed. Best-effort: any parse/error just keeps the current output.
   */
  private async reflectAndImprove(
    assignment: T2ToT3Assignment,
    output: string,
    maxRounds: number,
  ): Promise<string> {
    let current = output;
    try {
      const { T2Manager } = await import('./t2-manager.js');
      
      for (let round = 0; round < Math.max(1, maxRounds); round++) {
        const critic = new T2Manager(this.router, this.toolRegistry, this.parentId ?? '');
        critic.setSystemPromptOverride('You are a T2-Critic peer reviewing a T3 Worker. Use your tools and peer network if needed.');
        if (this.peerBus) critic.setPeerBus(this.peerBus);
        if (this.store) critic.setStore(this.store);

        const prompt = `Review this T3 Worker's output against the goal. 
Goal: ${assignment.expectedOutput}
Subtask: ${assignment.description}
Current Output:
${current}

Is this output sufficient and correct? Respond with a JSON object:
{"sufficient": true|false, "notes": "what is wrong or missing if false"}`;

        // Create a dummy section assignment for the T2-Critic to execute
        const reviewSection = {
          sectionId: `critic-${this.taskId}-${round}`,
          sectionTitle: `Reviewing: ${assignment.subtaskTitle}`,
          description: prompt,
          expectedOutput: 'A JSON verdict',
          constraints: [],
          t3Subtasks: [{
            subtaskId: `t3-critic-${this.taskId}-${round}`,
            subtaskTitle: 'Critique Output',
            description: prompt,
            expectedOutput: 'JSON verdict',
            constraints: [],
            peerT3Ids: [],
            executionMode: 'parallel' as const,
          }],
          executionMode: 'parallel' as const,
          peerT2Ids: []
        };

        const result = await critic.execute(reviewSection, this.taskId, this.signal);
        const critiqueText = result.sectionSummary;
        
        const match = critiqueText.match(/\{[\s\S]*\}/);
        const parsed = match ? JSON.parse(match[0]) : { sufficient: true };
        
        if (parsed.sufficient !== false) {
          this.log('T2-Critic approved output.');
          break; // sufficient
        }

        this.log(`T2-Critic rejected output: ${parsed.notes}`);
        
        const improved = await this.router.generate('T3', {
          messages: [{
            role: 'user',
            content: `Improve the following so it fully achieves the goal. Address specifically: ${parsed.notes ?? 'gaps vs the goal'}.
Output ONLY the improved result — no preamble, no commentary.

Goal / expected: ${assignment.expectedOutput}

Current output:
${current}`,
          }],
          systemPrompt: this.systemPromptOverride + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
          maxTokens: 4096,
          featureTag: assignment.sectionTitle,
        });
        const next = (improved.content ?? '').trim();
        if (!next) break;
        current = next;
        this.log('Reflection: revised output for better goal alignment.');
      }
    } catch (e) {
      this.log(`T2-Critic reflection failed: ${e}`);
    }
    return current;
  }

  private async selfTest(
    assignment: T2ToT3Assignment,
    output: string,
  ): Promise<{ checksRun: string[]; passed: string[]; failed: string[] }> {
    const prompt = `Self-test this output against the assignment requirements.

Assignment: ${assignment.description}
Expected output: ${assignment.expectedOutput}
Constraints: ${assignment.constraints.join('; ')}

Output to test:
${output}

Reply with JSON: { "completeness": "pass"|"fail", "correctness": "pass"|"fail", "compliance": "pass"|"fail", "notes": "string" }`;

    const testMessages: ConversationMessage[] = [{ role: 'user', content: prompt }];
    const testResult = await this.router.generate('T3', { 
      messages: testMessages, 
      maxTokens: 500,
      systemPrompt: this.systemPromptOverride + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
      featureTag: assignment.sectionTitle,
    });

    try {
      const jsonMatch = /\{[\s\S]*\}/.exec(testResult.content);
      if (!jsonMatch) throw new Error('No JSON in test result');
      const parsed = JSON.parse(jsonMatch[0]) as {
        completeness: string;
        correctness: string;
        compliance: string;
        notes: string;
      };

      const checksRun = ['completeness', 'correctness', 'compliance'];
      const passed = checksRun.filter((c) => parsed[c as keyof typeof parsed] === 'pass');
      const failed = checksRun.filter((c) => parsed[c as keyof typeof parsed] === 'fail');

      return { checksRun, passed, failed };
    } catch {
      return {
        checksRun: ['completeness', 'correctness', 'compliance'],
        passed: ['completeness', 'correctness', 'compliance'],
        failed: [],
      };
    }
  }

  private async correctOutput(originalOutput: string, failures: string[]): Promise<string> {
    const correctionPrompt = `The following output failed these checks: ${failures.join(', ')}.

Original output:
${originalOutput}

Correct the issues and provide an improved version that addresses all failures.`;

    await this.context.addMessage({ role: 'user', content: correctionPrompt });

    const result = await this.runAgentLoop(
      "You are in a correction phase. Fix the identified issues using your tools." + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
      this.tools
    );
    return result.output;
  }

  private buildSystemPrompt(assignment: T2ToT3Assignment): string {
    return `${T3_SYSTEM_PROMPT}

Your subtask:
- Title: ${assignment.subtaskTitle}
- Description: ${assignment.description}
- Expected output: ${assignment.expectedOutput}
- Constraints: ${assignment.constraints.join('; ')}`;
  }

  private buildInitialPrompt(assignment: T2ToT3Assignment): string {
    return `Execute the following subtask completely:

**${assignment.subtaskTitle}**

${assignment.description}

Expected output: ${assignment.expectedOutput}

Constraints:
${assignment.constraints.map((c) => `- ${c}`).join('\n')}

Begin execution now.`;
  }

  /**
   * Records a request_workers call (T3→T2 reinforcement). Capped at
   * maxPerSection; reinforcement workers (depth 1) cannot request more.
   */
  private recordReinforcements(input: Record<string, unknown>): string {
    if (this.reinforcementDepth !== 0) {
      return 'request_workers is unavailable to reinforcement workers — complete your assigned subtask.';
    }
    const max = this.router.getReinforcementsConfig?.()?.maxPerSection ?? 4;
    const raw = Array.isArray((input as { subtasks?: unknown }).subtasks)
      ? (input as { subtasks: unknown[] }).subtasks
      : [];
    let added = 0;
    for (const s of raw) {
      if (this.pendingReinforcements.length >= max) break;
      const o = s as { title?: unknown; description?: unknown; expectedOutput?: unknown };
      if (typeof o?.title !== 'string' || typeof o?.description !== 'string') continue;
      this.pendingReinforcements.push({
        subtaskId: `reinf-${this.id}-${this.pendingReinforcements.length + 1}`,
        subtaskTitle: o.title,
        description: o.description,
        expectedOutput: typeof o.expectedOutput === 'string' ? o.expectedOutput : o.title,
        constraints: [],
        peerT3Ids: [],
        parentT2: this.parentId ?? 'root',
        dependsOn: [],
      });
      added++;
    }
    return added > 0
      ? `Requested ${added} reinforcement worker(s) from your manager; they will run in parallel. Focus on your own part — do not redo their work.`
      : 'No valid reinforcement subtasks (each needs a title and description), or the per-section limit was reached.';
  }

  private buildResult(
    status: T3Result['status'],
    output: string,
    testResults: T3Result['testResults'],
    issues: string[],
    correctionAttempts: number,
  ): T3Result {
    return {
      subtaskId: this.assignment?.subtaskId ?? '',
      status,
      output,
      testResults,
      issues,
      peerSyncsUsed: this.peerSyncBuffer.map(m => m.fromId),
      correctionAttempts,
      reinforcements: this.pendingReinforcements.length ? this.pendingReinforcements : undefined,
    };
  }

  private isFileOperation(toolName: string): boolean {
    return ['file_write', 'file_edit', 'file_delete'].includes(toolName);
  }
}
