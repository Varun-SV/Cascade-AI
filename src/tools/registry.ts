// ─────────────────────────────────────────────
//  Cascade AI — Tool Registry
// ─────────────────────────────────────────────

import type { ToolDefinition, ToolExecuteOptions, ToolsConfig } from '../types.js';
import { DEFAULT_APPROVAL_REQUIRED } from '../constants.js';
import type { BaseTool } from './base.js';
import { ShellTool } from './shell.js';
import { FileReadTool, FileWriteTool, FileEditTool, FileDeleteTool, FileListTool } from './file.js';
import { GitTool } from './git.js';
import { GitHubTool } from './github.js';
import { BrowserTool } from './browser.js';
import { ImageAnalyzeTool } from './image.js';
import { PDFCreateTool } from './pdf.js';
import { CodeInterpreterTool } from './interpreter.js';
import { PeerCommunicationTool } from './peer.js';
import { McpClient } from '../mcp/client.js';
import { McpToolWrapper } from './mcp.js';

// ── Plugin System (Roadmap Stub) ──────────────────────────────────────────
//
// Future plugin support. Plugins bundle one or more tools together with
// optional lifecycle hooks. Use `registry.registerPlugin(plugin)` to register.
// This is a stub — full implementation tracked in ROADMAP.md.

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

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();
  private config: ToolsConfig;
  private ignoredPaths: Set<string> = new Set();
  private workspaceRoot: string;
  /** Loaded plugins, keyed by plugin name */
  private plugins: Map<string, ToolPlugin> = new Map();

  constructor(config: ToolsConfig, workspaceRoot: string = process.cwd()) {
    this.config = config;
    this.workspaceRoot = workspaceRoot;
    this.registerDefaults();
  }

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
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
    for (const tool of plugin.tools) {
      tool.setWorkspaceRoot(this.workspaceRoot);
      this.register(tool);
    }
    plugin.onRegister?.(this);
  }

  /** Returns the names of all registered plugins */
  getRegisteredPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  /** Registers all tools from an MCP client */
  registerMcpTools(mcpClient: McpClient): void {
    const definitions = mcpClient.getToolDefinitions();
    for (const def of definitions) {
      // Definitions from McpClient.getToolDefinitions() are prefixed as
      // `mcp::<serverName>::<toolName>` — three parts, not four. Previously
      // this destructured [,, serverName, toolName] which silently dropped
      // every MCP tool (toolName was always undefined and the `continue`
      // below filtered them all out).
      const [, serverName, toolName] = def.name.split('::');
      if (!serverName || !toolName) continue;

      const wrapper = new McpToolWrapper(
        mcpClient,
        serverName,
        toolName,
        def.description.replace(`[MCP:${serverName}] `, ''),
        def.inputSchema,
      );
      wrapper.setWorkspaceRoot(this.workspaceRoot);
      this.register(wrapper);
    }
  }

  setIgnoredPaths(paths: string[]): void {
    this.ignoredPaths = new Set(paths);
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
    return defaults.includes(toolName) || configured.includes(toolName);
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

    // Enforce .cascadeignore for file operations
    if (this.isFileOperation(toolName)) {
      const filePath = (input['path'] as string | undefined) ?? '';
      if (this.isIgnored(filePath)) {
        throw new Error(`Access denied: ${filePath} is in .cascadeignore`);
      }
    }

    return tool.execute(input, options);
  }

  private registerDefaults(): void {
    const tools: BaseTool[] = [
      new ShellTool(this.config.shellAllowlist, this.config.shellBlocklist),
      new FileReadTool(),
      new FileWriteTool(),
      new FileEditTool(),
      new FileDeleteTool(),
      new FileListTool(),
      new GitTool(),
      new GitHubTool(),
      new ImageAnalyzeTool(),
      new PDFCreateTool(),
      new CodeInterpreterTool(),
      new PeerCommunicationTool(),
    ];

    for (const tool of tools) {
      tool.setWorkspaceRoot(this.workspaceRoot);
      this.register(tool);
    }

    if (this.config.browserEnabled) {
      const browser = new BrowserTool();
      browser.setWorkspaceRoot(this.workspaceRoot);
      this.register(browser);
    }
  }

  private isFileOperation(toolName: string): boolean {
    return ['file_read', 'file_write', 'file_edit', 'file_delete'].includes(toolName);
  }

  private isIgnored(filePath: string): boolean {
    for (const ignored of this.ignoredPaths) {
      if (filePath.startsWith(ignored) || filePath.includes(ignored)) return true;
    }
    return false;
  }
}
