// ─────────────────────────────────────────────
//  Cascade Cloud — giving a hosted run a browser
// ─────────────────────────────────────────────
//
//  A hosted run has no browser. This attaches one from a provider the operator
//  configured, or does nothing at all when they configured none — which is the
//  default, and is why there is no switch to turn the capability off. It does
//  not exist until an endpoint is supplied.
//
//  The whole of the interesting policy is in two rules:
//
//    - The live-view URL goes to ONE socket, the one that started the run.
//      Providers issue it deliberately without a token so it can be handed to a
//      viewer, which makes it a bearer capability: anyone holding it can watch
//      the browser and, where the provider allows input, drive it. So it is
//      never broadcast, never written to the run record, and never logged.
//    - The run's browser is released when the run ends, keyed by the Cascade
//      TASK id rather than the conversation id. Those are different things —
//      one conversation holds many runs — and using the wrong one meant
//      cleanup matched nothing, which cost a review round on the desktop.

import {
  RemoteBrowserController,
  GenericCdpProvider,
  SteelProvider,
  isCdpEndpoint,
  type BrowserInput,
  type Cascade,
  type CascadeConfig,
  type RemoteBrowserProvider,
} from '#cascade-ai';

/**
 * Only the slice this needs.
 *
 * Not the whole CascadeConfig: the caller holds a Partial at this point, and
 * widening the caller to satisfy a dependency that reads four fields would be
 * the wrong way round.
 */
type RemoteBrowserSettings = NonNullable<CascadeConfig['tools']['remoteBrowser']>;

interface AttachOptions {
  cascade: Cascade;
  config: { tools?: { remoteBrowser?: RemoteBrowserSettings } };
  conversationId: string;
  /** The run owner's socket. The live view goes here and nowhere else. */
  emit: (event: string, payload: unknown) => void;
  /**
   * Where frames go, when the caller has a lossy channel to send them on.
   *
   * Separate from `emit` because frames are the one thing worth DROPPING. Every
   * other event on this socket is a fact that must arrive — a live view, a
   * control change, a refusal — while a frame is only the newest picture, and
   * one that cannot be written now is worthless by the time it could be.
   */
  emitFrame?: (event: string, payload: unknown) => void;
  /** Somewhere to record a misconfiguration without failing the run. */
  warn?: (message: string) => void;
}

/** Attached browser, or null when the deployment has no provider configured. */
export interface AttachedBrowser {
  /** The run this browser belongs to, once the run has announced itself. */
  readonly taskId: string | null;
  /** Release the run's session. Keyed by the Cascade task id. */
  endRun(): Promise<void>;
  /** The user pressed Stop. */
  stop(): void;
  /**
   * Somebody opened the panel: start sending them the page.
   *
   * Frames go to the run's own socket and nowhere else — the same rule the
   * live-view URL had, but enforced by us rather than by a provider handing out
   * an unguessable link. Answers false when there is nothing to stream, so the
   * client is never promised frames that will not come.
   */
  watch(): Promise<boolean>;
  /** The panel closed. Stop paying to render frames nobody is looking at. */
  unwatch(): Promise<void>;
  /**
   * The user wants the page for themselves.
   *
   * Resolves once the agent is actually out — an action already inside the
   * page finishes first — so "you have control" is true when the UI says it.
   */
  takeOver(): Promise<{ ok: boolean; detail?: string }>;
  /** The user is done with it, so the run may carry on. */
  handBack(): boolean;
  /** One thing the user did to the page, authorised on its own. */
  input(event: BrowserInput): Promise<{ ok: boolean; detail?: string }>;
  /** Suspend or resume the picture while keeping control. For signing in. */
  setCapture(on: boolean): Promise<boolean>;
  /**
   * The viewer confirms it actually received a frame for this watch.
   *
   * One per watch rather than per frame, and it gates Hide only — never
   * Chrome's own frame ack — so the stream stays lossy and nothing about the
   * frame rate waits on the viewer.
   */
  frameSeen(generation: number): void;
}

