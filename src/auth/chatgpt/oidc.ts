// ─────────────────────────────────────────────
//  Cascade AI — Sign in with ChatGPT: discovery and ID-token validation
// ─────────────────────────────────────────────

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { CHATGPT_DISCOVERY_URL, CHATGPT_ISSUER } from './constants.js';
import { ChatGptAuthError } from './errors.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Discovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  token_endpoint?: string;
  authorization_endpoint?: string;
}

const DISCOVERY_TTL_MS = 60 * 60_000;
let cached: { at: number; url: string; value: Discovery } | undefined;

/** OpenAI's OpenID configuration: the JWKS and the revocation endpoint come from here, not from constants. */
export async function fetchDiscovery(
  fetchImpl: FetchLike = fetch,
  url: string = CHATGPT_DISCOVERY_URL,
  now: () => number = Date.now,
): Promise<Discovery> {
  if (cached && cached.url === url && now() - cached.at < DISCOVERY_TTL_MS) return cached.value;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new ChatGptAuthError(`Could not reach OpenAI sign-in (${err instanceof Error ? err.message : String(err)}).`, 'transient');
  }
  if (!res.ok) {
    throw new ChatGptAuthError(`OpenAI sign-in configuration is unavailable (HTTP ${res.status}).`, res.status >= 500 ? 'transient' : 'invalid_response', res.status);
  }
  const body = (await res.json().catch(() => null)) as Partial<Discovery> | null;
  if (!body || typeof body.jwks_uri !== 'string' || typeof body.issuer !== 'string') {
    throw new ChatGptAuthError('OpenAI sign-in configuration was not understood.', 'invalid_response');
  }
  const value: Discovery = {
    issuer: body.issuer,
    jwks_uri: body.jwks_uri,
    ...(typeof body.revocation_endpoint === 'string' ? { revocation_endpoint: body.revocation_endpoint } : {}),
    ...(typeof body.token_endpoint === 'string' ? { token_endpoint: body.token_endpoint } : {}),
    ...(typeof body.authorization_endpoint === 'string' ? { authorization_endpoint: body.authorization_endpoint } : {}),
  };
  cached = { at: now(), url, value };
  return value;
}

/** For tests. */
export function resetDiscoveryCache(): void {
  cached = undefined;
}

export interface VerifiedIdToken {
  subject: string;
  email: string;
  issuer: string;
}

export interface IdTokenCheck {
  idToken: string;
  /** The issued client ID: the token's audience. */
  clientId: string;
  /** The nonce this attempt sent. Omitted only when checking a refresh response's token. */
  nonce?: string;
  /** Key resolver; defaults to OpenAI's JWKS (from discovery). Injected by tests. */
  jwks?: JWTVerifyGetKey;
  issuer?: string;
  fetch?: FetchLike;
  /** Seconds of clock skew allowed on exp/iat. */
  clockToleranceSec?: number;
  now?: () => number;
}

/**
 * Validate an ID token the way the spec requires: signature against OpenAI's
 * published JWKS, issuer, audience equal to the issued client ID, expiry, and
 * the nonce saved for this attempt. A valid token alone authorizes nothing;
 * the caller still checks the granted scopes.
 *
 * jose does the verification; only asymmetric algorithms are accepted, so a
 * token cannot be "verified" with an HMAC key or `alg: none`.
 */
export async function validateIdToken(c: IdTokenCheck): Promise<VerifiedIdToken> {
  const issuer = c.issuer ?? CHATGPT_ISSUER;
  let jwks = c.jwks;
  if (!jwks) {
    const d = await fetchDiscovery(c.fetch);
    const f = c.fetch;
    jwks = createRemoteJWKSet(new URL(d.jwks_uri), f ? { [customFetch]: f as typeof fetch } : {});
  }
  try {
    const { payload } = await jwtVerify(c.idToken, jwks, {
      issuer,
      audience: c.clientId,
      algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'],
      clockTolerance: c.clockToleranceSec ?? 60,
      ...(c.now ? { currentDate: new Date(c.now()) } : {}),
      requiredClaims: ['exp', 'sub'],
    });
    if (c.nonce !== undefined && payload['nonce'] !== c.nonce) {
      throw new ChatGptAuthError('The sign-in response did not match this request (nonce).', 'invalid_response');
    }
    const subject = String(payload.sub);
    const email = typeof payload['email'] === 'string' ? payload['email'] : '';
    return { subject, email, issuer };
  } catch (err) {
    if (err instanceof ChatGptAuthError) throw err;
    const code = (err as { code?: string }).code;
    // Network trouble fetching the key set is transient; anything else is a rejected token.
    if (code === 'ERR_JWKS_TIMEOUT') throw new ChatGptAuthError('Could not fetch OpenAI signing keys. Try again.', 'transient');
    throw new ChatGptAuthError(`The ID token was not accepted (${code ?? (err instanceof Error ? err.name : 'invalid')}).`, 'invalid_response');
  }
}

/** The claims of a JWT, WITHOUT verifying it. Only ever used for display or a scope fallback. */
export function unverifiedClaims(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}
