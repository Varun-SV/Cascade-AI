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
  /** Release the run's session. Keyed by the Cascade task id. */
  endRun(): Promise<void>;
  /** The user pressed Stop. */
  stop(): void;
}

export function attachRemoteBrowser(opts: AttachOptions): AttachedBrowser | null {
  const settings = opts.config.tools?.remoteBrowser;
  const provider = buildProvider(settings, opts.warn);
  if (!provider) return null;

  // The run's own id, learned when the run starts rather than when it ends: a
  // run that throws is exactly the one whose session needs releasing, and a
  // result is not available on that path.
  let taskId: string | null = null;
  opts.cascade.on('run:started', (e: unknown) => {
    const id = (e as { taskId?: string }).taskId;
    if (id) taskId = id;
  });

  const controller = new RemoteBrowserController({
    provider,
    ...(settings?.maxSessions ? { maxSessions: settings.maxSessions } : {}),
    onLiveView: (_runId, liveViewUrl) => {
      // To this socket only. See the file header.
      opts.emit('browser:live-view', {
        conversationId: opts.conversationId,
        // `interactive` and `showControls` are what make the embedded view a
        // control rather than a video: the user can take the page over and
        // navigate, which is the whole point of watching.
        liveViewUrl: liveViewUrl ? withViewerControls(liveViewUrl) : undefined,
      });
    },
  });

  opts.cascade.setBrowserController(controller.controller, (actorId) => controller.actorEnded(actorId));

  return {
    async endRun() {
      if (taskId) await controller.endRun(taskId);
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
