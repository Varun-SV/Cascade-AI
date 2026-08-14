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
import {
  discoverCredentials,
  maskSecret,
  OPENAI_COMPATIBLE_ENV,
  type DiscoveredCredential,
} from '../../config/credential-discovery.js';
import type { ProviderConfig, ProviderType } from '../../types.js';

export interface LinkOptions {
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
  const chosen = candidates.find((c) => c.directlyUsable) ?? candidates[0];
  if (!chosen) {
    console.log(chalk.yellow(`\n  No detected credential maps to "${provider}".\n`));
    return;
  }

  if (!chosen.directlyUsable) {
    console.log(chalk.yellow(`\n  Found a ${chosen.sourceTool} credential, but it can't be used against the standard ${provider} API.`));
    if (chosen.warning) console.log(chalk.gray(`  ${chosen.warning}`));
    console.log(chalk.gray('  Cascade won\'t adopt it because it would create a non-working provider.\n'));
    // Say what WOULD work, rather than leaving the user at a dead end.
    console.log(chalk.gray(`  Set ${chalk.white(envKeyFor(provider))} instead, or add a key with `) + chalk.cyan('cascade init') + chalk.gray('.\n'));
    return;
  }

  if (chosen.kind === 'oauth' && !options.acceptRisk) {
    console.log(chalk.yellow(`\n  ${chosen.sourceTool} provides a subscription OAuth token, not an API key.`));
    if (chosen.warning) console.log(chalk.gray(`  ${chosen.warning}`));
    console.log(chalk.gray('  Re-run with --accept-risk to adopt it anyway:\n'));
    console.log(chalk.cyan(`      cascade link ${provider} --accept-risk\n`));
    return;
  }

  await adoptCredential(chosen, options.workspace ?? process.cwd());
  console.log(chalk.green(`\n  ✓ Linked ${provider} using your ${chosen.sourceTool} credential (${maskSecret(chosen.secret)}).`));
  if (chosen.kind === 'oauth') {
    console.log(chalk.gray('  Adopted as an OAuth bearer token — revoke it in the source tool to disable.'));
  }
  console.log(chalk.gray('  Run `cascade doctor` to verify, or `cascade` to start.\n'));
}

function printDiscovered(found: DiscoveredCredential[]): void {
  console.log(chalk.magenta('\n  ◈ Detected credentials\n'));
  for (const c of found) {
    const usable = c.directlyUsable ? chalk.green('usable') : chalk.yellow('needs vendor backend');
    const kind = c.kind === 'oauth' ? chalk.yellow('oauth') : chalk.gray('api-key');
    console.log(`  ${chalk.white(c.provider.padEnd(18))} ${chalk.gray(maskSecret(c.secret).padEnd(12))} ${kind}  ${usable}`);
    console.log(chalk.gray(`    from ${c.sourceTool}`));
    if (c.warning) console.log(chalk.yellow(`    ⚠ ${c.warning}`));
  }
  console.log(chalk.gray('\n  Adopt one with:  ') + chalk.cyan('cascade link <provider> [--accept-risk]'));
  console.log(chalk.gray('  --accept-risk is required for subscription OAuth tokens.\n'));
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

async function adoptCredential(cred: DiscoveredCredential, workspace: string): Promise<void> {
  const cm = new ConfigManager(workspace);
  await cm.load();
  const config = cm.getConfig();

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
  if (cred.kind === 'oauth' && cred.provider === 'anthropic') {
    next.authToken = cred.secret;
  } else {
    next.apiKey = cred.secret;
  }
  // A discovered endpoint wins over a configured one — it is the endpoint this
  // particular key belongs to. Without one, whatever was already there stands.
  if (cred.baseUrl) next.baseUrl = cred.baseUrl;

  const providers = config.providers.filter((p) => p.type !== cred.provider);
  providers.push(next);
  await cm.updateConfig({ providers });
}
