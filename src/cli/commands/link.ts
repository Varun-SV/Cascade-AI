// ─────────────────────────────────────────────
//  Cascade AI — `cascade link` Command
// ─────────────────────────────────────────────
//
//  Reuse credentials you already have from other AI CLIs (Claude Code,
//  Codex, Gemini CLI, GitHub Copilot) instead of pasting keys again.
//
//    cascade link                 List detected credentials
//    cascade link <provider>      Adopt the best credential for a provider
//        --accept-risk            Required to adopt a subscription OAuth token
//
//  ⚠ Adopting a subscription OAuth token (e.g. Claude Code) reuses it
//  outside its own CLI, which may violate the vendor's terms of service.
//  Cascade only reads YOUR local files and never adopts an OAuth token
//  without --accept-risk.

import chalk from 'chalk';
import { ConfigManager } from '../../config/index.js';
import {
  discoverCredentials,
  maskSecret,
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

  const provider = normalizeProvider(target);
  if (!provider) {
    console.log(chalk.red(`\n  Unknown provider "${target}". Use one of: anthropic, openai, gemini.\n`));
    return;
  }

  // Prefer a directly-usable credential for this provider.
  const candidates = found.filter((c) => c.provider === provider);
  const chosen = candidates.find((c) => c.directlyUsable) ?? candidates[0];
  if (!chosen) {
    console.log(chalk.yellow(`\n  No detected credential maps to "${provider}".\n`));
    return;
  }

  if (!chosen.directlyUsable) {
    console.log(chalk.yellow(`\n  Found a ${chosen.sourceTool} credential, but it can't be used against the standard ${provider} API.`));
    if (chosen.warning) console.log(chalk.gray(`  ${chosen.warning}`));
    console.log(chalk.gray('  Cascade won\'t adopt it because it would create a non-working provider.\n'));
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

function normalizeProvider(target: string): ProviderType | null {
  const t = target.toLowerCase();
  if (t === 'anthropic' || t === 'claude' || t === 'claude-code') return 'anthropic';
  if (t === 'openai' || t === 'codex' || t === 'gpt') return 'openai';
  if (t === 'gemini' || t === 'google') return 'gemini';
  return null;
}

async function adoptCredential(cred: DiscoveredCredential, workspace: string): Promise<void> {
  const cm = new ConfigManager(workspace);
  await cm.load();
  const config = cm.getConfig();

  const next: ProviderConfig = {
    type: cred.provider,
    credentialSource: cred.sourceTool,
  };
  if (cred.kind === 'oauth' && cred.provider === 'anthropic') {
    next.authToken = cred.secret;
  } else {
    next.apiKey = cred.secret;
  }

  const providers = config.providers.filter((p) => p.type !== cred.provider);
  providers.push(next);
  await cm.updateConfig({ providers });
}
