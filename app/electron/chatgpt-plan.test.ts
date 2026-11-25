import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGE_USAGE_URL, createChatGptPlan, type PlanAuth } from './chatgpt-plan.js';
import { ChatGptAuth } from '../../src/auth/chatgpt/manager.js';
import { updateStore } from '../../src/auth/chatgpt/store.js';
import { isPlanModel, isUsageLimitMessage, usingPlan } from '../src/lib/chatgpt-plan.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chatgpt-app-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const seed = (): void => {
  updateStore(dir, (s) => {
    s.accounts.push({
      email: 'ana@example.com', issuer: 'https://auth.openai.com', subject: 's', client_id: 'oaiapp_a', ext_agent_host_id: 'urn:uuid:x',
      id_token: 'SECRET-ID', access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH', token_type: 'Bearer', expires_in: 3600,
      scopes: ['chatgpt.tokens.use.direct'], saved_at: new Date().toISOString(),
    });
    s.active = 'oaiapp_a';
  });
};

function plan(over: Partial<PlanAuth> = {}) {
  const auth = new ChatGptAuth({ dir, fetch: async () => new Response('', { status: 200 }), sleep: async () => undefined });
  const opened: string[] = [];
  const sent: Array<[string, unknown]> = [];
  const onChanged = vi.fn();
  const p = createChatGptPlan({
    auth: { ...(auth as unknown as PlanAuth), status: () => auth.status(), signIn: over.signIn ?? ((o) => auth.signIn(o)), signOut: (id) => auth.signOut(id), switchAccount: (id) => auth.switchAccount(id), markWelcomeShown: () => auth.markWelcomeShown() },
    openExternal: (u) => { opened.push(u); },
    onChanged,
    notify: (c, v) => sent.push([c, v]),
  });
  return { p, opened, sent, onChanged, auth };
}

describe('desktop ChatGPT plan handlers', () => {
  it('never hands the window a token', async () => {
    seed();
    const { p, sent } = plan();
    const view = JSON.stringify([p.status(), sent]);
    expect(view).toContain('ana@example.com');
    for (const secret of ['SECRET-ID', 'SECRET-ACCESS', 'SECRET-REFRESH']) expect(view).not.toContain(secret);
    const out = await p.signOut();
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(JSON.stringify(sent)).not.toContain('SECRET');
  });

  it('signs in through the system browser (openExternal), once at a time, and tells the app', async () => {
    let release!: () => void;
    const { p, opened, onChanged } = plan({
      signIn: async (o) => {
        await o.openUrl('https://auth.openai.com/api/accounts/authorize?x=1');
        await new Promise<void>((r) => { release = r; });
        return { account: { id: 'a', email: 'a@b.c', label: 'a@b.c', active: true, signedIn: true, planUsageEnabled: true, needsSignIn: false }, planUsageEnabled: true, showWelcome: true, newRegistration: true };
      },
    });
    const first = p.signIn();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatch(/^https:\/\/auth\.openai\.com\//);
    expect((await p.signIn())).toMatchObject({ ok: false });
    release();
    expect(await first).toMatchObject({ ok: true, planUsageEnabled: true, showWelcome: true });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a failed sign-in without throwing, and cancel aborts the wait', async () => {
    const { p } = plan({
      signIn: (o) => new Promise((_res, rej) => { o.signal?.addEventListener('abort', () => rej(new Error('Sign-in was cancelled.'))); }),
    });
    const pending = p.signIn();
    expect(p.status().signingIn).toBe(true);
    p.cancel();
    expect(await pending).toEqual({ ok: false, error: 'Sign-in was cancelled.' });
    expect(p.status().signingIn).toBe(false);
  });

  it('rejects an account id that is not a plain string', async () => {
    const { p } = plan();
    expect(await p.signIn({ accountId: { $ne: 1 } })).toMatchObject({ ok: false });
    expect(await p.switchAccount({ accountId: 42 })).toMatchObject({ ok: false });
    expect(await p.signOut({ accountId: ['x'] })).toMatchObject({ ok: false });
  });

  it('manage usage opens only the ChatGPT usage page', async () => {
    const { p, opened } = plan();
    await p.openManageUsage();
    expect(opened).toEqual([MANAGE_USAGE_URL]);
    expect(MANAGE_USAGE_URL).toBe('https://chatgpt.com/settings/usage');
  });

  it('the welcome is pending until Got it, then never again', () => {
    seed();
    const { p } = plan();
    expect(p.status().welcomePending).toBe(true);
    p.dismissWelcome();
    expect(p.status().welcomePending).toBe(false);
  });

  it('switches accounts and says when one must sign in first', async () => {
    seed();
    updateStore(dir, (s) => { s.accounts.push({ ...s.accounts[0]!, client_id: 'oaiapp_b', subject: 's2', email: 'bo@example.com', access_token: undefined, refresh_token: undefined, needs_sign_in: true }); });
    const { p } = plan();
    expect(await p.switchAccount({ accountId: 'oaiapp_b' })).toMatchObject({ ok: true, needsSignIn: true });
    expect(p.status().active?.id).toBe('oaiapp_a');
  });
});

describe('window helpers', () => {
  it('says Using ChatGPT plan for a plan model, or Auto when it is the only way to pay', () => {
    expect(isPlanModel('chatgpt:gpt-5.5')).toBe(true);
    expect(isPlanModel('gpt-5.5')).toBe(false);
    expect(usingPlan('chatgpt:gpt-5.5', true, 3)).toBe(true);
    expect(usingPlan('auto', true, 0)).toBe(true);
    expect(usingPlan('auto', true, 1)).toBe(false);
    expect(usingPlan('chatgpt:gpt-5.5', false, 0)).toBe(false);
  });
  it('recognises the usage-limit failure', () => {
    expect(isUsageLimitMessage('Run failed: ChatGPT plan usage limit reached. Open https://chatgpt.com/settings/usage')).toBe(true);
    expect(isUsageLimitMessage('Run failed: rate limit')).toBe(false);
  });
});
