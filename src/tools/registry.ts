// ─────────────────────────────────────────────
//  Cascade AI — Tool Registry
// ─────────────────────────────────────────────

import type { ToolDefinition, ToolExecuteOptions, ToolsConfig } from '../types.js';
import { DEFAULT_APPROVAL_REQUIRED } from '../constants.js';
import type { BaseTool } from './base.js';
import { ShellTool } from './shell.js';
import { FileReadTool, FileWriteTool, FileEditTool, FileDeleteTool } from './file.js';
import { GitTool } from './git.js';
import { GitHubTool } from './github.js';
import { BrowserTool } from './browser.js';
import { ImageAnalyzeTool } from './image.js';

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();
  private config: ToolsConfig;
  private ignoredPaths: Set<string> = new Set();

  constructor(config: ToolsConfig) {
    this.config = config;
    this.registerDefaults();
  }

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
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
    this.register(new ShellTool(
      this.config.shellAllowlist,
      this.config.shellBlocklist,
    ));
    this.register(new FileReadTool());
    this.register(new FileWriteTool());
    this.register(new FileEditTool());
    this.register(new FileDeleteTool());
    this.register(new GitTool());
    this.register(new GitHubTool());
    this.register(new ImageAnalyzeTool());

    if (this.config.browserEnabled) {
      this.register(new BrowserTool());
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
