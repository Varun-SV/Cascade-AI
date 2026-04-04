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

export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();
  private config: ToolsConfig;
  private ignoredPaths: Set<string> = new Set();
  private workspaceRoot: string;

  constructor(config: ToolsConfig, workspaceRoot: string = process.cwd()) {
    this.config = config;
    this.workspaceRoot = workspaceRoot;
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
