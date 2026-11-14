// ─────────────────────────────────────────────
//  Cascade AI — What the agent may send and see over CDP
// ─────────────────────────────────────────────
//
//  Default deny for commands, and for events at three levels: event name, field
//  and URL. A new Chromium method or event, or a new field on a known event, is
//  refused until someone reviews it. See docs/design/stage-1-plan.md section 5.
//
//  Changing a list below means bumping POLICY_VERSION in the same reviewed
//  commit; a snapshot test fails otherwise. Grants and approvals carry the
//  version, and a mismatch is refused rather than negotiated.

import { type Consent, bareHost, isPrivateHost, onConsentedSite, requestVerdict } from './egress-rules.js';

export const POLICY_VERSION = 3;

export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'DOM.describeNode',
  'DOM.getContentQuads',
  'DOM.resolveNode',
  'DOM.scrollIntoViewIfNeeded',
  'Emulation.setEmulatedMedia',
  'Emulation.setFocusEmulationEnabled',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Inspector.enable',
  'Log.enable',
  'Network.enable',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.captureScreenshot',
  'Page.createIsolatedWorld',
  'Page.enable',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.setLifecycleEventsEnabled',
  'Runtime.callFunctionOn',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.getProperties',
  'Runtime.releaseObject',
  'Runtime.runIfWaitingForDebugger',
  'Target.setAutoAttach',
]);

/** Denied whatever the allowlist says, so a bad edit to it can't open these. */
export const ALWAYS_DENIED_PREFIXES: readonly string[] = ['Fetch.', 'Storage.', 'SystemInfo.', 'Browser.'];
export const ALWAYS_DENIED: ReadonlySet<string> = new Set([
  'Network.clearBrowserCookies',
  'Network.deleteCookies',
  'Network.getAllCookies',
  'Network.getCookies',
  'Network.getRequestPostData',
  'Network.getResponseBody',
  'Network.getResponseBodyForInterception',
  'Network.searchInResponseBody',
  'Network.setCookie',
  'Network.setCookies',
  'Network.setRequestInterception',
  'Network.streamResourceContent',
  'Network.takeResponseBodyForInterceptionAsStream',
  'Page.setDownloadBehavior',
  'Target.attachToTarget',
  'Target.closeTarget',
  'Target.createBrowserContext',
  'Target.createTarget',
]);

/** A command as it arrives from the server. */
export interface CommandFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** Parses one frame. Anything not exactly a well-formed command is null. */
export function parseFrame(raw: string): CommandFrame | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const f = v as Record<string, unknown>;
  if (!Number.isSafeInteger(f.id) || typeof f.method !== 'string') return null;
  if (f.sessionId !== undefined && typeof f.sessionId !== 'string') return null;
  if (f.params !== undefined && (typeof f.params !== 'object' || f.params === null || Array.isArray(f.params))) return null;
  return {
    id: f.id as number,
    method: f.method,
    params: (f.params ?? {}) as Record<string, unknown>,
    ...(f.sessionId !== undefined ? { sessionId: f.sessionId } : {}),
  };
}

export type CommandDecision = { forward: true } | { forward: false; reason: string };

export interface CommandContext {
  /** The tab's session and nested sessions it announced on a consented site. */
  knownSessions: ReadonlySet<string>;
}

const refuse = (reason: string): CommandDecision => ({ forward: false, reason: `Denied by Cascade relay policy: ${reason}` });

export function checkCommand(frame: CommandFrame, ctx: CommandContext): CommandDecision {
  const { method, params, sessionId } = frame;
  if (ALWAYS_DENIED.has(method) || ALWAYS_DENIED_PREFIXES.some((p) => method.startsWith(p))) return refuse(method);
  if (sessionId === undefined || !ctx.knownSessions.has(sessionId)) return refuse(`unknown session for ${method}`);
  if (!ALLOWED_COMMANDS.has(method)) return refuse(`${method} is not on the allowlist`);
  if (method === 'Page.navigate') {
    const url = String(params.url ?? '');
    if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) return refuse(`Page.navigate to ${url.split(':')[0]}:`);
  }
  if (method === 'Target.setAutoAttach' && params.flatten !== true) return refuse('Target.setAutoAttach without flatten');
  return { forward: true };
}

// ── URLs in what the agent sees ──────────────────────────────────────────────

