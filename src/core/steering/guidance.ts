// ─────────────────────────────────────────────
//  Cascade AI — Live Steering (user → running workers)
// ─────────────────────────────────────────────
//
//  Lets a user "hijack" a running worker: text injected mid-run is drained by
//  each T3 worker at the top of its next agent-loop iteration and prepended
//  to its context as a USER INTERVENTION message. Honest granularity: it does
//  not abort an in-flight LLM call — it lands on the very next iteration.

export interface GuidanceEntry {
  text: string;
  /** Target a specific tier node (exact id or id prefix). Omitted = every worker. */
  nodeId?: string;
  timestamp: string;
}

export class GuidanceQueue {
  private entries: GuidanceEntry[] = [];
  /** Per-consumer read cursor so a broadcast entry reaches each worker once. */
  private cursors = new Map<string, number>();

  push(text: string, nodeId?: string): GuidanceEntry {
    const entry: GuidanceEntry = { text, nodeId, timestamp: new Date().toISOString() };
    this.entries.push(entry);
    return entry;
  }

  /**
   * New entries for this consumer since its last drain, filtered to entries
   * that target it (or target everyone). Advances the consumer's cursor.
   */
  drain(consumerId: string): GuidanceEntry[] {
    const from = this.cursors.get(consumerId) ?? 0;
    this.cursors.set(consumerId, this.entries.length);
    return this.entries
      .slice(from)
      .filter((e) => !e.nodeId || consumerId === e.nodeId || consumerId.startsWith(e.nodeId));
  }

  get size(): number {
    return this.entries.length;
  }
}
