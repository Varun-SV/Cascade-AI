import { describe, expect, it } from 'vitest';
import { canHydrate, canSerialize, SETTINGS_SECTIONS, type SettingsSection } from './form-state';

const none = new Set<SettingsSection>();

describe('canSerialize — an unloaded section is not a statement the user made', () => {
  it('withholds every section before the first snapshot', () => {
    // Saving here sent `models: auto`, `azureDeployments: []`, a blank SearXNG
    // URL and the advanced defaults — deleting tier pins and Azure rows, and
    // flipping `planApproval` because the form default differs from the
    // schema's.
    for (const section of SETTINGS_SECTIONS) {
      expect(canSerialize(section, { hydrated: none, touched: none }), section).toBe(false);
    }
  });

  it('sends a section the user edited even before it loaded', () => {
    expect(canSerialize('budget', { hydrated: none, touched: new Set(['budget']) })).toBe(true);
  });

  it('sends everything once hydrated', () => {
    const hydrated = new Set(SETTINGS_SECTIONS);
    for (const section of SETTINGS_SECTIONS) {
      expect(canSerialize(section, { hydrated, touched: none }), section).toBe(true);
    }
  });

  it('is per section, so one arriving does not unlock the rest', () => {
    const hydrated = new Set<SettingsSection>(['endpoints']);
    expect(canSerialize('endpoints', { hydrated, touched: none })).toBe(true);
    expect(canSerialize('azure', { hydrated, touched: none })).toBe(false);
  });
});

describe('canHydrate — a later snapshot does not overwrite an edit', () => {
  it('allows an untouched section to be filled', () => {
    expect(canHydrate('azure', none)).toBe(true);
  });

  it('refuses a section the user has edited', () => {
    // The real ordering: IPC snapshot lands, the user types an Azure key, the
    // socket snapshot arrives — and rebuilds every row with `apiKey: ''`.
    expect(canHydrate('azure', new Set(['azure']))).toBe(false);
  });

  it('is per section, so editing one does not freeze the others', () => {
    const touched = new Set<SettingsSection>(['budget']);
    expect(canHydrate('budget', touched)).toBe(false);
    expect(canHydrate('models', touched)).toBe(true);
  });
});

describe('the two rules together, over the reported sequence', () => {
  it('snapshot A → user edit → delayed snapshot A → the edit survives and is sent', () => {
    const hydrated = new Set<SettingsSection>();
    const touched = new Set<SettingsSection>();

    // 1. Nothing loaded: a save must say nothing at all.
    expect(canSerialize('budget', { hydrated, touched })).toBe(false);

    // 2. The IPC snapshot lands.
    hydrated.add('budget');
    expect(canHydrate('budget', touched)).toBe(true);

    // 3. The user edits a budget field.
    touched.add('budget');

    // 4. The socket snapshot arrives afterwards and must not replace it…
    expect(canHydrate('budget', touched)).toBe(false);
    // …while the edit is still what a save sends.
    expect(canSerialize('budget', { hydrated, touched })).toBe(true);
  });
});
