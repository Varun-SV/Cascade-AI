// ─────────────────────────────────────────────
//  Cascade AI — Tool Registry
// ─────────────────────────────────────────────

import EventEmitter from 'node:events';
import os from 'node:os';
import path from 'node:path';
import ignoreFactory, { type Ignore } from 'ignore';

// `ignore` is published as CJS. Under `moduleResolution: NodeNext` the
// default import surfaces the module namespace rather than the callable
// factory, so normalise to whichever shape the runtime hands us.
const ignore: (opts?: unknown) => Ignore =
  (ignoreFactory as unknown as { default?: (opts?: unknown) => Ignore }).default ??
  (ignoreFactory as unknown as (opts?: unknown) => Ignore);
import type { ToolDefinition, ToolExecuteOptions, ToolsConfig } from '../types.js';
import { DEFAULT_APPROVAL_REQUIRED, GLOBAL_CONFIG_DIR } from '../constants.js';
import type { PrivacyPaths } from '../core/privacy/paths.js';
import { ProcessJail } from './jail/process-jail.js';
import { BUILT_IN_PROTECTED } from '../config/ignore.js';
import { realPathOf } from '../utils/real-path.js';
import type { BaseTool } from './base.js';
import { WorkspaceGate } from './workspace-gate.js';
import { LinkAliases } from '../utils/link-aliases.js';
import { assignMcpToolNames } from './tool-name.js';
import { ShellTool } from './shell.js';
import { FileReadTool, FileWriteTool, FileEditTool, FileDeleteTool, FileListTool } from './file.js';
import { GitTool } from './git.js';
import { GitHubTool } from './github.js';
import { BrowserTool } from './browser.js';
import { ImageAnalyzeTool } from './image.js';
import { PDFCreateTool } from './pdf.js';
import { CodeInterpreterTool } from './interpreter.js';
import { PeerCommunicationTool } from './peer.js';
import { WebSearchTool } from './web-search.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';
import { WebFetchTool } from './web-fetch.js';
import { McpClient } from '../mcp/client.js';
import { McpToolWrapper } from './mcp.js';

// ── Plugin System (Roadmap Stub) ──────────────────────────────────────────
//
// Future plugin support. Plugins bundle one or more tools together with
// optional lifecycle hooks. Use `registry.registerPlugin(plugin)` to register.
// This is a stub — roadmap tracked in README.md under Roadmap.

/**
 * A ToolPlugin bundles one or more custom tools that extend Cascade's capabilities.
 * Plugins are loaded via `registerPlugin()` and behave like built-in tools.
 *
 * @example
 * const myPlugin: ToolPlugin = {
 *   name: 'my-custom-tools',
 *   version: '1.0.0',
 *   tools: [new MyCustomTool()],
 *   onRegister: (registry) => console.log('Plugin registered'),
 * };
 * registry.registerPlugin(myPlugin);
 */
export interface ToolPlugin {
  /** Unique plugin identifier */
  name: string;
  /** Semantic version string */
  version: string;
  /** One or more tools this plugin provides */
  tools: BaseTool[];
  /** Called once when the plugin is registered */
  onRegister?: (registry: ToolRegistry) => void;
}

/**
 * Built-in tools whose `path` input names a file or directory they read or
 * write, checked against the protected paths before they run. MCP and
 * agent-written tools are not in it: a server's `path` lives in the server's
 * own namespace, which need not be this workspace.
 */
const PATH_TOOLS = new Set([
  'file_read', 'file_write', 'file_edit', 'file_delete', 'file_list',
  'glob', 'grep', 'image_analyze', 'pdf_create', 'generate_document', 'transcribe_audio',
]);

/**
 * Built-in tools that send what they are given off this machine — to a web
 * page or search engine, GitHub, a media or transcription provider, or the
 * embedder and reranker behind the code index. A local-only subtask may not
 * use them: its arguments can carry what it read. MCP and plugin tools count
 * too; where one sends things is not known here.
 */
const OFF_MACHINE_TOOLS = new Set([
  'web_fetch', 'web_search', 'browser', 'browser_control', 'github',
  'generate_image', 'generate_speech', 'generate_video', 'transcribe_audio', 'code_search',
]);

/** Built-in tools that write the file their `path` input names. */
const WRITE_TOOLS = new Set(['file_write', 'file_edit', 'generate_document', 'pdf_create']);

/** Built-in tools that run programs, in the process jail. */
const COMMAND_TOOLS = new Set(['shell', 'run_code', 'git']);

