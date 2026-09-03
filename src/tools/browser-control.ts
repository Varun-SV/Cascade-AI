// ─────────────────────────────────────────────
//  Cascade AI — Act on the page the user is looking at
// ─────────────────────────────────────────────
//
//  The other half of `read_current_page`. That one lets the agent SEE the page
//  the user has open; this one lets it act on that same page — click, type,
//  submit.
//
//  Deliberately NOT the `browser` tool. That one drives a headless Chromium
//  Playwright launches: a second browser, invisible, with an empty cookie jar.
//  Most pages worth automating are behind a login, so a fresh headless session
//  sees a sign-in wall and nothing else. The desktop already runs a Chromium —
//  Electron IS one — and the user is already signed into it. Driving the view
//  they can watch is worth more than driving one they cannot see.
//
//  That is also why this is the more dangerous of the two. A headless throwaway
//  session can do little harm; the user's real session can send mail, spend
//  money, and delete things. So:
//
//    - `isDangerous()` is true, which routes every call through the approval
//      chain that already exists (t3-worker → T2 → T1 → user).
//    - The host can revoke mid-run. Approval is session-scoped by design (the
//      escalator caches an "always" answer task-wide), which is what makes a
//      multi-step form fill usable rather than ten prompts — and precisely why
//      there has to be a way to take it back. See `revokeApproval`.
//    - Registration is host-supplied. The provider only exists where there IS a
//      visible browser, so the tool never appears — and never has to be
//      refused — in the CLI or a hosted run.

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

/** One thing to do to the open page. */
export interface BrowserAction {
  kind: 'navigate' | 'click' | 'fill' | 'press' | 'wait_for' | 'extract_text';
  /** navigate */
  url?: string;
  /** click, fill, wait_for, extract_text (optional — defaults to the body) */
  selector?: string;
  /** fill */
  value?: string;
  /** press — a single key name, e.g. "Enter" or "Tab" */
  key?: string;
  /** wait_for */
  timeoutMs?: number;
}

export interface BrowserActionOutcome {
  ok: boolean;
  /** Human- and model-readable account of what happened. */
  detail: string;
  /** Where the page ended up, when the host can tell. */
  url?: string;
  title?: string;
}

/**
 * Who is asking, and how to stop them.
 *
 * Both fields exist because the browser is a SINGLETON the host owns while runs
 * come and go. Without run identity the host cannot tell a Stop in one run from
 * a Stop in every future run, and cannot tell two concurrent runs apart when
 * they both reach for the same page.
 */
export interface BrowserActionContext {
  /**
   * The run this action belongs to. Revocation and the host's single-owner
   * lease both key on it, so a Stop scopes to the run the user was watching
   * rather than to the process.
   */
  sessionId: string;
  /**
   * The individual worker asking — `tierId`, a per-instance id.
   *
   * Distinct from `sessionId` and both are needed. Every T3 worker in a run
   * passes the same `taskId` as the session, so the session says which RUN to
   * stop but cannot tell two sibling workers apart. The host leases the browser
   * to one actor for a whole sequence, and a lease keyed by session would hand
   * the same lease to every sibling at once — which is the state that lets one
   * worker navigate away in the middle of another's fill-then-click.
   */
  actorId: string;
  /**
   * Cancels an action already in flight. `wait_for` can sit for 30s and
   * `navigate` waits on the network, so without this a cancelled run keeps
   * touching the user's authenticated page after it was stopped.
   */
  signal?: AbortSignal;
}

/**
 * Performs one action against the browser view the host owns.
 *
 * Returning `ok: false` with a reason is expected and normal — a selector that
 * matches nothing is a thing the model should be told about and can recover
 * from, not an exception.
 */
export type BrowserController = (
  action: BrowserAction,
  context: BrowserActionContext,
) => Promise<BrowserActionOutcome>;

/**
 * Told that one worker is finished with the browser for good.
 *
 * Separate from the controller because it is not an action: it carries no
 * outcome and cannot fail. The host uses it to end that actor's sequence lease
 * — the only signal that reliably means "will not ask again", as opposed to a
 * worker that is merely waiting on its next model response.
 */
export type BrowserActorRelease = (actorId: string) => void;

export class BrowserControlTool extends BaseTool {
  readonly name = 'browser_control';

  readonly description =
    'Act on the web page the user has open in the built-in browser: navigate, click an element, type into a field, press a key, or wait for something to appear. ' +
    'This drives the REAL browser the user is signed into and can see, so actions have real consequences — prefer read_current_page when you only need to look. ' +
    'CSS selectors are matched against the live page; call extract_text first if you need to find one. ' +
    'There is one browser: if another part of this run is using it, this call waits its turn, so a slow reply means queued, not stuck.';

