// Copies the desktop's runs to the signed-in Cascade account: each answered
// turn into the shared cloud chat (so it also shows on web and CLI), and every
// run's cost into the account's spend report.
//
// Driven by the backend's `run:accounting` event, which App listens for and
// which comes once per run after its calls have settled, whichever session or
// view is on screen. It never blocks or breaks a run, and does nothing when
// signed out or opted out (`cascade.noCloudSync`). Each report ends as
// delivered, skipped on purpose, refused for good, or to be retried: all but
// the last are confirmed to the backend, which keeps that one and replays it
// on the next connect (see `mirrorAndConfirm`).

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
  /**
   * The account the desktop was signed in to when the run ended (null: signed
   * out), stamped by the backend. A report replayed later, maybe after another
   * account signed in, is sent only to this one. Absent from hosts that cannot
   * tell, where the account signed in when the report arrives is used.
   */
  account?: { userId: string; serverUrl: string } | null;
  /**
   * Whether syncing to the cloud was on when the run ended, stamped by the
   * backend. Only true is uploaded. Absent from reports an older build kept
   * on disk: those cannot show the user agreed as the run ended, so they are
   * never uploaded either, whatever the setting is now. (Hosts that cannot
   * stamp it have no cloud bridge, so nothing of theirs is uploaded anyway.)
   */
  sync?: boolean;
  cloud?: RunAccounting;
}

/** A user on a given cloud server. */
export interface CloudAccount { userId: string; serverUrl: string }

export interface CloudMirrorApi {
  /** Who is signed in, and to which server: the links below belong to them. */
  status(): Promise<{ signedIn: boolean; user: { id: string } | null; serverUrl: string }>;
  // `account`: who the request is for. The main process answers
  // `accountChanged` instead of sending it if another account is signed in,
  // and `syncOff` if syncing is off now.
  createConversation(title?: string, account?: CloudAccount): Promise<{ ok: boolean; accountChanged?: boolean; syncOff?: boolean; conversation?: { id: string } }>;
  appendTurn(id: string, turn: { userContent: string; runId?: string; outcome?: 'answered' | 'stopped'; endedAt?: number; assistant: { content: string; costUsd?: number; why?: string } }, account?: CloudAccount): Promise<{ ok: boolean; accountChanged?: boolean; syncOff?: boolean; error?: string }>;
  recordRunSpend(run: { conversationId: string | null; outcome: 'answered' | 'failed' | 'stopped'; costUsd: number; why: string; runId?: string; endedAt?: number }, account?: CloudAccount): Promise<{ ok: boolean; accountChanged?: boolean; syncOff?: boolean; error?: string }>;
  /** Records the opt-out in the main process, where the backend and the uploads read it. */
  setSyncOptOut?(optedOut: boolean): Promise<{ ok: boolean }>;
  /**
   * Hands the main process the opt-out an earlier build kept here. Until it
   * has, the main process counts syncing as off.
   */
  adoptSyncSetting?(legacyOptedOut: boolean): Promise<{ ok: boolean; optedOut?: boolean }>;
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
 * worth sending again. 'rejected': the cloud refused it in a way it would
 * refuse it again (a 4xx such as a report too large), so sending it again
 * would only repeat that forever. 'retry': no answer, a server error, or a
 * sign-in to renew, so the backend must keep it.
 */
export type MirrorResult = 'delivered' | 'skipped' | 'rejected' | 'retry';

/**
 * Whether a failed request is worth sending again: no answer at all (no
 * status), a server error, a sign-in to renew (401), a timeout (408) or a
 * rate limit (429). Any other 4xx would fail the same way every time.
 */
const isRetryable = (error: string | undefined): boolean => {
  const status = /\((\d{3})\)/.exec(error ?? '');
  if (!status) return true;
  const code = Number(status[1]);
  return code >= 500 || code === 401 || code === 408 || code === 429;
};

type CloudStatus = Awaited<ReturnType<CloudMirrorApi['status']>>;

/**
 * Another account signed in while a report was being sent: the rest of it is
 * not sent, to anyone. Thrown from any request so the send stops at once.
 */
class AccountChanged extends Error {}
/** Syncing was turned off while a report was being sent: the rest is not sent either. */
class SyncOff extends Error {}
type Answer = { ok: boolean; error?: string; accountChanged?: boolean; syncOff?: boolean };
const guard = <T extends Answer>(result: T): T => {
  if (result.accountChanged) throw new AccountChanged();
  if (result.syncOff) throw new SyncOff();
  return result;
};

const newRunId = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export class CloudMirror {
  /** Runs are sent one at a time, in the order they ended. */
  private queue: Promise<void> = Promise.resolve();
  /**
   * Per account and session, the report whose turn failed to copy and is to
   * be sent again: later turns of that session wait behind it (as 'retry'),
   * so the replay, which comes oldest first, copies them in the order the
   * runs ended. Spend-only reports and other sessions are not held.
   */
  private readonly heldBy = new Map<string, string>();

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
    // Off as the run ended (the backend's stamp) or off now: nothing is asked or sent.
    // Only a report stamped on as it ended can be uploaded (see `sync`).
    const optedOut = run?.sync !== true || this.optedOut();
    const atEnd = optedOut ? Promise.resolve(null) : this.api()?.status?.().catch(() => 'error' as const);
    // Anything that throws (a bridge call rejecting) is a failure to retry.
    // Another account signing in part-way is a skip, like one signed in before.
    const result = this.queue.then(() => this.send(run, optedOut, atEnd))
      .catch((err): MirrorResult => (err instanceof AccountChanged || err instanceof SyncOff ? 'skipped' : 'retry'))
      .then((outcome) => {
        // Settled for good (sent, skipped, refused): it is confirmed and never
        // replayed, so nothing may stay held behind it.
        if (outcome !== 'retry' && typeof run?.id === 'string') this.releaseRun(run.id);
        return outcome;
      });
    this.queue = result.then(() => undefined);
    return result;
  }

