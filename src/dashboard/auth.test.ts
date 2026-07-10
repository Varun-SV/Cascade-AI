import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authMiddleware, createToken } from './auth.js';

const SECRET = 'test-secret';

function run(middleware: ReturnType<typeof authMiddleware>, authHeader?: string) {
  const req = { headers: authHeader ? { authorization: authHeader } : {} } as Request;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  middleware(req, res, next);
  return { req: req as Request & { user?: unknown }, status, json, next };
}

describe('authMiddleware', () => {
  it('rejects a missing token when auth is required', () => {
    const { status, next } = run(authMiddleware(SECRET, true));
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an invalid token when auth is required', () => {
    const { status, next } = run(authMiddleware(SECRET, true), 'Bearer not-a-jwt');
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a valid token when auth is required', () => {
    const token = createToken({ id: 'u', username: 'u', role: 'admin' }, SECRET);
    const { req, next, status } = run(authMiddleware(SECRET, true), `Bearer ${token}`);
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect((req.user as { username: string }).username).toBe('u');
  });

  it('passes with no token when auth is disabled', () => {
    const { next, status } = run(authMiddleware(SECRET, false));
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('passes a NON-JWT token as anonymous when auth is disabled (desktop app case)', () => {
    // The desktop renderer always sends its Electron session token, which is
    // a random hex string, not a JWT. With auth off this must not 401.
    const { req, next, status } = run(authMiddleware(SECRET, false), 'Bearer 3f9a1c…random-hex');
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('still attaches the user for a valid token when auth is disabled', () => {
    const token = createToken({ id: 'u2', username: 'u2', role: 'viewer' }, SECRET);
    const { req, next } = run(authMiddleware(SECRET, false), `Bearer ${token}`);
    expect(next).toHaveBeenCalled();
    expect((req.user as { username: string }).username).toBe('u2');
  });
});
