// ─────────────────────────────────────────────
//  Cascade AI — `cascade doctor` Command
// ─────────────────────────────────────────────

import axios from 'axios';
import chalk from 'chalk';
import { OLLAMA_BASE_URL, LM_STUDIO_BASE_URL, PROVIDER_DISPLAY_NAMES } from '../../constants.js';

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

  // API keys from env
  const providers: Array<{ env: string; name: string }> = [
    { env: 'ANTHROPIC_API_KEY', name: 'Anthropic' },
    { env: 'OPENAI_API_KEY', name: 'OpenAI' },
    { env: 'GOOGLE_API_KEY', name: 'Google Gemini' },
    { env: 'AZURE_OPENAI_KEY', name: 'Azure OpenAI' },
  ];

  for (const { env, name } of providers) {
    const key = process.env[env];
    checks.push({
      label: `${name} API key`,
      ok: Boolean(key),
      detail: key ? `Set (${env})` : `Missing — set ${env}`,
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
