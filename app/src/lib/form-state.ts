// ─────────────────────────────────────────────
//  Cascade AI — what a settings form may say, and when
// ─────────────────────────────────────────────
//
//  Two rules, applied to EVERY writeable section rather than to endpoints
//  alone. Endpoints got them first, and each round since found another section
//  that needed them:
//
//    - a section the form has not loaded yet must not be serialized, because
//      its mount-time default is not a statement the user made. Saving before
//      the first snapshot sent `models: auto` (deleting every tier pin),
//      `azureDeployments: []` (deleting every row), a blank SearXNG URL and the
//      whole advanced default set — one of which, `planApproval: 'complex'`,
//      differs from the schema default, so a no-op Save silently turned plan
//      approval on;
//    - a section the user has edited must not be replaced by a snapshot that
//      arrives afterwards. The panel requests one over IPC and another over the
//      socket, independently, so the second can land after an edit. Azure was
//      the worst case: the redacted snapshot rebuilds each row with
//      `apiKey: ''`, so a key typed between the two snapshots was erased.

/** The sections a settings save can write, each hydrated and dirtied on its own. */
export type SettingsSection =
  | 'models' | 'budget' | 'endpoints' | 'azure' | 'webSearch' | 'advanced';

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'models', 'budget', 'endpoints', 'azure', 'webSearch', 'advanced',
];

/**
 * Whether this section may be included in a save.
 *
 * Hydrated OR touched: a section the user has edited is theirs to send even if
 * nothing has loaded, and withholding their own edit would be its own bug.
 */
export function canSerialize(
  section: SettingsSection,
  state: { hydrated: ReadonlySet<SettingsSection>; touched: ReadonlySet<SettingsSection> },
): boolean {
  return state.hydrated.has(section) || state.touched.has(section);
}

/**
 * Whether an arriving snapshot may replace this section.
 *
 * Never once the user has touched it. Dirtiness is cleared only by a save the
 * backend acknowledged, because until then the form holds the newer truth.
 */
export function canHydrate(
  section: SettingsSection,
  touched: ReadonlySet<SettingsSection>,
): boolean {
  return !touched.has(section);
}
