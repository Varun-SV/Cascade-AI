import { describe, it, expect } from 'vitest';
import { summarizeApproval } from './ApprovalPrompt.js';
import { assessRisk } from '../../../core/permissions/risk.js';
import type { ApprovalRequest } from '../../../types.js';

const req = (toolName: string, input: Record<string, unknown>): ApprovalRequest & { escalationContext: unknown } => ({
  id: 'r', tierId: 'T3-abc', toolName, input, description: 'd', isDangerous: true,
  risk: assessRisk(toolName, input, '/proj'),
  escalationContext: { subtaskContext: 'CLI & verification' },
});

describe('the approval card says who, what, why, and what /undo can do', () => {
  it('a delete: can be put back', () => {
    const s = summarizeApproval(req('shell', { command: 'rm -r build/' }));
    expect(s.who).toBe('T3 · CLI & verification');
    expect(s.verb).toBe('wants to run');
    expect(s.what).toBe('rm -r build/');
    expect(s.why).toBe('deletes build/');
    expect(s.undo).toMatch(/\/undo can put back/);
    expect(s.always).toBe('allow "deletes files" for this run');
  });
  it('a push: cannot be taken back', () => {
    const s = summarizeApproval(req('git', { operation: 'push', args: ['origin', 'main'] }));
    expect(s.what).toBe('git push origin main');
    expect(s.why).toMatch(/sends something off this computer/);
    expect(s.undo).toBe("/undo can't take this back");
  });
  it('without a risk, it falls back to the description', () => {
    const s = summarizeApproval({ id: 'r', tierId: 'MCP', toolName: 'mcp::x', input: { command: 'npx x' }, description: 'Spawn MCP server', isDangerous: true });
    expect(s.why).toBe('Spawn MCP server');
    expect(s.undo).toBe('');
  });
});
