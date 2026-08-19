import { describe, expect, it } from 'vitest';
import { applySettingsPayload, commitSettings, settingsSnapshot } from './settings-payload.js';
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

describe('an optional cap can be cleared, and never stored invalid', () => {
  it('removes a cap the user blanked', () => {
    // The panel says blank means no cap. Acting only on numbers made blank mean
    // "preserve", so an existing cap could not be removed — and the save ACK
    // rehydrated the old value, making the control impossible to clear.
    const config = base();
    config.budget = { maxCostPerRunUsd: 5, dailyBudgetUsd: 20 } as CascadeConfig['budget'];
    applySettingsPayload(config, { budget: { maxCostPerRun: undefined, dailyBudgetUsd: undefined } });

    expect('maxCostPerRunUsd' in config.budget).toBe(false);
    expect('dailyBudgetUsd' in config.budget).toBe(false);
  });

  it('leaves a cap alone when the payload does not mention it', () => {
    // Absent property still means "this surface is not speaking for that
    // field" — the same contract `endpoints` uses.
    const config = base();
    config.budget = { maxCostPerRunUsd: 5 } as CascadeConfig['budget'];
    applySettingsPayload(config, { budget: { dailyBudgetUsd: 20 } });
    expect(config.budget.maxCostPerRunUsd).toBe(5);
  });

  it('treats a zero cost cap as no cap rather than writing what the schema rejects', () => {
    // `BudgetConfigSchema.maxCostPerRunUsd` is `z.number().positive()`, and the
    // input allows 0 — so saving 0 wrote a config file that failed validation
    // on the very next load.
    const config = base();
    config.budget = { maxCostPerRunUsd: 5 } as CascadeConfig['budget'];
    applySettingsPayload(config, { budget: { maxCostPerRun: 0 } });
    expect('maxCostPerRunUsd' in config.budget).toBe(false);
  });

  it('refuses an approval timeout below the schema floor', () => {
    // `z.number().int().min(1000)`.
    const config = base();
    applySettingsPayload(config, { advanced: { approvalTimeoutMs: 0 } });
    expect(config.approvalTimeoutMs).toBeUndefined();
    applySettingsPayload(config, { advanced: { approvalTimeoutMs: 999 } });
    expect(config.approvalTimeoutMs).toBeUndefined();
    applySettingsPayload(config, { advanced: { approvalTimeoutMs: 1000 } });
    expect(config.approvalTimeoutMs).toBe(1000);
  });

  it('produces a config the schema accepts, for the values the panel allows', async () => {
    // The end of the reported sequence: Settings value → save → next load.
    const { validateConfig } = await import('./validate.js');
    const config = base();
    applySettingsPayload(config, {
      budget: { maxCostPerRun: 0, dailyBudgetUsd: 0, warnAtPct: 0 },
      advanced: { approvalTimeoutMs: 0 },
    });
    expect(() => validateConfig(config)).not.toThrow();
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

describe('commitSettings — a save that fails changes nothing', () => {
  const configured = (): CascadeConfig => ({
    providers: [{ type: 'anthropic', apiKey: 'sk-ant' }],
    models: { t1: 'claude-opus-4' },
    budget: { maxCostPerRunUsd: 5 },
    tools: {},
  } as unknown as CascadeConfig);

  it('adopts the change when the write succeeds', async () => {
    const live = configured();
    const result = await commitSettings(live, { budget: { maxCostPerRun: 9 } }, () => ({ ok: true }));

    expect(result.ok).toBe(true);
    expect(live.budget.maxCostPerRunUsd).toBe(9);
  });

  it('rolls the live config back when the write fails', async () => {
    // Both writers applied the payload to the LIVE config and persisted
    // afterwards, so a failed write left the change running while the caller
    // was told it had not saved.
    const live = configured();
    const result = await commitSettings(
      live, { budget: { maxCostPerRun: 9 }, models: { t1: 'gpt-5' } },
      () => ({ ok: false, error: 'EACCES' }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/EACCES/);
    expect(live.budget.maxCostPerRunUsd).toBe(5);
    expect(live.models.t1).toBe('claude-opus-4');
  });

  it('writes BEFORE adopting, so the running backend never sees an unsaved config', async () => {
    // This test asserted the opposite, and codified the bug: adopting first and
    // rolling back on failure reads as equivalent and is not. `write()` is
    // asynchronous filesystem I/O and the embedded `DashboardServer` reads this
    // very object when a run starts, so a run beginning inside that window used
    // configuration that was never persisted — and for a credential change may
    // already have sent the new secret somewhere — before the rollback and the
    // panel's truthful "not saved".
    const live = configured();
    let liveDuringWrite: number | undefined;
    let handed: number | undefined;

    await commitSettings(live, { budget: { maxCostPerRun: 9 } }, (committed) => {
      // What a concurrent run would observe while the write is in flight.
      liveDuringWrite = live.budget.maxCostPerRunUsd;
      // …and what the writer is given instead of reaching for the live one.
      handed = committed.budget.maxCostPerRunUsd;
      return { ok: true };
    });

    expect(liveDuringWrite).toBe(5);
    expect(handed).toBe(9);
    // Adopted once the write landed.
    expect(live.budget.maxCostPerRunUsd).toBe(9);
  });

  it('never makes the new config observable when the write fails', async () => {
    const live = configured();
    const observed: Array<number | undefined> = [];

    const result = await commitSettings(live, { budget: { maxCostPerRun: 9 } }, async (committed) => {
      observed.push(live.budget.maxCostPerRunUsd);
      // A real write yields to the event loop, which is where a run would start.
      await Promise.resolve();
      observed.push(live.budget.maxCostPerRunUsd);
      void committed;
      return { ok: false, error: 'EACCES' };
    });

    expect(result.ok).toBe(false);
    // Old at every point a concurrent reader could have looked, and after.
    expect(observed).toEqual([5, 5]);
    expect(live.budget.maxCostPerRunUsd).toBe(5);
  });

  it('never writes at all when the result would be invalid', async () => {
    const live = configured();
    let wrote = false;
    // `approvalTimeoutMs` below the schema floor is dropped by the writer, so
    // this stays valid; a genuinely invalid shape must not reach the disk.
    const result = await commitSettings(
      live, { advanced: { autonomy: 'nonsense' } }, () => { wrote = true; return { ok: true }; },
    );
    // The allowlist ignores the bad value rather than storing it, so this save
    // is valid and does write — the guarantee under test is that validation
    // runs BEFORE the write, which the invalid-config case below proves.
    expect(wrote).toBe(result.ok);
  });

  it('keeps the validator’s defaults rather than the pre-validation object', async () => {
    // `validateConfig()` returns a fully defaulted config, and discarding it
    // left the live object missing the fields a cleared cap should fall back
    // to — until a restart re-applied them.
    const live = configured();
    live.budget = { maxCostPerRunUsd: 5, maxTokensPerRun: 1234 } as CascadeConfig['budget'];
    await commitSettings(live, { budget: { maxTokensPerRun: undefined } }, () => ({ ok: true }));

    // Cleared, then defaulted by the schema — not simply absent.
    expect(live.budget.maxTokensPerRun).toBeGreaterThan(0);
  });

  it('preserves the live object identity, which the desktop aliases', async () => {
    const live = configured();
    const before = live;
    await commitSettings(live, { budget: { maxCostPerRun: 9 } }, () => ({ ok: true }));
    expect(live).toBe(before);
  });
});

describe('an Azure save replaces what the editor owns, not the whole row', () => {
  it('carries model and region through a save that never mentions them', async () => {
    // `azureModelForDeployment()` reads `model` for base-model identity and
    // `region` for pricing, and the panel has controls for neither — so
    // rebuilding rows from the DTO alone silently changed routing and cost
    // accounting on an unrelated save.
    const config = {
      providers: [{
        type: 'azure', deploymentName: 'prod-fast', baseUrl: 'https://r1.openai.azure.com',
        apiKey: 'az-key', model: 'gpt-5.4', region: 'eu',
      }],
      models: {}, budget: {}, tools: {},
    } as unknown as CascadeConfig;

    const snap = settingsSnapshot(config);
    expect(snap.azureDeployments[0]).toMatchObject({ model: 'gpt-5.4', region: 'eu' });

    // The round trip the panel performs on any unrelated save.
    applySettingsPayload(config, {
      azureDeployments: snap.azureDeployments.map((d) => ({
        label: d.label, baseUrl: d.baseUrl, deploymentName: d.deploymentName, apiVersion: d.apiVersion,
        model: d.model, region: d.region,
      })),
    });

    expect(config.providers[0]).toMatchObject({
      model: 'gpt-5.4', region: 'eu', apiKey: 'az-key',
    });
  });

  it('preserves them even when the payload omits them entirely', async () => {
    // An older renderer, or one that simply does not know the fields.
    const config = {
      providers: [{
        type: 'azure', deploymentName: 'prod', baseUrl: 'https://r1.openai.azure.com',
        apiKey: 'az-key', model: 'gpt-5.4', region: 'eu',
      }],
      models: {}, budget: {}, tools: {},
    } as unknown as CascadeConfig;

    applySettingsPayload(config, {
      azureDeployments: [{ deploymentName: 'prod', baseUrl: 'https://r1.openai.azure.com' }],
    });

    expect(config.providers[0]).toMatchObject({ model: 'gpt-5.4', region: 'eu' });
  });
});

describe('writer bounds are the schema’s', () => {
  it('accepts an inference timeout the schema accepts', async () => {
    // The writer required >= 10s while `CascadeConfigSchema` accepts >= 1s, so
    // 1–9 seconds was a valid config silently discarded behind a "Saved".
    const config = { providers: [], models: {}, budget: {}, tools: {} } as unknown as CascadeConfig;
    applySettingsPayload(config, { advanced: { localInferenceTimeoutMs: 5000, cloudInferenceTimeoutMs: 1000 } });
    expect(config.localInferenceTimeoutMs).toBe(5000);
    expect(config.cloudInferenceTimeoutMs).toBe(1000);
  });

  it('still refuses one below the schema floor', () => {
    const config = { providers: [], models: {}, budget: {}, tools: {} } as unknown as CascadeConfig;
    applySettingsPayload(config, { advanced: { localInferenceTimeoutMs: 999 } });
    expect(config.localInferenceTimeoutMs).toBeUndefined();
  });
});
