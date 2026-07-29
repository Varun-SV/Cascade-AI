import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ToolRegistry } from './registry.js';
import { BaseTool } from './base.js';
import type { ToolExecuteOptions } from '../types.js';

const toolsConfig = {
  shellAllowlist: [],
  shellBlocklist: [],
  requireApprovalFor: [],
  globalMcpServers: [],
  mcpServers: [],
  customTools: [],
} as unknown as Parameters<typeof ToolRegistry>[0];

const opts = { tierId: 'T3', sessionId: 's' };

describe('ToolRegistry .cascadeignore', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-reg-'));
    await fs.writeFile(path.join(workspace, 'safe.txt'), 'ok', 'utf-8');
    await fs.mkdir(path.join(workspace, 'node_modules'));
    await fs.writeFile(path.join(workspace, 'node_modules', 'pkg.txt'), 'private', 'utf-8');
    await fs.writeFile(path.join(workspace, 'mynodemodules.js'), 'unrelated', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('blocks paths inside ignored directories', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    reg.setIgnoredPaths(['node_modules/']);
    await expect(
      reg.execute('file_read', { path: 'node_modules/pkg.txt' }, opts),
    ).rejects.toThrow(/cascadeignore/);
  });

  it('does NOT match ignored pattern by substring — the old bug', async () => {
    // Before the fix, this path would be blocked because `node_modules` is a
    // substring of "mynodemodules.js". With gitignore semantics it is allowed.
    const reg = new ToolRegistry(toolsConfig, workspace);
    reg.setIgnoredPaths(['node_modules/']);
    const result = await reg.execute('file_read', { path: 'mynodemodules.js' }, opts);
    expect(result).toContain('unrelated');
  });

  it('blocks paths that escape the workspace root', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    await expect(
      reg.execute('file_read', { path: '../../etc/passwd' }, opts),
    ).rejects.toThrow();
  });

  it('allows regular workspace files when no patterns match', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    const result = await reg.execute('file_read', { path: 'safe.txt' }, opts);
    expect(result).toContain('ok');
  });

  it('respects negation patterns (gitignore semantics)', async () => {
    await fs.mkdir(path.join(workspace, 'build'));
    await fs.writeFile(path.join(workspace, 'build', 'keep.txt'), 'keep', 'utf-8');
    await fs.writeFile(path.join(workspace, 'build', 'skip.txt'), 'skip', 'utf-8');
    const reg = new ToolRegistry(toolsConfig, workspace);
    reg.setIgnoredPaths(['build/*', '!build/keep.txt']);
    await expect(
      reg.execute('file_read', { path: 'build/skip.txt' }, opts),
    ).rejects.toThrow(/cascadeignore/);
    const kept = await reg.execute('file_read', { path: 'build/keep.txt' }, opts);
    expect(kept).toContain('keep');
  });
});

describe('ToolRegistry enabledTools allowlist', () => {
  const ALL_DEFAULT_TOOLS = [
    'shell', 'file_read', 'file_write', 'file_edit', 'file_delete', 'file_list',
    'git', 'github', 'image_analyze', 'pdf_create', 'run_code', 'peer_message',
    'web_search', 'glob', 'grep', 'web_fetch',
  ];

  it('registers the full default tool set when enabledTools is omitted (unchanged behavior)', () => {
    const reg = new ToolRegistry(toolsConfig, '/tmp');
    for (const name of ALL_DEFAULT_TOOLS) {
      expect(reg.hasTool(name), name).toBe(true);
    }
  });

  it('registers ONLY the listed tools — the sole way to omit shell/file/git entirely', () => {
    // This is the hosted-multi-tenant case: web_search/web_fetch only, no
    // shell/file/git/run_code should exist at all (not just be approval-gated).
    const cfg = { ...toolsConfig, enabledTools: ['web_search', 'web_fetch'] } as unknown as Parameters<typeof ToolRegistry>[0];
    const reg = new ToolRegistry(cfg, '/tmp');
    expect(reg.hasTool('web_search')).toBe(true);
    expect(reg.hasTool('web_fetch')).toBe(true);
    for (const name of ALL_DEFAULT_TOOLS) {
      if (name === 'web_search' || name === 'web_fetch') continue;
      expect(reg.hasTool(name), name).toBe(false);
    }
  });

  it('registers no tools at all for an empty allowlist', () => {
    const cfg = { ...toolsConfig, enabledTools: [] } as unknown as Parameters<typeof ToolRegistry>[0];
    const reg = new ToolRegistry(cfg, '/tmp');
    for (const name of ALL_DEFAULT_TOOLS) {
      expect(reg.hasTool(name), name).toBe(false);
    }
  });

  it('still respects browserEnabled=false even when browser is in the allowlist', () => {
    const cfg = { ...toolsConfig, enabledTools: ['browser'], browserEnabled: false } as unknown as Parameters<typeof ToolRegistry>[0];
    const reg = new ToolRegistry(cfg, '/tmp');
    expect(reg.hasTool('browser')).toBe(false);
  });

  it('registers browser when both browserEnabled and the allowlist permit it', () => {
    const cfg = { ...toolsConfig, enabledTools: ['browser'], browserEnabled: true } as unknown as Parameters<typeof ToolRegistry>[0];
    const reg = new ToolRegistry(cfg, '/tmp');
    expect(reg.hasTool('browser')).toBe(true);
  });
});

