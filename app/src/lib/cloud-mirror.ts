// Copies the desktop's runs to the signed-in Cascade account: each answered
// turn into the shared cloud chat (so it also shows on web and CLI), and every
// run's cost into the account's spend report.
//
// Driven by the backend's `run:accounting` event, which App listens for and
// which comes once per run after its calls have settled, whichever session or
// view is on screen. It never blocks or breaks a run, and does nothing when
// signed out or opted out (`cascade.noCloudSync`). Each report ends as
// delivered, skipped on purpose, or to be retried: only the first two are
// confirmed to the backend, which keeps the third and replays it on the next
// connect (see `mirrorAndConfirm`).

/** What a run reports for the cloud: its cost and its /why, as JSON. */
export interface RunAccounting { costUsd: number; why: string }

/** One finished run, as the backend sends it in `run:accounting`. */
export interface AccountedRun {
  /** The backend's id for this report; also the run's id in the cloud. */
  id?: string;
  sessionId?: string;
  prompt?: string;
  output?: string;
  outcome?: 'answered' | 'failed' | 'stopped';
  /** False for runs not started from the desktop's own views (scheduled, API). */
  copyTurn?: boolean;
  /** When the run finished (epoch ms), so it counts on that day in the cloud. */
  endedAt?: number;
  cloud?: RunAccounting;
}

