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
  if (shared && !sameProviderConfig(shared.settings, settings)) {
    void shared.controller.dispose();
    shared = null;
  }
  if (!shared) {
    generation += 1;
    shared = {
      settings: { ...settings },
      controller: new RemoteBrowserController({
        provider,
        ...(settings.maxSessions ? { maxSessions: settings.maxSessions } : {}),
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
    controller.onLiveViewFor(id, ({ active, liveViewUrl }) => {
      // To this socket only. See the file header.
      opts.emit('browser:live-view', {
        conversationId: opts.conversationId,
        // Echoed back by Stop, so a control action names the run it controls
        // rather than a chat that may hold several.
        taskId: id,
        // `interactive` and `showControls` are what make the embedded view a
        // control rather than a video: the user can take the page over and
        // navigate, which is the whole point of watching.
        liveViewUrl: liveViewUrl ? withViewerControls(liveViewUrl) : undefined,
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
      }
    },
    stop() {
      if (taskId) controller.stopRun(taskId);
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
 * Ask the provider's viewer for an interactive session with its own controls.
 *
 * Added as query parameters on the URL the provider gave us rather than built
 * from scratch: it carries the session's own credentials, and reconstructing it
 * would mean reconstructing those too.
 */
export function withViewerControls(liveViewUrl: string): string {
  try {
    const u = new URL(liveViewUrl);
    u.searchParams.set('interactive', 'true');
    u.searchParams.set('showControls', 'true');
    return u.toString();
  } catch {
    // Not a URL we can parse — hand it back untouched rather than dropping the
    // only way the user has to watch.
    return liveViewUrl;
  }
}
