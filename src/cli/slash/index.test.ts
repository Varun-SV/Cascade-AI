import { describe, expect, it } from 'vitest';
import { SlashCommandRegistry, type SlashCommandContext } from './index.js';
import { getTheme } from '../themes/index.js';

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

  it('switches to a theme by its current name, or by its former one', async () => {
    const registry = new SlashCommandRegistry();
    const switched: string[] = [];
    const ctx = { onThemeChange: (theme: string) => switched.push(theme), onOutput: () => {} } as unknown as SlashCommandContext;

    // `/theme midnight` was "Unknown theme": the command checked the pre-rename list.
    expect((await registry.handle('/theme midnight', ctx)).output).toBe('Theme switched to: midnight');
    expect((await registry.handle('/theme cascade', ctx)).output).toBe('Theme switched to: cascade');
    expect(switched).toEqual(['midnight', 'cascade']);
    expect((await registry.handle('/theme nope', ctx)).output).toBe(
      'Unknown theme: nope. Available: midnight, aurora, ember, tide, bloom, daybreak',
    );
  });

  it('does not take what every object inherits for a theme', async () => {
    const registry = new SlashCommandRegistry();
    const switched: string[] = [];
    const ctx = { onThemeChange: (theme: string) => switched.push(theme), onOutput: () => {} } as unknown as SlashCommandContext;
    for (const name of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect((await registry.handle(`/theme ${name}`, ctx)).output).toMatch(/^Unknown theme/);
      // The config and --theme path falls back to the default instead of a function.
      expect(getTheme(name)).toBe(getTheme('midnight'));
    }
    expect(switched).toEqual([]);
  });

  it('offers completions for slash prefixes', () => {
    const registry = new SlashCommandRegistry();
    expect(registry.getCompletions('/st')).toContain('/status');
    expect(registry.getCompletions('/se')).toContain('/sessions');
  });
});