  readonly inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['navigate', 'click', 'fill', 'press', 'wait_for', 'extract_text'],
        description: 'What to do.',
      },
      url: { type: 'string', description: 'For navigate: the http(s) address to open.' },
      selector: {
        type: 'string',
        description: 'CSS selector for click, fill and wait_for. Optional for extract_text (defaults to the whole page).',
      },
      value: { type: 'string', description: 'For fill: the text to type.' },
      key: { type: 'string', description: 'For press: a key name such as "Enter", "Tab" or "Escape".' },
      timeoutMs: { type: 'number', description: 'For wait_for: how long to wait before giving up (default 10000, max 30000).' },
    },
    required: ['action'],
  };

  private controller: BrowserController;
  private release: BrowserActorRelease | undefined;
  /** One-way. See `revoke`. */
  private revoked = false;

  constructor(controller: BrowserController, release?: BrowserActorRelease) {
    super();
    this.controller = controller;
    this.release = release;
  }

  /**
   * A worker has finished. Ends its hold on the browser.
   *
   * Called from the tier's terminal path rather than by the model, because a
   * model cannot be relied on to announce that it is done — which is why the
   * host cannot use idle time as the boundary instead.
   */
  releaseActor(actorId: string): void {
    this.release?.(actorId);
  }

  /**
   * Permanently disable this tool, whatever the registry still holds.
   *
   * Registration-time gates cannot express "this run turned out to be
   * unattended": a host that wires the controller and only then declares the
   * run unattended has already registered the tool, and a check that ran at
   * registration has no second chance. Enforcing at EXECUTION time makes the
   * guarantee independent of call order, which is the whole point of stating
   * the invariant rather than relying on the scheduler's current sequence.
   *
   * One-way on purpose. A safety gate that can be re-opened by a later call is
   * a gate that a refactor re-opens by accident.
   */
  revoke(): void {
    this.revoked = true;
  }

  // Acting on a session the user is signed into is the highest-consequence
  // thing in the tool set — higher than shell, arguably, because the blast
  // radius is someone else's server rather than this machine.
  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    // Checked before anything else, including argument validation: once
    // revoked this tool must do nothing at all, however it is called.
    if (this.revoked) {
      return 'Error: browser control is not available in this run. It requires a person watching who can stop it, and nobody is.';
    }

    const kind = input['action'] as BrowserAction['kind'] | undefined;
    if (!kind) return 'Error: action is required.';

    // Checked before anything reaches the page: a run cancelled while this call
    // was queued must not go on to click something.
    if (options?.signal?.aborted) return 'Error: the run was cancelled before this action ran.';

    // Validated here rather than in the host so the model gets a specific,
    // correctable message instead of a generic failure from three layers down.
    const missing = requiredFieldFor(kind, input);
    if (missing) return `Error: "${kind}" needs ${missing}.`;

    const action: BrowserAction = {
      kind,
      ...(typeof input['url'] === 'string' ? { url: input['url'] } : {}),
      ...(typeof input['selector'] === 'string' ? { selector: input['selector'] } : {}),
      ...(typeof input['value'] === 'string' ? { value: input['value'] } : {}),
      ...(typeof input['key'] === 'string' ? { key: input['key'] } : {}),
      ...(typeof input['timeoutMs'] === 'number'
        ? { timeoutMs: Math.min(Math.max(input['timeoutMs'], 0), 30_000) }
        : {}),
    };

    let outcome: BrowserActionOutcome;
    try {
      outcome = await this.controller(action, {
        // `sessionId` is the run. The host scopes both revocation and its
        // single-owner lease on it, so passing it is not telemetry — drop it
        // and a Stop in one run silently stops every later one.
        sessionId: options?.sessionId ?? '',
        actorId: options?.tierId ?? options?.sessionId ?? '',
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      return `Error: the browser could not perform "${kind}" — ${err instanceof Error ? err.message : String(err)}`;
    }

    const where = outcome.url ? `\nPage: ${outcome.title ? `${outcome.title} — ` : ''}${outcome.url}` : '';
    return `${outcome.ok ? '' : 'Failed: '}${outcome.detail}${where}`;
  }
}

/** The field a given action cannot run without, or null when it has what it needs. */
function requiredFieldFor(kind: BrowserAction['kind'], input: Record<string, unknown>): string | null {
  const has = (k: string) => typeof input[k] === 'string' && (input[k] as string).length > 0;
  // `value` is checked for PRESENCE, not for being non-empty: clearing a field
  // is an ordinary form operation, and `{ action: 'fill', value: '' }` was
  // rejected as malformed even though the host already handles it.
  const given = (k: string) => typeof input[k] === 'string';
  switch (kind) {
    case 'navigate': return has('url') ? null : 'a url';
    case 'click': return has('selector') ? null : 'a selector';
    case 'fill': return has('selector') ? (given('value') ? null : 'a value') : 'a selector';
    case 'press': return has('key') ? null : 'a key';
    case 'wait_for': return has('selector') ? null : 'a selector';
    // extract_text works with or without a selector.
    case 'extract_text': return null;
    default: return null;
  }
}
