import { describe, expect, it } from 'vitest';
import { SlashCommandRegistry } from './index.js';

describe('SlashCommandRegistry', () => {
  it('exposes the implemented slash commands', () => {
    const registry = new SlashCommandRegistry();
    const commands = registry.getAll().map((command) => command.command);

    expect(commands).toContain('/status');
    expect(commands).toContain('/sessions');
    expect(commands).toContain('/identity');
    expect(commands).toContain('/rollback');
    expect(commands).toContain('/branch');
    expect(commands).toContain('/compact');
    expect(commands).toContain('/budget');
  });

  it('offers completions for slash prefixes', () => {
    const registry = new SlashCommandRegistry();
    expect(registry.getCompletions('/st')).toContain('/status');
    expect(registry.getCompletions('/se')).toContain('/sessions');
  });
});
