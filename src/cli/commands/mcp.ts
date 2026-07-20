// ─────────────────────────────────────────────
//  Cascade AI — `cascade mcp` (OAuth-connected MCP servers)
// ─────────────────────────────────────────────
//
// Connect a remote MCP server by logging in (OAuth loopback) instead of pasting
// a token. Tokens live in ~/.cascade-ai/mcp-oauth/<name>.json (0600) and are
// auto-refreshed at run time. See docs/mcp-oauth.md.

import chalk from 'chalk';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ConfigManager } from '../../config/index.js';
import { connectMcpWithLoopbackOAuth, FileMcpOAuthStore } from '../../mcp/oauth.js';

function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* headless — the printed URL still works */
  }
}

function storePathFor(name: string): string {
  const safe = name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 64) || 'server';
  return path.join(os.homedir(), '.cascade-ai', 'mcp-oauth', `${safe}.json`);
}

function defaultName(url: string): string {
  try { return new URL(url).hostname; } catch { return 'mcp-server'; }
}

export async function mcpConnectCommand(url: string, opts: { name?: string } = {}): Promise<void> {
  const name = (opts.name?.trim() || defaultName(url));
  const store = new FileMcpOAuthStore(storePathFor(name));
  console.log(chalk.magenta('\n  ◈ Connect an MCP server via OAuth'));
  console.log(chalk.dim(`  ${url}\n`));
  try {
    await connectMcpWithLoopbackOAuth({
      serverUrl: url,
      store,
      clientName: 'Cascade AI',
      openUrl: (u) => { console.log(chalk.dim('  Opening your browser to authorize…')); openBrowser(u); },
    });
    const cm = new ConfigManager(process.cwd());
    await cm.load();
    const config = cm.getConfig();
    config.tools = config.tools ?? ({} as typeof config.tools);
    const servers = config.tools.mcpServers ?? [];
    const entry = { name, url, oauthStore: storePathFor(name) };
    const idx = servers.findIndex((s) => s.name === name);
    if (idx >= 0) servers[idx] = entry; else servers.push(entry);
    config.tools.mcpServers = servers;
    config.tools.mcpTrusted = Array.from(new Set([...(config.tools.mcpTrusted ?? []), name]));
    await cm.updateConfig(config);
    console.log(chalk.green(`\n  ✓ Connected "${name}". Its tools are available to your runs.\n`));
  } catch (err) {
    console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
}

export async function mcpListCommand(): Promise<void> {
  const cm = new ConfigManager(process.cwd());
  await cm.load();
  const servers = cm.getConfig().tools?.mcpServers ?? [];
  if (!servers.length) { console.log(chalk.dim('\n  No MCP servers configured.\n')); return; }
  console.log(chalk.magenta('\n  ◈ MCP servers\n'));
  for (const s of servers) {
    const kind = s.oauthStore ? chalk.green('oauth') : s.headers ? chalk.cyan('token') : s.command ? chalk.dim('local') : chalk.dim('open');
    console.log(`  ${chalk.bold(s.name)}  ${chalk.dim(s.url || s.command || '')}  ${kind}`);
  }
  console.log();
}

export async function mcpRemoveCommand(name: string): Promise<void> {
  const cm = new ConfigManager(process.cwd());
  await cm.load();
  const config = cm.getConfig();
  const servers = config.tools?.mcpServers ?? [];
  const match = servers.find((s) => s.name === name);
  if (!match) { console.log(chalk.red(`\n  No MCP server named "${name}".\n`)); process.exitCode = 1; return; }
  config.tools.mcpServers = servers.filter((s) => s.name !== name);
  config.tools.mcpTrusted = (config.tools.mcpTrusted ?? []).filter((n) => n !== name);
  if (match.oauthStore) { try { new FileMcpOAuthStore(match.oauthStore).clear(); } catch { /* already gone */ } }
  await cm.updateConfig(config);
  console.log(chalk.green(`\n  ✓ Removed "${name}".\n`));
}