/** A URL for the agent, or null when the whole event must be dropped. */
export function agentUrl(raw: unknown, kind: 'document' | 'subresource', consent: Consent): string | null {
  if (typeof raw !== 'string') return null;
  if (raw === '' || raw === 'about:blank' || raw === 'about:srcdoc') return raw;
  // What Chromium reports as the origin of about:blank and sandboxed documents.
  if (raw === '://' || raw === 'null') return raw;
  if (kind === 'document') {
    if (!onConsentedSite(raw, consent)) return null;
    return withoutUserinfo(raw);
  }
  if (onConsentedSite(raw, consent)) return withoutUserinfo(raw);
  if (!requestVerdict(raw, 'Other', consent).allow) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return null;
  if (isPrivateHost(bareHost(u.hostname))) return null;
  return `${u.protocol}//${u.host}${u.pathname}`;
}

function withoutUserinfo(raw: string): string {
  try {
    const u = new URL(raw);
    if (!u.username && !u.password) return raw;
    u.username = ''; u.password = '';
    return u.toString();
  } catch { return raw; }
}

// ── Field schemas ────────────────────────────────────────────────────────────

const ALLOWED_HEADERS = new Set(['content-type', 'content-length']);

type Field = true | 'documentUrl' | 'subresourceUrl' | 'headers' | Schema;
interface Schema { [field: string]: Field }

const RESPONSE: Schema = {
  url: 'subresourceUrl', status: true, mimeType: true, headers: 'headers',
  connectionReused: true, connectionId: true, fromDiskCache: true, fromServiceWorker: true,
  fromPrefetchCache: true, encodedDataLength: true, timing: true, protocol: true,
};

const TARGET_INFO: Schema = {
  targetId: true, type: true, url: 'documentUrl', attached: true, browserContextId: true,
};

// `context.name` below stays: a page can't set it, and Playwright finds its utility world by it.
const SCHEMAS: Readonly<Record<string, Schema>> = {
  'Network.requestWillBeSent': {
    requestId: true, loaderId: true, documentURL: 'documentUrl', timestamp: true, wallTime: true, type: true,
    frameId: true, hasUserGesture: true, redirectResponse: RESPONSE,
    initiator: { type: true },
    request: { url: 'subresourceUrl', method: true, headers: 'headers', initialPriority: true, referrerPolicy: true, hasPostData: true },
  },
  'Network.responseReceived': { requestId: true, loaderId: true, timestamp: true, type: true, frameId: true, response: RESPONSE },
  'Network.loadingFailed': { requestId: true, timestamp: true, type: true, canceled: true },
  'Network.dataReceived': { requestId: true, timestamp: true, dataLength: true, encodedDataLength: true },
  'Network.loadingFinished': { requestId: true, timestamp: true, encodedDataLength: true },
  'Network.requestServedFromCache': { requestId: true },
  'Network.webSocketCreated': { requestId: true, url: 'subresourceUrl' },
  'Network.webSocketClosed': { requestId: true, timestamp: true },
  'Page.frameAttached': { frameId: true, parentFrameId: true },
  'Page.frameDetached': { frameId: true, reason: true },
  'Page.frameStartedLoading': { frameId: true },
  'Page.frameStoppedLoading': { frameId: true },
  'Page.frameClearedScheduledNavigation': { frameId: true },
  'Page.lifecycleEvent': { frameId: true, loaderId: true, name: true, timestamp: true },
  'Page.domContentEventFired': { timestamp: true },
  'Page.loadEventFired': { timestamp: true },
  'Page.frameNavigated': {
    type: true,
    frame: {
      id: true, parentId: true, loaderId: true, url: 'documentUrl', securityOrigin: 'documentUrl', mimeType: true,
    },
  },
  'Page.documentOpened': {
    frame: { id: true, parentId: true, loaderId: true, url: 'documentUrl', securityOrigin: 'documentUrl', mimeType: true },
  },
  'Page.navigatedWithinDocument': { frameId: true, url: 'documentUrl', navigationType: true },
  'Page.frameRequestedNavigation': { frameId: true, reason: true, url: 'documentUrl', disposition: true },
  'Page.frameScheduledNavigation': { frameId: true, delay: true, reason: true, url: 'documentUrl' },
  'Page.frameStartedNavigating': { frameId: true, url: 'documentUrl', loaderId: true, navigationType: true },
  'Page.downloadWillBegin': { frameId: true, guid: true, url: 'documentUrl' },
  'Page.downloadProgress': { guid: true, state: true, totalBytes: true, receivedBytes: true },
  'Runtime.executionContextCreated': {
    context: { id: true, uniqueId: true, name: true, origin: 'documentUrl', auxData: { isDefault: true, type: true, frameId: true } },
  },
  'Runtime.executionContextDestroyed': { executionContextId: true, executionContextUniqueId: true },
  'Runtime.executionContextsCleared': {},
  'Inspector.workerScriptLoaded': {},
  'Inspector.targetCrashed': {},
  'Target.attachedToTarget': { sessionId: true, waitingForDebugger: true, targetInfo: TARGET_INFO },
  'Target.detachedFromTarget': { sessionId: true, targetId: true },
  'Target.targetInfoChanged': { targetInfo: TARGET_INFO },
};