// ── Per-tool MCP selection ────────────────────
//
// A connected server usually brings dozens of tools and most are irrelevant to
// any given workspace. Deselected tools are left UNREGISTERED rather than
// refused at call time, so the model never sees them: it cannot propose one,
// they cost no tokens in the tool list, and there is no refusal to explain.

describe('ToolRegistry MCP per-tool selection', () => {
  /** Minimal stand-in for McpClient — only getToolDefinitions is read here. */
  function fakeClient(names: Array<[server: string, tool: string]>) {
    return {
      getToolDefinitions: () => names.map(([server, tool]) => ({
        name: `mcp::${server}::${tool}`,
        description: `[MCP:${server}] does ${tool}`,
        inputSchema: { type: 'object', properties: {} },
      })),
    } as unknown as Parameters<ToolRegistry['registerMcpTools']>[0];
  }

  it('registers every advertised tool when no filter is supplied', () => {
    const reg = new ToolRegistry(toolsConfig, '/tmp');
    reg.registerMcpTools(fakeClient([['github', 'get_me'], ['github', 'delete_repo']]));
    expect(reg.hasTool('mcp__github__get_me')).toBe(true);
    expect(reg.hasTool('mcp__github__delete_repo')).toBe(true);
  });

  it('leaves a deselected tool out of the registry entirely', () => {
    const reg = new ToolRegistry(toolsConfig, '/tmp');
    const denied = new Set(['mcp__github__delete_repo']);
    reg.registerMcpTools(
      fakeClient([['github', 'get_me'], ['github', 'delete_repo']]),
      (name) => !denied.has(name),
    );
    expect(reg.hasTool('mcp__github__get_me')).toBe(true);
    expect(reg.hasTool('mcp__github__delete_repo')).toBe(false);
    // And it is absent from what the model is shown, not merely unusable.
    const shown = reg.getToolDefinitions().map((d) => d.name);
    expect(shown).toContain('mcp__github__get_me');
    expect(shown).not.toContain('mcp__github__delete_repo');
  });

  it('filters on the REGISTERED name, which is what the user selects by', () => {
    // The deny list stores `mcp__server__tool`, not the bare vendor name — two
    // servers can both advertise a tool called "search".
    const reg = new ToolRegistry(toolsConfig, '/tmp');
    reg.registerMcpTools(
      fakeClient([['github', 'search'], ['notion', 'search']]),
      (name) => name !== 'mcp__notion__search',
    );
    expect(reg.hasTool('mcp__github__search')).toBe(true);
    expect(reg.hasTool('mcp__notion__search')).toBe(false);
  });

  it('can deselect everything a server offers without removing the server', () => {
    const reg = new ToolRegistry(toolsConfig, '/tmp');
    reg.registerMcpTools(fakeClient([['github', 'a'], ['github', 'b']]), () => false);
    expect(reg.getToolDefinitions().some((d) => d.name.startsWith('mcp__'))).toBe(false);
  });

  it('requiresApproval() is true for a dangerous MCP tool even though it is not in the static list', () => {
    // Regression: isDangerous() on McpToolWrapper alone changes nothing —
    // T3Worker.executeTool() gates on requiresApproval(), which used to
    // consult ONLY the static DEFAULT_APPROVAL_REQUIRED list (which can
    // never name an arbitrary connected server's tools), never
    // isDangerous(). A GitHub MCP server's create_repository/delete_repo
    // therefore ran with zero approval no matter what isDangerous() said.
    const reg = new ToolRegistry(toolsConfig, '/tmp');
    reg.registerMcpTools(fakeClient([['github', 'create_repository'], ['github', 'list_repos']]));
    expect(reg.isDangerous('mcp__github__create_repository')).toBe(true);
    expect(reg.requiresApproval('mcp__github__create_repository')).toBe(true);
    // A read-only-looking one should still not need approval.
    expect(reg.isDangerous('mcp__github__list_repos')).toBe(false);
    expect(reg.requiresApproval('mcp__github__list_repos')).toBe(false);
  });
});

describe('ToolRegistry.requiresApproval — gated on isDangerous(), not just the static list', () => {
  class FakeDangerousTool extends BaseTool {
    readonly name = 'fake_dangerous_tool';
    readonly description = 'test-only';
    readonly inputSchema = {};
    isDangerous(): boolean { return true; }
    async execute(_input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> { return 'ok'; }
  }

  it('requires approval for ANY tool that self-reports dangerous, not only ones named in DEFAULT_APPROVAL_REQUIRED', () => {
    const reg = new ToolRegistry(toolsConfig, '/tmp');
    reg.register(new FakeDangerousTool());
    expect(reg.hasTool('fake_dangerous_tool')).toBe(true); // sanity: not a built-in
    expect(reg.requiresApproval('fake_dangerous_tool')).toBe(true);
  });

  it('does not require approval for an ordinary safe tool', () => {
    const reg = new ToolRegistry(toolsConfig, '/tmp');
    expect(reg.requiresApproval('web_search')).toBe(false);
  });
});
