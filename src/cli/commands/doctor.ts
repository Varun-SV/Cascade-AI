// ─────────────────────────────────────────────
//  Cascade AI — `cascade doctor` Command
// ─────────────────────────────────────────────

import chalk from 'chalk';
import path from 'node:path';
import { CASCADE_CONFIG_FILE, LM_STUDIO_BASE_URL, OLLAMA_BASE_URL } from '../../constants.js';
import { ConfigManager } from '../../config/index.js';
import { discoverCredentials, type DiscoveredCredential } from '../../config/credential-discovery.js';
import { isRoutedByConfig } from './link.js';
import type { ProviderConfig } from '../../types.js';

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

/**
 * What `doctor` says about credentials it found on the machine.
 *
 * Exported so the wording can be tested on its own rather than by running the
 * whole diagnostic. `cascade link` is only offered as a remedy when something
 * would actually be adopted: a machine whose one discovered credential is a
 * Claude subscription token — which link is required to refuse — was told to
 * run a command that cannot succeed, and a diagnostic prescribing an impossible
 * step reads as a mistake the user made rather than a credential Cascade is not
 * permitted to use.
 */
export function linkableCredentialsDetail(
  discovered: ReadonlyArray<DiscoveredCredential>,
  configured: readonly ProviderConfig[] = [],
): string {
  // `directlyUsable` is the ENVIRONMENT's view. `cascade link` also adopts a
  // credential whose routing is already in the config — an Azure key beside
  // configured deployments, a bearer beside a configured gateway — so counting
  // the flag alone reported "none usable" immediately before link succeeded
  // with one. Same question, same answer, one function.
  const usable = discovered.filter((d) => d.directlyUsable || isRoutedByConfig(d, configured)).length;
  return usable > 0
    ? `${discovered.length} found (${usable} usable) — run \`cascade link\` to adopt`
    : `${discovered.length} found, none usable — run \`cascade link\` to see why`;
}