/**
 * The deployment's ONE controller, and the config it was built for.
 *
 * Module scope, and that is the whole point of this change. A controller per
 * run made `maxSessions` meaningless: every run got a fresh controller whose
 * session map was empty, so the cap counted to one and stopped, and two
 * concurrent runs each opened a paid session at a configured limit of one.
 *
 * With a bare CDP endpoint it was worse than cost. Both controllers connect to
 * the same websocket and take `contexts()[0].pages()[0]`, so two runs — two
 * USERS on a shared deployment — drive the same page, with per-run leases that
 * do not know about each other. Ownership has to live where the browsers do.
 */
let shared: { settings: RemoteBrowserSettings; controller: RemoteBrowserController } | null = null;

/**
 * Bumped every time a controller is built.
 *
 * Exported so a test can OBSERVE a rebuild. Without it the only assertion
 * available was "attach returned something", which is true whether the
 * controller was reused or replaced — so the rotation test passed against the
 * bug it was written for, and its revert-check went green.
 */
let generation = 0;
export function sharedBrowserGeneration(): number { return generation; }

/**
 * Whether two provider configurations are the same deployment browser.
 *
 * A direct comparison, deliberately, rather than a key derived from the
 * settings. The first version built a string and had to decide what to do with
 * the credential: `apiKey ? 'keyed' : 'anon'` was wrong because a rotation from
 * A to B then looked identical and the revoked key stayed in use, and hashing
 * it was worse — CodeQL flagged it as a weak password hash, and it was right
 * that the derived value bought nothing. Comparing in place needs no artifact
 * at all: no string to log, no digest to leak, and exact rather than
 * collision-prone.
 *
 * The key is compared but never copied anywhere it was not already: the live
 * config and the SteelProvider both hold it regardless.
 */
function sameProviderConfig(a: RemoteBrowserSettings, b: RemoteBrowserSettings): boolean {
  return a.provider === b.provider
    && a.url === b.url
    && a.apiKey === b.apiKey
    && a.maxSessions === b.maxSessions;
}

/** For tests, and for a deployment whose settings changed under it. */
export async function resetSharedBrowser(): Promise<void> {
  const previous = shared;
  shared = null;
  await previous?.controller.dispose();
}

/**
 * Where this run's frames should go.
 *
 * Its own function because the fallback is the part that can silently regress:
 * drop `emitFrame` and frames quietly become reliable again, banking stale
 * JPEGs behind a slow viewer with nothing failing to say so.
 */
export function frameEmitter(opts: Pick<AttachOptions, 'emit' | 'emitFrame'>): (event: string, payload: unknown) => void {
  return opts.emitFrame ?? opts.emit;
}

