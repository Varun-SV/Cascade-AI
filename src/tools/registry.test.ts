import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ToolRegistry } from './registry.js';
import { projectStateDir } from '../config/project-state.js';
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

describe('ToolRegistry — protected paths hold for every tool that takes one', () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-protect-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-outside-'));
    // A `.cascade/` left in the project, after the state folder is made.
    projectStateDir(workspace);
    await fs.mkdir(path.join(workspace, '.cascade'));
    await fs.writeFile(path.join(workspace, '.cascade', 'config.json'), '{"apiKey":"SECRET-config"}', 'utf-8');
    await fs.writeFile(path.join(workspace, '.cascade', 'dashboard-secret'), 'SECRET-dash', 'utf-8');
    await fs.writeFile(path.join(workspace, '.cascade', 'notes.md'), 'visible', 'utf-8');
    await fs.writeFile(path.join(workspace, '.env'), 'SECRET-env', 'utf-8');
    await fs.mkdir(path.join(workspace, 'keys'));
    await fs.writeFile(path.join(workspace, 'keys', 'server.pem'), 'SECRET-pem', 'utf-8');
    await fs.mkdir(path.join(workspace, 'private'));
    await fs.writeFile(path.join(workspace, 'private', 'plan.txt'), 'SECRET-private', 'utf-8');
    await fs.mkdir(path.join(workspace, 'src'));
    await fs.writeFile(path.join(workspace, 'src', 'a.ts'), 'const x = "SECRET-code";', 'utf-8');
    await fs.writeFile(path.join(outside, 'far.txt'), 'SECRET-outside', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("refuses Cascade's own secret files with no .cascadeignore at all", async () => {
    // `.cascade/config.json` holds provider keys in plain JSON; nothing
    // protected it, and nothing passed a workspace .cascadeignore on either.
    const reg = new ToolRegistry(toolsConfig, workspace);
    for (const file of ['.cascade/config.json', '.cascade/dashboard-secret', '.env', 'keys/server.pem']) {
      await expect(reg.execute('file_read', { path: file }, opts)).rejects.toThrow(/cascadeignore/);
    }
    await expect(reg.execute('file_write', { path: '.cascade/config.json', content: '{}' }, opts)).rejects.toThrow(/cascadeignore/);
    expect(await reg.execute('file_read', { path: '.cascade/notes.md' }, opts)).toContain('visible');
  });

  // realpath gives a hard link back as itself, so `notes.txt` linked to
  // `.env` was judged as `notes.txt` — and read out.
  it('refuses a hard link to a protected file, including one made after the last look', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    await fs.link(path.join(workspace, '.env'), path.join(workspace, 'notes.txt'));
    await expect(reg.execute('file_read', { path: 'notes.txt' }, opts)).rejects.toThrow(/cascadeignore/);
    await fs.link(path.join(workspace, 'keys', 'server.pem'), path.join(workspace, 'src', 'b.ts'));
    await expect(reg.execute('file_read', { path: 'src/b.ts' }, opts)).rejects.toThrow(/cascadeignore/);
    // Two names for an ordinary file are two names for an ordinary file.
    await fs.link(path.join(workspace, 'src', 'a.ts'), path.join(workspace, 'src', 'a-copy.ts'));
    expect(await reg.execute('file_read', { path: 'src/a-copy.ts' }, opts)).toContain('SECRET-code');
    const grep = await reg.execute('grep', { pattern: 'SECRET', output_mode: 'content' }, opts);
    expect(grep).not.toMatch(/SECRET-env|SECRET-pem/);
  });

  // The code index's database holds the indexed text; a configured place for
  // it is not one any built-in pattern names.
  it('refuses a file protected where it is, and its journals', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    await fs.mkdir(path.join(workspace, 'data'));
    for (const suffix of ['', '-wal']) await fs.writeFile(path.join(workspace, 'data', `idx.db${suffix}`), 'SECRET-index', 'utf-8');
    reg.protectFiles(['', '-wal', '-shm'].map((suffix) => path.join(workspace, 'data', `idx.db${suffix}`)));
    for (const file of ['data/idx.db', 'data/idx.db-wal']) {
      await expect(reg.execute('file_read', { path: file }, opts)).rejects.toThrow(/cascadeignore/);
    }
    await expect(reg.execute('file_write', { path: 'data/idx.db-shm', content: 'x' }, opts)).rejects.toThrow(/cascadeignore/);
    const grep = await reg.execute('grep', { pattern: 'SECRET-', output_mode: 'content' }, opts);
    expect(grep).toContain('SECRET-code');
    expect(grep).not.toContain('SECRET-index');
    // …and a hard link to it, under a name nothing protects.
    await fs.link(path.join(workspace, 'data', 'idx.db'), path.join(workspace, 'src', 'cache.txt'));
    await expect(reg.execute('file_read', { path: 'src/cache.txt' }, opts)).rejects.toThrow(/cascadeignore/);
  });

  it('keeps the built-ins protected against a negation in .cascadeignore', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    reg.setIgnoredPaths(['!.env', '!.cascade/config.json']);
    await expect(reg.execute('file_read', { path: '.env' }, opts)).rejects.toThrow(/cascadeignore/);
    await expect(reg.execute('file_read', { path: '.cascade/config.json' }, opts)).rejects.toThrow(/cascadeignore/);
  });

  it('leaves protected files out of grep, glob and file_list', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    reg.setIgnoredPaths(['private/']);

    for (const outputMode of ['content', 'files_with_matches', 'count']) {
      const found = await reg.execute('grep', { pattern: 'SECRET', output_mode: outputMode }, opts);
      expect(found).toContain('a.ts');
      expect(found).not.toMatch(/server\.pem|plan\.txt|SECRET-pem|SECRET-private/);
    }
    // Searching a protected file or folder directly is refused outright.
    await expect(reg.execute('grep', { pattern: 'SECRET', path: 'keys/server.pem' }, opts)).rejects.toThrow(/cascadeignore/);
    await expect(reg.execute('grep', { pattern: 'SECRET', path: '.cascade' }, opts)).resolves.not.toContain('SECRET-config');

    const listed = await reg.execute('glob', { pattern: '**/*' }, opts);
    expect(listed).toContain('a.ts');
    expect(listed).not.toMatch(/server\.pem|plan\.txt/);
    const dotfiles = await reg.execute('file_list', { path: '.cascade' }, opts);
    expect(dotfiles).toContain('notes.md');
    expect(dotfiles).not.toMatch(/config\.json|dashboard-secret/);
    expect(await reg.execute('file_list', { path: '.' }, opts)).not.toContain('.env');
  });

  it('leaves protected files out of the Node scan too, when ripgrep is missing', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    reg.setIgnoredPaths(['private/']);
    const pathBefore = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const found = await reg.execute('grep', { pattern: 'SECRET', glob: '**/*' }, opts);
      expect(found).toContain('a.ts');
      expect(found).not.toMatch(/SECRET-pem|SECRET-private/);
    } finally {
      process.env['PATH'] = pathBefore;
    }
  });

  it('does not let grep or glob reach outside the workspace', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    await expect(reg.execute('grep', { pattern: 'SECRET', path: outside }, opts)).rejects.toThrow(/cascadeignore/);
    const escaped = await reg.execute('glob', { pattern: `../${path.basename(outside)}/*` }, opts);
    expect(escaped).not.toContain('far.txt');
  });

  it('judges a symlink by what it points to, even for a file not written yet', async () => {
    await fs.symlink(path.join(workspace, '.env'), path.join(workspace, 'innocent.txt'));
    await fs.symlink(outside, path.join(workspace, 'out'));
    const reg = new ToolRegistry(toolsConfig, workspace);
    await expect(reg.execute('file_read', { path: 'innocent.txt' }, opts)).rejects.toThrow(/cascadeignore/);
    await expect(reg.execute('file_write', { path: 'out/new.txt', content: 'x' }, opts)).rejects.toThrow(/cascadeignore/);
  });
});

