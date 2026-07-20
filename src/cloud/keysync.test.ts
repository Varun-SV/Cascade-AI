import { describe, it, expect } from 'vitest';
import type { CascadeConfig } from '../types.js';
import { gatherSyncBundle, applySyncBundle } from './keysync.js';

// A minimal config stub — only the fields key-sync touches matter here.
function cfg(over: Partial<CascadeConfig> = {}): CascadeConfig {
  return {
    version: '1.0',
    providers: [],
    models: {},
    tools: { shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false },
    budget: {},
    ...over,
  } as unknown as CascadeConfig;
}

describe('keysync bundle', () => {
  it('gathers only the portable, defined fields', () => {
    const bundle = gatherSyncBundle(cfg({
      providers: [{ type: 'anthropic', apiKey: 'sk-a' }],
      tools: { shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: { braveApiKey: 'bk' } },
      models: { t1: 'claude-opus-4-8' },
      cascadeAuto: true,
    }));
    expect(bundle.providers).toHaveLength(1);
    expect(bundle.webSearch?.braveApiKey).toBe('bk');
    expect(bundle.models?.t1).toBe('claude-opus-4-8');
    expect(bundle.prefs?.cascadeAuto).toBe(true);
    expect(bundle.prefs?.autoBias).toBeUndefined();
  });

  it('merges providers by identity — updates matches, keeps local-only entries', () => {
    const local = cfg({
      providers: [
        { type: 'anthropic', apiKey: 'old' },   // will be updated by the bundle
        { type: 'ollama' },                       // local-only, must survive
      ],
    });
    const bundle = gatherSyncBundle(cfg({
      providers: [{ type: 'anthropic', apiKey: 'new' }, { type: 'openai', apiKey: 'sk-o' }],
    }));
    const merged = applySyncBundle(bundle, local);
    const byType = Object.fromEntries(merged.providers.map((p) => [p.type, p.apiKey]));
    expect(byType['anthropic']).toBe('new'); // incoming won
    expect('ollama' in byType).toBe(true);    // local-only kept
    expect(byType['openai']).toBe('sk-o');    // incoming added
    expect(merged.providers).toHaveLength(3);
  });

  it('round-trips a full gather → apply onto an empty config', () => {
    const source = cfg({
      providers: [{ type: 'anthropic', apiKey: 'sk-a', label: 'work' }],
      tools: { shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: { tavilyApiKey: 'tv' }, mcpServers: [{ name: 'gh', url: 'https://x', headers: { Authorization: 'Bearer t' } }] },
      budget: { dailyBudgetUsd: 5 },
    });
    const merged = applySyncBundle(gatherSyncBundle(source), cfg());
    expect(merged.providers[0]?.apiKey).toBe('sk-a');
    expect(merged.tools.webSearch?.tavilyApiKey).toBe('tv');
    expect(merged.tools.mcpServers?.[0]?.headers?.['Authorization']).toBe('Bearer t');
    expect(merged.budget.dailyBudgetUsd).toBe(5);
  });
});
