// ─────────────────────────────────────────────
//  Cascade Cloud Server — Express App
// ─────────────────────────────────────────────

import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import type { CloudEnv } from './env.js';
import type { CloudStore, OAuthProvider } from './db.js';
import {
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  parseCookies,
  type AuthedRequest,
} from './auth/session.js';
import { githubAuthUrl, exchangeGithubCode, googleAuthUrl, exchangeGoogleCode, type OAuthProfile } from './auth/oauth.js';

const OAUTH_STATE_COOKIE = 'cascade_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function createApp(env: CloudEnv, store: CloudStore) {
  const app = express();
  app.use(express.json());

  const secure = env.OAUTH_REDIRECT_BASE_URL.startsWith('https://');

  // Only the configured web origin may read cross-site responses, and only
  // that origin's requests carry the session cookie — cloud/web and
  // cloud/server run on different ports in dev, same origin in prod.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', env.WEB_ORIGIN);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Public, non-sensitive — lets the SPA decide which login buttons to show
  // without hardcoding provider availability at build time.
  app.get('/api/config', (_req, res) => {
    res.json({
      githubEnabled: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      devLoginEnabled: env.CLOUD_DEV_BYPASS,
    });
  });

  // Brute-force / abuse protection on unauthenticated entry points — OAuth
  // starts and callbacks and the dev-login shortcut all take unauthenticated
  // requests from the open internet.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many auth attempts. Try again in 15 minutes.' },
  });
  app.use('/auth', authLimiter);

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Slow down.' },
  });
  app.use('/api', apiLimiter);

  function finishLogin(res: express.Response, profile: OAuthProfile, provider: OAuthProvider) {
    const user = store.upsertUser({
      provider,
      providerId: profile.providerId,
      email: profile.email,
      name: profile.name,
      avatar: profile.avatar,
    });
    const token = createSessionToken({ userId: user.id }, env.SESSION_SECRET);
    setSessionCookie(res, token, secure);
    return user;
  }

  function beginOAuth(res: express.Response, buildUrl: (state: string) => string) {
    const state = randomBytes(16).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: OAUTH_STATE_TTL_MS,
      path: '/',
    });
    res.redirect(buildUrl(state));
  }

  function verifyOAuthState(req: express.Request): { code: string } | null {
    const code = req.query['code'];
    const state = req.query['state'];
    if (typeof code !== 'string' || typeof state !== 'string') return null;
    const cookies = parseCookies(req.headers.cookie);
    const expected = cookies[OAUTH_STATE_COOKIE];
    if (!expected || expected !== state) return null;
    return { code };
  }

  // ── GitHub ──────────────────────────────────

  app.get('/auth/github', (_req, res) => {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      res.status(503).json({ error: 'GitHub OAuth is not configured' });
      return;
    }
    beginOAuth(res, (state) => githubAuthUrl(state, env));
  });

  app.get('/auth/github/callback', async (req, res) => {
    const verified = verifyOAuthState(req);
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
    if (!verified) { res.status(400).send('Invalid or expired OAuth state'); return; }
    try {
      const profile = await exchangeGithubCode(verified.code, env);
      finishLogin(res, profile, 'github');
      res.redirect(env.WEB_ORIGIN);
    } catch (err) {
      res.status(502).send(`GitHub login failed: ${(err as Error).message}`);
    }
  });

  // ── Google ──────────────────────────────────

  app.get('/auth/google', (_req, res) => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      res.status(503).json({ error: 'Google OAuth is not configured' });
      return;
    }
    beginOAuth(res, (state) => googleAuthUrl(state, env));
  });

  app.get('/auth/google/callback', async (req, res) => {
    const verified = verifyOAuthState(req);
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
    if (!verified) { res.status(400).send('Invalid or expired OAuth state'); return; }
    try {
      const profile = await exchangeGoogleCode(verified.code, env);
      finishLogin(res, profile, 'google');
      res.redirect(env.WEB_ORIGIN);
    } catch (err) {
      res.status(502).send(`Google login failed: ${(err as Error).message}`);
    }
  });

  // ── Dev bypass ────────────────────────────────
  // Local-only shortcut so the chat flow can be built/tested without real
  // OAuth apps configured. Off unless CLOUD_DEV_BYPASS is explicitly set.
  if (env.CLOUD_DEV_BYPASS) {
    app.post('/auth/dev-login', (req, res) => {
      const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : 'Dev User';
      const user = finishLogin(
        res,
        { providerId: `dev-${name}`, email: `${name.toLowerCase().replace(/\s+/g, '-')}@dev.local`, name, avatar: null },
        'dev',
      );
      res.json({ user });
    });
  }

  app.post('/auth/logout', (_req, res) => {
    clearSessionCookie(res, secure);
    res.json({ ok: true });
  });

  app.get('/api/me', sessionMiddleware(env.SESSION_SECRET, false), (req: AuthedRequest, res) => {
    if (!req.session) { res.json({ user: null }); return; }
    const user = store.getUserById(req.session.userId);
    res.json({ user });
  });

  app.get('/api/conversations', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const conversations = store.listConversations(req.session!.userId);
    res.json({ conversations });
  });

  app.get('/api/conversations/:id/messages', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid conversation id' }); return; }
    const conversation = store.getConversation(id, req.session!.userId);
    if (!conversation) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ messages: store.getMessages(conversation.id) });
  });

  return app;
}
