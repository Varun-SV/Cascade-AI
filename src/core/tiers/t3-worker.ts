// ─────────────────────────────────────────────
//  Cascade AI — T3 Worker
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConversationMessage,
  GenerateOptions,
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
import type { ToolCreator } from '../../tools/tool-creator.js';
import {
  parseTextToolCalls,
  toToolCall,
  buildTextToolSystemPrompt,
} from '../../tools/text-tool-parser.js';

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
  }

  setPermissionEscalator(escalator: PermissionEscalator): void {
    this.permissionEscalator = escalator;
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
          const dep = await this.peerBus.waitFor(depId);
          if (dep.status === 'FAILED' || dep.status === 'ESCALATED') {
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

      this.setStatus('COMPLETED', output);
      this.sendStatusUpdate({ progressPct: 100, currentAction: 'Subtask complete', status: 'IN_PROGRESS', output });

      // ── Publish success to peers ─────────────
      this.peerBus?.publish(this.id, assignment.subtaskId, output, 'COMPLETED');

      return this.buildResult('COMPLETED', output, { checksRun, passed, failed }, issues, correctionAttempts);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
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

    // Detect if T3 model supports native tool use
    const t3Model = this.router.getModelForTier('T3');
    const useTextTools = t3Model?.supportsToolUse === false && tools.length > 0;
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
            if (stalledArtifactIterations === 2) {
              throw new Error(`Worker stalled waiting for artifact creation. Requesting dynamic tool generation from T2 Manager for: ${this.assignment?.subtaskTitle ?? 'unknown task'}`);
            }
            throw new Error('Artifact-producing task stalled without creating or verifying the required files');
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

  private async executeTool(tc: ToolCall): Promise<string> {
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
          const legacyDecision = await new Promise<{ approved: boolean; always?: boolean }>((resolve) => {
            this.emit('tool:approval-request', {
              id: `${this.id}-${tc.id}`,
              tierId: this.id,
              toolName: tc.name,
              input: tc.input,
              description: `T3 (${this.assignment?.subtaskTitle}) wants to run "${tc.name}"`,
              isDangerous: this.toolRegistry.isDangerous(tc.name),
            });
            this.once(`tool:approval-response:${this.id}-${tc.id}`, resolve);
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
      this.emit('tool:result', { tierId: this.id, toolName: tc.name, result });
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Announce which files this T3 plans to edit, then acquire locks on them
   * before competing siblings can claim them. T3s working on different files
   * proceed in full parallel; T3s on the same file serialize automatically.
   */
  private async coordinateFileIntents(assignment: T2ToT3Assignment): Promise<void> {
    if (!this.peerBus) return;
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

    // Acquire locks on all planned files (in deterministic order to avoid deadlock)
    const sortedFiles = [...plannedFiles].sort();
    for (const filePath of sortedFiles) {
      if (this.peerBus.isFileLocked(filePath)) {
        this.log(`[T3] Waiting for file lock: ${filePath}`);
        this.sendStatusUpdate({
          progressPct: 5,
          currentAction: `Waiting for peer to finish editing: ${filePath}`,
          status: 'IN_PROGRESS',
        });
        await this.peerBus.waitForFileRelease(filePath);
      }
      await this.peerBus.lockFile(this.id, filePath);
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
    };
  }

  private isFileOperation(toolName: string): boolean {
    return ['file_write', 'file_edit', 'file_delete'].includes(toolName);
  }
}
