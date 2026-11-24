import type {
  ApprovalResponse,
  PeerMessageEvent,
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

/**
 * A worker's peer message, stamped with the session the server is running.
 * The SDK only knows a session id when the caller passes one in, so the event
 * can arrive with an empty id and be sent to a room nobody joined.
 */
export function peerEventForSession(sessionId: string, e: unknown): PeerMessageEvent {
  return { ...(e as PeerMessageEvent), sessionId };
}
