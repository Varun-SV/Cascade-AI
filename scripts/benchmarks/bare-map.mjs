// ─────────────────────────────────────────────
//  Cascade AI — Prototype-free maps for source data
// ─────────────────────────────────────────────
/**
 * A map with NO prototype, for keys that come out of source files.
 *
 * Model families and modality names are arbitrary strings from JSON, and a
 * plain `{}` already has an answer for every one of `Object.prototype`'s.
 * `groups['toString']` is a function, so `??=` leaves it alone and the `.push`
 * after it throws — aborting the whole refresh over one source file the loader
 * promises to merely skip. `__proto__` fails the other way and more quietly:
 * assigning to it on a plain object runs the inherited setter instead of
 * storing anything, so the row vanishes without a warning and the snapshot is
 * short by one, which nobody notices because nothing said so.
 *
 * Null-prototype objects have neither behaviour — every key is an ordinary own
 * property, `__proto__` included. Denylisting the dangerous names instead
 * would be the same race this codebase already lost once over headers: the set
 * is fixed today and the cost of missing one is silent.
 *
 * They stringify, spread and enumerate exactly like `{}`, so nothing
 * downstream can tell the difference.
 */
export function bareMap(from) {
  const map = Object.create(null);
  if (from) for (const [k, v] of Object.entries(from)) map[k] = v;
  return map;
}
