// ─────────────────────────────────────────────
//  Cascade AI — `cascade link` Command
// ─────────────────────────────────────────────
//
//  Reuse credentials you already have from other AI CLIs (Claude Code,
//  Codex, Gemini CLI, GitHub Copilot) instead of pasting keys again.
//
//    cascade link                 List detected credentials
//    cascade link <provider>      Adopt the best credential for a provider
//        --accept-risk            Required for any bearer-token credential
//
//  ⚠ Subscription OAuth tokens are NOT adoptable. Each is locked to its own
//  vendor's backend, and Anthropic prohibits third-party use of Claude
//  subscription credentials outright. `cascade link` surfaces them so the
//  user knows what is on the machine, and refuses to configure a provider
//  that cannot work. Cascade only reads YOUR local files.

import chalk from 'chalk';
import { ConfigManager } from '../../config/index.js';
import { normalizeAzureEndpoint, sameAzureEndpoint } from '../../config/azure-endpoint.js';
import {
  discoverCredentials,
  maskSecret,
  OPENAI_COMPATIBLE_ENV,
  type DiscoveredCredential,
} from '../../config/credential-discovery.js';
import type { ProviderConfig, ProviderType } from '../../types.js';

export interface LinkOptions {
  /**
   * Deprecated and inert. It gated adoption of a subscription OAuth token,
   * which Anthropic now prohibits and refuses server-side — so every such
   * credential is reported unusable and returns before any adoption path. Kept
   * so `cascade link --accept-risk` in an existing script does not fail on an
   * unknown option; the refusal says explicitly that it no longer applies.
   */
  acceptRisk?: boolean;
  workspace?: string;
}

export async function linkCommand(target: string | undefined, options: LinkOptions = {}): Promise<void> {
  const found = await discoverCredentials();

  if (found.length === 0) {
    console.log(chalk.yellow('\n  No reusable credentials found.\n'));
    console.log(chalk.gray('  Cascade looks for Claude Code, Codex, Gemini CLI, and GitHub Copilot logins,'));
    console.log(chalk.gray('  plus ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY in your environment.\n'));
    return;
  }

  if (!target) {
    printDiscovered(found);
    return;
  }

  const resolved = normalizeProvider(target);
  if (!resolved) {
    const services = OPENAI_COMPATIBLE_ENV.map((s) => s.id).join(', ');
    console.log(chalk.red(`\n  Unknown provider "${target}".`));
    console.log(chalk.gray(`  Use one of: anthropic, openai, gemini, azure, openai-compatible`));
    console.log(chalk.gray(`  …or name a compatible service directly: ${services}\n`));
    return;
  }
  const { provider, serviceId } = resolved;

  // Prefer a directly-usable credential for this provider. When the target
  // named a specific OpenAI-compatible service, only that service's key
  // counts — they all share one provider type, so matching on type alone
  // would configure whichever key happened to be discovered first.
  const candidates = found.filter((c) => c.provider === provider
    && (!serviceId || c.serviceId === serviceId));

  // The bare `openai-compatible` target names a TYPE, and several services
  // share it. With keys for more than one exported, picking the first left the
  // choice to the order of a table in credential-discovery.ts and silently
  // overwrote the single compatible provider entry with whichever service that
  // happened to be. The user knows which one they meant; ask for it by name.
  const services = [...new Set(candidates.map((c) => c.serviceId).filter((id): id is string => !!id))];
  if (!serviceId && services.length > 1) {
    console.log(chalk.yellow(`\n  Keys for several OpenAI-compatible services are set, and "${target}" does not say which.`));
    console.log(chalk.gray('  Name the one you mean:\n'));
    for (const id of services) console.log(chalk.cyan(`      cascade link ${id}`));
    console.log('');
    return;
  }

  const chosen = candidates.find((c) => c.directlyUsable) ?? candidates[0];
  if (!chosen) {
    console.log(chalk.yellow(`\n  No detected credential maps to "${provider}".\n`));
    return;
  }

  // Azure's routing can come from the workspace instead of the environment.
  // Discovery only sees env vars, so a key exported beside deployments that
  // are ALREADY fully configured looked unusable — and bailing here made the
  // fill-into-existing-deployments path below reachable only by re-exporting
  // routing the config already had.
  const cm = new ConfigManager(options.workspace ?? process.cwd());
  await cm.load();
  // Routing can live in the workspace rather than the environment. Discovery
  // sees env vars only, so it cannot know that — and the bearer warning it
  // writes says "or configure `baseUrl` for the anthropic provider", advice
  // this gate then refused to honour.
  const configured = cm.getConfig().providers;
  const routedByConfig = isRoutedByConfig(chosen, configured);

  if (!chosen.directlyUsable && !routedByConfig) {
    console.log(chalk.yellow(`\n  Found a ${chosen.sourceTool} credential, but it can't be used against the standard ${provider} API.`));
    if (chosen.warning) console.log(chalk.gray(`  ${chosen.warning}`));
    console.log(chalk.gray('  Cascade won\'t adopt it because it would create a non-working provider.\n'));
    // `--accept-risk` used to be the way past this for a subscription token, so
    // silently ignoring it would leave the user waiting for an effect that is
    // never coming. There is no risk left to accept: the token is refused at
    // the API, so adopting it cannot produce a working provider.
    if (options.acceptRisk && chosen.kind === 'oauth') {
      console.log(chalk.gray('  --accept-risk no longer applies — a subscription token is refused by the'));
      console.log(chalk.gray('  provider itself, so there is no working configuration to opt into.\n'));
    }
    // Say what WOULD work, rather than leaving the user at a dead end.
    console.log(chalk.gray(`  Set ${chalk.white(envKeyFor(provider))} instead, or add a key with `) + chalk.cyan('cascade init') + chalk.gray('.\n'));
    return;
  }

  // Adoption can decline — several Azure resources with nothing to choose
  // between them, for one — and it explains why when it does. Printing
  // "✓ Linked" and "run cascade doctor to verify" over that told the user the
  // opposite of what had just happened.
  const adopted = await adoptCredential(chosen, cm);
  if (!adopted) return;
  console.log(chalk.green(`\n  ✓ Linked ${provider} using your ${chosen.sourceTool} credential (${maskSecret(chosen.secret)}).`));
  if (chosen.kind === 'bearer') {
    console.log(chalk.gray('  Adopted as a bearer token — set `baseUrl` to the gateway that issued it.'));
  }
  console.log(chalk.gray('  Run `cascade doctor` to verify, or `cascade` to start.\n'));
}