export async function doctorCommand(): Promise<void> {
  console.log(chalk.magenta('\n  ◈ Cascade Doctor — System Diagnostics\n'));

  const checks: CheckResult[] = [];

  // Node version
  const nodeVersion = process.versions.node;
  const [major] = nodeVersion.split('.').map(Number);
  checks.push({
    label: `Node.js ${nodeVersion}`,
    ok: (major ?? 0) >= 18,
    detail: (major ?? 0) < 18 ? 'Requires Node.js ≥ 18' : undefined,
  });

  const cm = new ConfigManager(process.cwd());
  await cm.load();
  const config = cm.getConfig();

  checks.push({
    label: 'Cascade config',
    ok: true,
    detail: `Loaded ${path.join(process.cwd(), CASCADE_CONFIG_FILE)}`,
  });

  // API keys from config/env/keystore
  const providers: Array<{ type: string; name: string }> = [
    { type: 'anthropic', name: 'Anthropic' },
    { type: 'openai', name: 'OpenAI' },
    { type: 'gemini', name: 'Google Gemini' },
    { type: 'azure', name: 'Azure OpenAI' },
  ];

  for (const { type, name } of providers) {
    // A bearer token configures a provider just as completely as a key does.
    // Checking only getApiKey() reported "Missing" for a provider that runs
    // fine — and `cascade link` sends the user straight here to verify, so the
    // first thing they saw after a successful link was a failure.
    const key = cm.getApiKey(type);
    const token = key ? undefined : cm.getAuthToken(type);
    checks.push({
      label: `${name} credential`,
      ok: Boolean(key || token),
      detail: key ? 'API key set' : token ? 'Bearer token set' : 'Missing',
    });
  }

  // Ollama
  const ollamaOk = await checkEndpoint(OLLAMA_BASE_URL + '/api/tags');
  checks.push({ label: 'Ollama (localhost:11434)', ok: ollamaOk, detail: ollamaOk ? 'Running' : 'Not running' });

  // LM Studio
  const lmOk = await checkEndpoint(LM_STUDIO_BASE_URL + '/v1/models');
  checks.push({ label: 'LM Studio (localhost:1234)', ok: lmOk, detail: lmOk ? 'Running' : 'Not running' });

  // Playwright
  let playwrightOk = false;
  try {
    await import('playwright');
    playwrightOk = true;
  } catch { /* not installed */ }
  checks.push({ label: 'Playwright (browser automation)', ok: playwrightOk, detail: playwrightOk ? 'Installed' : 'Optional — npm install playwright' });

  const hasOpenAICompatible = config.providers.some((provider) => provider.type === 'openai-compatible');
  if (hasOpenAICompatible) {
    checks.push({
      label: 'OpenAI-compatible endpoint',
      ok: config.providers.some((provider) => provider.type === 'openai-compatible' && Boolean(provider.baseUrl)),
      detail: 'Configured in .cascade/config.json',
    });
  }

  const dashboardPasswordConfigured = Boolean(process.env['CASCADE_DASHBOARD_PASSWORD']);
  checks.push({
    label: 'Dashboard auth',
    ok: !config.dashboard.auth || dashboardPasswordConfigured,
    detail: config.dashboard.auth
      ? (dashboardPasswordConfigured ? 'Password configured' : 'Missing CASCADE_DASHBOARD_PASSWORD')
      : 'Disabled',
  });

  const dashboardSecretConfigured = Boolean(config.dashboard.secret || process.env['CASCADE_DASHBOARD_SECRET']);
  checks.push({
    label: 'Dashboard JWT secret',
    ok: !config.dashboard.auth || dashboardSecretConfigured,
    detail: config.dashboard.auth
      ? (dashboardSecretConfigured ? 'Configured' : 'Persisted at .cascade/dashboard-secret (0600)')
      : 'Not required',
  });

  // Keystore backend (keytar if available, encrypted file otherwise)
  let keystoreBackend = 'file (AES-256-GCM)';
  try {
    await import('keytar');
    keystoreBackend = 'keytar (OS keychain)';
  } catch {
    // keytar not installed or failed to load (Alpine, headless)
  }
  checks.push({
    label: 'Keystore backend',
    ok: true,
    detail: keystoreBackend,
  });

  // Telemetry — opt-in only, displayed prominently so users can audit it.
  const telemetryEnabled = Boolean(config.telemetry?.enabled);
  checks.push({
    label: 'Telemetry',
    ok: true,
    detail: telemetryEnabled
      ? 'ON — toggle with `cascade telemetry off`'
      : 'OFF (default) — toggle with `cascade telemetry on`',
  });

  // Reusable credentials from other AI CLIs (Claude Code, Codex, Gemini, Copilot)
  try {
    const discovered = await discoverCredentials();
    if (discovered.length > 0) {
      checks.push({
        label: 'Linkable credentials',
        ok: true,
        detail: linkableCredentialsDetail(discovered, config.providers ?? []),
      });
    }
  } catch { /* discovery is best-effort */ }

  // Print results
  for (const c of checks) {
    const icon = c.ok ? chalk.green('  ✓') : chalk.yellow('  ○');
    const label = c.ok ? chalk.white(c.label) : chalk.gray(c.label);
    const detail = c.detail ? chalk.gray(` — ${c.detail}`) : '';
    console.log(`${icon}  ${label}${detail}`);
  }

  const failures = checks.filter((c) => !c.ok);
  console.log();

  if (failures.length === 0) {
    console.log(chalk.green('  All checks passed!\n'));
  } else {
    const critical = failures.filter((c) => c.label.includes('Node') || c.label.includes('credential'));
    if (critical.length) {
      console.log(chalk.yellow(`  ${critical.length} issue(s) need attention.\n`));
    } else {
      console.log(chalk.gray(`  ${failures.length} optional item(s) not configured.\n`));
    }
  }
}

async function checkEndpoint(url: string): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
