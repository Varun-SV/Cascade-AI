// ─────────────────────────────────────────────
//  Cascade AI — Sign in with ChatGPT: typed errors
// ─────────────────────────────────────────────

import { MANAGE_USAGE_URL } from './constants.js';

export type ChatGptAuthErrorKind =
  /** The user declined consent in the browser. */
  | 'access_denied'
  /** The callback was not the one this attempt is waiting for (state mismatch, wrong client, missing code). */
  | 'invalid_callback'
  /** The token endpoint refused the code or the ID token failed validation. */
  | 'invalid_response'
  /** The tokens are unusable: sign in again. */
  | 'sign_in_required'
  /** Network failure or a 5xx: nothing was erased, try again. */
  | 'transient'
  /** invalid_client: the registration itself is wrong. */
  | 'invalid_client'
  | 'timeout'
  | 'cancelled'
  | 'no_account';

export class ChatGptAuthError extends Error {
  constructor(message: string, readonly kind: ChatGptAuthErrorKind, readonly status?: number) {
    super(message);
    this.name = 'ChatGptAuthError';
  }
}

/**
 * A failure of an inference or model-list request on the ChatGPT plan route.
 *
 * Carries the real HTTP status, code, param and request id, because the spec
 * asks that they are preserved. `kind` is what a caller decides on; the
 * message is written for the person using the app.
 */
export type ChatGptRequestErrorKind =
  | 'usage_limit'
  | 'not_eligible'
  | 'unsupported_capability'
  | 'route_not_supported'
  | 'invalid_user'
  | 'scope_not_authorized'
  | 'unavailable'
  | 'admission_unauthorized'
  | 'admission_forbidden'
  | 'admission_unavailable'
  | 'incomplete'
  | 'failed';

export class ChatGptRequestError extends Error {
  /** `error.code` from the response, when there was one. */
  readonly code?: string;
  readonly param?: string;
  readonly requestId?: string;
  readonly status?: number;
  readonly kind: ChatGptRequestErrorKind;
  /** Whether trying the SAME request again later can work. */
  readonly retryable: boolean;
  /** Where to send the user, when there is somewhere. */
  readonly manageUsageUrl?: string;

  constructor(
    message: string,
    init: {
      kind: ChatGptRequestErrorKind;
      status?: number;
      code?: string;
      param?: string;
      requestId?: string;
      retryable?: boolean;
      manageUsageUrl?: string;
    },
  ) {
    super(message);
    this.name = 'ChatGptRequestError';
    this.kind = init.kind;
    if (init.status !== undefined) this.status = init.status;
    if (init.code !== undefined) this.code = init.code;
    if (init.param !== undefined) this.param = init.param;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.manageUsageUrl !== undefined) this.manageUsageUrl = init.manageUsageUrl;
    this.retryable = init.retryable === true;
  }
}

/** The structured codes the spec lists (Errors and recovery), by what they mean. */
const CODE_KINDS: Record<string, ChatGptRequestErrorKind> = {
  subscription_sharing_usage_limit_exceeded: 'usage_limit',
  subscription_sharing_user_not_eligible: 'not_eligible',
  subscription_sharing_usage_unavailable: 'unavailable',
  subscription_sharing_unsupported_capability: 'unsupported_capability',
  subscription_sharing_route_not_supported: 'route_not_supported',
  subscription_sharing_invalid_user: 'invalid_user',
  subscription_sharing_user_unavailable: 'unavailable',
  chatpass_v2_scope_not_authorized: 'scope_not_authorized',
  chatpass_v2_invalid_authorization_context: 'scope_not_authorized',
};

export interface RequestFailure {
  status?: number;
  code?: string | undefined;
  param?: string | undefined;
  /** `error.message` or the `{detail}` text: diagnostic, never a stable code. */
  message?: string | undefined;
  requestId?: string | undefined;
}

/** Turn what the route returned into a clear, typed error. */
export function requestErrorFrom(f: RequestFailure): ChatGptRequestError {
  const base = {
    ...(f.status !== undefined ? { status: f.status } : {}),
    ...(f.code ? { code: f.code } : {}),
    ...(f.param ? { param: f.param } : {}),
    ...(f.requestId ? { requestId: f.requestId } : {}),
  };
  const rid = f.requestId ? ` (request ${f.requestId})` : '';
  const said = f.message ? ` ${f.message}` : '';
  const kind = f.code ? CODE_KINDS[f.code] : undefined;

  switch (kind) {
    case 'usage_limit':
      return new ChatGptRequestError(
        `ChatGPT plan usage limit reached. Open ${MANAGE_USAGE_URL} to review your plan or this app's limit. `
        + `Cascade did not switch to another billing path.${rid}`,
        { kind, ...base, manageUsageUrl: MANAGE_USAGE_URL },
      );
    case 'not_eligible':
      return new ChatGptRequestError(
        'ChatGPT plan usage is not available for this account, workspace or policy, so Cascade cannot use it. '
        + `Use another provider or an API key.${rid}`,
        { kind, ...base },
      );
    case 'unsupported_capability':
      return new ChatGptRequestError(
        `The ChatGPT plan route does not support part of this request${f.param ? ` (${f.param})` : ''}.${said}${rid}`,
        { kind, ...base },
      );
    case 'route_not_supported':
      return new ChatGptRequestError(
        `The ChatGPT plan route does not support this endpoint or method.${said}${rid}`, { kind, ...base },
      );
    case 'invalid_user':
      return new ChatGptRequestError(
        `ChatGPT could not validate the signed-in account. Sign in again: cascade chatgpt signin.${rid}`,
        { kind, ...base },
      );
    case 'scope_not_authorized':
      return new ChatGptRequestError(
        `This sign-in does not authorize ChatGPT plan usage. Sign in again and approve it: cascade chatgpt signin.${rid}`,
        { kind, ...base },
      );
    case 'unavailable':
      return new ChatGptRequestError(
        `ChatGPT plan usage could not be checked right now. Credentials are kept; try again shortly.${rid}`,
        { kind, ...base, retryable: true },
      );
    default:
  }

  // Direct-route admission failures arrive as {"detail": "..."} with no code.
  if (f.status === 401) {
    return new ChatGptRequestError(
      'ChatGPT did not accept this sign-in (HTTP 401). Check the selected account and that plan usage was approved; '
      + `if it persists, sign in again: cascade chatgpt signin.${said}${rid}`,
      { kind: 'admission_unauthorized', ...base },
    );
  }
  if (f.status === 403) {
    return new ChatGptRequestError(
      `ChatGPT plan usage is not permitted here (HTTP 403), for example because of the region this request came from.${said}${rid}`,
      { kind: 'admission_forbidden', ...base },
    );
  }
  if (f.status === 503) {
    return new ChatGptRequestError(
      `ChatGPT plan usage is temporarily unavailable (HTTP 503). Credentials are kept; try again shortly.${said}${rid}`,
      { kind: 'admission_unavailable', ...base, retryable: true },
    );
  }
  return new ChatGptRequestError(
    `ChatGPT plan request failed${f.status ? ` (HTTP ${f.status})` : ''}${f.code ? `, ${f.code}` : ''}.${said}${rid}`,
    { kind: 'failed', ...base },
  );
}
