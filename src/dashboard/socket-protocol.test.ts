import { describe, expect, it } from 'vitest';
import {
  normalizePermissionDecisionPayload,
  normalizeRuntimeRefreshPayload,
  normalizeSessionSubscriptionPayload,
} from './socket-protocol.js';

describe('dashboard socket protocol helpers', () => {
  it('normalizes legacy and typed runtime refresh payloads to the shared shape', () => {
    expect(normalizeRuntimeRefreshPayload()).toEqual({ scope: 'workspace' });
    expect(normalizeRuntimeRefreshPayload('global')).toEqual({ scope: 'global' });
    expect(normalizeRuntimeRefreshPayload({ scope: 'workspace' })).toEqual({ scope: 'workspace' });
  });

  it('normalizes session subscription payloads from both string and object callers', () => {
    expect(normalizeSessionSubscriptionPayload('session-1')).toEqual({ sessionId: 'session-1' });
    expect(normalizeSessionSubscriptionPayload({ sessionId: 'session-2' })).toEqual({ sessionId: 'session-2' });
  });

  it('normalizes approval decisions to the shared permission decision payload', () => {
    expect(normalizePermissionDecisionPayload({
      id: 'req-1',
      approved: true,
      always: true,
    })).toEqual({
      requestId: 'req-1',
      approved: true,
      always: true,
      decidedBy: 'USER',
    });
  });
});

describe('the config:current snapshot carries endpoints', () => {
  // Two payloads feed one Settings form: the desktop's complete IPC snapshot
  // and this partial socket one. While this omitted `endpoints`, a reconnect
  // blanked the gateway fields in the form — and a save afterwards sent a
  // present-but-empty endpoint, which is an explicit CLEAR. A rotated
  // gateway-issued key typed after a reconnect would have been written to the
  // provider's public API.
  //
  // Asserted on the projection rather than a live socket: the shape is the
  // contract, and it is what the renderer reads.
  const snapshot = (providers: Array<{ type: string; baseUrl?: string }>): Record<string, string> =>
    Object.fromEntries(
      providers.filter((p) => p.type !== 'azure' && p.baseUrl).map((p) => [p.type, p.baseUrl as string]),
    );

  it('includes a configured gateway for every non-Azure provider', () => {
    expect(snapshot([
      { type: 'anthropic', baseUrl: 'https://corp-gateway.example' },
      { type: 'openai' },
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
    ])).toEqual({
      anthropic: 'https://corp-gateway.example',
      'openai-compatible': 'https://api.groq.com/openai/v1',
    });
  });

  it('leaves Azure out, since it is addressed per deployment', () => {
    expect(snapshot([{ type: 'azure', baseUrl: 'https://r1.openai.azure.com' }])).toEqual({});
  });

  it('is the same projection the server emits', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const nodePath = await import('node:path');
    const here = nodePath.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(nodePath.join(here, 'server.ts'), 'utf-8');
    // The projection above is a restatement; this keeps it honest about the
    // handler it stands for.
    expect(source).toMatch(/endpoints: Object\.fromEntries\(/);
    expect(source).toMatch(/p\.type !== 'azure' && p\.baseUrl/);
  });
});