/**
 * Whether the LOADED configuration already supplies the routing a credential
 * needs but the environment did not carry.
 *
 * Discovery sees environment variables only, so it cannot know that an Azure
 * deployment or an Anthropic gateway is already configured — it reports such a
 * credential `directlyUsable: false`. This command accepts it anyway, which
 * means `directlyUsable` alone is not the same question as "will linking work".
 *
 * Exported because `cascade doctor` has to ask the identical question: it was
 * reporting "none usable" about credentials this command adopts successfully a
 * moment later, and answering that from a second hand-written copy of the rule
 * is how these two drift.
 */
export function isRoutedByConfig(
  cred: Pick<DiscoveredCredential, 'provider' | 'kind'>,
  configured: readonly ProviderConfig[],
): boolean {
  if (cred.provider === 'azure') {
    return configured.some((p) => p.type === 'azure' && p.deploymentName?.trim() && p.baseUrl?.trim());
  }
  return cred.kind === 'bearer'
    && configured.some((p) => p.type === cred.provider && p.baseUrl?.trim());
}

function printDiscovered(found: DiscoveredCredential[]): void {
  console.log(chalk.magenta('\n  ◈ Detected credentials\n'));
  for (const c of found) {
    const usable = c.directlyUsable ? chalk.green('usable') : chalk.yellow('needs vendor backend');
    const kind = c.kind === 'oauth' ? chalk.yellow('subscription')
      : c.kind === 'bearer' ? chalk.cyan('bearer')
      : chalk.gray('api-key');
    console.log(`  ${chalk.white(c.provider.padEnd(18))} ${chalk.gray(maskSecret(c.secret).padEnd(12))} ${kind}  ${usable}`);
    console.log(chalk.gray(`    from ${c.sourceTool}`));
    if (c.warning) console.log(chalk.yellow(`    ⚠ ${c.warning}`));
  }
  console.log(chalk.gray('\n  Adopt one with:  ') + chalk.cyan('cascade link <provider>'));
  console.log(chalk.gray('  Subscription tokens are listed for visibility and cannot be adopted.\n'));
}

/** The env var that would configure this provider the supported way. */
function envKeyFor(provider: ProviderType): string {
  if (provider === 'openai') return 'OPENAI_API_KEY';
  if (provider === 'gemini') return 'GEMINI_API_KEY';
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'azure') return 'AZURE_OPENAI_KEY';
  return 'the provider\'s API key';
}

