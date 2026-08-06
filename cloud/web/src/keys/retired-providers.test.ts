// Upgrade safety for the browser key vault.
//
// Narrowing `ProviderType` is a build-time change and does nothing to values
// already in localStorage. Without a runtime migration, a user who selected a
// now-retired provider before upgrading keeps sending it on every `chat:run`,
// the server's Zod enum rejects the whole payload, and chatting is broken
// until they happen to open the vault and delete the row by hand.

import { describe, expect, it, beforeEach } from 'vitest';
import { loadKeys, saveKeys, takeRetiredProviderNotice } from './store.js';
import { stripRetiredProviders, describeRetiredRemoval } from '../lib/retired-providers.js';

/** Exactly what the vault held for a GitHub Models user before the upgrade. */
const VAULT_0_70_0 = [
  { type: 'anthropic', apiKey: 'sk-ant-real' },
  { type: 'github-models', apiKey: 'github_pat_dead' },
];

describe('stripRetiredProviders (web)', () => {
  it('drops retired entries and keeps everything else', () => {
    const { kept, removed } = stripRetiredProviders(VAULT_0_70_0);
    expect(removed).toEqual(['github-models']);
    expect(kept).toEqual([{ type: 'anthropic', apiKey: 'sk-ant-real' }]);
  });

  it('survives junk entries without dropping valid neighbours', () => {
    const { kept } = stripRetiredProviders([null, 'nonsense', { type: 'openai', apiKey: 'k' }]);
    expect(kept.some((p) => p.type === 'openai')).toBe(true);
  });

  it('explains the removal in terms that point at the replacement', () => {
    const msg = describeRetiredRemoval(['github-models']);
    expect(msg).toContain('GitHub Models');
    expect(msg).toContain('OpenAI-Compatible');
  });
});

describe('loadKeys — migrating a pre-upgrade vault', () => {
  beforeEach(() => {
    localStorage.clear();
    takeRetiredProviderNotice(); // drain any notice left by a previous test
  });

  it('returns a payload the server will accept, starting from a real pre-upgrade vault', () => {
    localStorage.setItem('cascade-cloud-keys', JSON.stringify(VAULT_0_70_0));

    const keys = loadKeys();

    // This is the assertion that matters: the array handed to `chat:run` no
    // longer contains a type the server's PROVIDER_TYPES enum rejects, so the
    // very first chat after upgrading works.
    //
    // Compared as `string` on purpose. TypeScript says `ProviderType` and
    // 'github-models' cannot overlap — and that is precisely the bug this
    // guards: the compiler's view stops at the type boundary, while
    // localStorage still holds the value a previous build wrote there.
    expect(keys.every((p) => (p.type as string) !== 'github-models')).toBe(true);
    expect(keys).toEqual([{ type: 'anthropic', apiKey: 'sk-ant-real' }]);
  });

  it('persists the cleaned vault so the migration happens once', () => {
    localStorage.setItem('cascade-cloud-keys', JSON.stringify(VAULT_0_70_0));
    loadKeys();

    const stored = JSON.parse(localStorage.getItem('cascade-cloud-keys')!);
    expect(stored).toEqual([{ type: 'anthropic', apiKey: 'sk-ant-real' }]);
  });

  it('surfaces a one-time notice, so a key does not just vanish', () => {
    localStorage.setItem('cascade-cloud-keys', JSON.stringify(VAULT_0_70_0));
    loadKeys();

    const notice = takeRetiredProviderNotice();
    expect(notice).toContain('GitHub Models');
    // Once, not on every render.
    expect(takeRetiredProviderNotice()).toBeNull();
  });

  it('says nothing when there was nothing to migrate', () => {
    saveKeys([{ type: 'openai', apiKey: 'k' }]);
    expect(loadKeys()).toEqual([{ type: 'openai', apiKey: 'k' }]);
    expect(takeRetiredProviderNotice()).toBeNull();
  });
});
