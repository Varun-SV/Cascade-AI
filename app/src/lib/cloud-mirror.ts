// Copies the desktop's runs to the signed-in Cascade account: each finished
// turn into the shared cloud chat (so it also shows on web and CLI), and each
// run's cost into the account's spend report.
//
// Driven by App's socket handlers, which never unmount, rather than by the
// chat panel: a run can finish while the user is looking at another session
// or another view, and its spend counts all the same. Everything here is
// best-effort: it never blocks or breaks a run, and does nothing when signed
// out or opted out (`cascade.noCloudSync`).

/** What a run reports for the cloud: its cost and its /why, as JSON. */
export interface RunAccounting { costUsd: number; why: string }

export interface CloudMirrorApi {
  createConversation(title?: string): Promise<{ ok: boolean; conversation?: { id: string } }>;
  appendTurn(id: string, turn: { userContent: string; assistant: { content: string; costUsd?: number; why?: string } }): Promise<{ ok: boolean }>;
  recordUnansweredRun(run: { conversationId: string | null; outcome: 'failed' | 'stopped'; costUsd: number; why: string }): Promise<{ ok: boolean }>;
}

export class CloudMirror {
  /** The prompt each session's current run was started with. */
  private prompts = new Map<string, string>();
  /** The cloud chat each local session is copied to. */
  private chats = new Map<string, string>();

  constructor(
    private readonly api: () => Partial<CloudMirrorApi> | undefined,
    private readonly optedOut: () => boolean,
  ) {}

  /** Called when a run starts, so its turn can be copied when it ends. */
  rememberPrompt(sessionId: string, prompt: string): void {
    this.prompts.set(sessionId, prompt);
  }

  /** A run ended with `session:complete`. */
  async completed(data: { sessionId?: string; result?: { output?: string }; cloud?: RunAccounting } | undefined): Promise<void> {
    const sid = data?.sessionId;
    if (!sid || this.optedOut()) return;
    const prompt = this.prompts.get(sid);
    const output = data?.result?.output;
    const api = this.api();
    try {
      if (output && prompt) {
        if (!api?.appendTurn || !api.createConversation) return;
        const chat = await this.chatFor(sid, prompt, api);
        if (!chat) return;
        // With its cost and /why, so the run counts in the spend report.
        await api.appendTurn(chat, { userContent: prompt, assistant: { content: output, ...data?.cloud } });
      } else if (data?.cloud) {
        // Stopped before any answer: the run resolves with no text, but the
        // calls it made were billed.
        await this.unanswered(sid, 'stopped', data.cloud);
      }
    } catch { /* best-effort mirror — offline, revoked token, etc. */ }
  }

  /** A run ended with `session:error`: no reply, but its calls were billed. */
  async failed(data: { sessionId?: string; cloud?: RunAccounting; stopped?: boolean } | undefined): Promise<void> {
    const sid = data?.sessionId;
    if (!sid || !data?.cloud || this.optedOut()) return;
    try {
      await this.unanswered(sid, data.stopped ? 'stopped' : 'failed', data.cloud);
    } catch { /* best-effort — the run's error is what the user sees */ }
  }

  /** Joins the chat already copied, if any; never creates an empty one. */
  private async unanswered(sid: string, outcome: 'failed' | 'stopped', accounting: RunAccounting): Promise<void> {
    const api = this.api();
    if (!api?.recordUnansweredRun) return;
    await api.recordUnansweredRun({ conversationId: this.chats.get(sid) ?? null, outcome, ...accounting });
  }

  private async chatFor(sid: string, prompt: string, api: Partial<CloudMirrorApi>): Promise<string | null> {
    const known = this.chats.get(sid);
    if (known) return known;
    const created = await api.createConversation!(prompt.slice(0, 72));
    if (!created.ok || !created.conversation) return null; // signed out / error → skip
    this.chats.set(sid, created.conversation.id);
    return created.conversation.id;
  }
}

/** The desktop's one mirror, over the preload bridge. */
export const cloudMirror = new CloudMirror(
  () => (typeof window === 'undefined' ? undefined : (window as unknown as { cascade?: { cloud?: Partial<CloudMirrorApi> } }).cascade?.cloud),
  () => { try { return localStorage.getItem('cascade.noCloudSync') === '1'; } catch { return false; } },
);