describe('ToolRegistry — nothing leaves the machine for a local-only caller', () => {
  it('refuses the tools that send their arguments elsewhere, and only while the caller is local-only', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-offline-'));
    const reg = new ToolRegistry(
      { shellAllowlist: [], shellBlocklist: [], webSearch: {}, browserEnabled: false, requireApprovalFor: [] } as never,
      ws,
    );
    await fs.writeFile(path.join(ws, 'a.txt'), 'local', 'utf-8');
    const offline = { tierId: 't3', sessionId: 's', requireApproval: false, isOffline: () => true };
    for (const name of ['web_fetch', 'web_search'].filter((n) => reg.hasTool(n))) {
      await expect(reg.execute(name, { url: 'https://example.com', query: 'x' }, offline), name)
        .rejects.toThrow(/unavailable to a local-only subtask/);
    }
    expect(reg.hasTool('web_fetch')).toBe(true);
    // Work on this machine carries on.
    expect(await reg.execute('file_read', { path: 'a.txt' }, offline)).toContain('local');
    await fs.rm(ws, { recursive: true, force: true });
  });

  // A plugin tool is an ordinary BaseTool, so neither the name list nor the
  // MCP check caught one — and a plugin can post its arguments anywhere.
  it('refuses a plugin\'s tools too, including ones its hook registers', async () => {
    class Upload extends BaseTool {
      readonly inputSchema = { type: 'object', properties: {} };
      readonly description = 'Upload notes';
      calls = 0;
      constructor(readonly name: string) { super(); }
      async execute(): Promise<string> { this.calls += 1; return 'uploaded'; }
    }
    const reg = new ToolRegistry(toolsConfig);
    const direct = new Upload('upload_notes');
    const hooked = new Upload('post_webhook');
    reg.registerPlugin({ name: 'uploader', version: '1.0.0', tools: [direct], onRegister: (r) => r.register(hooked) });
    const offline = { ...opts, isOffline: () => true };
    for (const name of ['upload_notes', 'post_webhook']) {
      await expect(reg.execute(name, {}, offline), name).rejects.toThrow(/unavailable to a local-only subtask/);
    }
    expect(direct.calls + hooked.calls).toBe(0);
    expect(await reg.execute('upload_notes', {}, { ...opts, isOffline: () => false })).toBe('uploaded');
  });

  // An embedder's own tool, registered straight through register(), was
  // neither named nor MCP nor a plugin's — and so was let through.
  it('refuses a tool registered from outside unless it says it keeps to the machine', async () => {
    class Custom extends BaseTool {
      readonly inputSchema = { type: 'object', properties: {} };
      readonly description = 'custom';
      calls = 0;
      constructor(readonly name: string, readonly localOnlySafe = false) { super(); }
      async execute(): Promise<string> { this.calls += 1; return 'ran'; }
    }
    const reg = new ToolRegistry(toolsConfig);
    const sender = new Custom('post_summary');
    const local = new Custom('word_count', true);
    reg.register(sender);
    reg.register(local);
    const offline = { ...opts, isOffline: () => true };
    await expect(reg.execute('post_summary', {}, offline)).rejects.toThrow(/unavailable to a local-only subtask/);
    expect(sender.calls).toBe(0);
    expect(await reg.execute('word_count', {}, offline)).toBe('ran');
    // Replacing a built-in under its name does not inherit its standing.
    reg.register(new Custom('file_read'));
    await expect(reg.execute('file_read', { path: 'x' }, offline)).rejects.toThrow(/unavailable to a local-only subtask/);
  });
});

