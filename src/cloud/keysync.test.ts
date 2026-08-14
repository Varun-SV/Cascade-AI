import { describe, it, expect } from 'vitest';
import type { CascadeConfig } from '../types.js';
import { gatherSyncBundle, applySyncBundle } from './keysync.js';
import { mcpServerPrefix } from '../tools/tool-name.js';

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

// ── Per-tool MCP selections ───────────────────
//
// The bundle already carried MCP servers WITH their auth headers. Carrying the
// servers but not the selections meant pushing settings to a second device
// handed it the connector, its credentials, and every tool switched back on —
// including a destructive one the user had deliberately turned off, with
// nothing on screen saying so.

describe('keysync — MCP per-tool selections', () => {
  const server = (name: string) => ({ name, url: `https://${name}.example.com/mcp` });

  it('carries the deny list alongside the servers', () => {
    const bundle = gatherSyncBundle(cfg({
      tools: { mcpServers: [server('github')], disabledTools: ['mcp__github__delete_repo'] },
    } as Partial<CascadeConfig>));
    expect(bundle.disabledTools).toEqual(['mcp__github__delete_repo']);
  });

  it('omits the field entirely when nothing is switched off', () => {
    const bundle = gatherSyncBundle(cfg({
      tools: { mcpServers: [server('github')] },
    } as Partial<CascadeConfig>));
    expect(bundle.disabledTools).toBeUndefined();
  });

  it('never syncs a non-MCP denial — it can never be re-enabled once pulled', () => {
    // mergeDisabledTools() only lets a SERVER'S prefix override a stored
    // entry — a built-in tool like `read_current_page` matches no server
    // prefix, so a copy that ever reached a bundle would sit in `kept`
    // forever: a device that later re-enabled it and pushed again could never
    // clear the copy already pulled onto another device. Built-in tool
    // selections are device-local; only MCP-prefixed denials travel.
    const bundle = gatherSyncBundle(cfg({
      tools: { mcpServers: [server('github')], disabledTools: ['mcp__github__delete_repo', 'read_current_page'] },
    } as Partial<CascadeConfig>));
    expect(bundle.disabledTools).toEqual(['mcp__github__delete_repo']);
    expect(bundle.disabledTools).not.toContain('read_current_page');
  });

  it('a non-MCP denial is not undone by a later pull, and never spreads to another device', () => {
    // End-to-end: device A disables a built-in tool, pushes, then re-enables
    // it and pushes again. Device B, mid-way through, must never receive it
    // (nothing to sync) and must never lose ITS OWN unrelated local denial.
    const deviceB = cfg({ tools: { disabledTools: ['read_current_page'] } } as Partial<CascadeConfig>);
    const pushFromA = gatherSyncBundle(cfg({
      tools: { mcpServers: [server('github')], disabledTools: ['mcp__github__delete_repo', 'browser_screenshot'] },
    } as Partial<CascadeConfig>));
    const merged = applySyncBundle(pushFromA, deviceB);
    expect(merged.tools.disabledTools).toContain('mcp__github__delete_repo'); // synced in
    expect(merged.tools.disabledTools).toContain('read_current_page');       // B's own, untouched
    expect(merged.tools.disabledTools).not.toContain('browser_screenshot');  // A's own, never sent
  });

  it('applies the incoming selection for a server the bundle brings', () => {
    const local = cfg({ tools: { mcpServers: [server('github')], disabledTools: [] } } as Partial<CascadeConfig>);
    const next = applySyncBundle(
      { v: 2, mcpServers: [server('github')], disabledTools: ['mcp__github__delete_repo'] },
      local,
    );
    expect(next.tools.disabledTools).toEqual(['mcp__github__delete_repo']);
  });

  it('lets a pull RE-ENABLE a tool, not only disable one', () => {
    // "Push my settings" has to move in both directions, or the two devices
    // silently diverge the moment someone turns something back on.
    const local = cfg({
      tools: { mcpServers: [server('github')], disabledTools: ['mcp__github__delete_repo'] },
    } as Partial<CascadeConfig>);
    const next = applySyncBundle({ v: 2, mcpServers: [server('github')], disabledTools: [] }, local);
    expect(next.tools.disabledTools).toBeUndefined();
  });

  it('does NOT clear selections when pulling a pre-selection (v1) bundle', () => {
    // A v1 bundle omits `disabledTools` because the format had no such field —
    // not because nothing is switched off. Reading that as an empty selection
    // re-enables the destructive tool the user turned off, on an ordinary sync
    // pull, with nothing on screen saying so.
    const local = cfg({
      tools: { mcpServers: [server('github')], disabledTools: ['mcp__github__delete_repo'] },
    } as Partial<CascadeConfig>);
    const next = applySyncBundle({ v: 1, mcpServers: [server('github')] }, local);
    expect(next.tools.disabledTools).toEqual(['mcp__github__delete_repo']);
  });

  it('DOES clear them for a v2 bundle that omits the field', () => {
    // Same JSON, different meaning: v2 omits the field only when the pushing
    // device genuinely had nothing switched off, so the pull must re-enable.
    const local = cfg({
      tools: { mcpServers: [server('github')], disabledTools: ['mcp__github__delete_repo'] },
    } as Partial<CascadeConfig>);
    const next = applySyncBundle({ v: 2, mcpServers: [server('github')] }, local);
    expect(next.tools.disabledTools).toBeUndefined();
  });

  it('gathers at the version that carries selections', () => {
    expect(gatherSyncBundle(cfg()).v).toBe(2);
  });

  it('leaves selections alone for a server the bundle never mentions', () => {
    // Syncing one connector must not silently re-arm another's tools.
    const local = cfg({
      tools: {
        mcpServers: [server('github'), server('notion')],
        disabledTools: ['mcp__github__delete_repo', 'mcp__notion__delete_page'],
      },
    } as Partial<CascadeConfig>);
    const next = applySyncBundle(
      { v: 2, mcpServers: [server('github')], disabledTools: [] },
      local,
    );
    expect(next.tools.disabledTools).toEqual(['mcp__notion__delete_page']);
  });

  it('separates servers whose names fold to the same tool prefix on merge', () => {
    // Each device's connection-time uniqueness guard only ever sees its OWN
    // list, so `foo bar` here and `foo@bar` there are both individually valid —
    // the collision only comes into existence at the merge. Left alone, one
    // server's tools overwrite the other's in the registry and a single deny
    // entry silently applies to both.
    const local = cfg({
      tools: { mcpServers: [{ name: 'foo bar', url: 'https://a.example.com/mcp' }] },
    } as Partial<CascadeConfig>);
    const next = applySyncBundle(
      { v: 2, mcpServers: [{ name: 'foo@bar', url: 'https://b.example.com/mcp' }] },
      local,
    );
    const names = (next.tools.mcpServers ?? []).map((m) => m.name);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('foo bar');            // the local name is never rewritten
    expect(names[1]).not.toBe('foo@bar');        // the incoming one is suffixed
    // The point of the rename: distinct registered tool prefixes.
    const prefixes = new Set(names.map((n) => mcpServerPrefix(n)));
    expect(prefixes.size).toBe(2);
  });

  it('carries a renamed server\'s deny entries over to its new prefix', () => {
    const local = cfg({
      tools: {
        mcpServers: [{ name: 'foo bar', url: 'https://a.example.com/mcp' }],
        disabledTools: ['mcp__foo_bar__local_only'],
      },
    } as Partial<CascadeConfig>);
    const next = applySyncBundle(
      {
        v: 2,
        mcpServers: [{ name: 'foo@bar', url: 'https://b.example.com/mcp' }],
        disabledTools: ['mcp__foo_bar__delete_everything'],
      },
      local,
    );
    const renamed = (next.tools.mcpServers ?? [])[1]!.name;
    // The incoming denial follows its server; the local one stays put, because
    // the bundle never actually mentioned the local server.
    expect(next.tools.disabledTools).toContain(`${mcpServerPrefix(renamed)}delete_everything`);
    expect(next.tools.disabledTools).toContain('mcp__foo_bar__local_only');
  });

  it('still updates in place when the raw name matches exactly', () => {
    const local = cfg({
      tools: { mcpServers: [{ name: 'github', url: 'https://old.example.com/mcp' }] },
    } as Partial<CascadeConfig>);
    const next = applySyncBundle(
      { v: 2, mcpServers: [{ name: 'github', url: 'https://new.example.com/mcp' }] },
      local,
    );
    expect(next.tools.mcpServers).toHaveLength(1);
    expect(next.tools.mcpServers![0]!.url).toBe('https://new.example.com/mcp');
  });
});

