import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAccount, statusLines, usesChatGptPlan } from './chatgpt.js';
import { ChatGptAuth } from '../../auth/chatgpt/manager.js';
import { updateStore } from '../../auth/chatgpt/store.js';
import { withChatGptPlan, hasUsableProvider } from '../../config/index.js';
import { ModelSelector } from '../../core/router/selector.js';
import { SETTINGS } from '../settings/spec.js';
import { MANAGE_USAGE_URL } from '../../auth/chatgpt/constants.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chatgpt-cli-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const seed = (id: string, email: string, over: Record<string, unknown> = {}): void => {
  updateStore(dir, (s) => {
    s.accounts.push({
      email, issuer: 'https://auth.openai.com', subject: `s-${id}`, client_id: id, ext_agent_host_id: 'urn:uuid:x',
      access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600,
      scopes: ['chatgpt.tokens.use.direct', 'openid'], saved_at: new Date().toISOString(), ...over,
    });
    if (!s.active) s.active = id;
  });
};

describe('picking an account', () => {
  it('by number, email, ID or ID tail; ambiguous emails need the ID', () => {
    seed('oaiapp_aaa111', 'ana@example.com');
    seed('oaiapp_bbb222', 'ana@example.com');
    seed('oaiapp_ccc333', 'bo@example.com');
    const accounts = new ChatGptAuth({ dir }).status().accounts;
    expect(resolveAccount(accounts, '3')?.id).toBe('oaiapp_ccc333');
    expect(resolveAccount(accounts, 'bo@example.com')?.id).toBe('oaiapp_ccc333');
    expect(resolveAccount(accounts, 'ana@example.com')).toBeUndefined();
    expect(resolveAccount(accounts, 'bbb222')?.id).toBe('oaiapp_bbb222');
    expect(resolveAccount(accounts, 'oaiapp_aaa111')?.id).toBe('oaiapp_aaa111');
  });
});

describe('status', () => {
  it('says not signed in, then shows the active account and the manage-usage URL', () => {
    const a = new ChatGptAuth({ dir });
    expect(statusLines(a.status())[0]).toMatch(/not signed in/);
    seed('oaiapp_aaa111', 'ana@example.com');
    const text = statusLines(a.status()).join('\n');
    expect(text).toContain('ana@example.com');
    expect(text).toContain('enabled');
    expect(text).toMatch(/Access token\s+in \d+m|in 1h/);
    expect(text).toContain(MANAGE_USAGE_URL);
  });
  it('flags a sign-in without plan usage, and a signed-out account', () => {
    seed('oaiapp_aaa111', 'ana@example.com', { scopes: ['openid'] });
    expect(statusLines(new ChatGptAuth({ dir }).status()).join('\n')).toContain('not enabled');
  });
});

describe('the provider row', () => {
  it('exists only while a signed-in account approved plan usage, and counts as a usable provider', () => {
    expect(withChatGptPlan([{ type: 'chatgpt' }], dir)).toEqual([]);
    seed('oaiapp_aaa111', 'ana@example.com');
    const rows = withChatGptPlan([{ type: 'openai', apiKey: 'k' }, { type: 'chatgpt' }], dir);
    expect(rows.map((r) => r.type)).toEqual(['openai', 'chatgpt']);
    expect(hasUsableProvider(withChatGptPlan([], dir))).toBe(true);
    expect(hasUsableProvider([])).toBe(false);
  });
  it('is not there once the account is signed out', async () => {
    seed('oaiapp_aaa111', 'ana@example.com', { needs_sign_in: true });
    expect(withChatGptPlan([], dir)).toEqual([]);
  });
});

describe('"Using ChatGPT plan"', () => {
  const cfg = (models: Record<string, string>, providers: string[]) => ({ models, providers: providers.map((type) => ({ type })) });
  it('shows when a tier is pinned to a plan model or the plan is the only provider', () => {
    expect(usesChatGptPlan(cfg({ t1: 'chatgpt:gpt-5.5' }, ['openai', 'chatgpt']))).toBe(true);
    expect(usesChatGptPlan(cfg({}, ['chatgpt']))).toBe(true);
    expect(usesChatGptPlan(cfg({}, ['openai', 'chatgpt']))).toBe(false);
    expect(usesChatGptPlan(cfg({ t1: 'chatgpt:gpt-5.5' }, ['openai']))).toBe(false);
  });
});

describe('/settings', () => {
  it('offers Continue with ChatGPT, status and sign-out as actions', () => {
    const ids = SETTINGS.filter((s) => s.action?.startsWith('chatgpt')).map((s) => s.id);
    expect(ids).toEqual(['chatgpt', 'chatgpt-status', 'chatgpt-signout']);
    expect(SETTINGS.find((s) => s.id === 'chatgpt')!.label).toContain('Continue with ChatGPT');
  });
});

describe('model selection', () => {
  const plan = (slug: string) => ({
    id: `chatgpt:${slug}`, baseModelId: slug, name: slug, provider: 'chatgpt' as const, contextWindow: 1, isVisionCapable: true,
    inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 1, supportsStreaming: true, isLocal: false,
  });
  it('resolves chatgpt:<slug> to the plan model, never to an OpenAI model with the same slug', () => {
    const sel = new ModelSelector(new Set(['openai', 'chatgpt']));
    sel.addDynamicModel(plan('gpt-5'));
    expect(sel.selectForTier('T1', 'chatgpt:gpt-5')?.provider).toBe('chatgpt');
    expect(sel.selectForTier('T1', 'gpt-5')?.provider).toBe('openai');
  });
  it('registers an unseen chatgpt:<slug> pin under the namespaced id', () => {
    const sel = new ModelSelector(new Set(['chatgpt']));
    expect(sel.selectForTier('T2', 'chatgpt:gpt-9')).toMatchObject({ id: 'chatgpt:gpt-9', provider: 'chatgpt', baseModelId: 'gpt-9' });
  });
  it('lets the plan\'s models compete as discovered candidates when signed in', () => {
    const sel = new ModelSelector(new Set(['openai', 'chatgpt']));
    sel.addDynamicModel(plan('gpt-7'));
    expect(sel.getCandidatesForTier('T1').some((m) => m.id === 'chatgpt:gpt-7')).toBe(true);
  });
});
