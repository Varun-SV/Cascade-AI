// ─────────────────────────────────────────────
//  Cascade Cloud Server — Express App
// ─────────────────────────────────────────────

import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CloudEnv } from './env.js';
import type { CloudStore, OAuthProvider } from './db.js';
import {
  createSessionToken,
  createNativeAccessToken,
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  parseCookies,
  type AuthedRequest,
} from './auth/session.js';
import { NativeAuthStore, isLoopbackRedirect, hashRefreshToken } from './native-auth.js';
import { githubAuthUrl, exchangeGithubCode, googleAuthUrl, exchangeGoogleCode, type OAuthProfile } from './auth/oauth.js';
import { limitsForPlan, todayKey, checkStorageQuota } from './entitlements.js';
import { skillCatalog } from './skills.js';
import { renderDocsPage } from './docs.js';
import { tenantScratchDir } from './paths.js';
import {
  billingConfig, makeRazorpay, createSubscription, cancelSubscription,
  verifyWebhookSignature, planForStatus, subscriptionFromWebhook,
} from './billing.js';
import { HandoffStore, parseHandoffBody } from './handoff.js';
import { MAX_DOCUMENT_BYTES, parseDocument, resolveDocumentMime } from './documents.js';
import { connectorCatalog, getConnector, validateRemoteMcpUrl } from './mcp.js';
import { McpOAuthFlows, encodeOAuthBlob } from './mcp-oauth.js';
import {
  BrokerFlows, getBrokerProvider, brokerConfigured, brokeredConnectorIds,
  brokerAuthorizeUrl, brokerExchangeCode,
} from './connect-broker.js';

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_MEMORY_LEN = 2000;
const MAX_MEMORY_CATEGORY_LEN = 32;
const MAX_TITLE_LEN = 120;
/** Upper bound on a persisted message (well above any real turn; a light DoS rail). */
const MAX_MESSAGE_LEN = 500_000;
const MAX_SKILL_NAME_LEN = 60;
const MAX_SKILL_DESC_LEN = 200;
const MAX_SKILL_PROMPT_LEN = 8000;
// A generous ceiling so one account can't fill the shared DB with presets.
const MAX_SKILLS_PER_USER = 50;

/** Reads + trims an optional short category, or null when blank/oversized/absent. */
function parseCategory(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, MAX_MEMORY_CATEGORY_LEN);
  return trimmed ? trimmed : null;
}

/** Shapes a stored custom skill into the same wire shape as the /api/skills catalog. */
function customSkillView(s: { id: string; name: string; description: string; usageCount: number; systemPrompt: string }) {
  return { id: s.id, name: s.name, description: s.description, custom: true as const, usageCount: s.usageCount, systemPrompt: s.systemPrompt };
}

/** Validates a custom-skill create/update body into a normalized shape. */
function parseSkillBody(
  body: unknown,
): { name: string; description: string; systemPrompt: string } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
  const description = typeof b['description'] === 'string' ? b['description'].trim() : '';
  const systemPrompt = typeof b['systemPrompt'] === 'string' ? b['systemPrompt'].trim() : '';
  if (!name) return { error: 'Skill name is required' };
  if (name.length > MAX_SKILL_NAME_LEN) return { error: `Name must be ≤ ${MAX_SKILL_NAME_LEN} characters` };
  if (description.length > MAX_SKILL_DESC_LEN) return { error: `Description must be ≤ ${MAX_SKILL_DESC_LEN} characters` };
  if (!systemPrompt) return { error: 'Skill instructions are required' };
  if (systemPrompt.length > MAX_SKILL_PROMPT_LEN) return { error: `Instructions must be ≤ ${MAX_SKILL_PROMPT_LEN} characters` };
  return { name, description, systemPrompt };
}

const OAUTH_STATE_COOKIE = 'cascade_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Self-contained HTML for the device-approval page. No external resources
 *  (CSP-safe); the form calls the approve API with the session cookie. */
function renderActivatePage(authed: boolean, webOrigin: string, prefill: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const body = authed
    ? `<form id="f"><label for="c">Device code</label>
         <input id="c" name="user_code" autocomplete="off" spellcheck="false" value="${esc(prefill)}" placeholder="WXYZ-1234" />
         <button type="submit">Approve device</button></form>
       <p id="msg" role="status"></p>
       <script>
         var f=document.getElementById('f'),m=document.getElementById('msg');
         f.addEventListener('submit',async function(e){e.preventDefault();m.textContent='Approving…';
           try{var r=await fetch('/api/native/device/approve',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_code:document.getElementById('c').value})});
             var j=await r.json(); m.textContent=r.ok&&j.ok?'✓ Approved — return to your terminal or app.':'That code is invalid or expired.'; if(r.ok&&j.ok){f.querySelector('button').disabled=true;}}
           catch(_){m.textContent='Something went wrong. Try again.';}});
       </script>`
    : `<p>Sign in first, then reopen this page to approve your device.</p>
       <p><a class="btn" href="${esc(webOrigin)}">Sign in to Cascade</a></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/><title>Activate a device · Cascade</title>
    <style>
      :root{color-scheme:light dark}
      body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f13;color:#e7e7ea;font:16px/1.5 -apple-system,Segoe UI,Roboto,system-ui,sans-serif}
      .card{width:min(92vw,420px);background:#17181d;border:1px solid #2a2c33;border-radius:16px;padding:28px}
      h1{font-size:1.2rem;margin:0 0 6px} p{color:#a9abb3}
      label{display:block;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#8b8d95;margin:14px 0 6px}
      input{width:100%;box-sizing:border-box;font:1.1rem ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;padding:12px 14px;border-radius:10px;border:1px solid #33353d;background:#0e0f13;color:#fff}
      button,.btn{margin-top:16px;display:inline-block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;padding:12px 14px;border:0;border-radius:10px;background:#c98a2a;color:#151006;font-weight:700;cursor:pointer}
      button:disabled{opacity:.5;cursor:default}
    </style></head>
    <body><main class="card"><h1>Activate a device</h1>
      <p>Enter the code shown in your terminal or desktop app to sign it in.</p>${body}</main></body></html>`;
}

