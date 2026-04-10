import type {
  ApprovalResponse,
  PermissionDecisionPayload,
  RuntimeRefreshPayload,
  RuntimeScope,
  SessionSubscriptionPayload,
} from '../types.js';

export function normalizeRuntimeRefreshPayload(
  payload?: RuntimeRefreshPayload | RuntimeScope,
): RuntimeRefreshPayload {
  if (payload === 'workspace' || payload === 'global') {
    return { scope: payload };
  }
  return { scope: payload?.scope ?? 'workspace' };
}

export function normalizeSessionSubscriptionPayload(
  payload: SessionSubscriptionPayload | string,
): SessionSubscriptionPayload {
  return typeof payload === 'string' ? { sessionId: payload } : payload;
}

export function normalizePermissionDecisionPayload(
  payload: PermissionDecisionPayload | ApprovalResponse,
): PermissionDecisionPayload {
  if ('requestId' in payload) return payload;
  return {
    requestId: payload.id,
    approved: payload.approved,
    always: payload.always,
    decidedBy: 'USER',
  };
}
