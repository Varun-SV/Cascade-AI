// ─────────────────────────────────────────────
//  Cascade AI — Context Window Manager
// ─────────────────────────────────────────────

import type { ConversationMessage, TokenUsage } from '../../types.js';
import { DEFAULT_AUTO_SUMMARIZE_AT, DEFAULT_CONTEXT_LIMIT } from '../../constants.js';

export class ContextManager {
  private messages: ConversationMessage[] = [];
  private tokenCount = 0;
  private readonly limit: number;
  private readonly summarizeAt: number;
  private onSummarizeNeeded?: (messages: ConversationMessage[]) => Promise<string>;

  constructor(
    limit = DEFAULT_CONTEXT_LIMIT,
    summarizeAt = DEFAULT_AUTO_SUMMARIZE_AT,
  ) {
    this.limit = limit;
    this.summarizeAt = summarizeAt;
  }

  setOnSummarizeNeeded(fn: (messages: ConversationMessage[]) => Promise<string>): void {
    this.onSummarizeNeeded = fn;
  }

  async addMessage(message: ConversationMessage, estimatedTokens = 0): Promise<void> {
    this.messages.push(message);
    this.tokenCount += estimatedTokens;

    if (this.tokenCount >= this.summarizeAt && this.onSummarizeNeeded) {
      await this.summarize();
    }
  }

  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  getTokenCount(): number {
    return this.tokenCount;
  }

  isNearLimit(): boolean {
    return this.tokenCount >= this.summarizeAt;
  }

  isAtLimit(): boolean {
    return this.tokenCount >= this.limit;
  }

  getUsagePercent(): number {
    return Math.min(100, (this.tokenCount / this.limit) * 100);
  }

  pruneToFit(maxTokens: number): ConversationMessage[] {
    const result: ConversationMessage[] = [];
    let count = 0;
    // Always keep system messages + last N messages
    const system = this.messages.filter((m) => m.role === 'system');
    const nonSystem = this.messages.filter((m) => m.role !== 'system');

    for (const m of system) result.push(m);

    // Add from end going backwards
    const recent: ConversationMessage[] = [];
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const est = this.estimateTokens(nonSystem[i]!);
      if (count + est > maxTokens) break;
      recent.unshift(nonSystem[i]!);
      count += est;
    }
    result.push(...recent);
    return result;
  }

  updateTokenCount(usage: TokenUsage): void {
    this.tokenCount = usage.totalTokens;
  }

  clear(): void {
    this.messages = [];
    this.tokenCount = 0;
  }

  /**
   * Returns a human-readable summary of the current context state.
   * Useful for debugging and status-bar display.
   */
  getContextSummary(): {
    messageCount: number;
    tokenCount: number;
    usagePercent: number;
    isNearLimit: boolean;
    isAtLimit: boolean;
  } {
    return {
      messageCount: this.messages.length,
      tokenCount: this.tokenCount,
      usagePercent: this.getUsagePercent(),
      isNearLimit: this.isNearLimit(),
      isAtLimit: this.isAtLimit(),
    };
  }

  private async summarize(): Promise<void> {
    if (!this.onSummarizeNeeded) return;

    const toSummarize = this.messages.filter((m) => m.role !== 'system');
    if (toSummarize.length < 4) return;

    const summary = await this.onSummarizeNeeded(toSummarize);

    const systemMessages = this.messages.filter((m) => m.role === 'system');
    const recent = toSummarize.slice(-4);

    this.messages = [
      ...systemMessages,
      { role: 'user', content: `[Previous conversation summary]\n${summary}` },
      { role: 'assistant', content: 'Understood. Continuing from the summary above.' },
      ...recent,
    ];

    this.tokenCount = Math.floor(this.tokenCount * 0.3);
  }

  private estimateTokens(message: ConversationMessage): number {
    let charCount = 0;

    if (typeof message.content === 'string') {
      charCount = message.content.length;
    } else {
      for (const block of message.content) {
        if (block.type === 'text') {
          charCount += block.text.length;
        } else if (block.type === 'image') {
          // Images consume significant tokens; use a conservative flat estimate
          // (~85 tokens/image thumbnail tile as a lower-bound proxy)
          charCount += 340; // ≈ 85 tokens × 4 chars/token equivalent
        } else if (block.type === 'tool_result') {
          charCount += block.content.length;
        }
      }
    }

    // Role + structural overhead (~4 tokens per message)
    const overhead = 16;
    return Math.ceil(charCount / 4) + overhead;
  }
}