// The destination was marked local-only before the write, and stayed so
// when the write never happened — a public file lost to cloud workers for good.
describe('ToolRegistry — a local-only write that does not happen', () => {
  it('takes the mark off a file the tool left as it was, and keeps it on one it wrote', async () => {
    const { PrivacyPaths } = await import('../core/privacy/paths.js');
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-unmark-')));
    await fs.writeFile(path.join(ws, 'readme.md'), 'public\n');
    const privacy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: ws });
    const reg = new ToolRegistry(toolsConfig, ws);
    reg.setPrivacyPaths(privacy);
    const offline = { ...opts, isOffline: () => true };
    await expect(reg.execute('file_edit', { path: 'readme.md', old_string: 'absent', new_string: 'x' }, offline)).rejects.toThrow(/not found/);
    expect(privacy.isLocalOnly('readme.md')).toBe(false);
    expect(new PrivacyPaths([], { workspaceRoot: ws }).isLocalOnly('readme.md')).toBe(false);
    await reg.execute('file_edit', { path: 'readme.md', old_string: 'public', new_string: 'private summary' }, offline);
    expect(privacy.isLocalOnly('readme.md')).toBe(true);
    await fs.rm(ws, { recursive: true, force: true });
  });

  // Marked before the gate, two writes to one file shared a mark: the first,
  // failing, took it off while the second went on to write.
  it('keeps the mark of a write that happened when another to the same file failed', async () => {
    const { PrivacyPaths } = await import('../core/privacy/paths.js');
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-unmark2-')));
    await fs.writeFile(path.join(ws, 'readme.md'), 'public\n');
    const privacy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: ws });
    const reg = new ToolRegistry(toolsConfig, ws);
    reg.setPrivacyPaths(privacy);
    const offline = { ...opts, isOffline: () => true };
    const [failed, wrote] = await Promise.allSettled([
      reg.execute('file_edit', { path: 'readme.md', old_string: 'absent', new_string: 'x' }, offline),
      reg.execute('file_write', { path: 'readme.md', content: 'private summary' }, offline),
    ]);
    expect(failed.status).toBe('rejected');
    expect(wrote.status).toBe('fulfilled');
    expect(privacy.isLocalOnly('readme.md')).toBe(true);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

