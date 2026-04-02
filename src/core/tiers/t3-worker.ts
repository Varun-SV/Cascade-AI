// ─────────────────────────────────────────────
//  Cascade AI — T3 Worker
// ─────────────────────────────────────────────

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
- Self-test your output: check completeness, correctness, and constraint compliance.
- If you find issues after one correction attempt, escalate honestly rather than fabricating output.
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
    const MAX_ITERATIONS = 15;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const options: GenerateOptions = {
        messages: this.context.getMessages(),
        systemPrompt,
        tools: tools.length ? tools : undefined,
        maxTokens: 4096,
      };

      const chunks: string[] = [];
      const result = await this.router.generate(
        'T3',
        options,
        (chunk) => {
          if (chunk.text) chunks.push(chunk.text);
          this.emit('stream:token', { tierId: this.id, text: chunk.text });
        },
      );

      await this.context.addMessage({ role: 'assistant', content: result.content });

      if (result.finishReason === 'stop' || !result.toolCalls?.length) {
        return { output: result.content, toolCalls: allToolCalls };
      }

      // Execute tool calls
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
