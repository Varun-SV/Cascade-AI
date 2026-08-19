// ─────────────────────────────────────────────
//  Cascade AI — which endpoints Settings may speak for
// ─────────────────────────────────────────────

/**
 * The endpoint entries this panel is currently entitled to send.
 *
 * The counterpart to `endpointFromSettingsPayload()` in the SDK, on the sending
 * side. There, a property that is PRESENT and empty is an explicit clear and a
 * property that is ABSENT means "this surface cannot address that provider".
 * The panel therefore must not send an empty property for a field it has not
 * populated yet — and its fields start blank while the snapshot that fills them
 * arrives asynchronously.
 *
 * Between mount and that snapshot, sending everything turned "we do not know
 * yet" into "the user cleared it": pressing Save, or pasting a rotated gateway
 * key and saving, retired the credential paired with a gateway still sitting in
 * the config. Omitting the property is the honest description of not knowing,
 * and the write layer reads it as `preserve` rather than acting on it.
 *
 * A field the user has actually touched is always sent, hydrated or not — they
 * have expressed an intent, and it is theirs.
 *
 * Lives here rather than in the SDK because the renderer cannot import it: the
 * SDK is a Node package and pulling it into the browser bundle to reach one
 * pure function would be the larger mistake.
 */
export function addressableEndpoints(
  fields: ReadonlyArray<readonly [type: string, value: string]>,
  state: { hydrated: boolean; touched: ReadonlySet<string> },
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [type, value] of fields) {
    if (!state.hydrated && !state.touched.has(type)) continue;
    out[type] = value.trim() || undefined;
  }
  return out;
}

/**
 * The endpoint values to apply when a snapshot arrives.
 *
 * A late snapshot must not overwrite a field the user has already edited.
 * Settings hydrates asynchronously, so someone can type gateway B, have the
 * snapshot land holding the old gateway A, and watch their edit vanish — while
 * the key they typed for B stays in the form and is then saved against A.
 *
 * The same `touched` set governs sending and receiving, which is the point: one
 * fact about the field, used by both directions. Split across two rules they
 * disagreed, and the disagreement is invisible in the UI.
 */
export function hydrateEndpoints(
  current: Readonly<Record<string, string>>,
  snapshot: Readonly<Record<string, string | undefined>> | undefined,
  touched: ReadonlySet<string>,
): Record<string, string> {
  const next: Record<string, string> = { ...current };
  if (!snapshot) return next;
  for (const type of Object.keys(current)) {
    if (touched.has(type)) continue;
    next[type] = snapshot[type] ?? '';
  }
  return next;
}