export function attachRemoteBrowser(opts: AttachOptions): AttachedBrowser | null {
  const settings = opts.config.tools?.remoteBrowser;
  if (!settings?.provider) return null;
  const provider = buildProvider(settings, opts.warn);
  if (!provider) return null;

  // The run's own id, learned when the run starts rather than when it ends: a
  // run that throws is exactly the one whose session needs releasing, and a
  // result is not available on that path.
  let taskId: string | null = null;

  // Reused across runs. A settings change makes a new one and disposes the old
  // rather than leaving its sessions running at the operator's expense.
  let retiring: Promise<unknown> | undefined;
  if (shared && !sameProviderConfig(shared.settings, settings)) {
    // KEPT, not discarded. Disposal detaches CDP sessions and hands provider
    // sessions back over the network, so it is not instant — and the
    // replacement below used to start work immediately, which meant the first
    // action after a settings change could call `createSession` while the
    // outgoing controller was still releasing. Two controllers holding
    // sessions against one provider's cap, which neither pool can see because
    // each counts only its own. On a provider that enforces its own limit the
    // action simply fails, and it is the first one after the operator changed
    // something, which is exactly when it will be blamed on the change.
    //
    // Handed to the new controller as its `ready` rather than awaited here:
    // this function is synchronous by contract — the caller wires listeners on
    // what it returns — and the wait only has to happen before the new
    // controller OPENS anything, not before it exists.
    retiring = shared.controller.dispose();
    shared = null;
  }
  if (!shared) {
    generation += 1;
    shared = {
      settings: { ...settings },
      controller: new RemoteBrowserController({
        provider,
        ...(settings.maxSessions ? { maxSessions: settings.maxSessions } : {}),
        ...(retiring ? { ready: retiring } : {}),
      }),
    };
  }
  const controller = shared.controller;

  // Bound to the TASK id, and only once the run announces it.
  //
  // Registering under the conversation id was a silent no-op: the controller
  // looks listeners up by `BrowserActionContext.sessionId`, which T3Worker sets
  // to `this.taskId`. Those identities are deliberately different — one
  // conversation holds many runs — so the announcement went to a key nothing
  // was listening on and no live view ever reached the client. Same mismatch as
  // the run-end bug on the desktop, reintroduced one layer up.
  //
  // The conversation id stays, but only as routing: it says WHICH socket and
  // which chat pane. The task id is the control identity.
  opts.cascade.on('run:started', (e: unknown) => {
    const id = (e as { taskId?: string }).taskId;
    if (!id) return;
    taskId = id;
    // Who holds the page, on the same one socket as everything else about it.
    //
    // Pushed rather than answered, because the interesting change is the one
    // nobody asked for: an idle takeover lapses on its own, and a client that
    // still believes it has control keeps typing into a lease it lost.
    controller.onControlFor(id, ({ human, capturing, confirmed }) => {
      opts.emit('browser:control', {
        conversationId: opts.conversationId,
        taskId: id,
        human,
        capturing,
        // Whether THIS watch has confirmed a picture. The blind keyboard
        // surface turns on with it, so it is pushed rather than inferred.
        confirmed,
      });
    });
    controller.onLiveViewFor(id, ({ active, liveViewUrl }) => {
      // To this socket only. See the file header.
      opts.emit('browser:live-view', {
        conversationId: opts.conversationId,
        // Echoed back by Stop, so a control action names the run it controls
        // rather than a chat that may hold several.
        taskId: id,
        // Watch-only. The user's supervision is the live view plus Stop; input
        // through this frame would be a SECOND, uncoordinated controller racing
        // the agent on the same page. See asWatchOnlyViewer.
        liveViewUrl: liveViewUrl ? asWatchOnlyViewer(liveViewUrl) : undefined,
        // Stated rather than implied by an absent URL. Attached-but-unwatchable
        // and not-attached-at-all both have no URL, and the UI must tell them
        // apart: the first still needs a Stop control, the second needs no panel.
        active,
      });
    });
  });

  // setRemoteBrowserController, NOT setBrowserController: that one gates on
  // agentBrowserControl, the desktop flag for driving a signed-in session,
  // which defaults to false and is never set on a server. Calling it here
  // registered nothing at all.
  opts.cascade.setRemoteBrowserController(controller.controller, (actorId) => controller.actorEnded(actorId));

  return {
    get taskId() { return taskId; },
    async endRun() {
      // Only this run's session. The controller outlives the run.
      if (taskId) {
        await controller.endRun(taskId);
        controller.offLiveViewFor(taskId);
        controller.offControlFor(taskId);
      }
    },
    stop() {
      if (taskId) controller.stopRun(taskId);
    },
    async watch() {
      if (!taskId) return false;
      const id = taskId;
      const sendFrame = frameEmitter(opts);
      return await controller.startWatching(id, (frame) => {
        // To this socket only. A frame is a picture of whatever the agent is
        // looking at — a half-filled form, a logged-in page — so it is exactly
        // as sensitive as the live-view URL it replaces, and travels the same
        // single path to the run's owner.
        sendFrame('browser:frame', {
          conversationId: opts.conversationId,
          // Echoed so a client showing several chats can route the frame, and
          // so a late frame from a finished run is discardable.
          taskId: id,
          data: frame.data,
          width: frame.width,
          height: frame.height,
          // Which watch this picture belongs to, so the receipt the client
          // sends back names what it actually saw rather than whatever is
          // current by the time it arrives.
          generation: frame.generation,
        });
      });
    },
    async unwatch() {
      if (taskId) await controller.stopWatching(taskId);
    },
    async takeOver() {
      if (!taskId) return { ok: false, detail: 'This run has no browser open.' };
      return await controller.takeOver(taskId);
    },
    handBack() {
      return taskId ? controller.handBack(taskId) : false;
    },
    async input(event: BrowserInput) {
      if (!taskId) return { ok: false, detail: 'This run has no browser open.' };
      return await controller.input(taskId, event);
    },
    frameSeen(generation: number) {
      if (taskId) controller.frameSeen(taskId, generation);
    },
    async setCapture(on: boolean) {
      if (!taskId) return false;
      return await controller.setCapture(taskId, on);
    },
  };
}