export const ALLOWED_EVENTS: ReadonlySet<string> = new Set(Object.keys(SCHEMAS));

/** Every field of every allowed event, for the test that ties changes to a version bump. */
export function policySchemaSnapshot(): string {
  return JSON.stringify(SCHEMAS);
}

/** Target info as the agent may see it, or null if it names a blocked destination. */
export function filterTargetInfo(info: Record<string, unknown>, consent: Consent): Record<string, unknown> | null {
  try { return applySchema(info, TARGET_INFO, consent); } catch (e) {
    if (e instanceof DropEvent) return null;
    throw e;
  }
}

class DropEvent extends Error {}

function applySchema(value: Record<string, unknown>, schema: Schema, consent: Consent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    if (!(name in value)) continue;
    const v = value[name];
    if (field === true) out[name] = v;
    else if (field === 'documentUrl' || field === 'subresourceUrl') {
      const safe = agentUrl(v, field === 'documentUrl' ? 'document' : 'subresource', consent);
      if (safe === null) throw new DropEvent();
      out[name] = safe;
    } else if (field === 'headers') out[name] = allowedHeaders(v);
    else if (v && typeof v === 'object') out[name] = applySchema(v as Record<string, unknown>, field, consent);
  }
  return out;
}

function allowedHeaders(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([k]) => ALLOWED_HEADERS.has(k.toLowerCase())));
}

/** The event as the agent may see it, or null to drop it. */
export function filterEvent(method: string, params: Record<string, unknown>, consent: Consent): Record<string, unknown> | null {
  const schema = Object.hasOwn(SCHEMAS, method) ? SCHEMAS[method] : undefined;
  if (!schema) return null;
  try {
    const out = applySchema(params, schema, consent);
    // ExtraInfo events are never forwarded, so nothing may promise them: Playwright
    // would wait for them for ever.
    if (method === 'Network.requestWillBeSent') {
      if (params.type === 'Document' && agentUrl((params.request as { url?: unknown } | undefined)?.url, 'document', consent) === null) return null;
      out.redirectHasExtraInfo = false;
      if (out.redirectResponse) (out.redirectResponse as Record<string, unknown>).statusText = '';
    }
    if (method === 'Network.responseReceived') {
      if (params.type === 'Document' && agentUrl((params.response as { url?: unknown } | undefined)?.url, 'document', consent) === null) return null;
      out.hasExtraInfo = false;
      // Server-controlled text, removed; Playwright needs the field to exist.
      if (out.response) (out.response as Record<string, unknown>).statusText = '';
    }
    return out;
  } catch (e) {
    if (e instanceof DropEvent) return null;
    throw e;
  }
}

// ── Replies that carry URLs ──────────────────────────────────────────────────

export interface FrameTreeNode { frame?: Record<string, unknown> & { id?: string }; childFrames?: FrameTreeNode[] }

const FRAME_SCHEMA = SCHEMAS['Page.frameNavigated']!.frame as Schema;

function filterFrameTree(node: FrameTreeNode, consent: Consent): FrameTreeNode | null {
  let frame: Record<string, unknown>;
  try { frame = applySchema(node.frame ?? {}, FRAME_SCHEMA, consent); } catch { return null; }
  const childFrames = (node.childFrames ?? []).map((c) => filterFrameTree(c, consent)).filter((c): c is FrameTreeNode => c !== null);
  return { frame, ...(childFrames.length ? { childFrames } : {}) };
}

export const HIDDEN_HISTORY_URL = 'about:blank#not-consented';

/** A command's reply as the agent may see it. Only replies that carry URLs change. */
export function filterReply(method: string, result: Record<string, unknown>, consent: Consent): Record<string, unknown> {
  if (method === 'Page.getFrameTree' && result.frameTree) {
    const tree = filterFrameTree(result.frameTree as FrameTreeNode, consent);
    return tree ? { frameTree: tree } : { frameTree: { frame: { id: '', url: 'about:blank' } } };
  }
  if (method === 'Page.getNavigationHistory' && Array.isArray(result.entries)) {
    return {
      currentIndex: result.currentIndex,
      entries: (result.entries as { id: unknown; url?: string; title?: string; transitionType?: unknown }[]).map((e) => {
        const shown = agentUrl(e.url, 'document', consent);
        return shown === null
          ? { id: e.id, url: HIDDEN_HISTORY_URL, userTypedURL: HIDDEN_HISTORY_URL, title: '', transitionType: e.transitionType }
          : { id: e.id, url: shown, userTypedURL: shown, title: '', transitionType: e.transitionType };
      }),
    };
  }
  return result;
}
