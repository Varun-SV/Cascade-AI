// ─────────────────────────────────────────────
//  Cascade Cloud Server — OAuth (GitHub + Google)
// ─────────────────────────────────────────────
//
// Plain authorization-code flow over the platform `fetch` — no passport, no
// extra OAuth client dependency. Each provider exposes an authorize URL
// builder and a code->profile exchange function; index.ts wires these into
// routes and owns the CSRF `state` cookie.

import type { CloudEnv } from '../env.js';

export interface OAuthProfile {
  providerId: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
}

function redirectUri(env: CloudEnv, provider: 'github' | 'google'): string {
  return `${env.OAUTH_REDIRECT_BASE_URL.replace(/\/$/, '')}/auth/${provider}/callback`;
}

// ── GitHub ──────────────────────────────────────

export function githubAuthUrl(state: string, env: CloudEnv): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID ?? '',
    redirect_uri: redirectUri(env, 'github'),
    scope: 'read:user user:email',
    state,
    allow_signup: 'true',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeGithubCode(code: string, env: CloudEnv): Promise<OAuthProfile> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(env, 'github'),
    }),
  });
  if (!tokenRes.ok) throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenBody.access_token) throw new Error(`GitHub token exchange failed: ${tokenBody.error ?? 'no access_token'}`);

  const authHeaders = {
    Authorization: `Bearer ${tokenBody.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cascade-cloud',
  };

  const userRes = await fetch('https://api.github.com/user', { headers: authHeaders });
  if (!userRes.ok) throw new Error(`GitHub profile fetch failed: ${userRes.status}`);
  const user = (await userRes.json()) as { id: number; login: string; name: string | null; avatar_url: string | null; email: string | null };

  let email = user.email;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers: authHeaders });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
    }
  }

  return {
    providerId: String(user.id),
    email,
    name: user.name ?? user.login,
    avatar: user.avatar_url,
  };
}

// ── Google ──────────────────────────────────────

export function googleAuthUrl(state: string, env: CloudEnv): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri(env, 'google'),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(code: string, env: CloudEnv): Promise<OAuthProfile> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      code,
      redirect_uri: redirectUri(env, 'google'),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new Error(`Google token exchange failed: ${tokenRes.status}`);
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenBody.access_token) throw new Error(`Google token exchange failed: ${tokenBody.error ?? 'no access_token'}`);

  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  if (!userRes.ok) throw new Error(`Google profile fetch failed: ${userRes.status}`);
  const user = (await userRes.json()) as { sub: string; email: string | null; name: string | null; picture: string | null };

  return {
    providerId: user.sub,
    email: user.email,
    name: user.name,
    avatar: user.picture,
  };
}