/** Which provider the operator asked for, or null when they asked for none. */
function buildProvider(
  settings: RemoteBrowserSettings | undefined,
  warn?: (message: string) => void,
): RemoteBrowserProvider | null {
  if (!settings?.provider) return null;

  if (settings.provider === 'cdp') {
    // Named at attach time rather than as an obscure Playwright failure on the
    // first action — an http:// URL copied from a provider's docs is the
    // likely mistake, and it is worth saying which one.
    if (!settings.url || !isCdpEndpoint(settings.url)) {
      warn?.(`remoteBrowser.url must be a ws:// or wss:// endpoint; got ${settings.url ?? '(none)'}`);
      return null;
    }
    return new GenericCdpProvider(settings.url);
  }

  return new SteelProvider({
    ...(settings.url ? { url: settings.url } : {}),
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
  });
}

/**
 * Ask the provider's viewer for a WATCH-ONLY session.
 *
 * This used to request `interactive=true`, and the panel told the user they
 * could "take over in this window". They could — but so could the agent, at
 * the same time. Viewer input goes straight to the live session over the
 * provider's own channel: it never passes through `BrowserLease`, and there is
 * no handoff event back to the controller. So while a Playwright `click` or
 * `fill` was in flight the user could edit the same page through the iframe and
 * the agent's action would then land on top of what they had just done. The UI
 * promised exclusive control and delivered concurrent control, which is the
 * same shape as an action landing after Stop: a mutation the person believed
 * they had prevented.
 *
 * Watch and Stop is a smaller promise that this code can actually keep, and the
 * handoff that arrived since is deliberately NOT this: it runs over the frames
 * this server streams, where the agent is paused on the same lease the workers
 * queue on before a single event is accepted. The provider's viewer has no such
 * gate, so it stays watch-only whatever else the panel can now do.
 *
 * Added as query parameters on the URL the provider gave us rather than built
 * from scratch: it carries the session's own credentials, and reconstructing it
 * would mean reconstructing those too.
 *
 * The flag alone is not the guarantee — its meaning belongs to the provider.
 * `BrowserLiveView` also makes the frame ignore pointer events, so input cannot
 * reach the session whatever a given viewer does with `interactive`.
 */
export function asWatchOnlyViewer(liveViewUrl: string): string {
  try {
    const u = new URL(liveViewUrl);
    u.searchParams.set('interactive', 'false');
    u.searchParams.set('showControls', 'false');
    return u.toString();
  } catch {
    // Not a URL we can parse — hand it back untouched rather than dropping the
    // only way the user has to watch.
    return liveViewUrl;
  }
}
