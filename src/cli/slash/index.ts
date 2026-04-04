// ─────────────────────────────────────────────
//  Cascade AI — Slash Command Registry
// ─────────────────────────────────────────────

import { THEME_NAMES } from '../../constants.js';

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
  onRollback: () => Promise<string | void>;
  onBranch: () => Promise<void>;
  onModelInfo: () => string | Promise<string>;
  onModelsInfo: () => string | Promise<string>;
  onProvidersInfo: () => string | Promise<string>;
  onConfigInfo: () => string | Promise<string>;
  onCostInfo: () => string | Promise<string>;
  onCompact: () => Promise<string | void>;
  onStatus: () => string | Promise<string>;
  onSessions: (args: string[]) => Promise<string> | string;
  onIdentity: (args: string[]) => Promise<string> | string;
  onRetry: () => Promise<string> | string;
  onSearch: (args: string[]) => Promise<string> | string;
  onDiagnose: () => Promise<string> | string;
  onLogs: (args: string[]) => Promise<string> | string;
  onTree: () => string;
  onResume: (args: string[]) => Promise<string> | string;
}

export interface SlashCommandResult {
  output?: string | Promise<string>;
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
    const result = await cmd.handler(args, ctx);
    if (result.output instanceof Promise) {
      result.output = await result.output;
    }
    return result as { output?: string; handled: boolean };
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
        const lines = this.getAll()
          .filter((c) => c.command !== '/help')
          .map((c) => `  ${c.command.padEnd(14)} ${c.description}`);
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
        const out = await ctx.onRollback();
        return { output: out || 'File changes rolled back.', handled: true };
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
      handler: (_args, ctx) => ({ output: ctx.onModelInfo(), handled: true }),
    });

    this.register({
      command: '/models',
      description: 'List available models by provider',
      handler: (_args, ctx) => ({ output: ctx.onModelsInfo(), handled: true }),
    });

    this.register({
      command: '/providers',
      description: 'Show configured providers',
      handler: (_args, ctx) => ({ output: ctx.onProvidersInfo(), handled: true }),
    });

    this.register({
      command: '/config',
      description: 'Show active configuration summary',
      handler: (_args, ctx) => ({ output: ctx.onConfigInfo(), handled: true }),
    });

    this.register({
      command: '/retry',
      description: 'Retry the last user prompt',
      handler: async (_args, ctx) => ({ output: await ctx.onRetry(), handled: true }),
    });

    this.register({
      command: '/search',
      description: 'Search past sessions/messages',
      handler: async (args, ctx) => ({ output: await ctx.onSearch(args), handled: true }),
    });

    this.register({
      command: '/diagnose',
      description: 'Run provider/model/config health checks',
      handler: async (_args, ctx) => ({ output: await ctx.onDiagnose(), handled: true }),
    });

    this.register({
      command: '/logs',
      description: 'Show recent runtime logs',
      handler: async (args, ctx) => ({ output: await ctx.onLogs(args), handled: true }),
    });

    this.register({
      command: '/tree',
      description: 'Show current agent tree as text',
      handler: (_args, ctx) => ({ output: ctx.onTree(), handled: true }),
    });

    this.register({
      command: '/resume',
      description: 'Resume a session by ID',
      handler: async (args, ctx) => ({ output: await ctx.onResume(args), handled: true }),
    });

    this.register({
      command: '/cost',
      description: 'Show session cost and token usage',
      handler: (_args, ctx) => {
        return { output: ctx.onCostInfo(), handled: true };
      },
    });

    this.register({
      command: '/status',
      description: 'Show active agent tree status',
      handler: (_args, ctx) => ({ output: ctx.onStatus(), handled: true }),
    });

    this.register({
      command: '/sessions',
      description: 'List and resume past sessions',
      handler: async (args, ctx) => ({ output: await ctx.onSessions(args), handled: true }),
    });

    this.register({
      command: '/identity',
      description: 'Switch active identity',
      handler: async (args, ctx) => ({ output: await ctx.onIdentity(args), handled: true }),
    });

    this.register({
      command: '/compact',
      description: 'Compact/summarize context now',
      handler: async (_args, ctx) => {
        const out = await ctx.onCompact();
        return { output: out || 'Context compacted.', handled: true };
      },
    });
  }
}