// A name a local-only subtask chose can carry what it read, and a cloud
// worker's listing — or command — showed it. What it makes now goes to its
// private folder, outside the project.
describe('ToolRegistry — what a local-only subtask makes', () => {
  it('goes to its private folder, out of the project, where only a local-only subtask reaches it', async () => {
    const { PrivacyPaths } = await import('../core/privacy/paths.js');
    const { statePath } = await import('../config/project-state.js');
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-private-')));
    await fs.writeFile(path.join(ws, 'readme.md'), 'public\n');
    await fs.mkdir(path.join(ws, 'secret'));
    const privacy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: ws });
    const reg = new ToolRegistry(toolsConfig, ws);
    reg.setPrivacyPaths(privacy);
    const offline = { ...opts, isOffline: () => true };

    const written = await reg.execute('file_write', { path: 'LEAK-NAME/deep/x.txt', content: 'PRIVATE' }, offline);
    expect(written).toContain('@private/LEAK-NAME/deep/x.txt');
    await expect(fs.stat(path.join(ws, 'LEAK-NAME'))).rejects.toThrow();
    expect(await fs.readFile(statePath(ws, 'private', 'LEAK-NAME', 'deep', 'x.txt'), 'utf8')).toBe('PRIVATE');
    // Read back under the name it gave, or the private one…
    expect(await reg.execute('file_read', { path: 'LEAK-NAME/deep/x.txt' }, offline)).toContain('PRIVATE');
    expect(await reg.execute('file_read', { path: '@private/LEAK-NAME/deep/x.txt' }, offline)).toContain('PRIVATE');
    expect(await reg.execute('file_list', { path: '@private/LEAK-NAME' }, offline)).toContain('deep');
    // …but by no one else.
    await expect(reg.execute('file_read', { path: '@private/LEAK-NAME/deep/x.txt' }, opts)).rejects.toThrow(/not local-only/);
    await expect(reg.execute('file_read', { path: 'LEAK-NAME/deep/x.txt' }, opts)).rejects.toThrow();
    expect(await reg.execute('file_list', { path: '.' }, opts)).not.toContain('LEAK-NAME');
    // A new file in a folder a local-only pattern covers whole stays there:
    // the folder's names are hidden with it.
    expect(await reg.execute('file_write', { path: 'secret/draft.md', content: 'x' }, offline)).not.toContain('@private');
    expect(await fs.readFile(path.join(ws, 'secret', 'draft.md'), 'utf8')).toBe('x');
    // A file the project has is written where it is, and marked.
    await reg.execute('file_write', { path: 'readme.md', content: 'PRIVATE summary' }, offline);
    expect(privacy.isLocalOnly('readme.md')).toBe(true);
    // A path out of the private folder is refused, and the screenshots are
    // there to read, not to write.
    await expect(reg.execute('file_read', { path: '@private/../config.json' }, offline)).rejects.toThrow(/outside/);
    await expect(reg.execute('file_write', { path: '@screenshots/x.png', content: 'x' }, opts)).rejects.toThrow(/read-only/);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

// Another process — the CLI beside the desktop app — running a local-only
// command in the workspace holds .cascade/gate/alone; a tool call here waits
// for it, where there is local-only work at all.
describe('ToolRegistry — another process using the workspace', () => {
  it('waits for its local-only command before touching the workspace', async () => {
    const { PrivacyPaths } = await import('../core/privacy/paths.js');
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-other-process-')));
    await fs.writeFile(path.join(ws, 'notes.md'), 'public\n');
    const { statePath } = await import('../config/project-state.js');
    const gate = statePath(ws, 'gate');
    await fs.mkdir(gate, { recursive: true });
    await fs.writeFile(path.join(gate, 'alone'), String(process.ppid));
    const reg = new ToolRegistry(toolsConfig, ws);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: ws }));
    let done = false;
    const read = reg.execute('file_read', { path: 'notes.md' }, opts).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    await fs.rm(path.join(gate, 'alone'));
    await read;
    expect(done).toBe(true);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

// An approved write could take a rule out of `.cascadeignore`, and the next
// run — which reads it at start — would no longer protect that path.
describe('ToolRegistry — the files that decide what is protected', () => {
  it('lets agents read .cascadeignore, under any name, but not change or remove it', async () => {
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-policy-')));
    await fs.writeFile(path.join(ws, '.cascadeignore'), 'private/\n');
    await fs.symlink(path.join(ws, '.cascadeignore'), path.join(ws, 'rules.txt'));
    await fs.link(path.join(ws, '.cascadeignore'), path.join(ws, 'rules-copy.txt'));
    const reg = new ToolRegistry(toolsConfig, ws);
    expect(await reg.execute('file_read', { path: '.cascadeignore' }, opts)).toContain('private/');
    for (const name of ['.cascadeignore', './.cascadeignore', 'rules.txt', 'rules-copy.txt']) {
      await expect(reg.execute('file_write', { path: name, content: '' }, opts), name).rejects.toThrow(/may read it but not change it/);
      await expect(reg.execute('file_edit', { path: name, old_string: 'private/', new_string: '' }, opts), name).rejects.toThrow(/may read it but not change it/);
      await expect(reg.execute('file_delete', { path: name }, opts), name).rejects.toThrow(/may read it but not change it/);
    }
    expect(await fs.readFile(path.join(ws, '.cascadeignore'), 'utf8')).toBe('private/\n');
    // Somewhere it would be new is not where Cascade reads it from.
    await reg.execute('file_write', { path: 'sub/.cascadeignore', content: 'x' }, opts);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

describe('ToolRegistry — where a write lands', () => {
  // realpath fails on a symlink whose target is missing, and its name stood
  // in for where the write would go: outside the workspace.
  it('refuses a write through a symlink to a file outside the workspace that does not exist yet', async () => {
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-dangling-')));
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-dangling-out-')));
    await fs.symlink(path.join(outside, 'created.txt'), path.join(ws, 'report.txt'));
    await fs.mkdir(path.join(outside, 'dir'));
    await fs.symlink(path.join(outside, 'dir', 'missing'), path.join(ws, 'folder'));
    const reg = new ToolRegistry(toolsConfig, ws);
    for (const target of ['report.txt', 'folder/new.txt']) {
      await expect(reg.execute('file_write', { path: target, content: 'x' }, opts), target).rejects.toThrow(/workspace|cascadeignore/);
    }
    await expect(fs.stat(path.join(outside, 'created.txt'))).rejects.toThrow();
    await expect(fs.stat(path.join(outside, 'dir', 'missing'))).rejects.toThrow();
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('keeps run checkpoints, which hold earlier prompts and outputs, from the file tools', async () => {
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-resume-')));
    await fs.mkdir(path.join(ws, '.cascade', 'resume'), { recursive: true });
    await fs.writeFile(path.join(ws, '.cascade', 'resume', 'run-1.json'), '{"prompt":"PRIOR-RUN-PROMPT"}');
    const reg = new ToolRegistry(toolsConfig, ws);
    await expect(reg.execute('file_read', { path: '.cascade/resume/run-1.json' }, opts)).rejects.toThrow(/cascadeignore/);
    expect(await reg.execute('grep', { pattern: 'PRIOR-RUN', output_mode: 'content' }, opts)).not.toContain('PRIOR-RUN-PROMPT"');
    await fs.rm(ws, { recursive: true, force: true });
  });
});
