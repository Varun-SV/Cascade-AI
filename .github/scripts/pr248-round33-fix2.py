from pathlib import Path


def r(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

p = Path('src/browser/remote/controller.ts')
s = p.read_text()

# Narrow the invalidation token: concurrent/replacement WATCHES are valid and
# existing tests intentionally expect both callers to observe streaming. Only
# an UNWATCH must invalidate the popup-handoff attachment that lives outside
# watchQueue.
s = r(s,
"""  /**
   * Identity of the newest watch/unwatch REQUEST, distinct from `watchGen`
   * (which identifies a viewer that actually began). An unwatch increments
   * this synchronously so an in-flight popup attachment cannot resurrect the
   * callback after the panel has already gone away.
   */
  watchIntentGen?: number;
""",
"""  /**
   * Bumped synchronously for every UNWATCH request. Popup page handoff is the
   * one attachment path outside `watchQueue`; it snapshots this value and must
   * not publish if an unwatch arrived while its CDP session was being created.
   * Ordinary queued watches do not use it, so overlapping watchers retain the
   * established idempotent/ordered semantics.
   */
  watchDetachGen?: number;
""", 'detach field')

s = r(s,
"""    // Assigned when REQUESTED, not when this queued turn eventually runs. A
    // later unwatch therefore invalidates an attachment already in flight even
    // though the physical lifecycle operations still execute in their original
    // order. `watchGen` remains the identity of a viewer that actually begins.
    const watchIntent = (held.watchIntentGen ?? 0) + 1;
    held.watchIntentGen = watchIntent;
    // Queued rather than refused. The check for "already watching" happens
""",
"""    // Queued rather than refused. The check for "already watching" happens
""", 'remove watch-wide request token')

s = r(s,
"""      // Do not resurrect a consumer already superseded by an unwatch or a
      // newer watch request. The physical turn still runs in order; only the
      // stale recipient is withheld.
      if (held.watchIntentGen === watchIntent) held.onFrame = onFrame;
""",
"""      held.onFrame = onFrame;
""", 'restore overlapping watcher callback')

s = r(s,
"""      const attached = await this.attachScreencast(runId, held, onFrame, watchIntent);
      // A failed watch must not leave a dead consumer installed. A real
      // watcher that replaced this one meanwhile owns the callback now.
      if (!attached && held.watchIntentGen === watchIntent && held.onFrame === onFrame) {
        held.onFrame = undefined;
      }
""",
"""      const attached = await this.attachScreencast(runId, held, onFrame);
      // A failed watch must not leave a dead consumer installed. A real
      // watcher that replaced this one meanwhile owns the callback now.
      if (!attached && held.onFrame === onFrame) held.onFrame = undefined;
""", 'restore start attach semantics')

s = r(s,
"""    onFrame?: (frame: BrowserFrame) => void,
    expectedWatchIntent = held.watchIntentGen,
  ): Promise<CDPSession | null> {
    const consumerIntent = onFrame ? expectedWatchIntent : undefined;
    if (onFrame && held.watchIntentGen === consumerIntent) held.onFrame = onFrame;
""",
"""    onFrame?: (frame: BrowserFrame) => void,
    popupDetachGen?: number,
  ): Promise<CDPSession | null> {
    // Only popup handoff supplies this token. Normal watcher attachment is
    // already serialized by watchQueue and must preserve overlapping-watch
    // semantics; the token exists solely for the out-of-queue handoff race.
    const consumerIntent = onFrame && popupDetachGen !== undefined ? popupDetachGen : undefined;
    if (onFrame) held.onFrame = onFrame;
""", 'narrow attach token')

s = r(s,
"""        return this.attachScreencast(runId, held, onFrame, expectedWatchIntent);
""",
"""        return this.attachScreencast(runId, held, onFrame, popupDetachGen);
""", 'recursive detach token')

s = s.replace('held.watchIntentGen !== consumerIntent', 'held.watchDetachGen !== consumerIntent')

s = r(s,
"""    held.watchIntentGen = (held.watchIntentGen ?? 0) + 1;
""",
"""    held.watchDetachGen = (held.watchDetachGen ?? 0) + 1;
""", 'unwatch detach generation')

# Popup/adopt path opts into request-time unwatch invalidation. Ordinary
# startWatching intentionally does not.
s = r(s,
"""      await this.attachScreencast(runId, held, deliver);
      return;
""",
"""      await this.attachScreencast(runId, held, deliver, held.watchDetachGen ?? 0);
      return;
""", 'popup attach detach token')

# A page that was already closed when THIS action was planned is a recovery
# boundary, not a concurrent navigation. `open()` may legitimately adopt the
# surviving opener and bump generation; compare perform() against that recovered
# generation. If the page closes only while the action waits, the old planned
# generation remains and the action is still refused rather than retargeted.
s = r(s,
"""    const planned = this.runs.get(runId)?.generation ?? 0;

    const lease_ = this.leaseFor(runId);
""",
"""    const plannedRun = this.runs.get(runId);
    const planned = plannedRun?.generation ?? 0;
    const recoveringClosedPage = plannedRun?.page.isClosed() === true;

    const lease_ = this.leaseFor(runId);
""", 'planned closed page snapshot')

s = r(s,
"""      return await this.perform(runId, held, action, planned);
""",
"""      return await this.perform(runId, held, action, recoveringClosedPage ? held.generation : planned);
""", 'allow deliberate closed-popup recovery')

p.write_text(s)