  private async send(
    run: AccountedRun | undefined,
    optedOut: boolean,
    atEnd: Promise<CloudStatus | null | 'error'> | undefined,
  ): Promise<MirrorResult> {
    const sid = run?.sessionId;
    // Off when the run ended is off for good; off now is off too.
    if (!sid || !run?.cloud || run.sync !== true || optedOut || this.optedOut()) return 'skipped';
    const api = this.api();
    if (!api) return 'skipped';
    // Links belong to the account they were made under; signed out, nothing goes.
    // The account the run ended under, as the backend stamped it; else the one
    // signed in when this report arrived.
    const stamped = run.account;
    if (stamped === null) return 'skipped';
    const ended = stamped && typeof stamped.userId === 'string' && typeof stamped.serverUrl === 'string'
      ? { signedIn: true, user: { id: stamped.userId }, serverUrl: stamped.serverUrl }
      : await atEnd;
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
    // Every request names this account, and the main process checks it just
    // before sending: another account signing in mid-send gets nothing.
    const owner: CloudAccount | undefined = who?.user ? { userId: who.user.id, serverUrl: who.serverUrl } : undefined;
    const outcome = run.outcome ?? 'answered';
    let turnToRetry = false;
    // One id for this run, however it is sent and however often: the cloud
    // adds its turn to a chat once, and counts the run once, per id. The
    // backend's id when it gave one, so a replayed report is the same run.
    const stableId = typeof run.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(run.id);
    const runId = stableId ? run.id! : newRunId();
    const endedAt = typeof run.endedAt === 'number' ? { endedAt: run.endedAt } : {};
    // A turn from the desktop's own views is copied, with its cost: an answer,
    // or what a run the user stopped had written so far (counted as stopped).
    if ((outcome === 'answered' || outcome === 'stopped') && run.output && run.prompt && run.copyTurn !== false
      && api.appendTurn && api.createConversation) {
      // An earlier turn of this session is still to be copied: this one goes after it.
      const holder = this.heldBy.get(key);
      if (holder && holder !== runId) return 'retry';
      const turn = {
        userContent: run.prompt, runId, ...(outcome === 'stopped' ? { outcome } : {}), ...endedAt,
        assistant: { content: run.output, ...run.cloud },
      };
      const known = this.chats.get(key);
      let sent = known ? await this.appendTurn(api, known, turn, owner) : 'gone';
      if (sent === 'ok') { this.release(key, runId); return 'delivered'; }
      if (sent === 'gone') {
        // No chat yet, or the one linked is gone or not this account's.
        if (known) this.chats.delete(key);
        const chat = await this.newChat(key, run.prompt, api, owner);
        sent = chat ? await this.appendTurn(api, chat, turn, owner) : 'retry';
        if (sent === 'ok') { this.release(key, runId); return 'delivered'; }
      }
      // The turn could not be copied this time: send it again later, after
      // its cost is counted below. The cloud adds a turn to a chat once per
      // run id, and counts the run once, so the resend repeats neither.
      turnToRetry = sent === 'retry';
      // Held only for a report the backend keeps and replays (it has an id).
      if (turnToRetry && stableId) this.heldBy.set(key, runId);
      else this.release(key, runId);
    }
    // Anything else still spent money: its cost alone, under the chat already
    // copied for this session if there is one. It never creates an empty chat.
    // Under the same run id, so a turn that was added after all is not counted
    // a second time.
    if (!api.recordRunSpend) return 'skipped';
    const conversationId = this.chats.get(key) ?? null;
    const cost = run.cloud;
    const send = (chat: string | null) => api.recordRunSpend!({ conversationId: chat, outcome, runId, ...endedAt, ...cost }, owner)
      .catch((): Answer => ({ ok: false })).then(guard);
    let recorded = await send(conversationId);
    // No answer: once more, to the same chat (the run id keeps it to one).
    if (!recorded.ok && !isNotFound(recorded.error) && isRetryable(recorded.error)) recorded = await send(conversationId);
    // Only a chat the cloud says is gone loses its link (and the run is
    // counted on its own): a lost answer or a passing error leaves the
    // session's later turns in the chat they belong to.
    if (!recorded.ok && conversationId && isNotFound(recorded.error)) {
      this.chats.delete(key);
      recorded = await send(null);
    }
    if (!recorded.ok && !isRetryable(recorded.error)) {
      // Refused for good: kept, it would be sent and refused on every connect.
      console.warn('[cloud] the cloud refused a run report and will not take it:', recorded.error);
      return 'rejected';
    }
    // Not counted, or counted but its turn not copied: kept by the backend and
    // sent again, under the same run id.
    if (!recorded.ok || turnToRetry) return 'retry';
    return 'delivered';
  }

