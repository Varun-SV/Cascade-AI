import { describe, expect, it, vi } from 'vitest';
import { Cascade } from './cascade.js';
import type { CascadeConfig, ConversationMessage } from '../types.js';

const baseConfig: CascadeConfig = {
  version: '1.0',
  defaultIdentityId: 'default',
  providers: [],
  models: {},
  tools: {
    shellAllowlist: [],
    shellBlocklist: [],
    requireApprovalFor: [],
    browserEnabled: false,
  },
  hooks: {},
  dashboard: {
    port: 4891,
    auth: false,
    teamMode: 'single',
  },
  telemetry: {
    enabled: false,
  },
  memory: {
    maxSessionMessages: 1000,
    autoSummarizeAt: 150000,
    retentionDays: 90,
  },
  theme: 'cascade',
  workspace: {
    cascadeMdPath: 'CASCADE.md',
    configPath: '.cascade/config.json',
    keystorePath: '.cascade/keystore.enc',
    auditLogPath: '.cascade/audit.log',
  },
};

describe('Cascade routing complexity', () => {
  it('passes recent conversation context into complexity routing', async () => {
    const cascade = new Cascade(baseConfig);
    const generate = vi.fn().mockResolvedValue({
      content: 'Complex',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      finishReason: 'stop',
    });

    (cascade as any).router = { generate };

    const history: ConversationMessage[] = [
      { role: 'assistant', content: 'I can do a deep multi-agent research pass and generate a verified PDF report.' },
      { role: 'user', content: 'Sounds good.' },
    ];

    const complexity = await (cascade as any).determineComplexity('proceed', history);
    const routedPrompt = generate.mock.calls[0]?.[1]?.messages?.[0]?.content as string;

    expect(complexity).toBe('Complex');
    expect(routedPrompt).toContain('Recent conversation:');
    expect(routedPrompt).toContain('I can do a deep multi-agent research pass');
    expect(routedPrompt).toContain('Latest user message:\nproceed');
  });
});
