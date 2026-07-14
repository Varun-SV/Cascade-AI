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
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  parseCookies,
  type AuthedRequest,
} from './auth/session.js';
import { githubAuthUrl, exchangeGithubCode, googleAuthUrl, exchangeGoogleCode, type OAuthProfile } from './auth/oauth.js';
import { limitsForPlan, todayKey } from './entitlements.js';
import { skillCatalog } from './skills.js';
import { tenantScratchDir } from './paths.js';
import {
  billingConfig, makeRazorpay, createSubscription, cancelSubscription,
  verifyWebhookSignature, planForStatus, subscriptionFromWebhook,
} from './billing.js';

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_MEMORY_LEN = 2000;
const MAX_MEMORY_CATEGORY_LEN = 32;
const MAX_TITLE_LEN = 120;
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

export function createApp(env: CloudEnv, store: CloudStore) {
  const app = express();
  // Behind Railway (and most PaaS) the app sits behind exactly one reverse
  // proxy that sets X-Forwarded-For. Without trusting it, express-rate-limit
  // THROWS ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request (it refuses to
  // key limits off a spoofable header), which surfaced as 500s in production.
  // Trust exactly one hop — `true` would trust a client-supplied XFF and let
  // anyone forge their rate-limit identity.
  app.set('trust proxy', 1);
  // Image uploads carry a base64 payload larger than a normal API body, so
  // they get their own bigger parser on the route; every other endpoint keeps
  // the tight default limit.
  const uploadJson = express.json({ limit: '8mb' });
  // The Razorpay webhook signature is an HMAC of the RAW request body, so that
  // route needs the unparsed bytes — capture them and skip the JSON parser.
  const webhookRaw = express.raw({ type: '*/*', limit: '1mb' });
  app.use((req, res, next) => {
    if (req.path === '/api/uploads' || req.path === '/api/billing/webhook') { next(); return; }
    express.json()(req, res, next);
  });

  const secure = env.OAUTH_REDIRECT_BASE_URL.startsWith('https://');

  // Only the configured web origin may read cross-site responses, and only
  // that origin's requests carry the session cookie — cloud/web and
  // cloud/server run on different ports in dev, same origin in prod.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', env.WEB_ORIGIN);
    res.header('Access-Control-Allow-Credentials', 'true');
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

  app.get('/api/conversations/:id/messages', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid conversation id' }); return; }
    const conversation = store.getConversation(id, req.session!.userId);
    if (!conversation) { res.status(404).json({ error: 'Not found' }); return; }
    const messages = store.getMessages(conversation.id).map((m) => ({
      ...m,
      attachments: store.getAttachmentsForMessage(m.id).map((a) => ({ id: a.id, mime: a.mime, kind: a.kind })),
    }));
    res.json({ conversation: { id: conversation.id, title: conversation.title, skillId: conversation.skillId }, messages });
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

  // ── Image uploads (multimodal input) ──
  // Client sends { mime, dataBase64 }; we validate type + size, write to the
  // per-tenant dir, and return an id the chat:run payload references. Keys and
  // bytes never leave the tenant's own scratch space.
  app.post('/api/uploads', sessionMiddleware(env.SESSION_SECRET), uploadJson, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const mime = typeof req.body?.mime === 'string' ? req.body.mime : '';
    const dataBase64 = typeof req.body?.dataBase64 === 'string' ? req.body.dataBase64 : '';
    if (!IMAGE_MIME_TYPES.has(mime)) { res.status(400).json({ error: 'Unsupported image type (jpeg, png, gif, webp only)' }); return; }
    if (!dataBase64) { res.status(400).json({ error: 'Missing image data' }); return; }
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
      res.status(400).json({ error: `Image must be between 1 byte and ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB` });
      return;
    }
    const dir = path.join(tenantScratchDir(env, userId), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, randomUUID());
    fs.writeFileSync(filePath, bytes);
    const att = store.addAttachment({ userId, messageId: null, kind: 'image', mime, path: filePath });
    res.json({ id: att.id, mime: att.mime });
  });

  app.get('/api/uploads/:id', sessionMiddleware(env.SESSION_SECRET), (req: AuthedRequest, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string') { res.status(400).json({ error: 'Invalid upload id' }); return; }
    const att = store.getOwnedAttachment(id, req.session!.userId);
    if (!att) { res.status(404).json({ error: 'Not found' }); return; }
    res.type(att.mime);
    fs.createReadStream(att.path).on('error', () => res.status(404).end()).pipe(res);
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
      console.error('[billing] subscribe failed:', err);
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
