// ─────────────────────────────────────────────
//  Cascade AI — applying a settings snapshot to form state
// ─────────────────────────────────────────────

/**
 * A form value derived from a snapshot field, with UNSET meaning unset.
 *
 * The snapshot is complete: every section the save can write, it carries. So a
 * field that comes back `undefined` is a positive statement that nothing is
 * configured — not an absence of information — and applying only the values
 * that happened to be present made hydration a MERGE. A budget cap or SearXNG
 * URL cleared elsewhere stayed in the form, and the next unrelated Save
 * serialized it straight back and recreated the setting.
 *
 * `fallback` is what unset looks like in the form: `''` for a text input, the
 * documented default for an advanced knob.
 */
export function fieldFromSnapshot<T>(value: T | undefined | null, fallback: T): T {
  return value === undefined || value === null ? fallback : value;
}

/** The same rule for a numeric input, which the form holds as a string. */
export function numberFieldFromSnapshot(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : '';
}
