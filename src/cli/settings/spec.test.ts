import { describe, it, expect } from 'vitest';
import { SETTINGS, SECTIONS, findSetting, display, parseValue, nextValue, changedText, tryChange, redactSecrets } from './spec.js';
import { validateConfig } from '../../config/validate.js';
import type { CascadeConfig } from '../../types.js';

const config = (): CascadeConfig => ({ providers: [{ type: 'anthropic', apiKey: 'sk-ant-abcdef1234' }], theme: 'cascade', budget: { warnAtPct: 80 } } as unknown as CascadeConfig);
const item = (id: string) => findSetting(id)!;

describe('settings', () => {
  it('every setting has a known section, a unique id and words for a person', () => {
    const ids = SETTINGS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SETTINGS) {
      expect(SECTIONS.some((x) => x.id === s.section), s.id).toBe(true);
      expect(s.help.length, s.id).toBeGreaterThan(10);
      if (s.kind === 'action') expect(s.action, s.id).toBeDefined();
      else expect(s.get && s.set, s.id).toBeTruthy();
    }
    for (const sec of SECTIONS) expect(SETTINGS.some((s) => s.section === sec.id), sec.id).toBe(true);
  });

  it('a key shows only that it is set and its last four characters', () => {
    const c = config();
    expect(display(item('key.anthropic'), c)).toBe('set ••••1234');
    expect(display(item('key.openai'), c)).toBe('not set');
    item('key.openai').set!(c, 'sk-new-9999');
    expect(c.providers.find((p) => p.type === 'openai')?.apiKey).toBe('sk-new-9999');
    item('key.anthropic').set!(c, undefined);
    expect(c.providers.some((p) => p.type === 'anthropic')).toBe(false);
  });

  it('reads what a person types, and says what is wrong', () => {
    expect(parseValue(item('autonomy'), 'AUTO')).toEqual({ ok: true, value: 'auto' });
    expect(parseValue(item('autonomy'), 'yolo')).toMatchObject({ ok: false, error: expect.stringMatching(/manual, auto/) });
    expect(parseValue(item('browser'), 'on')).toEqual({ ok: true, value: true });
    expect(parseValue(item('maxCostPerRun'), '$2.50')).toEqual({ ok: true, value: 2.5 });
    expect(parseValue(item('maxCostPerRun'), '')).toEqual({ ok: true, value: undefined });
    expect(parseValue(item('approvalTimeout'), '0').ok).toBe(false);
    expect(parseValue(item('ollama'), 'localhost').ok).toBe(false);
    expect(parseValue(item('key.openai'), 'sk with space').ok).toBe(false);
    expect(parseValue(item('login'), 'x').ok).toBe(false);
  });

  it('writes the config where Cascade reads it', () => {
    const c = config();
    item('approvalTimeout').set!(c, 5);
    expect(c.approvalTimeoutMs).toBe(300_000);
    expect(display(item('approvalTimeout'), c)).toBe('5 min');
    item('extendedContext').set!(c, true);
    expect(c.extendedContext?.enabled).toBe(true);
    item('maxCostPerRun').set!(c, undefined);
    expect(display(item('maxCostPerRun'), c)).toBe('no cap');
  });

  it('a value the config schema refuses is caught before anything is saved (Codex on 53bc237)', () => {
    expect(parseValue(item('maxCostPerRun'), '0').ok).toBe(false);
    expect(parseValue(item('contextMultiplier'), '6').ok).toBe(false);
    expect(parseValue(item('maxTokensPerRun'), '1500.5').ok).toBe(false);
    // And whatever the parser lets through is checked against the schema itself.
    const c = validateConfig({ providers: [], theme: 'cascade' });
    const before = JSON.stringify(c);
    const bad = tryChange(c, { ...item('contextMultiplier'), max: undefined }, 9);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(c)).toBe(before);
    expect(tryChange(c, item('contextMultiplier'), 3)).toEqual({ ok: true });
  });

  it('Enter cycles a choice and flips a toggle', () => {
    const c = config();
    expect(nextValue(item('autonomy'), c)).toBe('auto');
    expect(nextValue(item('browser'), c)).toBe(true);
  });

  it('finds a setting by id or by its words, and says when a change applies', () => {
    expect(findSetting('mode')?.id).toBe('autonomy');
    expect(findSetting('nothing like it')).toBeUndefined();
    const c = config();
    item('browser').set!(c, true);
    expect(changedText(item('browser'), c)).toBe('Browser: on. Takes effect the next time you start Cascade.');
  });
});

describe('redactSecrets (Codex on 9c6b865)', () => {
  it('masks a key typed after a key setting, and anything that looks like a key', () => {
    expect(redactSecrets('/settings key.openai sk-proj-abcdefghijklmnop1234')).toBe('/settings key.openai ••••');
    expect(redactSecrets('/settings key.openai not-even-a-key-shape')).toBe('/settings key.openai ••••');
    expect(redactSecrets('/settings braveKey BSAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBe('/settings braveKey ••••');
    expect(redactSecrets('/settings sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('/settings ••••');
    expect(redactSecrets('/settings ollama sk-abcdefghijklmnop')).toBe('/settings ollama ••••');
  });
  it('leaves ordinary settings and other commands as typed', () => {
    expect(redactSecrets('/settings mode auto')).toBe('/settings mode auto');
    expect(redactSecrets('/settings key.openai')).toBe('/settings key.openai');
    expect(redactSecrets('/settings budget')).toBe('/settings budget');
    expect(redactSecrets('/why')).toBe('/why');
  });
});
