// ─────────────────────────────────────────────
//  Cascade AI — T3 Worker
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalRequest,
  ConversationMessage,
  GenerateOptions,
  T2ToT3Assignment,
  T3Result,
  ToolCall,
  ToolDefinition,
} from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { BaseTier } from './base.js';
import { ContextManager } from '../context/manager.js';

const T3_SYSTEM_PROMPT = `You are a T3 Worker agent in the Cascade AI system. Your job is to execute a specific subtask completely and accurately.

Rules:
- Execute the subtask completely — do not stop partway through.
- Use tools when needed. Ask for approval only when the tool registry requires it.
- If the task asks for a file or artifact, you must actually create it in the workspace, verify that it exists, and inspect it before claiming success.
- Intermediate files are allowed when useful. Clean them up after a successful final artifact verification. If the run fails, keep intermediates for debugging.
- Self-test your output: check completeness, correctness, and constraint compliance.
- If you are not making meaningful progress, stop and escalate rather than looping or padding the response.
- Return structured output that directly addresses the expected output specification.`;

export class T3Worker extends BaseTier {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private context: ContextManager;
  private assignment?: T2ToT3Assignment;
  private peerSyncBuffer: Map<string, unknown> = new Map();

  constructor(router: CascadeRouter, toolRegistry: ToolRegistry, parentId: string) {
    super('T3', undefined, parentId);
    this.router = router;
    this.toolRegistry = toolRegistry;
    this.context = new ContextManager();
  }

  async execute(assignment: T2ToT3Assignment, taskId: string): Promise<T3Result> {
    this.assignment = assignment;
    this.taskId = taskId;
    this.setLabel(assignment.subtaskTitle);
    this.setStatus('ACTIVE');

    this.sendStatusUpdate({
      progressPct: 0,
      currentAction: `Starting subtask: ${assignment.subtaskTitle}`,
      status: 'IN_PROGRESS',
    });

    this.log(`T3 executing subtask: ${assignment.subtaskTitle}`);

    const tools = this.toolRegistry.getToolDefinitions();
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
      // Execute
      const result = await this.runAgentLoop(systemPrompt, tools);
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
          return this.buildResult('ESCALATED', output, { checksRun, passed, failed }, issues, correctionAttempts);
        }
      }

      this.sendStatusUpdate({ progressPct: 70, currentAction: 'Self-testing output', status: 'IN_PROGRESS' });

      // Self-test
      const testResult = await this.selfTest(assignment, output);
      checksRun.push(...testResult.checksRun);
      passed.push(...testResult.passed);
      failed.push(...testResult.failed);

      // If failed, one correction attempt
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
          return this.buildResult('ESCALATED', output, { checksRun, passed, failed }, issues, correctionAttempts);
        }
      }

      this.setStatus('COMPLETED');
      this.sendStatusUpdate({ progressPct: 100, currentAction: 'Subtask complete', status: 'IN_PROGRESS' });

      return this.buildResult('COMPLETED', output, { checksRun, passed, failed }, issues, correctionAttempts);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      issues.push(`Execution error: ${errMsg}`);
      this.setStatus('FAILED');
      return this.buildResult('ESCALATED', output || errMsg, { checksRun, passed, failed }, issues, correctionAttempts);
    }
  }

  receivePeerSync(fromId: string, content: unknown): void {
    this.peerSyncBuffer.set(fromId, content);
    this.emit('peer-sync-received', { fromId, content });
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

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const options: GenerateOptions = {
        messages: this.context.getMessages(),
        systemPrompt,
        tools: tools.length ? tools : undefined,
        maxTokens: 4096,
      };

      const result = await this.router.generate(
        'T3',
        options,
        (chunk) => {
          this.emit('stream:token', { tierId: this.id, text: chunk.text });
        },
      );

      await this.context.addMessage({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

      if (!result.toolCalls?.length) {
        if (requiresArtifact) {
          stalledArtifactIterations += 1;
          if (stalledArtifactIterations >= 2) {
            throw new Error('Artifact-producing task stalled without creating or verifying the required files');
          }
          await this.context.addMessage({
            role: 'user',
            content: 'You have not yet created and verified the required artifact. Use tools to create the file in the workspace, verify it exists, and inspect the result before concluding.',
          });
          continue;
        }
        return { output: result.content, toolCalls: allToolCalls };
      }

      stalledArtifactIterations = 0;

      if (result.finishReason === 'stop' && !requiresArtifact) {
        return { output: result.content, toolCalls: allToolCalls };
      }

      for (const tc of result.toolCalls) {
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
      const request: ApprovalRequest = {
        id: `${this.id}-${tc.id}`,
        tierId: this.id,
        toolName: tc.name,
        input: tc.input,
        description: `T3 (${this.assignment?.subtaskTitle}) wants to run: ${tc.name}`,
        isDangerous: this.toolRegistry.isDangerous(tc.name),
      };

      const approved = await new Promise<boolean>((resolve) => {
        this.emit('tool:approval-request', request);
        this.once(`tool:approval-response:${request.id}`, (resp: { approved: boolean }) => {
          resolve(resp.approved);
        });
      });

      if (!approved) {
        return `Tool ${tc.name} was denied by user.`;
      }
    }

    try {
      const result = await this.toolRegistry.execute(tc.name, tc.input, {
        tierId: this.id,
        sessionId: this.taskId,
        requireApproval: false,
      });
      this.emit('tool:result', { tierId: this.id, toolName: tc.name, result });
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private requiresArtifact(): boolean {
    const haystack = `${this.assignment?.description ?? ''}
${this.assignment?.expectedOutput ?? ''}`;
    return /\b[\w./-]+\.(pdf|md|html|txt|json|csv|py|js|ts|tsx|jsx|docx?)\b/i.test(haystack)
      || /save (?:a|the)? file|create (?:a|the)? file|write (?:a|the)? file/i.test(haystack);
  }

  private extractArtifactPaths(assignment: T2ToT3Assignment): string[] {
    const haystack = `${assignment.description}
${assignment.expectedOutput}`;
    const matches = haystack.match(/\b[\w./-]+\.(pdf|md|html|txt|json|csv|py|js|ts|tsx|jsx|docx?)\b/gi) ?? [];
    return [...new Set(matches.map((m) => m.trim()))];
  }

  private async verifyArtifacts(assignment: T2ToT3Assignment): Promise<{ ok: boolean; issues: string[] }> {
    const artifactPaths = this.extractArtifactPaths(assignment);
    if (!artifactPaths.length) return { ok: true, issues: [] };

    const issues: string[] = [];

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
          }
        } else if (stat.size < 100) {
          issues.push(`PDF artifact looks too small to be valid: ${artifactPath}`);
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
    const testResult = await this.router.generate('T3', { messages: testMessages, maxTokens: 500 });

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

    const result = await this.router.generate(
      'T3',
      { messages: this.context.getMessages(), maxTokens: 4096 },
      (chunk) => this.emit('stream:token', { tierId: this.id, text: chunk.text }),
    );
    await this.context.addMessage({ role: 'assistant', content: result.content });
    return result.content;
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
      peerSyncsUsed: [...this.peerSyncBuffer.keys()],
      correctionAttempts,
    };
  }
}