  /** This report's turn is settled (copied, or never will be): later turns go on. */
  private release(key: string, runId: string): void {
    if (this.heldBy.get(key) === runId) this.heldBy.delete(key);
  }

  /** Every hold this report has, whichever account and session it was under. */
  private releaseRun(runId: string): void {
    for (const [key, holder] of this.heldBy) if (holder === runId) this.heldBy.delete(key);
  }

  /**
   * Sends a turn to a chat, and once more if no answer came back: the cloud
   * then answers from what the first request added, so a lost response does
   * not copy the turn twice or start another chat. 'gone' when the chat no
   * longer exists or is not this account's (the cloud answers 404); 'rejected'
   * when the cloud refuses the turn for good; 'retry' otherwise.
   */
  private async appendTurn(
    api: Partial<CloudMirrorApi>, chat: string, turn: Parameters<CloudMirrorApi['appendTurn']>[1], owner?: CloudAccount,
  ): Promise<'ok' | 'gone' | 'rejected' | 'retry'> {
    let error: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = guard(await api.appendTurn!(chat, turn, owner).catch((): Answer => ({ ok: false })));
      if (result.ok) return 'ok';
      if (isNotFound(result.error)) return 'gone';
      error = result.error;
      if (!isRetryable(error)) return 'rejected';
    }
    return isRetryable(error) ? 'retry' : 'rejected';
  }

  private async newChat(key: string, prompt: string, api: Partial<CloudMirrorApi>, owner?: CloudAccount): Promise<string | null> {
    const created = guard(await api.createConversation!(prompt.slice(0, 72), owner));
    if (!created.ok || !created.conversation) return null; // signed out / error
    this.chats.set(key, created.conversation.id);
    return created.conversation.id;
  }
}

/**
 * Mirrors one `run:accounting` report and confirms it to the backend unless it
 * is to be retried. A report that failed in a way worth retrying is left
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

/**
 * The window's stored opt-out (kept by an earlier build) is handed to the main
 * process, which owns the setting now and counts syncing as off until this has
 * run. A stored opt-in never overrides an opt-out the main process has.
 * Answers whether the main process now has syncing off.
 */
export async function migrateSyncOptOut(
  api: Partial<CloudMirrorApi> | undefined, storedOptOut: () => boolean,
): Promise<boolean> {
  const legacy = storedOptOut();
  try {
    if (api?.adoptSyncSetting) return (await api.adoptSyncSetting(legacy)).optedOut !== false;
    if (legacy && api?.setSyncOptOut) return (await api.setSyncOptOut(true)).ok;
  } catch { /* not handed over: the main process keeps counting syncing as off */ }
  return legacy;
}

/** The desktop's one mirror, over the preload bridge. */
export const cloudBridge = (): Partial<CloudMirrorApi> | undefined =>
  (typeof window === 'undefined' ? undefined : (window as unknown as { cascade?: { cloud?: Partial<CloudMirrorApi> } }).cascade?.cloud);
/** The opt-out an earlier build kept in this window's storage. */
export const storedSyncOptOut = (): boolean => { try { return localStorage.getItem('cascade.noCloudSync') === '1'; } catch { return false; } };
export const cloudMirror = new CloudMirror(cloudBridge, storedSyncOptOut, storedChatLinks());