export class ToolRegistry extends EventEmitter {
  private tools: Map<string, BaseTool> = new Map();
  private config: ToolsConfig;
  /** The built-in protected paths, kept apart so no `.cascadeignore` line can undo them. */
  private readonly builtInMatcher: Ignore = ignore().add([...BUILT_IN_PROTECTED]);
  /** The workspace's `.cascadeignore`. */
  private ignoreMatcher: Ignore = ignore();
  private workspaceRoot: string;
  /** Loaded plugins, keyed by plugin name */
  private plugins: Map<string, ToolPlugin> = new Map();
  /**
   * The tools plugins put here. Like an MCP tool, what one does with its
   * arguments is not known here, so a local-only subtask may not call one.
   */
  private readonly pluginTools = new Set<string>();
  /** The workspace's privacy policies, for the jail to hide local-only paths by. */
  private privacyPaths?: PrivacyPaths;
  /** Every configured secret value, for the jail to keep out of a command's environment. */
  private secretValues: () => string[] = () => [];
  /** Where shell, run_code and git launch what they run. */
  private readonly processJail: ProcessJail;
  /** Lets a local-only subtask's command or write run alone (workspace-gate.ts). */
  private readonly gate = new WorkspaceGate();
  /** Files protected where they are configured to be, not by name: the code index's database. */
  private readonly protectedFiles = new Set<string>();
  /** Other names — hard links — for the protected files in the workspace. */
  private aliases: LinkAliases;

  constructor(config: ToolsConfig, workspaceRoot: string = process.cwd()) {
    super();
    this.config = config;
    this.workspaceRoot = workspaceRoot;
    this.aliases = this.newAliases();
    this.processJail = new ProcessJail({
      mode: config.processJail ?? 'auto',
      workspaceRoot,
      // The built-ins only: a workspace's .cascadeignore commonly lists the
      // build directories commands have to read.
      isProtected: (rel) => this.builtInMatcher.ignores(rel),
      isLocalOnly: (rel) => !!this.privacyPaths?.isLocalOnly(rel),
      hiddenPatterns: (offline) => [
        ...BUILT_IN_PROTECTED,
        ...(offline ? [] : this.privacyPaths?.localOnlyPatterns() ?? []),
      ],
      hiddenDirs: [path.join(os.homedir(), GLOBAL_CONFIG_DIR)],
      hiddenFiles: () => [...this.protectedFiles],
      secretValues: () => this.secretValues(),
      taint: (rels) => this.markLocalOnly(rels),
      log: (msg) => { this.emit('log', msg); },
    });
    this.registerDefaults();
  }

  /** The privacy policies the process jail hides local-only paths by. */
  setPrivacyPaths(paths: PrivacyPaths | undefined): void {
    this.privacyPaths = paths;
  }

  /** Where the configured secrets are read from when a command is launched. */
  setSecretValues(read: () => string[]): void {
    this.secretValues = read;
  }

  register(tool: BaseTool): void {
    tool.setPathGuard((absPath) => this.isProtected(absPath));
    tool.setProcessJail(this.processJail);
    this.tools.set(tool.name, tool);
    this.emit('tool:added', tool.name);
  }

  /**
   * The directory every registered tool resolves relative paths against.
   *
   * Exposed so a caller that has to reason about a file a tool WROTE can look
   * in the same place the tool wrote it. `process.cwd()` is not that place
   * outside a plain CLI run: the hosted server's cwd is the app directory
   * while the run's workspace is the tenant's scratch dir, and Electron's cwd
   * is the app bundle rather than the user's chosen folder.
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Wait until a named tool is registered, resolving immediately if it already exists.
   * T3 workers can call this after encountering a missing-tool error to resume
   * automatically once T2 synthesizes the tool.
   */
  waitForTool(toolName: string, timeoutMs = 60_000): Promise<void> {
    if (this.tools.has(toolName)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('tool:added', handler);
        reject(new Error(`Timeout waiting for tool: ${toolName}`));
      }, timeoutMs);

