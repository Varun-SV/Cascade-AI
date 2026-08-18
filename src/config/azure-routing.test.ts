import { describe, expect, it } from 'vitest';
import { resolveAzureRouting, type AzureRow } from './azure-routing.js';

const row = (deploymentName: string, baseUrl: string): AzureRow =>
  ({ type: 'azure', deploymentName, baseUrl });

describe('resolveAzureRouting', () => {
  it('refuses a deployment name that exists on two resources', () => {
    // Both callers used `find(...)`, which takes whichever row comes first — so
    // an exported key silently rotated an arbitrary one of the two resources.
    // A deployment name is unique only WITHIN a resource; two owners is a real
    // ambiguity.
    const view = [
      row('prod', 'https://resource-a.openai.azure.com'),
      row('prod', 'https://resource-b.openai.azure.com'),
    ];
    const result = resolveAzureRouting(view, view, { deployment: 'prod' });
    expect(result).toMatchObject({ ok: false, reason: 'ambiguous-resource' });
    expect((result as { resources: string[] }).resources).toHaveLength(2);
  });

  it('pins the resource from a deployment name that is unique', () => {
    const view = [
      row('prod', 'https://resource-a.openai.azure.com'),
      row('dev', 'https://resource-b.openai.azure.com'),
    ];
    expect(resolveAzureRouting(view, view, { deployment: 'prod' }))
      .toMatchObject({ ok: true, resource: 'https://resource-a.openai.azure.com' });
  });

  it('raises the collision when an endpoint is named and the deployment lives elsewhere', () => {
    // The second variant: endpoint B + deployment `prod`, where `prod` is on A.
    // The upsert guard checked the name GLOBALLY, so seeing A/prod suppressed
    // creating B/prod — the key rotated B's siblings and the supplied
    // deployment was silently discarded instead of raising the collision.
    const view = [
      row('prod', 'https://resource-a.openai.azure.com'),
      row('other', 'https://resource-b.openai.azure.com'),
    ];
    expect(resolveAzureRouting(view, view, {
      endpoint: 'https://resource-b.openai.azure.com',
      deployment: 'prod',
    })).toMatchObject({ ok: false, reason: 'name-on-another-resource' });
  });

  it('creates a deployment named on a resource that does not have it yet', () => {
    const view = [row('other', 'https://resource-b.openai.azure.com')];
    expect(resolveAzureRouting(view, view, {
      endpoint: 'https://resource-b.openai.azure.com',
      deployment: 'prod',
    })).toMatchObject({
      ok: true,
      resource: 'https://resource-b.openai.azure.com',
      createDeployment: 'prod',
    });
  });

  it('does not re-create a deployment that is already on the resource', () => {
    const view = [row('prod', 'https://resource-a.openai.azure.com')];
    const result = resolveAzureRouting(view, view, { deployment: 'prod' });
    expect(result).toMatchObject({ ok: true });
    expect((result as { createDeployment?: string }).createDeployment).toBeUndefined();
  });

  it('uses a sole configured resource when nothing is named', () => {
    const view = [
      row('a', 'https://resource-a.openai.azure.com'),
      row('b', 'https://resource-a.openai.azure.com/'),
    ];
    expect(resolveAzureRouting(view, view, {})).toMatchObject({ ok: true });
  });

  it('refuses when several resources are configured and nothing is named', () => {
    const view = [
      row('a', 'https://resource-a.openai.azure.com'),
      row('b', 'https://resource-b.openai.azure.com'),
    ];
    expect(resolveAzureRouting(view, view, {})).toMatchObject({ ok: false, reason: 'ambiguous-resource' });
  });

  it('refuses an exported endpoint that nothing is configured on', () => {
    const view = [row('a', 'https://resource-a.openai.azure.com')];
    expect(resolveAzureRouting(view, view, { endpoint: 'https://elsewhere.openai.azure.com' }))
      .toMatchObject({ ok: false, reason: 'endpoint-not-configured' });
  });

  it('refuses when no row can route a request at all', () => {
    expect(resolveAzureRouting([{ type: 'azure', deploymentName: 'prod' }], [], {}))
      .toMatchObject({ ok: false, reason: 'no-routable-rows' });
  });

  it('returns only rows the caller may write, while deciding from the wider view', () => {
    // The global store informs the decision; only workspace rows are returned.
    const globalRow = row('prod', 'https://resource-a.openai.azure.com');
    const workspaceRow = row('dev', 'https://resource-a.openai.azure.com');
    const result = resolveAzureRouting([workspaceRow, globalRow], [workspaceRow], { deployment: 'prod' });
    expect(result).toMatchObject({ ok: true, resource: 'https://resource-a.openai.azure.com' });
    expect((result as { rows: AzureRow[] }).rows).toEqual([workspaceRow]);
    // `prod` exists on the resource in the view, so nothing is created.
    expect((result as { createDeployment?: string }).createDeployment).toBeUndefined();
  });
});