export interface CloudMirrorApi {
  /** Who is signed in, and to which server: the links below belong to them. */
  status(): Promise<{ signedIn: boolean; user: { id: string } | null; serverUrl: string }>;
  createConversation(title?: string): Promise<{ ok: boolean; conversation?: { id: string } }>;
  appendTurn(id: string, turn: { userContent: string; runId?: string; outcome?: 'answered' | 'stopped'; endedAt?: number; assistant: { content: string; costUsd?: number; why?: string } }): Promise<{ ok: boolean; error?: string }>;
  recordRunSpend(run: { conversationId: string | null; outcome: 'answered' | 'failed' | 'stopped'; costUsd: number; why: string; runId?: string; endedAt?: number }): Promise<{ ok: boolean; error?: string }>;
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

/** The cloud answers 404 for a chat that was deleted, or is not this account's. */
const isNotFound = (error: string | undefined): boolean => /\(404\)/.test(error ?? '');

/**
 * How a report ended. 'delivered': the cloud has it. 'skipped': on purpose
 * (opted out, signed out, another account now, nothing to send) and never
 * worth sending again. 'retry': the cloud could not be reached or answered
 * with an error, so the backend must keep it.
 */
export type MirrorResult = 'delivered' | 'skipped' | 'retry';

type CloudStatus = Awaited<ReturnType<CloudMirrorApi['status']>>;

const newRunId = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export class CloudMirror {
  /** Runs are sent one at a time, in the order they ended. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: () => Partial<CloudMirrorApi> | undefined,
    private readonly optedOut: () => boolean,
    private readonly chats: ChatLinks,
  ) {}

  /**
   * A run's `run:accounting`. Resolves with how it ended (see MirrorResult).
   * Who is signed in, and whether syncing is on, are taken now, as the run
   * ends: a send can wait behind a slow one, and if the account changes in
   * the meantime the run is not sent to the new one.
   */
  accounted(run: AccountedRun | undefined): Promise<MirrorResult> {
    const optedOut = this.optedOut();
    const atEnd = optedOut ? Promise.resolve(null) : this.api()?.status?.().catch(() => 'error' as const);
    // Anything that throws (a bridge call rejecting) is a failure to retry.
    const result = this.queue.then(() => this.send(run, optedOut, atEnd)).catch((): MirrorResult => 'retry');
    this.queue = result.then(() => undefined);
    return result;
  }

  private async send(
    run: AccountedRun | undefined,
    optedOut: boolean,
    atEnd: Promise<CloudStatus | null | 'error'> | undefined,
  ): Promise<MirrorResult> {
    const sid = run?.sessionId;
    if (!sid || !run?.cloud || optedOut || this.optedOut()) return 'skipped';
    const api = this.api();
    if (!api) return 'skipped';
    // Links belong to the account they were made under; signed out, nothing goes.
    const ended = await atEnd;
    // Not knowing who is signed in is not the same as nobody being signed in.
    if (ended === 'error') return 'retry';
    const who = ended ?? null;
    if (api.status) {
      if (!who?.signedIn || !who.user) return 'skipped';
      // Still the account the run ended under, on the same server.
      const now = await api.status().catch(() => 'error' as const);
      if (now === 'error') return 'retry';
      if (!now?.signedIn || now.user?.id !== who.user.id || now.serverUrl !== who.serverUrl) return 'skipped';
    }
    const key = `${who?.serverUrl ?? ''}|${who?.user?.id ?? ''}|${sid}`;
    const outcome = run.outcome ?? 'answered';
    // One id for this run, however it is sent and however often: the cloud
    // adds its turn to a chat once, and counts the run once, per id. The
    // backend's id when it gave one, so a replayed report is the same run.
    const runId = typeof run.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(run.id) ? run.id : newRunId();
    const endedAt = typeof run.endedAt === 'number' ? { endedAt: run.endedAt } : {};
    // A turn from the desktop's own views is copied, with its cost: an answer,
    // or what a run the user stopped had written so far (counted as stopped).
    if ((outcome === 'answered' || outcome === 'stopped') && run.output && run.prompt && run.copyTurn !== false
      && api.appendTurn && api.createConversation) {
      const turn = {
        userContent: run.prompt, runId, ...(outcome === 'stopped' ? { outcome } : {}), ...endedAt,
        assistant: { content: run.output, ...run.cloud },
      };
      const known = this.chats.get(key);
      const sent = known ? await this.appendTurn(api, known, turn) : 'gone';
      if (sent === 'ok') return 'delivered';
      if (sent === 'gone') {
        // No chat yet, or the one linked is gone or not this account's.
        if (known) this.chats.delete(key);
        const chat = await this.newChat(key, run.prompt, api);
        if (chat && (await this.appendTurn(api, chat, turn)) === 'ok') return 'delivered';
      }
    }
    // Anything else still spent money: its cost alone, under the chat already
    // copied for this session if there is one. It never creates an empty chat.
    // Under the same run id, so a turn that was added after all is not counted
    // a second time.
    if (!api.recordRunSpend) return 'skipped';
    const conversationId = this.chats.get(key) ?? null;
    const cost = run.cloud;
    const send = (chat: string | null) => api.recordRunSpend!({ conversationId: chat, outcome, runId, ...endedAt, ...cost })
      .catch(() => ({ ok: false, error: undefined }));
    let recorded = await send(conversationId);
    // No answer: once more, to the same chat (the run id keeps it to one).
    if (!recorded.ok && !isNotFound(recorded.error)) recorded = await send(conversationId);
    // Only a chat the cloud says is gone loses its link (and the run is
    // counted on its own): a lost answer or a passing error leaves the
    // session's later turns in the chat they belong to.
    if (!recorded.ok && conversationId && isNotFound(recorded.error)) {
      this.chats.delete(key);
      recorded = await send(null);
    }
    // Not counted: kept by the backend and sent again, under the same run id.
    return recorded.ok ? 'delivered' : 'retry';
  }

  /**
   * Sends a turn to a chat, and once more if no answer came back: the cloud
   * then answers from what the first request added, so a lost response does
   * not copy the turn twice or start another chat. 'gone' when the chat no
   * longer exists or is not this account's (the cloud answers 404).
   */
  private async appendTurn(
    api: Partial<CloudMirrorApi>, chat: string, turn: Parameters<CloudMirrorApi['appendTurn']>[1],
  ): Promise<'ok' | 'gone' | 'failed'> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await api.appendTurn!(chat, turn).catch(() => ({ ok: false, error: undefined }));
      if (result.ok) return 'ok';
      if (isNotFound(result.error)) return 'gone';
    }
    return 'failed';
  }

  private async newChat(key: string, prompt: string, api: Partial<CloudMirrorApi>): Promise<string | null> {
    const created = await api.createConversation!(prompt.slice(0, 72));
    if (!created.ok || !created.conversation) return null; // signed out / error
    this.chats.set(key, created.conversation.id);
    return created.conversation.id;
  }
}

/**
 * Mirrors one `run:accounting` report and confirms it to the backend only once
 * it was delivered or skipped on purpose. A report that failed is left
 * unconfirmed, so the backend keeps it on disk and replays it on the next
 * connect, under the same id.
 */
export async function mirrorAndConfirm(
  mirror: Pick<CloudMirror, 'accounted'>, run: AccountedRun | undefined, confirm: (id: string) => void,
): Promise<MirrorResult> {
  const result = await mirror.accounted(run);
  if (result !== 'retry' && typeof run?.id === 'string') confirm(run.id);
  return result;
}

/** The desktop's one mirror, over the preload bridge. */
export const cloudMirror = new CloudMirror(
  () => (typeof window === 'undefined' ? undefined : (window as unknown as { cascade?: { cloud?: Partial<CloudMirrorApi> } }).cascade?.cloud),
  () => { try { return localStorage.getItem('cascade.noCloudSync') === '1'; } catch { return false; } },
  storedChatLinks(),
);