export function createApp(env: CloudEnv, store: CloudStore) {
  const app = express();
  // Behind Railway (and most PaaS) the app sits behind exactly one reverse
  // proxy that sets X-Forwarded-For. Without trusting it, express-rate-limit
  // THROWS ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request (it refuses to
  // key limits off a spoofable header), which surfaced as 500s in production.
  // Trust exactly one hop — `true` would trust a client-supplied XFF and let
  // anyone forge their rate-limit identity.
  app.set('trust proxy', 1);
  // Image/document uploads carry a base64 payload larger than a normal API
  // body, so they get their own bigger parser on the route; every other
  // endpoint keeps the tight default limit. 16mb covers a 10 MB document once
  // base64 inflation (~33%) is accounted for — the per-file byte cap in the
  // handler is the real guard.
  const uploadJson = express.json({ limit: '16mb' });
  // The Razorpay webhook signature is an HMAC of the RAW request body, so that
  // route needs the unparsed bytes — capture them and skip the JSON parser.
  const webhookRaw = express.raw({ type: '*/*', limit: '1mb' });
  // Routes that accept large bodies (file saves, chat/memory imports) run their
  // own 16mb parser; keep them off the tight 100kb default.
  const rawBodyRoutes = new Set(['/api/uploads', '/api/billing/webhook', '/api/files', '/api/memories/import']);
  app.use((req, res, next) => {
    if (rawBodyRoutes.has(req.path)) { next(); return; }
    express.json()(req, res, next);
  });

  const secure = env.OAUTH_REDIRECT_BASE_URL.startsWith('https://');

  // Only the configured web origin may read cross-site responses, and only
  // that origin's requests carry the session cookie — cloud/web and
  // cloud/server run on different ports in dev, same origin in prod.
  app.use((req, res, next) => {
    // The handoff courier is reached cross-origin from the KEYLESS desktop app,
    // which carries no session cookie — so those routes advertise an open,
    // NON-credentialed CORS policy (the code in the URL is the only bearer
    // secret). Every other route stays pinned to the configured web origin and
    // allows credentials, so the session cookie only ever travels there.
    if (req.path.startsWith('/api/handoff')) {
      res.header('Access-Control-Allow-Origin', '*');
    } else {
      res.header('Access-Control-Allow-Origin', env.WEB_ORIGIN);
      res.header('Access-Control-Allow-Credentials', 'true');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Public, non-sensitive — lets the SPA decide which login buttons to show
  // without hardcoding provider availability at build time. googleClientId
  // is not a secret (only GOOGLE_CLIENT_SECRET is) — the SPA needs it to run
  // its own client-side Drive appData consent flow (see task #28).
  app.get('/api/config', (_req, res) => {
    res.json({
      githubEnabled: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      googleClientId: env.GOOGLE_CLIENT_ID ?? null,
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

  // ── Native (desktop/CLI) auth broker ─────────
  // Desktop/CLI sign in against this server (which holds the provider secrets)
  // — never against Google/GitHub directly — so no OAuth secret ships in a
  // native app. Loopback flow for the desktop, device-code flow for the CLI.
  // See docs/native-auth.md.
  const nativeStore = new NativeAuthStore();
  const NATIVE_REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

  function issueNativeTokens(userId: string) {
    const accessToken = createNativeAccessToken(userId, env.SESSION_SECRET);
    const refreshRaw = randomBytes(32).toString('base64url');
    store.addRefreshToken({ userId, tokenHash: hashRefreshToken(refreshRaw), expiresAt: Date.now() + NATIVE_REFRESH_TTL_MS });
    return { access_token: accessToken, refresh_token: refreshRaw, token_type: 'Bearer', expires_in: 3600 };
  }

  // Called from the shared OAuth callbacks: if the flow was a native loopback
  // sign-in (a pending record keyed by the validated state), mint a one-time
  // code and 302 it to the desktop's loopback listener. Returns true when it
  // handled the response, so the web branch is skipped.
  function completeNativeIfPending(
    req: express.Request, res: express.Response, profile: OAuthProfile, provider: OAuthProvider,
  ): boolean {
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    const native = state ? nativeStore.consumePendingLoopback(state) : null;
    if (!native) return false;
    const user = store.upsertUser({
      provider, providerId: profile.providerId, email: profile.email, name: profile.name, avatar: profile.avatar,
    });
    const code = nativeStore.createLoopbackCode({ userId: user.id, challenge: native.challenge, redirect: native.redirect });
    const url = new URL(native.redirect);
    url.searchParams.set('code', code);
    if (native.appState) url.searchParams.set('state', native.appState);
    res.redirect(url.toString());
    return true;
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
      if (completeNativeIfPending(req, res, profile, 'github')) return;
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
      if (completeNativeIfPending(req, res, profile, 'google')) return;
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

  // ── Native auth routes ───────────────────────

  // Loopback flow — start. The desktop opens this in the system browser with a
  // loopback redirect + PKCE challenge; we run the normal web OAuth, then the
  // shared callback 302s a one-time code back to the loopback listener.
  app.get('/auth/native/:provider', (req, res) => {
    const provider = req.params['provider'];
    const redirect = String(req.query['redirect_uri'] ?? '');
    const challenge = String(req.query['code_challenge'] ?? '');
    const appState = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    // Validate the request shape before checking server config, so a malformed
    // native request is a clear 400 regardless of which providers are set up.
    if (provider !== 'github' && provider !== 'google') { res.status(400).json({ error: 'Unknown provider' }); return; }
    if (!isLoopbackRedirect(redirect)) { res.status(400).json({ error: 'redirect_uri must be a http loopback address (127.0.0.1 / localhost)' }); return; }
    if (!challenge) { res.status(400).json({ error: 'code_challenge (PKCE) is required' }); return; }
    if (provider === 'github' && (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)) { res.status(503).json({ error: 'GitHub OAuth is not configured' }); return; }
    if (provider === 'google' && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) { res.status(503).json({ error: 'Google OAuth is not configured' }); return; }

    const oauthState = randomBytes(16).toString('hex');
    nativeStore.createPendingLoopback(oauthState, { challenge, redirect, appState });
    res.cookie(OAUTH_STATE_COOKIE, oauthState, { httpOnly: true, secure, sameSite: 'lax', maxAge: OAUTH_STATE_TTL_MS, path: '/' });
    res.redirect(provider === 'github' ? githubAuthUrl(oauthState, env) : googleAuthUrl(oauthState, env));
  });

  // Loopback flow — redeem. The desktop posts the one-time code + PKCE verifier.
  app.post('/api/native/token', (req: AuthedRequest, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const verifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : '';
    const result = nativeStore.consumeLoopbackCode(code, verifier);
    if (!result) { res.status(400).json({ error: 'invalid_grant' }); return; }
    res.json(issueNativeTokens(result.userId));
  });

  // Device flow — start (CLI).
  app.post('/api/native/device', (_req, res) => {
    const d = nativeStore.createDevice();
    res.json({
      device_code: d.deviceCode,
      user_code: d.userCode,
      verification_uri: `${env.OAUTH_REDIRECT_BASE_URL}/activate`,
      expires_in: d.expiresIn,
      interval: d.interval,
    });
  });

  // Device flow — poll (CLI). Standard device-grant responses.
  app.post('/api/native/device/token', (req, res) => {
    const deviceCode = typeof req.body?.device_code === 'string' ? req.body.device_code : '';
    const poll = nativeStore.pollDevice(deviceCode);
    if (poll.status === 'approved') { res.json(issueNativeTokens(poll.userId)); return; }
    if (poll.status === 'slow_down') { res.status(429).json({ error: 'slow_down' }); return; }
    if (poll.status === 'pending') { res.status(428).json({ error: 'authorization_pending' }); return; }
    res.status(400).json({ error: 'expired_token' });
  });

  // Device flow — approve. Called by the /activate page; must be web-signed-in
  // so the approval binds to a real user.
  app.post('/api/native/device/approve', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const userCode = typeof req.body?.user_code === 'string' ? req.body.user_code : '';
    if (!userCode) { res.status(400).json({ error: 'user_code required' }); return; }
    const ok = nativeStore.approveDevice(userCode, req.session!.userId);
    res.status(ok ? 200 : 400).json({ ok });
  });

  // The page a user opens to approve a device. Self-contained; no external
  // resources. Requires a web session to actually approve.
  app.get('/activate', sessionMiddleware(env.SESSION_SECRET, false), (req: AuthedRequest, res) => {
    const prefill = typeof req.query['code'] === 'string' ? req.query['code'].replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) : '';
    res.type('html').send(renderActivatePage(!!req.session, env.WEB_ORIGIN, prefill));
  });

  // Rotate a refresh token → fresh access (+ refresh). Old token is single-use.
  app.post('/api/native/refresh', (req, res) => {
    const token = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
    const result = token ? store.consumeRefreshToken(hashRefreshToken(token)) : null;
    if (!result) { res.status(401).json({ error: 'invalid_grant' }); return; }
    res.json(issueNativeTokens(result.userId));
  });

  // Revoke the presented refresh token (native sign-out).
  app.post('/api/native/logout', (req, res) => {
    const token = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
    if (token) store.revokeRefreshToken(hashRefreshToken(token));
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

  // Create an empty conversation — native surfaces (desktop/CLI) open a cloud-
  // backed session here, then persist locally-executed turns via /turns below.
  app.post('/api/conversations', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const raw = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const title = raw ? raw.slice(0, MAX_TITLE_LEN) : null;
    const conversation = store.createConversation(req.session!.userId, title);
    res.json({ conversation: { id: conversation.id, title: conversation.title, skillId: conversation.skillId } });
  });

  // Persist a locally-executed turn into the conversation tree. The run itself
  // ran on the client (its own keys + tools); we only store the resulting user +
  // assistant messages, honouring the branch params (edit / regenerate). Returns
  // the new active path so the client re-renders with authoritative sibling data.
  app.post('/api/conversations/:id/turns', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    const body = req.body as {
      userContent?: unknown;
      assistant?: { content?: unknown; model?: unknown; tier?: unknown; why?: unknown; costUsd?: unknown };
      editOfMessageId?: unknown;
      regenerateFromUserMessageId?: unknown;
    };
    if (typeof id !== 'string' || typeof body?.userContent !== 'string' || typeof body?.assistant?.content !== 'string') {
      res.status(400).json({ error: 'userContent and assistant.content are required' }); return;
    }
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const path = store.appendTurn(id, req.session!.userId, {
      userContent: body.userContent.slice(0, MAX_MESSAGE_LEN),
      assistant: {
        content: body.assistant.content.slice(0, MAX_MESSAGE_LEN),
        model: str(body.assistant.model),
        tier: str(body.assistant.tier),
        why: str(body.assistant.why),
        costUsd: typeof body.assistant.costUsd === 'number' ? body.assistant.costUsd : null,
      },
      editOfMessageId: str(body.editOfMessageId),
      regenerateFromUserMessageId: str(body.regenerateFromUserMessageId),
    });
    if (!path) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ messages: serializeActivePath(id) });
  });

  // Rename a conversation — used by the opt-in in-browser titler and manual edits.
  app.patch('/api/conversations/:id/title', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid conversation id' }); return; }
    const raw = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!raw) { res.status(400).json({ error: 'Title is required' }); return; }
    const title = raw.slice(0, MAX_TITLE_LEN);
    if (!store.renameConversation(id, req.session!.userId, title)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ ok: true, title });
  });

  // Serialise the currently-selected path through the conversation tree, adding
  // per-message sibling ids so the client can render the < n/m > branch navigator
  // and jump between alternative edits/regenerations.
  const serializeActivePath = (conversationId: string) =>
    store.getActivePath(conversationId).map((m) => ({
      ...m,
      siblingIds: store.getSiblingIds(m.id),
      attachments: store.getAttachmentsForMessage(m.id).map((a) => ({
        id: a.id, mime: a.mime, kind: a.kind, filename: a.filename, charCount: a.charCount,
      })),
    }));

  app.get('/api/conversations/:id/messages', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid conversation id' }); return; }
    const conversation = store.getConversation(id, req.session!.userId);
    if (!conversation) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({
      conversation: { id: conversation.id, title: conversation.title, skillId: conversation.skillId },
      messages: serializeActivePath(conversation.id),
    });
  });

  // Branching: switch the active path to a chosen sibling (the < n/m > arrows).
  app.post('/api/conversations/:id/select-branch', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    const messageId = (req.body as { messageId?: unknown })?.messageId;
    if (typeof id !== 'string' || typeof messageId !== 'string') {
      res.status(400).json({ error: 'Invalid conversation or message id' }); return;
    }
    const path = store.selectBranch(id, req.session!.userId, messageId);
    if (!path) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ messages: serializeActivePath(id) });
  });

  // Branching: delete a message and its entire subtree; returns the new path.
  app.delete('/api/conversations/:id/messages/:messageId', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    const messageId = req.params['messageId'];
    if (typeof id !== 'string' || typeof messageId !== 'string') {
      res.status(400).json({ error: 'Invalid conversation or message id' }); return;
    }
    const path = store.deleteMessageSubtree(id, req.session!.userId, messageId);
    if (!path) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ messages: serializeActivePath(id) });
  });

  // ── Run explorer: tier mix for today ──
  app.get('/api/tier-mix', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    res.json({ mix: store.tierMixSince(req.session!.userId, start.getTime()) });
  });

  // ── Skills — built-in catalog (public) merged with the user's custom
  // presets. Session is optional so a logged-out mount still gets the built-ins;
  // a logged-in user additionally gets their own editable skills + usage counts.
  app.get('/api/skills', sessionMiddleware(env.SESSION_SECRET, false), (req: AuthedRequest, res) => {
    const builtins = skillCatalog().map((s) => ({ ...s, custom: false, usageCount: 0 }));
    const userId = req.session?.userId;
    const custom = userId
      ? store.listUserSkills(userId).map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          custom: true,
          usageCount: s.usageCount,
          // Safe to return: the requester owns these skills. Built-in prompt
          // text stays server-side (it's the product's IP, not the user's).
          systemPrompt: s.systemPrompt,
        }))
      : [];
    res.json({ skills: [...builtins, ...custom] });
  });

  app.post('/api/skills', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const parsed = parseSkillBody(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const userId = req.session!.userId;
    if (store.listUserSkills(userId).length >= MAX_SKILLS_PER_USER) {
      res.status(400).json({ error: `You can have at most ${MAX_SKILLS_PER_USER} custom skills` });
      return;
    }
    res.json({ skill: customSkillView(store.createUserSkill(userId, parsed)) });
  });

  app.put('/api/skills/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid skill id' }); return; }
    const parsed = parseSkillBody(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const skill = store.updateUserSkill(id, req.session!.userId, parsed);
    if (!skill) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ skill: customSkillView(skill) });
  });

  app.delete('/api/skills/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid skill id' }); return; }
    res.json({ ok: store.deleteUserSkill(id, req.session!.userId) });
  });

  // ── Memory (per-user persistent facts) ──
  app.get('/api/memories', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    res.json({ memories: store.listMemories(req.session!.userId) });
  });

  app.post('/api/memories', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) { res.status(400).json({ error: 'Memory content is required' }); return; }
    if (content.length > MAX_MEMORY_LEN) { res.status(400).json({ error: `Memory must be ≤ ${MAX_MEMORY_LEN} characters` }); return; }
    res.json({ memory: store.addMemory(req.session!.userId, content, parseCategory(req.body?.category)) });
  });

  app.put('/api/memories/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid memory id' }); return; }
    if (!content) { res.status(400).json({ error: 'Memory content is required' }); return; }
    if (content.length > MAX_MEMORY_LEN) { res.status(400).json({ error: `Memory must be ≤ ${MAX_MEMORY_LEN} characters` }); return; }
    const memory = store.updateMemory(id, req.session!.userId, content, parseCategory(req.body?.category));
    if (!memory) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ memory });
  });

  app.delete('/api/memories/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid memory id' }); return; }
    res.json({ ok: store.deleteMemory(id, req.session!.userId) });
  });

  // ── Key sync (E2E-encrypted settings relay) ──
  // The server stores one opaque ciphertext envelope per user and hands it back
  // verbatim; it has no passphrase and cannot decrypt it. See docs/key-sync.md.
  const MAX_SECRETS_BLOB_BYTES = 512 * 1024;

  app.get('/api/keysync', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const rec = store.getUserSecrets(req.session!.userId);
    if (!rec) { res.json({ blob: null }); return; }
    res.json({ blob: JSON.parse(rec.blob), version: rec.version, updatedAt: rec.updatedAt });
  });

  app.put('/api/keysync', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const blob = req.body?.blob;
    // Shape-check only — the contents are ciphertext we must not (and can't) read.
    if (!blob || typeof blob.ciphertext !== 'string' || typeof blob.salt !== 'string' || typeof blob.iv !== 'string') {
      res.status(400).json({ error: 'Invalid encrypted blob' });
      return;
    }
    const serialized = JSON.stringify({ ciphertext: blob.ciphertext, salt: blob.salt, iv: blob.iv });
    if (Buffer.byteLength(serialized, 'utf-8') > MAX_SECRETS_BLOB_BYTES) {
      res.status(413).json({ error: 'Encrypted settings are too large to sync' });
      return;
    }
    const saved = store.putUserSecrets(req.session!.userId, serialized);
    res.json({ ok: true, ...saved });
  });

  app.delete('/api/keysync', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    res.json({ ok: store.deleteUserSecrets(req.session!.userId) });
  });

  // ── Remote MCP servers & connectors ──
  // The catalog is static presets; the servers are per-user, with auth headers
  // stored server-side and never returned. Adding validates the URL (https +
  // no private/loopback hosts) so the hosted server can't be used for SSRF.
  app.get('/api/mcp/connectors', sessionMiddleware(env.SESSION_SECRET, false), (_req: AuthedRequest, res) => {
    // Flag connectors whose broker OAuth app is configured, so the UI can offer a
    // one-click "Connect" (our own app) for providers that can't self-register.
    const brokered = new Set(brokeredConnectorIds(env));
    res.json({ connectors: connectorCatalog().map((c) => ({ ...c, broker: brokered.has(c.id) })) });
  });

  app.get('/api/mcp/servers', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    res.json({ servers: store.listMcpServers(req.session!.userId) });
  });

  app.post('/api/mcp/servers', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const body = req.body ?? {};
    const connectorId = typeof body.connectorId === 'string' ? body.connectorId : undefined;
    const connector = connectorId ? getConnector(connectorId) : undefined;
    if (connectorId && !connector) { res.status(400).json({ error: 'Unknown connector' }); return; }

    const name = (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : connector?.name || '').slice(0, 80);
    const rawUrl = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : connector?.url ?? '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!name) { res.status(400).json({ error: 'A name is required.' }); return; }

    const valid = validateRemoteMcpUrl(rawUrl);
    if (!valid.ok) { res.status(400).json({ error: valid.reason }); return; }

    // Build the auth header. A connector preset defines the header name/prefix;
    // a custom server accepts an explicit { authHeader } or defaults to Bearer.
    let headers: Record<string, string> | undefined;
    if (token) {
      const headerName = connector?.authHeader || (typeof body.authHeader === 'string' && body.authHeader.trim()) || 'Authorization';
      const prefix = connector ? connector.authPrefix : 'Bearer ';
      headers = { [headerName]: `${prefix}${token}` };
    }
    const server = store.addMcpServer({ userId, name, url: valid.url, headers, connectorId: connectorId ?? null });
    res.json({ server });
  });

  app.patch('/api/mcp/servers/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid server id' }); return; }
    if (typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'enabled (boolean) is required' }); return; }
    const ok = store.setMcpServerEnabled(id, req.session!.userId, req.body.enabled);
    if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  });

  app.delete('/api/mcp/servers/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid server id' }); return; }
    res.json({ ok: store.deleteMcpServer(id, req.session!.userId) });
  });

  // ── MCP OAuth connect ──
  // "Connect" runs an OAuth flow (login + authorize) instead of pasting a token.
  // The MCP SDK drives discovery/DCR/PKCE/refresh; tokens are stored encrypted.
  const mcpOAuthFlows = new McpOAuthFlows();
  const mcpCallbackUrl = `${env.OAUTH_REDIRECT_BASE_URL.replace(/\/$/, '')}/api/mcp/oauth/callback`;

  app.post('/api/mcp/oauth/start', sessionMiddleware(env.SESSION_SECRET), async (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const body = req.body ?? {};
    const connectorId = typeof body.connectorId === 'string' ? body.connectorId : null;
    const connector = connectorId ? getConnector(connectorId) : undefined;
    if (connectorId && !connector) { res.status(400).json({ error: 'Unknown connector' }); return; }
    const name = (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : connector?.name || '').slice(0, 80);
    const rawUrl = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : connector?.url ?? '';
    if (!name) { res.status(400).json({ error: 'A name is required.' }); return; }
    const valid = validateRemoteMcpUrl(rawUrl);
    if (!valid.ok) { res.status(400).json({ error: valid.reason }); return; }
    try {
      const started = await mcpOAuthFlows.start({ serverUrl: valid.url, name, connectorId, userId, redirectUrl: mcpCallbackUrl });
      // null → the server doesn't advertise OAuth; the client falls back to a pasted token.
      if (!started) { res.json({ oauth: false }); return; }
      res.json({ oauth: true, authorizeUrl: started.authorizeUrl });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Could not start authorization.' });
    }
  });

  // Top-level browser redirect back from the authorization server. Bound to the
  // user via the pending flow (captured under the session at /start); `state` is
  // the CSRF + lookup key. No session cookie is required here.
  app.get('/api/mcp/oauth/callback', async (req, res) => {
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    const backTo = `${env.WEB_ORIGIN.replace(/\/$/, '')}/`;
    if (!code || !state) { res.redirect(`${backTo}?mcp=error`); return; }
    try {
      const done = await mcpOAuthFlows.finish({ state, code });
      store.addMcpServer({
        userId: done.userId, name: done.name, url: done.serverUrl,
        connectorId: done.connectorId, oauthJson: encodeOAuthBlob(done.stored, env.SESSION_SECRET),
      });
      res.redirect(`${backTo}?mcp=connected`);
    } catch {
      res.redirect(`${backTo}?mcp=error`);
    }
  });

  // ── "Connect" broker (our own OAuth apps) ──
  // For providers without Dynamic Client Registration (GitHub), run the
  // authorization-code flow with OUR registered OAuth app — client_id/secret held
  // server-side. Env-gated: a connector with no app configured returns 400 here
  // and the UI falls back to token paste. See docs/connectors-broker.md.
  const brokerFlows = new BrokerFlows();

  app.post('/api/connect/:provider/start', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const providerId = String(req.params['provider'] ?? '');
    const provider = getBrokerProvider(providerId);
    if (!provider) { res.status(404).json({ error: 'Unknown connector' }); return; }
    if (!brokerConfigured(env, providerId)) {
      res.status(400).json({ error: 'This connector is not set up for one-click sign-in yet.' });
      return;
    }
    const state = brokerFlows.create(req.session!.userId, providerId);
    res.json({ authorizeUrl: brokerAuthorizeUrl(env, provider, state) });
  });

  // Top-level browser redirect back from the provider. `state` (minted at /start
  // under the session) is the CSRF + lookup key AND binds the token to the user;
  // it must match the provider it was issued for. No session cookie required here.
  app.get('/api/connect/:provider/callback', async (req, res) => {
    const backTo = `${env.WEB_ORIGIN.replace(/\/$/, '')}/`;
    const providerId = String(req.params['provider'] ?? '');
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    const provider = getBrokerProvider(providerId);
    if (!provider || !code || !state) { res.redirect(`${backTo}?mcp=error`); return; }
    const flow = brokerFlows.take(state);
    if (!flow || flow.providerId !== providerId) { res.redirect(`${backTo}?mcp=error`); return; }
    try {
      const tokens = await brokerExchangeCode(env, provider, code);
      const stored = { tokens, ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}) };
      store.addMcpServer({
        userId: flow.userId, name: provider.name, url: provider.mcpUrl,
        connectorId: provider.id, oauthJson: encodeOAuthBlob(stored, env.SESSION_SECRET),
      });
      res.redirect(`${backTo}?mcp=connected`);
    } catch {
      res.redirect(`${backTo}?mcp=error`);
    }
  });

  // ── Uploads (multimodal images + documents) ──
  // Client sends { mime, dataBase64, filename? }. Images go straight to the
  // tenant dir for multimodal input; documents (PDF/DOCX/text) are parsed to
  // plain text at upload time so a run injects the text without re-parsing.
  // Both return an id the chat:run payload references. Bytes never leave the
  // tenant's own scratch space.
  app.post('/api/uploads', sessionMiddleware(env.SESSION_SECRET), uploadJson, async (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const mime = typeof req.body?.mime === 'string' ? req.body.mime : '';
    const filename = typeof req.body?.filename === 'string' ? req.body.filename.slice(0, 255) : '';
    const dataBase64 = typeof req.body?.dataBase64 === 'string' ? req.body.dataBase64 : '';
    if (!dataBase64) { res.status(400).json({ error: 'Missing upload data' }); return; }
    const bytes = Buffer.from(dataBase64, 'base64');
    const dir = path.join(tenantScratchDir(env, userId), 'uploads');

    if (IMAGE_MIME_TYPES.has(mime)) {
      if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
        res.status(400).json({ error: `Image must be between 1 byte and ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB` });
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, randomUUID());
      fs.writeFileSync(filePath, bytes);
      const att = store.addAttachment({ userId, messageId: null, kind: 'image', mime, path: filePath });
      res.json({ id: att.id, kind: att.kind, mime: att.mime });
      return;
    }

    const docMime = resolveDocumentMime(mime, filename);
    if (!docMime) {
      res.status(400).json({ error: 'Unsupported file type. Upload an image, PDF, Word (.docx), or a text file.' });
      return;
    }
    if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) {
      res.status(400).json({ error: `Document must be between 1 byte and ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB` });
      return;
    }
    let extracted: { text: string; truncated: boolean };
    try {
      extracted = await parseDocument({ bytes, mime: docMime, filename });
    } catch {
      res.status(422).json({ error: "Couldn't read that document — it may be scanned, encrypted, or corrupt." });
      return;
    }
    if (!extracted.text.trim()) {
      res.status(422).json({ error: 'No text could be extracted from that document.' });
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, randomUUID());
    fs.writeFileSync(filePath, bytes);
    const att = store.addAttachment({
      userId, messageId: null, kind: 'document', mime: docMime, path: filePath,
      filename: filename || 'document', extractedText: extracted.text,
    });
    res.json({ id: att.id, kind: att.kind, mime: att.mime, filename: att.filename, charCount: att.charCount, truncated: extracted.truncated });
  });

  app.get('/api/uploads/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid upload id' }); return; }
    const att = store.getOwnedAttachment(id, req.session!.userId);
    if (!att) { res.status(404).json({ error: 'Not found' }); return; }
    res.type(att.mime);
    fs.createReadStream(att.path).on('error', () => res.status(404).end()).pipe(res);
  });

  // ── Cascade Files (saved generated files) ──
  const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024;
  const filesDir = (userId: string) => path.join(tenantScratchDir(env, userId), 'files');
  const MIME_BY_EXT: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv',
    html: 'text/html', xml: 'application/xml', yml: 'text/yaml', yaml: 'text/yaml',
    js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', sh: 'text/x-sh',
    css: 'text/css', sql: 'text/plain', log: 'text/plain',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  const mimeForFileName = (name: string): string => MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'text/plain';

  app.get('/api/files', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const plan = store.getUserById(userId)?.plan ?? 'free';
    res.json({
      files: store.listFiles(userId),
      usedBytes: store.sumUserFileBytes(userId),
      limitBytes: limitsForPlan(plan).storageBytes,
      plan,
    });
  });

  app.post('/api/files', sessionMiddleware(env.SESSION_SECRET), uploadJson, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const body = req.body ?? {};
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : '';
    const content = typeof body.content === 'string' ? body.content : '';
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null;
    // Client renders binary formats (PDF/Office) and sends them base64-encoded;
    // text files are stored as UTF-8 as before.
    const encoding: BufferEncoding = body.encoding === 'base64' ? 'base64' : 'utf-8';
    if (!name) { res.status(400).json({ error: 'A file name is required.' }); return; }
    const bytes = Buffer.from(content, encoding);
    if (bytes.length === 0) { res.status(400).json({ error: 'Nothing to save.' }); return; }
    if (bytes.length > MAX_SINGLE_FILE_BYTES) { res.status(413).json({ error: `A single file must be ≤ ${MAX_SINGLE_FILE_BYTES / (1024 * 1024)} MB.` }); return; }
    const plan = store.getUserById(userId)?.plan ?? 'free';
    try {
      checkStorageQuota(store.sumUserFileBytes(userId), bytes.length, plan);
    } catch (err) {
      res.status(413).json({ error: err instanceof Error ? err.message : 'Storage full.' });
      return;
    }
    fs.mkdirSync(filesDir(userId), { recursive: true });
    const file = store.addFile({ userId, conversationId, name, mime: mimeForFileName(name), size: bytes.length });
    fs.writeFileSync(path.join(filesDir(userId), file.id), bytes);
    res.json({ file, usedBytes: store.sumUserFileBytes(userId), limitBytes: limitsForPlan(plan).storageBytes });
  });

  app.get('/api/files/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid file id' }); return; }
    const file = store.getFile(id, req.session!.userId);
    if (!file) { res.status(404).json({ error: 'Not found' }); return; }
    res.type(file.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/[^\w.\- ]/g, '_')}"`);
    fs.createReadStream(path.join(filesDir(req.session!.userId), file.id)).on('error', () => res.status(404).end()).pipe(res);
  });

  app.delete('/api/files/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid file id' }); return; }
    const userId = req.session!.userId;
    const file = store.getFile(id, userId);
    if (file) { try { fs.rmSync(path.join(filesDir(userId), file.id)); } catch { /* already gone */ } store.deleteFile(id, userId); }
    res.json({ ok: true, usedBytes: store.sumUserFileBytes(userId) });
  });

  // ── Delete a chat / all chats + import chats/memories ──
  // Register the collection route before the ':id' route so "all" isn't parsed
  // as a conversation id.
  app.delete('/api/conversations', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    res.json({ deleted: store.deleteAllConversations(req.session!.userId) });
  });

  app.delete('/api/conversations/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid id' }); return; }
    res.json({ ok: store.deleteConversation(id, req.session!.userId) });
  });

  app.post('/api/memories/import', sessionMiddleware(env.SESSION_SECRET), uploadJson, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const items = Array.isArray(req.body?.memories) ? req.body.memories : [];
    const existing = new Set(store.listMemories(userId).map((m) => m.content.trim()));
    let imported = 0;
    for (const it of items.slice(0, 500)) {
      const content = typeof it === 'string' ? it.trim() : (typeof it?.content === 'string' ? it.content.trim() : '');
      if (!content || content.length > MAX_MEMORY_LEN || existing.has(content)) continue;
      store.addMemory(userId, content, parseCategory(it?.category));
      existing.add(content);
      imported++;
    }
    res.json({ imported });
  });

  app.get('/api/usage', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const user = store.getUserById(req.session!.userId);
    const plan = user?.plan ?? 'free';
    const limits = limitsForPlan(plan);
    const used = store.getUsage(req.session!.userId, todayKey());
    res.json({ plan, dailyRuns: used, dailyRunLimit: limits.dailyRuns, maxConcurrentRuns: limits.maxConcurrentRuns });
  });

  // ── Billing (Razorpay recurring subscriptions) ──
  const billing = billingConfig(env);
  // One-line boot diagnostic so a misconfigured deploy is obvious in the logs.
  // Only non-secret fields are printed (key id + plan id are safe to log; the
  // secret and webhook secret never are). The plan id length surfaces a stray
  // space/newline that would otherwise read as "ID not found" from Razorpay.
  if (billing) {
    const mode = billing.keyId.startsWith('rzp_live') ? 'live' : 'test';
    console.log(`[billing] configured — mode=${mode} keyId=${billing.keyId} planId="${billing.planId}" (len ${billing.planId.length})`);
  } else {
    console.log('[billing] not configured — set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_PLAN_ID to enable subscriptions');
  }

  // Current billing state for the signed-in user. `configured:false` when the
  // env vars are absent — the Upgrade page then shows the plan comparison only.
  app.get('/api/billing', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const user = store.getUserById(req.session!.userId);
    res.json({
      configured: !!billing,
      keyId: billing?.keyId ?? null,
      priceLabel: billing?.priceLabel ?? null,
      plan: user?.plan ?? 'free',
      status: user?.subscriptionStatus ?? null,
      currentEnd: user?.subscriptionCurrentEnd ?? null,
      hasSubscription: !!user?.subscriptionId,
    });
  });

  // Create a subscription and return the id for Razorpay Checkout on the client.
  app.post('/api/billing/subscribe', sessionMiddleware(env.SESSION_SECRET), async (req: AuthedRequest, res) => {
    if (!billing) { res.status(503).json({ error: 'Billing is not configured' }); return; }
    try {
      const sub = await createSubscription(makeRazorpay(billing), billing.planId);
      // Persist the id now (status stays 'free' until the webhook confirms payment).
      store.setUserSubscription(req.session!.userId, {
        subscriptionId: sub.id,
        status: sub.status,
        currentEnd: sub.currentEnd,
        plan: planForStatus(sub.status),
      });
      res.json({ subscriptionId: sub.id, keyId: billing.keyId });
    } catch (err) {
      // Include the (non-secret) mode + plan id so a 400 "ID not found" / 401
      // auth error in the logs points straight at which value is wrong.
      const mode = billing.keyId.startsWith('rzp_live') ? 'live' : 'test';
      console.error(`[billing] subscribe failed (mode=${mode} keyId=${billing.keyId} planId="${billing.planId}"):`, err);
      res.status(502).json({ error: 'Could not start the subscription. Try again.' });
    }
  });

  // Cancel at cycle end — access continues until the paid period ends.
  app.post('/api/billing/cancel', sessionMiddleware(env.SESSION_SECRET), async (req: AuthedRequest, res) => {
    if (!billing) { res.status(503).json({ error: 'Billing is not configured' }); return; }
    const user = store.getUserById(req.session!.userId);
    if (!user?.subscriptionId) { res.status(400).json({ error: 'No active subscription' }); return; }
    try {
      await cancelSubscription(makeRazorpay(billing), user.subscriptionId);
      // Leave plan as-is until the webhook fires 'subscription.cancelled'; just
      // reflect the pending cancellation in status.
      store.setUserSubscription(req.session!.userId, {
        subscriptionId: user.subscriptionId,
        status: 'cancel_scheduled',
        currentEnd: user.subscriptionCurrentEnd,
        plan: user.plan,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[billing] cancel failed:', err);
      res.status(502).json({ error: 'Could not cancel. Try again.' });
    }
  });

  // Razorpay → us. Signature-verified, no session. Drives the plan transitions.
  app.post('/api/billing/webhook', webhookRaw, (req, res) => {
    if (!billing) { res.status(503).end(); return; }
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const signature = req.header('x-razorpay-signature');
    if (!verifyWebhookSignature(raw, signature, billing.webhookSecret)) {
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { res.status(400).end(); return; }
    const sub = subscriptionFromWebhook(body);
    if (sub) {
      const user = store.getUserBySubscriptionId(sub.subscriptionId);
      if (user) {
        store.setUserSubscription(user.id, {
          subscriptionId: sub.subscriptionId,
          status: sub.status,
          currentEnd: sub.currentEnd,
          plan: planForStatus(sub.status),
        });
      }
    }
    res.json({ ok: true }); // always 200 to a validly-signed event so Razorpay stops retrying
  });

  // ── Conversation handoff (open-and-continue, web ↔ desktop) ──
  // A short-lived courier: snapshot a transcript here → get a code, redeem the
  // code on the other surface → get the snapshot back. Nothing is stored
  // durably (see handoff.ts). Create + read are unauthenticated so the keyless
  // desktop app can use them; they get their own tighter limiters on top of the
  // /api one, and the read endpoint 404s a bad/expired code without leaking
  // which it was.
  const handoffs = new HandoffStore();
  const handoffCreateLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many handoff codes. Slow down.' },
  });
  const handoffReadLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many attempts. Slow down.' },
  });

  app.post('/api/handoff', handoffCreateLimiter, (req, res) => {
    const parsed = parseHandoffBody(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const { code, expiresAt } = handoffs.create(parsed);
    res.json({ code, expiresAt });
  });

  app.get('/api/handoff/:code', handoffReadLimiter, (req, res) => {
    const code = req.params['code'];
    if (typeof code !== 'string') { res.status(400).json({ error: 'Invalid code' }); return; }
    const snapshot = handoffs.get(code);
    if (!snapshot) { res.status(404).json({ error: 'That code is invalid or has expired.' }); return; }
    res.json(snapshot);
  });

  // Seed a NEW conversation from a redeemed transcript — the web side of a
  // redeem. Authenticated + owner-scoped: the imported chat becomes the
  // caller's own conversation, ready to continue in the cloud.
  app.post('/api/conversations/import', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const parsed = parseHandoffBody(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const convo = store.importConversation(req.session!.userId, parsed.title, parsed.skillId, parsed.messages);
    res.json({ conversation: { id: convo.id, title: convo.title, skillId: convo.skillId } });
  });

  // ── Public docs site (cascadeai.in/docs) ─────
  // Registered before the SPA catch-all so /docs serves the documentation page
  // rather than the app shell. Self-contained HTML; safe to cache briefly.
  app.get(['/docs', '/docs/'], (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(renderDocsPage());
  });
  // Any deeper /docs/* path (there are no sub-pages yet) redirects to the index.
  app.get('/docs/*', (_req, res) => res.redirect(302, '/docs'));

  // ── Serve the built SPA ──────────────────────
  // In dev, cloud/web runs its own Vite server (proxying /api, /auth,
  // /socket.io back here — see cloud/web/vite.config.ts) and this simply
  // finds nothing to serve. In production (one Railway service), cloud/web
  // is built first and this serves it directly — no separate static host.
  const webDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
  }

  return app;
}