      const handler = (name: string) => {
        if (name === toolName) {
          clearTimeout(timer);
          this.off('tool:added', handler);
          resolve();
        }
      };
      this.on('tool:added', handler);
    });
  }

  /**
   * Register a ToolPlugin, loading all its tools into the registry.
   * Each tool is configured with the current workspace root.
   * Duplicate plugin names are silently ignored.
   *
   * @example
   * registry.registerPlugin(myPlugin);
   */
  registerPlugin(plugin: ToolPlugin): void {
    if (this.plugins.has(plugin.name)) return;
    this.plugins.set(plugin.name, plugin);
    const before = new Map(this.tools);
    for (const tool of plugin.tools) {
      tool.setWorkspaceRoot(this.workspaceRoot);
      this.register(tool);
    }
    plugin.onRegister?.(this);
    // Everything the plugin added or replaced, including what its onRegister
    // hook registered directly.
    for (const [name, tool] of this.tools) {
      if (before.get(name) !== tool) this.pluginTools.add(name);
    }
  }

  /** Returns the names of all registered plugins */
  getRegisteredPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Registers all tools from an MCP client.
   *
   * `isAllowed` receives the FINAL registered name (`mcp__server__tool`) — the
   * same string the user sees and the same one that reaches the provider — so
   * a per-tool opt-out in Settings can be expressed as a plain name list.
   * Filtering here rather than at call time means a deselected tool is genuinely
   * absent from the definitions handed to the model, so it is never proposed,
   * never counted against the tool budget, and never has to be refused.
   */
  registerMcpTools(mcpClient: McpClient, isAllowed?: (registeredName: string) => boolean): void {
    // Definitions from McpClient.getToolDefinitions() are prefixed as
    // `mcp::<serverName>::<toolName>` — three parts, not four. Previously this
    // destructured [,, serverName, toolName] which silently dropped every MCP
    // tool (toolName was always undefined and everything got filtered out).
    const parsed = mcpClient.getToolDefinitions().flatMap((def) => {
      const [, server, tool] = def.name.split('::');
      return server && tool ? [{ def, server, tool }] : [];
    });
    // Named as one set: `register()` keys by name, so two tools whose raw names
    // sanitise onto the same string would silently become one. Same call as
    // discovery makes, so Settings and the run agree on every name.
    const names = assignMcpToolNames(parsed);

    parsed.forEach(({ def, server, tool }, i) => {
      const wrapper = new McpToolWrapper(
        mcpClient,
        server,
        tool,
        def.description.replace(`[MCP:${server}] `, ''),
        def.inputSchema,
        names[i],
      );
      if (isAllowed && !isAllowed(wrapper.name)) return;
      wrapper.setWorkspaceRoot(this.workspaceRoot);
      this.register(wrapper);
    });
  }

  setIgnoredPaths(patterns: string[]): void {
    // `ignore` mirrors .gitignore semantics: supports negation, globs, dirs.
    // Using the library eliminates the old substring bug where `node_modules`
    // would also match `mynodemodules.js`.
    this.ignoreMatcher = ignore().add(patterns);
    this.aliases = this.newAliases();
  }

  private newAliases(): LinkAliases {
    return new LinkAliases(this.workspaceRoot, (rel) => this.builtInMatcher.ignores(rel) || this.ignoreMatcher.ignores(rel));
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.getDefinition());
  }

  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  requiresApproval(toolName: string): boolean {
    const defaults = DEFAULT_APPROVAL_REQUIRED as string[];
    const configured = this.config.requireApprovalFor;
    // Also gate on isDangerous(): the static list requires a human to
    // remember to add every dangerous tool to it by hand, which has already
    // caused one real gap (see the DEFAULT_APPROVAL_REQUIRED comment — git
    // and file_edit shipped without approval for a while) and, before this
    // line, a second one — an MCP tool's isDangerous() override had nothing
    // consulting it, so a connected server's create_repository/delete_file/
    // etc. ran with zero approval no matter what isDangerous() said. Every
    // built-in dangerous tool is already in the list, so this is a no-op for
    // all of them; it only changes behavior for tools the list doesn't know
    // about.
    return defaults.includes(toolName) || configured.includes(toolName) || this.isDangerous(toolName);
  }

  isDangerous(toolName: string): boolean {
    return this.tools.get(toolName)?.isDangerous() ?? false;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    options: ToolExecuteOptions,
  ): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Tool not found: ${toolName}`);

    if (options.isOffline?.() && (OFF_MACHINE_TOOLS.has(toolName) || tool instanceof McpToolWrapper || this.pluginTools.has(toolName))) {
      throw new Error(`${toolName} is unavailable to a local-only subtask (privacy.paths): it would send what the subtask knows off this machine.`);
    }

    // Enforce .cascadeignore and the built-in protected paths for every tool
    // that takes a path. It used to cover the four file_* tools only, so grep
    // printed a protected file's contents and glob listed it.
    if (PATH_TOOLS.has(toolName)) {
      const filePath = input['path'];
      if (typeof filePath === 'string' && this.isIgnored(filePath)) {
        throw new Error(`Access denied: ${filePath} is protected (.cascadeignore)`);
      }
    }

    // What a local-only subtask writes may carry what it read, so it is
    // local-only too: a file tool's destination is marked before the write,
    // a command's changes when it ends (the jail finds them).
    const offline = options.isOffline?.() === true;
    if (offline && WRITE_TOOLS.has(toolName) && typeof input['path'] === 'string') {
      this.markWritten(input['path']);
    }
    if (tool.delegatesToTools) return tool.execute(input, options);
    const leave = await this.gate.enter(offline && (COMMAND_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)));
    try {
      return await tool.execute(input, options);
    } finally {
      leave();
    }
  }

  /** Mark the file a write tool is about to write local-only: under its name, and where it lands. */
  private markWritten(filePath: string): void {
    const abs = path.resolve(this.workspaceRoot, filePath);
    const rels = [path.relative(this.workspaceRoot, abs), path.relative(realPathOf(this.workspaceRoot), realPathOf(abs))];
    this.markLocalOnly(rels.filter((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel)));
  }

  private markLocalOnly(rels: string[]): void {
    const added = this.privacyPaths?.addDerived(rels) ?? [];
    if (added.length) {
      this.emit('log', `[privacy] Written by a local-only subtask, so local-only from now on: ${added.join(', ')}`);
    }
  }

  private registerDefaults(): void {
    // `enabledTools` is the ONLY way to omit a built-in tool entirely (shell,
    // file_*, git, … have no other off-switch — requireApprovalFor still
    // requires a click, it doesn't remove the tool). Built for embedding
    // Cascade where the full tool surface must never exist for a run, not
    // just be gated. Undefined = unchanged default behavior (full set).
    const allowlist = this.config.enabledTools;
    const enabled = (name: string): boolean => !allowlist || allowlist.includes(name);

    const candidates: Array<BaseTool | false> = [
      enabled('shell') && new ShellTool(this.config.shellAllowlist, this.config.shellBlocklist),
      enabled('file_read') && new FileReadTool(),
      enabled('file_write') && new FileWriteTool(),
      enabled('file_edit') && new FileEditTool(),
      enabled('file_delete') && new FileDeleteTool(),
      enabled('file_list') && new FileListTool(),
      enabled('git') && new GitTool(),
      enabled('github') && new GitHubTool(),
      enabled('image_analyze') && new ImageAnalyzeTool(),
      enabled('pdf_create') && new PDFCreateTool(),
      enabled('run_code') && new CodeInterpreterTool(),
      enabled('peer_message') && new PeerCommunicationTool(),
      enabled('web_search') && new WebSearchTool(this.config.webSearch),
      enabled('glob') && new GlobTool(),
      enabled('grep') && new GrepTool(),
      enabled('web_fetch') && new WebFetchTool(),
    ];
    const tools = candidates.filter((t): t is BaseTool => t !== false);

    for (const tool of tools) {
      tool.setWorkspaceRoot(this.workspaceRoot);
      this.register(tool);
    }

    if (this.config.browserEnabled && enabled('browser')) {
      const browser = new BrowserTool();
      browser.setWorkspaceRoot(this.workspaceRoot);
      this.register(browser);
    }
  }

  private isIgnored(filePath: string): boolean {
    if (!filePath) return false;
    return this.isProtected(path.resolve(this.workspaceRoot, filePath));
  }

  /**
   * True for an absolute path no tool may touch: outside the workspace, or
   * protected by the built-ins or `.cascadeignore` — under its own name or,
   * through a symlink, under the name of what it points to.
   */
  isProtected(absPath: string): boolean {
    if (this.protectedByName(absPath, this.workspaceRoot)) return true;
    const real = realPathOf(absPath);
    if (real !== absPath && this.protectedByName(real, realPathOf(this.workspaceRoot))) return true;
    if (this.protectedFiles.has(path.resolve(absPath)) || this.protectedFiles.has(real)) return true;
    return this.aliases.isAlias(absPath);
  }

  /**
   * Protect files by where they are, wherever that is — for a file whose
   * place is configured, which no built-in pattern names: the code index's
   * database when `codeIndex.dbPath` moves it, and its journals. Commands do
   * not see them either.
   */
  protectFiles(absPaths: string[]): void {
    for (const p of absPaths) {
      this.protectedFiles.add(path.resolve(p));
      this.protectedFiles.add(realPathOf(path.resolve(p)));
    }
  }

  private protectedByName(absPath: string, root: string): boolean {
    const rel = path.relative(root, absPath);
    // The workspace itself: listing or searching it is how work starts.
    if (rel === '') return false;
    // Outside the workspace (defence in depth; the file tools' own
    // path-sandbox guards reject these too).
    if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
    // `ignore` requires POSIX-style separators.
    const posixRel = rel.split(path.sep).join('/');
    return this.builtInMatcher.ignores(posixRel) || this.ignoreMatcher.ignores(posixRel);
  }
}
