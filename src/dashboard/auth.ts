// ─────────────────────────────────────────────
//  Cascade AI — JWT Auth
// ─────────────────────────────────────────────

import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

export interface DashboardUser {
  id: string;
  username: string;
  role: 'admin' | 'viewer';
  tenantId?: string;   // For multi-tenant mode
}

export function createToken(user: DashboardUser, secret: string): string {
  return jwt.sign(user, secret, { expiresIn: '24h' });
}

export function verifyToken(token: string, secret: string): DashboardUser | null {
  try {
    return jwt.verify(token, secret) as DashboardUser;
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