/**
 * A link target resolves to a provider type, and — for the OpenAI-compatible
 * services, which all share one type — which service was actually meant.
 */
function normalizeProvider(target: string): { provider: ProviderType; serviceId?: string } | null {
  const t = target.toLowerCase();
  if (t === 'anthropic' || t === 'claude' || t === 'claude-code') return { provider: 'anthropic' };
  if (t === 'openai' || t === 'codex' || t === 'gpt') return { provider: 'openai' };
  if (t === 'gemini' || t === 'google') return { provider: 'gemini' };
  if (t === 'azure' || t === 'azure-openai') return { provider: 'azure' };
  if (t === 'openai-compatible' || t === 'compatible') return { provider: 'openai-compatible' };
  // Naming the service is how a user actually thinks about this: they have a
  // Groq key, not an "openai-compatible" key.
  const service = OPENAI_COMPATIBLE_ENV.find((s) => s.id === t || s.label.toLowerCase() === t);
  if (service) return { provider: 'openai-compatible', serviceId: service.id };
  return null;
}

async function adoptCredential(cred: DiscoveredCredential, cm: ConfigManager): Promise<boolean> {
  const config = cm.getConfig();

  // Azure is configured one entry PER DEPLOYMENT — `init()` maps each to its
  // own model, and the deployment name IS the model id. Collapsing them to a
  // single entry, as the replace-by-type path below does, would delete every
  // other deployment's name, endpoint and key, and the save is authoritative
  // for the global credential store, so they would not come back. A key is not
  // a reason to forget a user's topology: fill it into the deployments that
  // are already there and leave everything else alone.
  const azureDeployments = cred.provider === 'azure'
    ? config.providers.filter((p) => p.type === 'azure' && p.deploymentName?.trim())
    : [];
  if (azureDeployments.length > 0) {
    // A FULLY ROUTED credential names the deployment it belongs to, so there is
    // nothing to infer: upsert that exact row. Requiring its endpoint to already
    // exist meant a key exported with a brand-new resource — everything needed
    // to add it — was refused, and a new deployment on a known resource silently
    // updated the old rows without ever being created.
    const target = cred.baseUrl?.trim();
    const deployment = cred.deploymentName?.trim();
    if (target && deployment) {
      // Endpoints compared through the shared normalizer, not as typed. The
      // provider strips trailing slashes before it builds a client, so
      // `https://acme.openai.azure.com` and the same URL with one address the
      // same resource — but an exact comparison called them different, missed
      // the existing row, and appended a DUPLICATE deployment. The router takes
      // the first row matching a deployment name, so it kept using the old
      // keyless one while this printed "✓ Linked".
      const existing = config.providers.find((p) => p.type === 'azure'
        && sameAzureEndpoint(p.baseUrl, target)
        && (p.deploymentName?.trim() ?? '') === deployment);

      // A deployment name is the MODEL ID everywhere downstream, and the router
      // binds an Azure model with `deploymentName === model.id` — the first row
      // that matches, endpoint not consulted. So two resources each with a
      // `prod` deployment are indistinguishable once configured: appending the
      // second would create a row that can never be selected, while this
      // printed "✓ Linked" and requests carried on to the other resource.
      // Refusing is the honest answer — the same answer this function already
      // gives when several resources leave a key with nothing to choose
      // between them.
      const claimedElsewhere = !existing && config.providers.some((p) => p.type === 'azure'
        && (p.deploymentName?.trim() ?? '') === deployment
        && !sameAzureEndpoint(p.baseUrl, target));
      if (claimedElsewhere) {
        console.log(chalk.yellow(`\n  A different Azure resource already has a deployment named "${deployment}".`));
        console.log(chalk.gray('  Deployment names are model ids in Cascade, so two resources cannot share one —'));
        console.log(chalk.gray('  the second would never be selected. Rename one deployment, or remove the entry'));
        console.log(chalk.gray('  you no longer use, then run this again.\n'));
        return false;
      }

      const providers = existing
        ? config.providers.map((p) => (p === existing
          ? { ...p, apiKey: cred.secret, credentialSource: cred.sourceTool, ...(cred.apiVersion ? { apiVersion: cred.apiVersion } : {}) }
          : p))
        : [...config.providers, {
          type: 'azure' as const,
          apiKey: cred.secret,
          baseUrl: target,
          deploymentName: deployment,
          ...(cred.apiVersion ? { apiVersion: cred.apiVersion } : {}),
          credentialSource: cred.sourceTool,
        }];
      await cm.updateConfig({ providers });
      return true;
    }

    // Routing came from the workspace instead. An Azure key belongs to ONE
    // RESOURCE, so writing it across every deployment would break the ones on
    // other resources and overwrite keys they already had — permanently, since
    // the save is authoritative for the global credential store.
    //
    // An exported AZURE_OPENAI_ENDPOINT names that resource even when no
    // deployment name came with it, so it narrows the candidates before the
    // ambiguity check rather than after. Counting every configured resource
    // first refused a key whose resource was never in doubt — and because the
    // refusal returns before updateConfig(), the key injectEnvKeys had already
    // put into those deployments in memory was never persisted, so the command
    // failed with the routing sitting right there.
    const scoped = target
      ? azureDeployments.filter((p) => sameAzureEndpoint(p.baseUrl, target))
      : azureDeployments;
    const resources = [...new Set(scoped.map((p) => normalizeAzureEndpoint(p.baseUrl)))];
    if (resources.length !== 1) {
      const all = [...new Set(azureDeployments.map((p) => normalizeAzureEndpoint(p.baseUrl)))];
      if (target && scoped.length === 0) {
        console.log(chalk.yellow(`\n  No configured Azure deployment is on ${target}.`));
        console.log(chalk.gray('  Set AZURE_OPENAI_DEPLOYMENT as well to add one, or point'));
        console.log(chalk.gray('  AZURE_OPENAI_ENDPOINT at a resource you have configured:\n'));
      } else {
        console.log(chalk.yellow('\n  Several Azure resources are configured, and an Azure key belongs to one of them.'));
        console.log(chalk.gray('  Set AZURE_OPENAI_ENDPOINT to the resource this key is for, then run again:\n'));
      }
      for (const r of all) console.log(chalk.gray(`      ${r || '(no endpoint set)'}`));
      console.log('');
      return false;
    }
    const only = resources[0];
    const providers = config.providers.map((p) => (
      p.type === 'azure' && p.deploymentName?.trim() && normalizeAzureEndpoint(p.baseUrl) === only
        ? { ...p, apiKey: cred.secret, credentialSource: cred.sourceTool }
        : p
    ));
    await cm.updateConfig({ providers });
    return true;
  }

  // Build ON TOP of whatever is already configured for this provider. The
  // entry is replaced wholesale below, so starting from scratch discarded
  // every non-credential field the user had set — `baseUrl` above all. That
  // was invisible while the Anthropic client ignored baseUrl; now that it
  // honours it, linking a gateway token would have wiped the gateway and sent
  // the token to api.anthropic.com, which is the one place it is not valid.
  const existing = config.providers.find((p) => p.type === cred.provider);
  const next: ProviderConfig = {
    ...existing,
    type: cred.provider,
    credentialSource: cred.sourceTool,
    // Both cleared first: adopting a credential REPLACES the old one, and
    // leaving a stale key beside a new token makes which one is in use depend
    // on provider-internal precedence.
    apiKey: undefined,
    authToken: undefined,
  };
  // A bearer token goes to authToken; everything else is an API key. The only
  // bearer credential discovery still yields is ANTHROPIC_AUTH_TOKEN, which is
  // the gateway case Anthropic documents.
  if (cred.kind === 'bearer') {
    next.authToken = cred.secret;
  } else {
    next.apiKey = cred.secret;
  }
  // A discovered endpoint wins over a configured one — it is the endpoint this
  // particular key belongs to. Without one, whatever was already there stands.
  if (cred.baseUrl) {
    next.baseUrl = cred.baseUrl;
    // `local` is a statement about the endpoint that is being REPLACED. Carried
    // across by the spread above, a self-hosted entry's `local: true` would
    // survive onto a hosted URL — and isLocalEndpoint() gives an explicit
    // `local` precedence over the URL, so every model from that paid service
    // would be priced at zero and slip the budget caps entirely. Dropping it
    // lets it be recomputed from the new URL, in both directions.
    delete next.local;
  }
  // Azure's routing is as required as its key; discovery only reports the
  // credential as usable when it carried both.
  if (cred.deploymentName) next.deploymentName = cred.deploymentName;
  if (cred.apiVersion) next.apiVersion = cred.apiVersion;

  const providers = config.providers.filter((p) => p.type !== cred.provider);
  providers.push(next);
  await cm.updateConfig({ providers });
  return true;
}
