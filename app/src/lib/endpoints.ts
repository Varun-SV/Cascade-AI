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
 * What ONE endpoint field becomes when a snapshot arrives.
 *
 * Per field, and taking `current` as an argument rather than reading a captured
 * object, because the callers are asynchronous: `getSettings().then(applyConfig)`
 * runs under a mount-time closure and the socket listener under a per-socket
 * one. A batch version that received "all the current values" received the
 * values from the render that registered the callback — so the rule correctly
 * refused to overwrite a dirty field and then wrote back the stale empty string
 * it had captured, erasing the edit anyway. Used inside a functional state
 * update, `current` is whatever React holds right now and there is nothing to
 * go stale.
 *
 * A field the user has already edited is never replaced: the snapshot can land
 * after they have typed, and overwriting loses the edit while keeping the key
 * typed beside it — which the next save then pairs with the host they replaced.
 */
export function endpointAfterSnapshot(
  current: string,
  snapshotValue: string | undefined,
  touched: boolean,
): string {
  return touched ? current : (snapshotValue ?? '');
}
