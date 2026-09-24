// ─────────────────────────────────────────────
//  Cascade AI — Who may use the workspace at once
// ─────────────────────────────────────────────
//
//  What a local-only subtask writes is marked local-only (privacy/paths.ts).
//  A file tool's write is marked before it happens; a command's writes can
//  only be found once it has ended. Until then, a file it wrote looks like
//  any other — so while it runs, no other tool call may run: a read would
//  see what it wrote, and a write would be marked local-only along with it.
//
//  Tool calls take the gate shared; that command, and a local-only file
//  write, take it alone. First come, first served: a caller waiting to go
//  alone holds back the shared callers behind it, so it is not starved.

export class WorkspaceGate {
  private shared = 0;
  private alone = false;
  private queue: Array<{ alone: boolean; grant: () => void }> = [];

  /** Wait for a turn; the function returned ends it. */
  enter(alone: boolean): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({ alone, grant: () => resolve(this.leaver(alone)) });
      this.pump();
    });
  }

  private leaver(alone: boolean): () => void {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (alone) this.alone = false;
      else this.shared -= 1;
      this.pump();
    };
  }

  private pump(): void {
    while (this.queue.length > 0 && !this.alone) {
      const next = this.queue[0]!;
      if (next.alone && this.shared > 0) return;
      this.queue.shift();
      if (next.alone) this.alone = true;
      else this.shared += 1;
      next.grant();
    }
  }
}
