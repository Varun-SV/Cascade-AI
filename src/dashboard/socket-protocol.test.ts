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
