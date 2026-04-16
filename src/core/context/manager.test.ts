import { describe, expect, it, vi } from 'vitest';
import { ContextManager } from './manager.js';

describe('ContextManager', () => {
  it('triggers summarization when limits are reached', async () => {
    const manager = new ContextManager(100, 50);
    const mockSummarize = vi.fn().mockResolvedValue('Summary of conversation');
    manager.setOnSummarizeNeeded(mockSummarize);

    // Add many messages to trigger summarizeAt (50 tokens)
    // 1 char = 0.25 tokens estimate in the code
    await manager.addMessage({ role: 'user', content: 'a'.repeat(200) }, 50);

    // In ContextManager.ts, addMessage calls summarize() if tokenCount >= summarizeAt
    // But summarize() returns early if toSummarize.length < 4
    await manager.addMessage({ role: 'assistant', content: 'reply 1' }, 5);
    await manager.addMessage({ role: 'user', content: 'query 2' }, 5);
    await manager.addMessage({ role: 'assistant', content: 'reply 2' }, 5);

    // This should trigger summarize()
    await manager.addMessage({ role: 'user', content: 'trigger' }, 5);

    expect(mockSummarize).toHaveBeenCalled();
    expect(manager.getMessages()[0]!.content).toContain('Summary of conversation');
  });

  it('prunes messages to fit within a limit', () => {
    const manager = new ContextManager(1000, 800);
    manager.addMessage({ role: 'system', content: 'System prompt' }, 10);
    manager.addMessage({ role: 'user', content: 'User 1' }, 100);
    manager.addMessage({ role: 'assistant', content: 'Asst 1' }, 100);
    manager.addMessage({ role: 'user', content: 'User 2' }, 100);

    const pruned = manager.pruneToFit(150);
    // Should keep system prompt + recent messages from end
    expect(pruned.some((m) => m.role === 'system')).toBe(true);
    expect(pruned[pruned.length - 1]!.content).toBe('User 2');
  });

  it('getContextSummary returns correct state', async () => {
    const manager = new ContextManager(1000, 500);
    await manager.addMessage({ role: 'user', content: 'hello' }, 10);
    await manager.addMessage({ role: 'assistant', content: 'hi there' }, 10);

    const summary = manager.getContextSummary();
    expect(summary.messageCount).toBe(2);
    expect(summary.tokenCount).toBe(20);
    expect(summary.usagePercent).toBeCloseTo(2, 0);
    expect(summary.isNearLimit).toBe(false);
    expect(summary.isAtLimit).toBe(false);
  });

  it('getContextSummary reflects near-limit state', async () => {
    const manager = new ContextManager(1000, 50);
    await manager.addMessage({ role: 'user', content: 'x' }, 60);

    const summary = manager.getContextSummary();
    expect(summary.isNearLimit).toBe(true);
    expect(summary.isAtLimit).toBe(false);
  });

  it('clear resets messages and token count', async () => {
    const manager = new ContextManager(1000, 500);
    await manager.addMessage({ role: 'user', content: 'hello' }, 20);
    manager.clear();

    const summary = manager.getContextSummary();
    expect(summary.messageCount).toBe(0);
    expect(summary.tokenCount).toBe(0);
  });

  it('updateTokenCount sets the count directly', async () => {
    const manager = new ContextManager(1000, 500);
    manager.updateTokenCount({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCostUsd: 0.001,
    });
    expect(manager.getTokenCount()).toBe(150);
  });
});
