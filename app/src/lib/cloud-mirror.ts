// Copies the desktop's runs to the signed-in Cascade account: each answered
// turn into the shared cloud chat (so it also shows on web and CLI), and every
// run's cost into the account's spend report.
//
// Driven by the backend's `run:accounting` event, which App listens for and
// which comes once per run after its calls have settled, whichever session or
// view is on screen. Everything here is best-effort: it never blocks or breaks
// a run, and does nothing when signed out or opted out (`cascade.noCloudSync`).

/** What a run reports for the cloud: its cost and its /why, as JSON. */
export interface RunAccounting { costUsd: number; why: string }

/** One finished run, as the backend sends it in `run:accounting`. */
export interface AccountedRun {
  sessionId?: string;
  prompt?: string;
  output?: string;
  outcome?: 'answered' | 'failed' | 'stopped';
  /** False for runs not started from the desktop's own views (scheduled, API). */
  copyTurn?: boolean;
  cloud?: RunAccounting;
}

export interface CloudMirrorApi {
  /** Who is signed in, and to which server: the links below belong to them. */
  status(): Promise<{ signedIn: boolean; user: { id: string } | null; serverUrl: string }>;
  createConversation(title?: string): Promise<{ ok: boolean; conversation?: { id: string } }>;
  appendTurn(id: string, turn: { userContent: string; assistant: { content: string; costUsd?: number; why?: string } }): Promise<{ ok: boolean }>;
  recordRunSpend(run: { conversationId: string | null; outcome: 'answered' | 'failed' | 'stopped'; costUsd: number; why: string }): Promise<{ ok: boolean }>;
}

/**
 * Where the local-session → cloud-chat links are kept between launches. Keys
 * name the account as well as the session (`account|session`): a chat made
 * under one account is no use to another signed in later.
 */
export interface ChatLinks {
  get(key: string): string | undefined;
  set(key: string, chatId: string): void;
  delete(key: string): void;
}

/** Links kept in localStorage, newest last, at most `max` of them. */
export function storedChatLinks(key = 'cascade.cloudChats', max = 500): ChatLinks {
  const read = (): Array<[string, string]> => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
      return Array.isArray(raw) ? raw.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : [];
    } catch { return []; }
  };
  const memory = new Map<string, string>(read());
  const save = () => { try { localStorage.setItem(key, JSON.stringify([...memory])); } catch { /* kept for this launch only */ } };
  return {
    get: (k) => memory.get(k),
    set: (k, chat) => {
      memory.delete(k);
      memory.set(k, chat);
      while (memory.size > max) memory.delete(memory.keys().next().value!);
      save();
    },
    delete: (k) => { if (memory.delete(k)) save(); },
  };
}

export class CloudMirror {
  /** Runs are sent one at a time, in the order they ended. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: () => Partial<CloudMirrorApi> | undefined,
    private readonly optedOut: () => boolean,
    private readonly chats: ChatLinks,
  ) {}

  /** A run's `run:accounting`. Resolves once it has been sent, or skipped. */
  accounted(run: AccountedRun | undefined): Promise<void> {
    this.queue = this.queue.then(() => this.send(run)).catch(() => { /* best-effort mirror */ });
    return this.queue;
  }

  private async send(run: AccountedRun | undefined): Promise<void> {
    const sid = run?.sessionId;
    if (!sid || !run?.cloud || this.optedOut()) return;
    const api = this.api();
    if (!api) return;
    // Links belong to the account they were made under; signed out, nothing goes.
    const who = await api.status?.().catch(() => null);
    if (api.status && (!who?.signedIn || !who.user)) return;
    const key = `${who?.serverUrl ?? ''}|${who?.user?.id ?? ''}|${sid}`;
    const outcome = run.outcome ?? 'answered';
    // An answered turn from the desktop's own views is copied, with its cost.
    if (outcome === 'answered' && run.output && run.prompt && run.copyTurn !== false
      && api.appendTurn && api.createConversation) {
      const turn = { userContent: run.prompt, assistant: { content: run.output, ...run.cloud } };
      const known = this.chats.get(key);
      if (known) {
        if ((await api.appendTurn(known, turn)).ok) return;
        // The chat is gone, or not this account's: start a new one.
        this.chats.delete(key);
      }
      const chat = await this.newChat(key, run.prompt, api);
      if (chat && (await api.appendTurn(chat, turn)).ok) return;
    }
    // Anything else still spent money: its cost alone, under the chat already
    // copied for this session if there is one. It never creates an empty chat.
    if (!api.recordRunSpend) return;
    const conversationId = this.chats.get(key) ?? null;
    const sent = await api.recordRunSpend({ conversationId, outcome, ...run.cloud });
    // A chat the account can no longer reach: count the run on its own.
    if (!sent.ok && conversationId) {
      this.chats.delete(key);
      await api.recordRunSpend({ conversationId: null, outcome, ...run.cloud });
    }
  }

  private async newChat(key: string, prompt: string, api: Partial<CloudMirrorApi>): Promise<string | null> {
    const created = await api.createConversation!(prompt.slice(0, 72));
    if (!created.ok || !created.conversation) return null; // signed out / error
    this.chats.set(key, created.conversation.id);
    return created.conversation.id;
  }
}

/** The desktop's one mirror, over the preload bridge. */
export const cloudMirror = new CloudMirror(
  () => (typeof window === 'undefined' ? undefined : (window as unknown as { cascade?: { cloud?: Partial<CloudMirrorApi> } }).cascade?.cloud),
  () => { try { return localStorage.getItem('cascade.noCloudSync') === '1'; } catch { return false; } },
  storedChatLinks(),
);