describe('keysync — a bundle predating 0.75 must not reinstate a dead token', () => {
  it('drops a Claude subscription token instead of letting it win the merge', () => {
    // The incoming entry wins the provider merge, and the result is persisted.
    // Without this filter, pulling an old bundle overwrote a valid API key with
    // a token this release cannot use — and the next launch stripped that
    // token, leaving the good key permanently gone.
    const local = cfg({ providers: [{ type: 'anthropic', apiKey: 'sk-ant-still-good' }] });
    const stale = {
      v: 2,
      providers: [{ type: 'anthropic', authToken: 'sk-ant-oat01-dead', credentialSource: 'Claude Code' }],
    } as unknown as Parameters<typeof applySyncBundle>[0];

    const merged = applySyncBundle(stale, local);
    const anthropic = merged.providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.apiKey).toBe('sk-ant-still-good');
    expect(anthropic?.authToken).toBeUndefined();
  });

  it('still carries a legitimate gateway bearer through the merge', () => {
    const local = cfg({ providers: [] });
    const bundle = {
      v: 2,
      providers: [{ type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal' }],
    } as unknown as Parameters<typeof applySyncBundle>[0];

    const merged = applySyncBundle(bundle, local);
    const anthropic = merged.providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.authToken).toBe('gw-token');
    expect(anthropic?.baseUrl).toBe('https://gateway.internal');
  });
});

