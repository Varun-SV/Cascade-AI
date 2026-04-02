// ─────────────────────────────────────────────
//  Cascade AI — Slash Command Registry
// ─────────────────────────────────────────────

import { SLASH_COMMANDS, THEME_NAMES } from '../../constants.js';

export interface SlashCommand {
  command: string;
  description: string;
  args?: string[];
  handler: (args: string[], ctx: SlashCommandContext) => Promise<SlashCommandResult> | SlashCommandResult;
}

export interface SlashCommandContext {
  sessionId: string;
  workspacePath: string;
  onOutput: (text: string) => void;
  onClear: () => void;
  onExit: () => void;
  onThemeChange: (theme: string) => void;
  onExport: (format: 'markdown' | 'json') => Promise<void>;
  onRollback: () => Promise<void>;
  onBranch: () => Promise<void>;
  onModelInfo: () => string;
  onCostInfo: () => string;
  onCompact: () => Promise<void>;
}

export interface SlashCommandResult {
  output?: string;
  handled: boolean;
}

export class SlashCommandRegistry {
  private commands: Map<string, SlashCommand> = new Map();

  constructor() {
    this.registerDefaults();
  }

  register(cmd: SlashCommand): void {
    this.commands.set(cmd.command, cmd);
  }

  async handle(input: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const [command, ...args] = input.trim().split(/\s+/);
    const cmd = this.commands.get(command ?? '');
    if (!cmd) return { handled: false };
    return cmd.handler(args, ctx);
  }

  isSlashCommand(input: string): boolean {
    return input.trim().startsWith('/');
  }

  getCompletions(partial: string): string[] {
    return Array.from(this.commands.keys()).filter((c) => c.startsWith(partial));
  }

  getAll(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  private registerDefaults(): void {
    this.register({
      command: '/help',
      description: 'Show available commands',
      handler: (_args, ctx) => {
        const lines = SLASH_COMMANDS.map((c) => `  ${c.command.padEnd(14)} ${c.description}`);
        ctx.onOutput(['', 'Cascade AI — Slash Commands', '─'.repeat(40), ...lines, ''].join('\n'));
        return { handled: true };
      },
    });

    this.register({
      command: '/clear',
      description: 'Clear the conversation',
      handler: (_args, ctx) => {
        ctx.onClear();
        return { handled: true };
      },
    });

    this.register({
      command: '/exit',
      description: 'Exit Cascade',
      handler: (_args, ctx) => {
        ctx.onExit();
        return { handled: true };
      },
    });

    this.register({
      command: '/theme',
      description: 'Switch color theme',
      handler: (args, ctx) => {
        const name = args[0];
        if (!name) {
          ctx.onOutput(`Available themes: ${THEME_NAMES.join(', ')}`);
          return { handled: true };
        }
        if (!THEME_NAMES.includes(name as never)) {
          return { output: `Unknown theme: ${name}. Available: ${THEME_NAMES.join(', ')}`, handled: true };
        }
        ctx.onThemeChange(name);
        return { output: `Theme switched to: ${name}`, handled: true };
      },
    });

    this.register({
      command: '/export',
      description: 'Export session (markdown|json)',
      handler: async (args, ctx) => {
        const format = (args[0] as 'markdown' | 'json' | undefined) ?? 'markdown';
        await ctx.onExport(format);
        return { output: `Session exported as ${format}`, handled: true };
      },
    });

    this.register({
      command: '/rollback',
      description: 'Undo all file changes in this session',
      handler: async (_args, ctx) => {
        await ctx.onRollback();
        return { output: 'File changes rolled back.', handled: true };
      },
    });

    this.register({
      command: '/branch',
      description: 'Fork current session into parallel branches',
      handler: async (_args, ctx) => {
        await ctx.onBranch();
        return { output: 'Session branched.', handled: true };
      },
    });

    this.register({
      command: '/model',
      description: 'Show active models per tier',
      handler: (_args, ctx) => {
        return { output: ctx.onModelInfo(), handled: true };
      },
    });

    this.register({
      command: '/cost',
      description: 'Show session cost and token usage',
      handler: (_args, ctx) => {
        return { output: ctx.onCostInfo(), handled: true };
      },
    });

    this.register({
      command: '/compact',
      description: 'Compact/summarize context now',
      handler: async (_args, ctx) => {
        await ctx.onCompact();
        return { output: 'Context compacted.', handled: true };
      },
    });
  }
}
