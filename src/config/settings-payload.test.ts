import { describe, expect, it } from 'vitest';
import { applySettingsPayload, settingsSnapshot } from './settings-payload.js';
import type { CascadeConfig } from '../types.js';

// The socket handler applied keys, endpoints, models and TWO budget fields,
// while the panel sends one payload to it and to the desktop IPC bridge alike.
// Every control below reported a successful save on that path and changed
// nothing. They are asserted through the shared function precisely because
// having two implementations is what produced the gap.
const base = (): CascadeConfig => ({
  providers: [],
  models: {},
  budget: {},
  tools: {},
} as unknown as CascadeConfig);

describe('applySettingsPayload — the whole Settings save, not part of it', () => {
  it('applies the extended budget fields, not just maxCostPerRun', () => {
    const config = base();
    applySettingsPayload(config, {
      budget: {
        maxCostPerRun: 5, autoBias: 'quality',
        dailyBudgetUsd: 20, sessionBudgetUsd: 3,
        maxTokensPerRun: 90_000, warnAtPct: 75,
      },
    });

    expect(config.budget).toMatchObject({
      maxCostPerRunUsd: 5,
      dailyBudgetUsd: 20,
      sessionBudgetUsd: 3,
      maxTokensPerRun: 90_000,
      warnAtPct: 75,
    });
    expect(config.autoBias).toBe('quality');
  });

  it('rejects out-of-range budget values rather than storing them', () => {
    const config = base();
    applySettingsPayload(config, {
      budget: { dailyBudgetUsd: -1, maxTokensPerRun: 0, warnAtPct: 140 },
    });
    expect(config.budget.dailyBudgetUsd).toBeUndefined();
    expect(config.budget.maxTokensPerRun).toBeUndefined();
    expect(config.budget.warnAtPct).toBeUndefined();
  });

  it('replaces the Azure deployment list, inheriting keys within a resource only', () => {
    const config = base();
    config.providers = [
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', apiKey: 'a-key' },
      { type: 'anthropic', apiKey: 'sk-ant' },
    ] as CascadeConfig['providers'];

    applySettingsPayload(config, {
      azureDeployments: [
        // Blank key, same resource — inherits.
        { deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com' },
        // Blank key, DIFFERENT resource — inherits nothing.
        { deploymentName: 'chat', baseUrl: 'https://resource-b.openai.azure.com' },
        // Entirely empty rows the user added and abandoned are dropped.
        {},
      ],
    });

    const azure = config.providers.filter((p) => p.type === 'azure');
    expect(azure).toHaveLength(2);
    expect(azure[0]).toMatchObject({ deploymentName: 'prod', apiKey: 'a-key' });
    expect(azure[1]?.apiKey).toBeUndefined();
    // Non-Azure providers survive the list replacement.
    expect(config.providers.find((p) => p.type === 'anthropic')).toMatchObject({ apiKey: 'sk-ant' });
  });

  it('applies the web-search backends, keeping a blank key rather than clearing it', () => {
    const config = base();
    config.tools = { webSearch: { braveApiKey: 'kept', searxngUrl: 'http://old' } } as CascadeConfig['tools'];
    applySettingsPayload(config, {
      webSearch: { searxngUrl: 'http://searx.internal', braveApiKey: undefined, tavilyApiKey: 'new-tavily' },
    });

    expect(config.tools?.webSearch).toMatchObject({
      searxngUrl: 'http://searx.internal',
      braveApiKey: 'kept',
      tavilyApiKey: 'new-tavily',
    });
  });

  it('clears the SearxNG URL when it is emptied, which is a real edit', () => {
    const config = base();
    config.tools = { webSearch: { searxngUrl: 'http://old' } } as CascadeConfig['tools'];
    applySettingsPayload(config, { webSearch: { searxngUrl: '  ' } });
    expect(config.tools?.webSearch?.searxngUrl).toBeUndefined();
  });

  it('applies advanced settings through the allowlist and ignores anything else', () => {
    const config = base();
    applySettingsPayload(config, {
      advanced: {
        autonomy: 'auto',
        localConcurrency: 4,
        telemetryEnabled: false,
        // Out of range, wrong type, and not on the list at all.
        approvalTimeoutMs: -5,
        planApproval: 'sometimes',
        somethingElse: 'injected',
      },
    });

    expect(config.autonomy).toBe('auto');
    expect(config.localConcurrency).toBe(4);
    expect(config.telemetry?.enabled).toBe(false);
    expect(config.approvalTimeoutMs).toBeUndefined();
    expect(config.planApproval).toBeUndefined();
    expect((config as unknown as Record<string, unknown>)['somethingElse']).toBeUndefined();
  });

  it("deletes a model binding set to 'auto' rather than storing the word", () => {
    const config = base();
    config.models = { t1: 'claude-opus-4', t2: 'gpt-4o' } as CascadeConfig['models'];
    applySettingsPayload(config, { models: { t1: 'auto', t2: 'gpt-5' } });
    expect(config.models.t1).toBeUndefined();
    expect(config.models.t2).toBe('gpt-5');
  });

  it('still returns credential refusals from the same call', () => {
    const config = base();
    config.providers = [
      { type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' },
    ] as CascadeConfig['providers'];

    const result = applySettingsPayload(config, {
      keys: { 'openai-compatible': 'new-key' },
      endpoints: { 'openai-compatible': undefined },
      budget: { dailyBudgetUsd: 12 },
    });

    expect(result.refused).toEqual([{ type: 'openai-compatible', reason: 'unroutable' }]);
    // …and the rest of the payload still applied. A refused credential is not a
    // failed save.
    expect(config.budget.dailyBudgetUsd).toBe(12);
  });
});

describe('settingsSnapshot — as complete as the save is', () => {
  // The panel keeps its own defaults for any section a snapshot does not fill,
  // and serializes them on every save. While the socket save was also partial
  // that was merely incomplete; once the save applied the whole payload it
  // became destructive, so the snapshot has to carry everything the save can
  // write.
  const configured = (): CascadeConfig => ({
    providers: [
      { type: 'anthropic', apiKey: 'sk-ant', baseUrl: 'https://corp-gateway.example' },
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://r1.openai.azure.com', apiKey: 'az-key' },
      { type: 'openai', authToken: 'bearer-only', baseUrl: 'https://gw.example' },
    ],
    models: { t1: 'claude-opus-4' },
    budget: { maxCostPerRunUsd: 5, dailyBudgetUsd: 20, sessionBudgetUsd: 3, maxTokensPerRun: 90_000, warnAtPct: 75 },
    autoBias: 'quality',
    localConcurrency: 8,
    tools: { webSearch: { searxngUrl: 'http://searx.internal', braveApiKey: 'brave' } },
  } as unknown as CascadeConfig);

  it('carries every section the save can write', () => {
    const snap = settingsSnapshot(configured());

    expect(snap.budget).toMatchObject({
      maxCostPerRun: 5, dailyBudgetUsd: 20, sessionBudgetUsd: 3, maxTokensPerRun: 90_000, warnAtPct: 75,
      autoBias: 'quality',
    });
    expect(snap.azureDeployments).toEqual([
      { label: undefined, baseUrl: 'https://r1.openai.azure.com', deploymentName: 'prod', apiVersion: undefined, hasKey: true },
    ]);
    expect(snap.webSearch).toEqual({ searxngUrl: 'http://searx.internal', hasBraveKey: true, hasTavilyKey: false });
    expect(snap.advanced['localConcurrency']).toBe(8);
    expect(snap.endpoints).toEqual({ anthropic: 'https://corp-gateway.example', openai: 'https://gw.example' });
  });

  it('never returns a secret, only whether one is set', () => {
    const serialized = JSON.stringify(settingsSnapshot(configured()));
    expect(serialized).not.toContain('sk-ant');
    expect(serialized).not.toContain('az-key');
    expect(serialized).not.toContain('bearer-only');
    expect(serialized).not.toContain('brave');
  });

  it('counts a bearer-only provider as credentialled', () => {
    // Counting only `apiKey` showed a gateway-configured provider as
    // unconfigured in the panel.
    expect(settingsSnapshot(configured()).providersWithKey).toContain('openai');
  });

  it('round-trips: snapshot, save it back unchanged, nothing is lost', () => {
    // The reported failure in one assertion. The panel hydrates from the
    // snapshot and re-serializes every section on the next save, so anything
    // the snapshot omits comes back as a UI default and overwrites what was
    // stored.
    const config = configured();
    const snap = settingsSnapshot(config);

    applySettingsPayload(config, {
      models: snap.models,
      budget: snap.budget,
      azureDeployments: snap.azureDeployments.map((d) => ({
        label: d.label, baseUrl: d.baseUrl, deploymentName: d.deploymentName, apiVersion: d.apiVersion,
      })),
      webSearch: { searxngUrl: snap.webSearch.searxngUrl },
      advanced: snap.advanced,
    });

    expect(config.providers.filter((p) => p.type === 'azure')).toHaveLength(1);
    expect(config.providers.find((p) => p.type === 'azure')?.apiKey).toBe('az-key');
    expect(config.tools?.webSearch?.searxngUrl).toBe('http://searx.internal');
    expect(config.tools?.webSearch?.braveApiKey).toBe('brave');
    expect(config.localConcurrency).toBe(8);
    expect(config.budget.dailyBudgetUsd).toBe(20);
  });
});
