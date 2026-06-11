// ─────────────────────────────────────────────
//  Cascade AI — JWT Auth
// ─────────────────────────────────────────────

import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

export interface DashboardUser {
  id: string;
  username: string;
  role: 'admin' | 'viewer';
}

// Pin the signing algorithm so a forged token cannot downgrade to `alg: none`
// or trick verification into using an unexpected algorithm.
const JWT_ALGORITHM = 'HS256' as const;

export function createToken(user: DashboardUser, secret: string): string {
  return jwt.sign(user, secret, { expiresIn: '24h', algorithm: JWT_ALGORITHM });
}

export function verifyToken(token: string, secret: string): DashboardUser | null {
  try {
    return jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] }) as DashboardUser;
  } catch {
    return null;
  }
}

export function authMiddleware(secret: string, required = true) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      if (!required) { (req as Request & { user?: DashboardUser }).user = undefined; next(); return; }
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = verifyToken(token, secret);
    if (!user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    (req as Request & { user: DashboardUser }).user = user;
    next();
  };
}
