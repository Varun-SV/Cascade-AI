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
import { uniqueMcpServerName, removeMcpServerDenials } from '../../tools/tool-name.js';


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
  const desiredName = (opts.name?.trim() || defaultName(url));
  console.log(chalk.magenta('\n  ◈ Connect an MCP server via OAuth'));
  console.log(chalk.dim(`  ${url}\n`));
  try {
    // Resolve the FINAL name — unique against every server already configured
    // — before starting OAuth, so the token store path is derived from the
    // name that actually lands in config, matching the desktop's connect flow.
    // Reconnecting the same server (exact raw-name match) still updates in
    // place; only a genuinely new name that collides on its sanitized tool
    // prefix (`foo bar` vs `foo@bar`) gets suffixed — this command previously
    // had no uniqueness check at all, so two servers named that way would
    // register identical `mcp__foo_bar__…` tool names and one would silently
    // overwrite the other's wrapper in the registry.
    const cm = new ConfigManager(process.cwd());
    await cm.load();
    const config = cm.getConfig();
    config.tools = config.tools ?? ({} as typeof config.tools);
    const servers = config.tools.mcpServers ?? [];
    const existingIdx = servers.findIndex((s) => s.name === desiredName);
    const name = existingIdx >= 0 ? desiredName : uniqueMcpServerName(desiredName, servers.map((s) => s.name));

    const store = new FileMcpOAuthStore(storePathFor(name));
    await connectMcpWithLoopbackOAuth({
      serverUrl: url,
      store,
      clientName: 'Cascade AI',
      openUrl: (u) => { console.log(chalk.dim('  Opening your browser to authorize…')); openBrowser(u); },
    });
    const entry = { name, url, oauthStore: storePathFor(name) };
    if (existingIdx >= 0) servers[existingIdx] = entry; else servers.push(entry);
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
  // Matches the desktop removal handler: without this, reconnecting the same
  // connector later — through THIS command, under the same name — silently
  // re-disabled tools the user had switched off in a previous life of that
  // connection, with nothing on screen explaining why.
  config.tools.disabledTools = removeMcpServerDenials(config.tools.disabledTools, name);
  if (match.oauthStore) { try { new FileMcpOAuthStore(match.oauthStore).clear(); } catch { /* already gone */ } }
  await cm.updateConfig(config);
  console.log(chalk.green(`\n  ✓ Removed "${name}".\n`));
}