describe('keysync — an endpoint-only revoked row must not win either', () => {
  it('drops the whole row, so a valid local key survives the merge', () => {
    // Keeping the entry minus its token is right for local config, where the
    // row holds a gateway the user configured. It is wrong for an incoming
    // bundle: mergeByKey treats a matching incoming row as authoritative, so an
    // endpoint-only row replaced a valid local key and persisted with no
    // credential at all — the exact loss the filter was added to prevent.
    const local = cfg({
      providers: [{ type: 'anthropic', apiKey: 'sk-ant-still-good', baseUrl: 'https://gw.internal' }],
    });
    const stale = {
      v: 2,
      providers: [{
        type: 'anthropic', authToken: 'sk-ant-oat01-dead',
        baseUrl: 'https://gw.internal', credentialSource: 'Claude Code',
      }],
    } as unknown as Parameters<typeof applySyncBundle>[0];

    const merged = applySyncBundle(stale, local);
    const anthropic = merged.providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.apiKey).toBe('sk-ant-still-good');
    expect(anthropic?.authToken).toBeUndefined();
  });

  it('keeps a synced row that carries a replacement API key beside the dead token', () => {
    // Dropping the row wholesale lost the key. This is the state the
    // settings-save paths fixed in this release used to produce, so a device
    // still on an older build syncs exactly this shape — and the key is the
    // thing the user is trying to transfer.
    const local = cfg({ providers: [{ type: 'anthropic', apiKey: 'sk-ant-old' }] });
    const bundle = {
      v: 2,
      providers: [{
        type: 'anthropic', authToken: 'sk-ant-oat01-dead',
        apiKey: 'sk-ant-replacement', credentialSource: 'Claude Code',
      }],
    } as unknown as Parameters<typeof applySyncBundle>[0];

    const merged = applySyncBundle(bundle, local);
    const anthropic = merged.providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.apiKey).toBe('sk-ant-replacement');
    expect(anthropic?.authToken).toBeUndefined();
  });
});

describe('keysync — a pin the removed credential leaves dangling', () => {
  it('clears an Anthropic pin the bundle brought with the dead token', () => {
    // clearRetiredPins() does not cover this: `anthropic` is not a retired
    // provider type, it is a supported one whose credential died. The models
    // merge lets the incoming pin win, so without this the pull persisted a pin
    // naming a provider that is not there — and the router throws on that
    // rather than falling back to the provider that still works.
    const local = cfg({ providers: [{ type: 'openai', apiKey: 'sk-openai' }], models: { t1: 'gpt-5' } });
    const stale = {
      v: 2,
      providers: [{ type: 'anthropic', authToken: 'sk-ant-oat01-dead', credentialSource: 'Claude Code' }],
      models: { t1: 'anthropic:claude-opus-4' },
    } as unknown as Parameters<typeof applySyncBundle>[0];

    const cleanup = { removed: [] as string[], clearedPins: [] as string[] };
    const merged = applySyncBundle(stale, local, cleanup as never);
    expect((merged.models as Record<string, unknown>)['t1']).toBeUndefined();
    expect(cleanup.clearedPins).toContain('t1');
  });

  it('leaves the pin alone when the local side still has a usable Anthropic key', () => {
    // The pin resolves fine — clearing it would be data loss caused by a stale
    // remote snapshot, which is the same reasoning the retired-pin
    // reconciliation already applies.
    const local = cfg({ providers: [{ type: 'anthropic', apiKey: 'sk-ant-good' }] });
    const stale = {
      v: 2,
      providers: [{ type: 'anthropic', authToken: 'sk-ant-oat01-dead', credentialSource: 'Claude Code' }],
      models: { t1: 'anthropic:claude-opus-4' },
    } as unknown as Parameters<typeof applySyncBundle>[0];

    const merged = applySyncBundle(stale, local);
    expect((merged.models as Record<string, unknown>)['t1']).toBe('anthropic:claude-opus-4');
  });
});
