import { describe, expect, it } from 'vitest';
import { type AnswerStore, REMEMBER_MS, consentFromForm, forgetAnswers, keepAnswer, keptCount, keptKey, recallAnswer } from './answers.js';

function memoryStore(): AnswerStore {
  let data: Record<string, unknown> = {};
  return {
    get: async (k) => (k in data ? { [k]: data[k] } : {}),
    set: async (items) => { data = { ...data, ...JSON.parse(JSON.stringify(items)) as Record<string, unknown> }; },
  };
}

describe("the consent window's answer", () => {
  it('named sites, as before', () => {
    expect(consentFromForm({ sites: 'github.com docs.github.com', anyPublic: false })).toEqual({ consent: { allowedOrigins: ['https://github.com', 'https://docs.github.com'], privateOrigins: [], maxTabs: 4 } });
  });

  it('any public site, with or without sites typed too', () => {
    expect(consentFromForm({ sites: '', anyPublic: true })).toEqual({ consent: { allowedOrigins: [], privateOrigins: [], anyPublic: true, maxTabs: 4 } });
    expect(consentFromForm({ sites: 'github.com', anyPublic: true })).toMatchObject({ consent: { allowedOrigins: ['https://github.com'], anyPublic: true } });
  });

  it('screenshots only when ticked, and never as an answer on their own', () => {
    expect(consentFromForm({ sites: 'github.com', anyPublic: false, screenshots: true })).toMatchObject({ consent: { screenshots: true } });
    expect(consentFromForm({ sites: 'github.com', anyPublic: false })).not.toHaveProperty('consent.screenshots');
    expect(consentFromForm({ sites: '', anyPublic: false, screenshots: true })).toBeNull();
  });

  it('tabs at once: four unless picked, one to eight', () => {
    expect(consentFromForm({ sites: 'github.com', anyPublic: false, maxTabs: 2 })).toMatchObject({ consent: { maxTabs: 2 } });
    expect(consentFromForm({ sites: 'github.com', anyPublic: false, maxTabs: 40 })).toMatchObject({ consent: { maxTabs: 8 } });
    expect(consentFromForm({ sites: 'github.com', anyPublic: false, maxTabs: 0 })).toMatchObject({ consent: { maxTabs: 1 } });
    expect(consentFromForm({ sites: '', anyPublic: false, maxTabs: 4 })).toBeNull();
  });

  it('nothing at all is a no; a private site or a bad one is asked again, any public site or not', () => {
    expect(consentFromForm({ sites: '  ', anyPublic: false })).toBeNull();
    expect(consentFromForm({ sites: 'localhost:3000', anyPublic: true })).toMatchObject({ error: expect.stringContaining('private network') });
    expect(consentFromForm({ sites: 'file:///etc', anyPublic: true })).toMatchObject({ error: expect.any(String) });
    expect(consentFromForm({ sites: Array.from({ length: 51 }, (_, i) => `s${i}.test`).join(' '), anyPublic: false })).toMatchObject({ error: expect.stringContaining('at most 50') });
  });
});

describe('answers kept for a chat', () => {
  const form = { sites: 'github.com', anyPublic: false, incognito: true, remember: true };

  it("come back for that server's chat only, and lapse", async () => {
    const store = memoryStore();
    await keepAnswer(store, keptKey('https://cascadeai.in', 'chat1'), form, 1000);
    expect(await recallAnswer(store, keptKey('https://cascadeai.in', 'chat1'), 2000)).toMatchObject({ sites: 'github.com', incognito: true });
    expect(await recallAnswer(store, keptKey('https://cascadeai.in', 'chat2'), 2000)).toBeNull();
    expect(await recallAnswer(store, keptKey('https://other.example', 'chat1'), 2000)).toBeNull();
    expect(await recallAnswer(store, keptKey('https://cascadeai.in', 'chat1'), 1000 + REMEMBER_MS + 1)).toBeNull();
  });

  it('keep the screenshot choice with the rest of the answer', async () => {
    const store = memoryStore();
    await keepAnswer(store, 'a|1', { ...form, screenshots: true }, 0);
    expect(await recallAnswer(store, 'a|1', 1)).toMatchObject({ screenshots: true });
    expect(consentFromForm((await recallAnswer(store, 'a|1', 1))!)).toMatchObject({ consent: { screenshots: true } });
  });

  it('keep the tab choice; one kept before it was asked gives one tab', async () => {
    const store = memoryStore();
    await keepAnswer(store, 'a|1', { ...form, maxTabs: 3 }, 0);
    expect(await recallAnswer(store, 'a|1', 1)).toMatchObject({ maxTabs: 3 });
    await store.set({ keptAnswers: { 'a|2': { sites: 'github.com', anyPublic: false, incognito: true, screenshots: false, until: 100 } } });
    expect(await recallAnswer(store, 'a|2', 1)).not.toHaveProperty('maxTabs');
  });

  it('are counted, and forgotten all at once', async () => {
    const store = memoryStore();
    await keepAnswer(store, 'a|1', form, 0);
    await keepAnswer(store, 'a|2', { ...form, anyPublic: true }, 0);
    expect(await keptCount(store, 1)).toBe(2);
    expect(await recallAnswer(store, 'a|1', 1)).toMatchObject({ screenshots: false });
    await forgetAnswers(store);
    expect(await keptCount(store, 1)).toBe(0);
  });
});
