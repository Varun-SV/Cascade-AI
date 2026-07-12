// ─────────────────────────────────────────────
//  Cascade Cloud Server — Session Cookie
// ─────────────────────────────────────────────

import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

export const SESSION_COOKIE_NAME = 'cascade_cloud_session';

// Pinned for the same reason as src/dashboard/auth.ts: a forged token must
// not be able to downgrade the verification algorithm.
const JWT_ALGORITHM = 'HS256' as const;
const SESSION_TTL = '30d';

export interface CloudSession {
  userId: string;
}

export function createSessionToken(session: CloudSession, secret: string): string {
  return jwt.sign(session, secret, { expiresIn: SESSION_TTL, algorithm: JWT_ALGORITHM });
}

export function verifySessionToken(token: string, secret: string): CloudSession | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] }) as CloudSession;
    if (!decoded || typeof decoded.userId !== 'string') return null;
    return { userId: decoded.userId };
  } catch {
    return null;
  }
}

/** Minimal Cookie-header parser — avoids pulling in cookie-parser for one cookie. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}

export interface AuthedRequest extends Request {
  session?: CloudSession;
}

export function sessionMiddleware(secret: string, required = true) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];

    const session = token ? verifySessionToken(token, secret) : null;
    if (!session) {
      if (!required) { req.session = undefined; next(); return; }
      res.status(401).json({ error: 'Not signed in' });
      return;
    }

    req.session = session;
    next();
  };
}
