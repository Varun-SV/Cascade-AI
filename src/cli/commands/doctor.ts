// ─────────────────────────────────────────────
//  Cascade AI — `cascade doctor` Command
// ─────────────────────────────────────────────

import axios from 'axios';
import chalk from 'chalk';
import path from 'node:path';
import { CASCADE_CONFIG_FILE, LM_STUDIO_BASE_URL, OLLAMA_BASE_URL } from '../../constants.js';
import { ConfigManager } from '../../config/index.js';

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
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
    const key = cm.getApiKey(type);
    checks.push({
      label: `${name} API key`,
      ok: Boolean(key),
      detail: key ? 'Set' : 'Missing',
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
      ? (dashboardSecretConfigured ? 'Configured' : 'Using ephemeral secret at runtime')
      : 'Not required',
  });

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
    const critical = failures.filter((c) => c.label.includes('Node') || c.label.includes('API key'));
    if (critical.length) {
      console.log(chalk.yellow(`  ${critical.length} issue(s) need attention.\n`));
    } else {
      console.log(chalk.gray(`  ${failures.length} optional item(s) not configured.\n`));
    }
  }
}

async function checkEndpoint(url: string): Promise<boolean> {
  try {
    await axios.get(url, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
