// ─────────────────────────────────────────────────────────────────────────────
//  PoC 2: request-level origin enforcement, and the fail-closed lease model
// ─────────────────────────────────────────────────────────────────────────────
//
//  Follows ChatGPT's stage-1 review on PR #316 (design §4.2 and §5):
//
//  1. Origin enforcement must stop the REQUEST, not detach after it. Here
//     the device-side policy holds its own privileged CDP session on the tab
//     (the agent never sees it) and pauses every request at the Request
//     stage with Fetch, before anything is sent:
//       - a document request (top-level navigation or iframe) must be
//         http(s) to a consented origin, or it is failed; a file: request of
//         any type is failed;
//       - any request to a private-network destination (loopback, RFC 1918,
//         link-local, unique-local IPv6, *.local, localhost, and IPv6 forms
//         that reach an IPv4 address) is failed unless that origin was
//         consented;
//       - other subresources (scripts, images, fetch/XHR) to public origins
//         are allowed. Pages need their CDNs, and Cascade cannot tell page
//         script from agent script. This is the stated limit of §4.2.
//     The agent's own Fetch.* stays denied, so it can neither see nor turn
//     off the policy's interception.
//     Out-of-process frames and workers are their own targets, which the
//     tab's interception does not see. The policy auto-attaches every child
//     target paused and intercepts it before it runs; a browser-level guard
//     does the same for new top-level targets (service and shared workers),
//     closes new pages, and keeps a browser-wide interception as a backstop
//     for a pop-up that sends its first request before it is paused.
//
//  2. Capabilities are single-use, and a dropped connection is never
//     resumed (model (a)). A lease ends when its capability expires.
//     Nothing is served until the tab is known to be on a consented site,
//     and a frame or worker on a site without consent (one the tab held
//     before the lease, which no request policy saw load) is never handed
//     to the agent. A capability opens exactly one connection and one
//     lease; it is burned on first use and again on disconnect. Getting
//     control back needs a NEW capability, which the device mints only after
//     the user approves again (simulated here by approveRun()).
//
//  Hosts: Chromium maps allowed.test and offlist.test to two local servers
//  (--host-resolver-rules), so "public, not consented" is testable offline.
//  A third server on a 127.0.0.1 IP literal is the private-network target.
//  Each server counts the requests it receives, so "blocked" means the
//  server saw nothing, not just that the agent got an error.
//
//  Run from the repo root:  node docs/design/poc/tab-cdp-relay/poc-egress-and-lease.mjs
//  Chromium: CHROMIUM=/path/to/chrome, else Playwright's bundled browser.

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { WebSocket, WebSocketServer } = require('ws');

const TAB_SESSION = 'cascade-tab-1';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Test servers that count what reaches them ───────────────────────────────

function countingServer(name, routes) {
  const hits = [];
  const table = new Map(Object.entries(routes));
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const route = table.get(req.url.split('?')[0]);
    if (typeof route !== 'function') { res.statusCode = 404; return res.end(); }
    route(req, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ name, server, hits, port: server.address().port })));
}

const html = (body) => (req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html>${body}`); };
const js = (body) => (req, res) => { res.setHeader('content-type', 'text/javascript'); res.end(body); };
// What a worker or frame reports back after fetching a URL it was given.
const TRY_FETCH = "(u) => fetch(u).then(() => 'reached', (e) => 'failed: ' + e.message)";

// ── Chromium with host mapping and one tab ──────────────────────────────────

async function launchChromium(mapRules) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-poc2-'));
  const proc = spawn(process.env.CHROMIUM || chromium.executablePath(), [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`, `--host-resolver-rules=${mapRules}`,
    // Service workers need a secure context; the mapped test origins are http.
    '--unsafely-treat-insecure-origin-as-secure=http://allowed.test,http://allowed2.test', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//); if (m) resolve(Number(m[1])); });
    proc.on('exit', (code) => reject(new Error(`chromium exited ${code}: ${buf.slice(-400)}`)));
  });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return { proc, port, tab: list.find((t) => t.type === 'page'), browserWs: version.webSocketDebuggerUrl };
}

function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }

// A tiny CDP client for the policy's own session.
function cdpClient(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let id = 1;
  const pending = new Map();
  const handlers = new Map();
  const listeners = [];
  // Only events this prototype subscribes to are dispatched.
  const EVENTS = new Set(['Fetch.requestPaused']);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    else if (typeof msg.method === 'string') {
      for (const fn of listeners) fn(msg);
      if (EVENTS.has(msg.method)) {
        const fn = handlers.get(msg.method);
        if (typeof fn === 'function') fn(msg.params);
      }
    }
  });
  const sendRaw = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    ready: new Promise((r) => ws.on('open', r)),
    send: (method, params = {}) => sendRaw(method, params),
    sendRaw,
    on: (method, fn) => handlers.set(method, fn),
    onAny: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

// ── 1. Device-side egress policy (privileged; the agent cannot reach it) ────

function isPrivateV4(h) {
  const [a, b] = h.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || a >= 224; // multicast, reserved and broadcast
}

/** An IPv6 literal as eight 16-bit groups, with a trailing dotted IPv4 expanded. */
function ipv6Groups(h) {
  let s = h;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g || '0', 16));
}

const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateHost(host) {
  // A fully qualified name's root dot (`localhost.`) resolves as without it.
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0].replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (net.isIPv4(h)) return isPrivateV4(h);
  if (net.isIPv6(h)) {
    const g = ipv6Groups(h);
    const zeros = (n) => g.slice(0, n).every((x) => x === 0);
    // IPv4 inside IPv6 is checked as the IPv4 it reaches: mapped (::ffff:a.b.c.d),
    // compatible (::a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::).
    if (zeros(5) && g[5] === 0xffff) return isPrivateV4(v4From(g[6], g[7]));
    if (zeros(6)) return g[6] === 0 && g[7] <= 1 ? true : isPrivateV4(v4From(g[6], g[7])); // :: and ::1
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(v4From(g[6], g[7]));
    if (g[0] === 0x2002) return isPrivateV4(v4From(g[1], g[2]));
    return (g[0] & 0xfe00) === 0xfc00 // unique local fc00::/7
      || (g[0] & 0xffc0) === 0xfe80 // link-local fe80::/10
      || (g[0] & 0xff00) === 0xff00; // multicast
  }
  // Hostnames: production resolves and checks the address on the device
  // (and pins it for the request, against DNS rebinding). Not done here.
  return false;
}

/**
 * The policy's verdict on one request, before it is sent. A document (a
 * top-level page or a frame) may only be http(s) on a consented origin: any
 * other scheme (`file:`, `chrome:`, `data:`…) is blocked, as a `file:` request
 * of any type is.
 */
function egressVerdict(rawUrl, resourceType, consentedOrigins) {
  let url;
  try { url = new URL(rawUrl); } catch { return { verdict: 'block', reason: 'unparseable URL' }; }
  const web = url.protocol === 'http:' || url.protocol === 'https:';
  if (!web) {
    if (resourceType === 'Document') return { verdict: 'block', reason: `${url.protocol} document` };
    if (url.protocol === 'file:') return { verdict: 'block', reason: 'file: request' };
    return { verdict: 'allow', reason: '' };
  }
  const consented = consentedOrigins.has(url.origin);
  if (resourceType === 'Document' && !consented) return { verdict: 'block', reason: 'navigation to an origin without consent' };
  if (isPrivateHost(url.hostname) && !consented) return { verdict: 'block', reason: 'private-network destination' };
  return { verdict: 'allow', reason: '' };
}

// Pauses every request a target sends, every resource type, BEFORE it is sent.
const INTERCEPT_ALL = { patterns: [{ urlPattern: '*', requestStage: 'Request' }] };
// New child targets (frames, workers) start paused, so a policy can be put on
// them before they send anything.
const AUTO_ATTACH_PAUSED = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

/**
 * Puts the egress policy on one attached target and only then lets it run.
 * Its own children are attached paused too, so the policy follows the whole
 * tree. A dedicated worker has no request interception of its own: Chromium
 * sends its requests through its parent frame, which is already policed
 * (attached targets only come from policed sessions), so it runs. Any other
 * target whose interception cannot be enabled stays paused and returns false:
 * a target the policy cannot see never runs.
 */
async function policeTarget(send, sessionId, type) {
  let policed = 'own interception';
  try { await send('Fetch.enable', INTERCEPT_ALL, sessionId); } catch {
    if (type !== 'worker') return false;
    policed = "parent frame's interception";
  }
  await send('Target.setAutoAttach', AUTO_ATTACH_PAUSED, sessionId).catch(() => { /* a target with no children */ });
  await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  return policed;
}

/** Decides one paused request by the egress policy and fails or continues it. */
async function decideRequest(send, msg, consentedOrigins, decisions, where) {
  const { requestId, request, resourceType } = msg.params;
  const { verdict, reason } = egressVerdict(request.url, resourceType, consentedOrigins);
  decisions.push({ verdict, resourceType, url: request.url, reason, where });
  try {
    if (verdict === 'block') await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, msg.sessionId);
    else await send('Fetch.continueRequest', { requestId }, msg.sessionId);
  } catch { /* request already gone */ }
}

/**
 * The policy on the tab: its own requests, and those of every target inside
 * it. Out-of-process frames (a cross-site frame under site isolation) and
 * workers are their own targets, which the tab's interception does not see.
 */
async function startEgressPolicy(tabWsUrl, consentedOrigins) {
  const client = cdpClient(tabWsUrl);
  await client.ready;
  const decisions = [];
  const children = [];
  const send = (method, params = {}, sessionId) => client.sendRaw(method, params, sessionId);
  client.onAny(async (msg) => {
    if (msg.method === 'Fetch.requestPaused') {
      await decideRequest(send, msg, consentedOrigins, decisions, msg.sessionId ? 'child' : 'tab');
    } else if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      children.push({ type: targetInfo.type, policed: await policeTarget(send, sessionId, targetInfo.type) });
    }
  });
  await send('Fetch.enable', INTERCEPT_ALL);
  await send('Target.setAutoAttach', AUTO_ATTACH_PAUSED);
  return { decisions, children, close: () => client.close() };
}

// ── 2. Relay with single-use capabilities and an exclusive lease ────────────

// Default deny. A session-level command is forwarded only if its exact
// method is on this list AND its session id is one the relay has seen
// attached (the tab, or a nested frame/worker session the tab announced).
// Seeded from the 25 methods Playwright 1.64.1 used in poc.mjs, plus the
// ones these flows need. Changing it is a reviewable policy change.
const ALLOW = new Set([
  'DOM.getContentQuads', 'DOM.scrollIntoViewIfNeeded', 'DOM.describeNode', 'DOM.resolveNode',
  'Emulation.setEmulatedMedia', 'Emulation.setFocusEmulationEnabled',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Inspector.enable', 'Log.enable', 'Network.enable',
  'Page.addScriptToEvaluateOnNewDocument', 'Page.captureScreenshot', 'Page.createIsolatedWorld', 'Page.enable',
  'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.getNavigationHistory', 'Page.navigate',
  'Page.navigateToHistoryEntry', 'Page.setLifecycleEventsEnabled',
  'Runtime.callFunctionOn', 'Runtime.enable', 'Runtime.evaluate', 'Runtime.releaseObject',
  'Runtime.runIfWaitingForDebugger', 'Runtime.getProperties', 'Target.setAutoAttach',
]);
// Denied whatever the allowlist says (belt and braces against a bad edit).
const ALWAYS_DENY_PREFIXES = ['Fetch.', 'Storage.', 'SystemInfo.', 'Browser.'];
const ALWAYS_DENY = new Set([
  'Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies',
  'Network.clearBrowserCookies', 'Network.setRequestInterception', 'Page.setDownloadBehavior',
  'Network.getRequestPostData', 'Network.getResponseBody', 'Network.getResponseBodyForInterception',
  'Network.takeResponseBodyForInterceptionAsStream', 'Network.streamResourceContent', 'Network.searchInResponseBody',
  'Target.createTarget', 'Target.closeTarget', 'Target.attachToTarget', 'Target.createBrowserContext',
]);
const policyRefusal = (method, sessionId, knownSessions) => {
  if (ALWAYS_DENY.has(method) || ALWAYS_DENY_PREFIXES.some((p) => method.startsWith(p))) return `Denied by Cascade relay policy: ${method}`;
  if (!knownSessions.has(sessionId)) return `Denied by Cascade relay policy: unknown session ${sessionId}`;
  if (!ALLOW.has(method)) return `Denied by Cascade relay policy: ${method} is not on the allowlist`;
  return null;
};
const allowlistMisses = new Set();

function createCapabilityStore() {
  const caps = new Map(); // token -> { runId, state: 'fresh'|'used'|'burned', expiresAt }
  let generation = 0;
  return {
    // The device mints a capability only after the user approves the run.
    approveRun(runId, ttlMs = 30 * 60_000) {
      const token = crypto.randomBytes(24).toString('base64url');
      caps.set(token, { runId, state: 'fresh', expiresAt: Date.now() + ttlMs });
      return token;
    },
    // Single use: the first successful claim consumes it.
    claim(token) {
      const c = caps.get(token);
      if (!c) return { ok: false, why: 'unknown capability' };
      if (c.state !== 'fresh') return { ok: false, why: `capability already ${c.state}` };
      if (Date.now() > c.expiresAt) return { ok: false, why: 'capability expired' };
      c.state = 'used';
      // The lease it opens ends when it expires.
      return { ok: true, runId: c.runId, generation: ++generation, expiresAt: c.expiresAt };
    },
    burn(token) { const c = caps.get(token); if (c) c.state = 'burned'; },
  };
}

// Events are filtered too, not only commands: an allowlisted Network.enable
// makes Chromium emit request and response headers, and its ExtraInfo events
// carry raw Cookie and Set-Cookie values, HttpOnly ones included. Those never
// leave the device. ExtraInfo events are dropped, the flags that promise them
// are cleared (so Playwright does not wait for them), and credential headers
// are removed from what remains.
// Payload-bearing events go too: request bodies, WebSocket frames and
// EventSource messages carry the application's own data.
const DROPPED_EVENTS = new Set([
  'Network.requestWillBeSentExtraInfo', 'Network.responseReceivedExtraInfo',
  'Network.responseReceivedEarlyHints', 'Network.webSocketHandshakeResponseReceived',
  'Network.webSocketWillSendHandshakeRequest', 'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived', 'Network.webSocketFrameError', 'Network.eventSourceMessageReceived',
  'Network.requestIntercepted', 'Network.trustTokenOperationDone',
  'Network.reportingApiReportAdded', 'Network.reportingApiReportUpdated',
  'Network.subresourceWebBundleInnerResponseParsed',
]);
/** A request as the agent may see it: no credential headers, no body. */
function redactRequest(r) {
  if (!r || typeof r !== 'object') return r;
  const { postData, postDataEntries, ...rest } = r;
  void postData; void postDataEntries;
  return { ...rest, headers: withoutCredentials(r.headers) };
}
const CREDENTIAL_HEADERS = /^(cookie|set-cookie2?|authorization|proxy-authorization)$/i;
const withoutCredentials = (headers) => (headers && typeof headers === 'object'
  ? Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.test(k)))
  : headers);
function redactResponse(r) {
  if (!r || typeof r !== 'object') return r;
  const { headersText, requestHeadersText, ...rest } = r;
  void headersText; void requestHeadersText;
  return { ...rest, headers: withoutCredentials(r.headers), ...(r.requestHeaders ? { requestHeaders: withoutCredentials(r.requestHeaders) } : {}) };
}
/** The event as the agent may see it, or null to drop it. */
function redactEvent(method, params) {
  if (DROPPED_EVENTS.has(method)) return null;
  if (method === 'Network.requestWillBeSent') {
    return {
      ...params,
      request: redactRequest(params.request),
      ...(params.redirectResponse ? { redirectResponse: redactResponse(params.redirectResponse) } : {}),
      redirectHasExtraInfo: false,
    };
  }
  if (method === 'Network.responseReceived') return { ...params, response: redactResponse(params.response), hasExtraInfo: false };
  return params;
}

/**
 * The privileged browser-level guard for new top-level targets, which the
 * tab's policy does not cover. New targets start paused (waitForDebuggerOnStart),
 * before they send any request.
 * - A new page (a `target=_blank` link, `window.open`) would also be a second
 *   tab the lease does not cover. It gets a deny-everything interception
 *   first, then is resumed (closing it while paused would leave the opener's
 *   window.open waiting) and closed.
 * - Anything else, such as a service worker or shared worker the page starts,
 *   gets the egress policy before it runs. One whose interception cannot be
 *   enabled is closed.
 * The CLI drives a dedicated browser profile, so during a lease every new
 * target is one the run started.
 */
async function startPopupGuard(browserWs, leasedTargetId, consentedOrigins) {
  const client = cdpClient(browserWs);
  await client.ready;
  const closed = [];
  const workers = [];
  const decisions = [];
  const denyAll = new Set();
  const send = (method, params = {}, sessionId) => client.sendRaw(method, params, sessionId);
  const quiet = (method, params, sessionId) => send(method, params, sessionId).catch(() => {});
  const blockedRequests = [];
  client.onAny(async (msg) => {
    if (msg.method === 'Fetch.requestPaused') {
      if (!msg.sessionId) {
        await decideRequest(send, msg, consentedOrigins, decisions, 'browser');
      } else if (denyAll.has(msg.sessionId)) {
        blockedRequests.push(msg.params.request.url);
        await quiet('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'BlockedByClient' }, msg.sessionId);
      } else {
        await decideRequest(send, msg, consentedOrigins, decisions, 'worker');
      }
      return;
    }
    if (msg.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = msg.params;
    if (targetInfo.type === 'page' && targetInfo.targetId !== leasedTargetId) {
      closed.push(targetInfo.url || '(not yet navigated)');
      denyAll.add(sessionId);
      await quiet('Fetch.enable', INTERCEPT_ALL, sessionId);
      await quiet('Runtime.runIfWaitingForDebugger', {}, sessionId);
      await quiet('Target.closeTarget', { targetId: targetInfo.targetId });
      return;
    }
    if (targetInfo.targetId === leasedTargetId) {
      // The leased tab has its own policy session.
      await quiet('Runtime.runIfWaitingForDebugger', {}, sessionId);
      await quiet('Target.detachFromTarget', { sessionId });
      return;
    }
    const policed = await policeTarget(send, sessionId, targetInfo.type);
    workers.push({ type: targetInfo.type, policed });
    if (!policed) await quiet('Target.closeTarget', { targetId: targetInfo.targetId });
  });
  // Browser-wide interception, a measured backstop: without it, a burst of
  // pop-ups sends some first requests before their own targets are paused
  // (see the ten-pop-up check). Requests the target-level policies let
  // through reach it too, under the same rules.
  await send('Fetch.enable', INTERCEPT_ALL);
  await send('Target.setAutoAttach', AUTO_ATTACH_PAUSED);
  return { closed, workers, decisions, blockedRequests, close: () => client.close() };
}

/** Whether a URL is on a site the run may show: consented http(s), or about:blank. */
const onConsentedSite = (consentedOrigins) => (u) => {
  if (u === 'about:blank') return true;
  try {
    const x = new URL(u);
    return (x.protocol === 'http:' || x.protocol === 'https:') && consentedOrigins.has(x.origin);
  } catch { return false; }
};

function startRelay(tabWsUrl, caps, consentedOrigins) {
  const consented = onConsentedSite(consentedOrigins);
  // History entries from sites without consent (the tab's past, or a
  // navigation the policy failed) are listed with no URL or title.
  const redactHistory = (r) => (r && Array.isArray(r.entries)
    ? { ...r, entries: r.entries.map((e) => (consented(e.url) ? e : { ...e, url: 'about:blank#not-consented', userTypedURL: 'about:blank#not-consented', title: '' })) }
    : r);
  const server = http.createServer((_, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  // `watch`: a test can name a secret and count where it was seen.
  const state = { lease: null, refusals: [], hidden: [], watch: null, seenFromTab: 0, sentToAgent: 0 };
  // A frame or worker the agent may reach: on a consented origin (a blob:
  // URL counts as its creator's), or not navigated yet. An unnavigated one
  // can only load through the request policy, which needs consent.
  const childConsented = (u) => {
    if (!u || u === 'about:blank') return true;
    try { return consentedOrigins.has(new URL(u).origin); } catch { return false; }
  };

  server.on('upgrade', (req, socket, head) => {
    const token = (req.url.match(/^\/devtools\/browser\/([\w-]+)$/) || [])[1];
    const refuse = (why) => { state.refusals.push(why); socket.write(`HTTP/1.1 403 Forbidden\r\n\r\n${why}`); socket.destroy(); };
    if (!token) return refuse('no capability');
    // One exclusive lease per tab: a second connection is refused outright,
    // and its token is NOT consumed.
    if (state.lease) return refuse('tab already leased');
    const claim = caps.claim(token);
    if (!claim.ok) return refuse(claim.why);
    wss.handleUpgrade(req, socket, head, (client) => attach(client, token, claim.generation, claim.expiresAt));
  });

  function attach(client, token, generation, expiresAt) {
    const tab = new WebSocket(tabWsUrl, { perMessageDeflate: false });
    state.lease = { token, generation, client, tab };
    let nextId = 1;
    const pending = new Map();
    const queue = [];
    const sendTab = (m) => (tab.readyState === WebSocket.OPEN ? tab.send(JSON.stringify(m)) : queue.push(m));
    tab.on('open', () => { while (queue.length) tab.send(JSON.stringify(queue.shift())); });
    const reply = (id, sessionId, body) => client.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), ...body }));
    const emit = (method, params, sessionId) => {
      const safe = redactEvent(method, params);
      if (safe === null) return;
      const frame = JSON.stringify({ method, params: safe, ...(sessionId ? { sessionId } : {}) });
      if (state.watch && frame.includes(state.watch)) state.sentToAgent++;
      client.send(frame);
    };
    let targetInfo = null;
    const knownSessions = new Set([TAB_SESSION]);
    // Scripts the agent registered to run on every new document. Chromium
    // drops them when this connection's session ends, which teardown does;
    // they are also removed by name first, so the user's later pages never
    // run them even if the connection outlived the lease.
    const injected = [];

    // Fail closed: any disconnect ends the lease and burns the capability.
    const end = () => {
      if (state.lease?.generation !== generation) return;
      clearTimeout(expiry);
      for (const { identifier, sessionId } of injected.splice(0)) {
        sendTab({ id: nextId++, method: 'Page.removeScriptToEvaluateOnNewDocument', params: { identifier }, ...(sessionId ? { sessionId } : {}) });
      }
      caps.burn(token);
      state.lease = null;
      try { client.close(1011, 'lease ended'); } catch {}
      try { tab.close(); } catch {}
    };
    tab.on('close', end);
    client.on('close', end);
    tab.on('error', end);
    client.on('error', end);
    // A lease lasts no longer than the capability that opened it.
    const expiry = setTimeout(() => { state.refusals.push('lease ended: capability expired'); end(); }, Math.max(0, expiresAt - Date.now()));
    expiry.unref?.();

    // Nothing is served until the tab is known to be on a consented site: a
    // page it was already showing loaded before any request policy, so the
    // policy never had the chance to refuse it.
    let ready = false;
    const backlog = [];
    const checkId = nextId++;
    pending.set(checkId, { internal: (m) => {
      const url = m.result?.targetInfo?.url ?? '';
      if (!consented(url)) { state.refusals.push(`the tab is on a site without consent: ${originOf(url) || url}`); return end(); }
      ready = true;
      while (backlog.length) serve(backlog.shift());
    } });
    sendTab({ id: checkId, method: 'Target.getTargetInfo' });

    tab.on('message', (raw) => {
      if (state.watch && String(raw).includes(state.watch)) state.seenFromTab++;
      const msg = JSON.parse(raw);
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (p.internal) return p.internal(msg);
        reply(p.clientId, p.sessionId, msg.error ? { error: msg.error } : { result: p.transform ? p.transform(msg.result) : msg.result });
      } else {
        // Events from a session the agent was never given are not its own.
        if (msg.sessionId && !knownSessions.has(msg.sessionId)) return;
        if (msg.method === 'Target.attachedToTarget') {
          const { sessionId: child, targetInfo: info, waitingForDebugger } = msg.params;
          // A frame or worker on a site without consent, typically one the tab
          // already held before the lease (it sent no request for the policy
          // to stop), is never handed to the agent.
          if (!childConsented(info?.url)) {
            state.hidden.push(info?.url ?? '');
            if (waitingForDebugger) sendTab({ id: nextId++, method: 'Runtime.runIfWaitingForDebugger', sessionId: child });
            return;
          }
          knownSessions.add(child);
        }
        if (msg.method === 'Target.detachedFromTarget') knownSessions.delete(msg.params.sessionId);
        emit(msg.method, msg.params, msg.sessionId ?? TAB_SESSION);
      }
    });

    client.on('message', (raw) => {
      // Fencing: a socket from an older lease generation is never served.
      if (state.lease?.generation !== generation) return;
      if (!ready) return void backlog.push(raw);
      serve(raw);
    });

    function serve(raw) {
      if (state.lease?.generation !== generation) return;
      // A frame that is not a well-formed command ends the lease, fail closed,
      // rather than throwing out of the relay.
      let frame;
      try { frame = JSON.parse(raw); } catch { frame = null; }
      if (!frame || typeof frame !== 'object' || typeof frame.method !== 'string' || !Number.isInteger(frame.id)
        || (frame.sessionId !== undefined && typeof frame.sessionId !== 'string')
        || (frame.params !== undefined && (typeof frame.params !== 'object' || frame.params === null))) {
        state.refusals.push('malformed frame');
        return end();
      }
      const { id, method, params = {}, sessionId } = frame;
      if (sessionId) {
        // The command contract also checks the one argument that names a
        // destination: an agent navigation is http(s) or about:blank only.
        if (method === 'Page.navigate' && !/^(https?:|about:blank$)/i.test(String(params.url ?? ''))) {
          return reply(id, sessionId, { error: { code: -32000, message: `Denied by Cascade relay policy: Page.navigate to ${String(params.url).split(':')[0]}:` } });
        }
        const refusal = policyRefusal(method, sessionId, knownSessions);
        if (refusal) {
          if (refusal.includes('not on the allowlist')) allowlistMisses.add(method);
          return reply(id, sessionId, { error: { code: -32000, message: refusal } });
        }
      }
      if (!sessionId) {
        switch (method) {
          case 'Browser.getVersion': return reply(id, null, { result: { protocolVersion: '1.3', product: 'Chrome/Cascade-Relay', revision: '', userAgent: 'Cascade-Relay', jsVersion: '' } });
          case 'Browser.setDownloadBehavior': return reply(id, null, { result: {} });
          case 'Target.getTargetInfo': return reply(id, null, { result: { targetInfo: targetInfo ?? { targetId: 'browser', type: 'browser', title: '', url: '', attached: true } } });
          case 'Target.setAutoAttach': {
            reply(id, null, { result: {} });
            const rid = nextId++;
            pending.set(rid, { internal: (m) => {
              targetInfo = { ...m.result.targetInfo, attached: true, browserContextId: 'cascade-default' };
              emit('Target.attachedToTarget', { sessionId: TAB_SESSION, targetInfo, waitingForDebugger: false });
            } });
            return sendTab({ id: rid, method: 'Target.getTargetInfo' });
          }
          default: return reply(id, null, { error: { code: -32601, message: `Relay: browser-level ${method} not supported` } });
        }
      }
      const toTab = (m) => (sessionId === TAB_SESSION ? m : { ...m, sessionId });
      // Going back or forward: only to an entry on a consented site. A page
      // restored from the back-forward cache sends no request, so the request
      // policy alone would never see it.
      if (method === 'Page.navigateToHistoryEntry') {
        const hid = nextId++;
        pending.set(hid, { internal: (m) => {
          const entry = m.result?.entries?.find((e) => e.id === params.entryId);
          if (!entry || !consented(entry.url)) {
            return reply(id, sessionId, { error: { code: -32000, message: 'Denied by Cascade relay policy: that history entry is not on a consented site' } });
          }
          const rid = nextId++;
          pending.set(rid, { clientId: id, sessionId });
          sendTab(toTab({ id: rid, method, params }));
        } });
        return sendTab(toTab({ id: hid, method: 'Page.getNavigationHistory' }));
      }
      const rid = nextId++;
      const transform = method === 'Page.getNavigationHistory' ? redactHistory
        : method === 'Page.addScriptToEvaluateOnNewDocument' ? (r) => {
          if (r?.identifier) injected.push({ identifier: r.identifier, sessionId: sessionId === TAB_SESSION ? undefined : sessionId });
          return r;
        }
        : undefined;
      pending.set(rid, { clientId: id, sessionId, transform });
      sendTab(toTab({ id: rid, method, params }));
    }
  }

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, state, endpoint: (token) => `ws://127.0.0.1:${server.address().port}/devtools/browser/${token}`,
  })));
}

// Try a raw WebSocket connection; resolves 'open' or the refusal.
const tryConnect = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('unexpected-response', (_, res) => resolve(`refused ${res.statusCode}`));
  ws.on('error', (e) => resolve(`error ${e.message}`));
});

// ── Run ─────────────────────────────────────────────────────────────────────

const offlist = await countingServer('offlist.test', {
  '/': html('<title>offlist</title>off'),
  '/collect': (req, res) => res.end('ok'),
  '/lib.js': (req, res) => { res.setHeader('content-type', 'text/javascript'); res.end('window.__lib = 1;'); },
});
const SESSION_SECRET = `S3SS10N-${crypto.randomBytes(8).toString('hex')}`;
const BODY_SECRET = `B0DY-${crypto.randomBytes(8).toString('hex')}`;
const priv = await countingServer('127.0.0.1 (private)', { '/admin': (req, res) => res.end('router admin') });
const allowed = await countingServer('allowed.test', {
  '/': html(`<title>allowed</title>
    <a id="off" href="http://offlist.test/">off-list link</a>
    <a id="redir" href="/redirect">redirect</a>
    <form id="f" method="post" action="http://offlist.test/collect"><input name="q" value="secret"><button>go</button></form>
    <script src="http://offlist.test/lib.js"></script>`),
  '/two': html('<title>allowed two</title>two'),
  '/opener': html(`<title>opener</title><a id="nb" href="http://offlist.test/popup-link" target="_blank">new tab</a>`),
  // A form that sends a body the agent never typed (a stored token, say).
  '/form': html(`<title>form</title><form id="pf" method="post" action="/save">
    <input type="hidden" name="token" value="${BODY_SECRET}"><button id="go">save</button></form>`),
  '/save': (req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>saved</title>ok'); }); },
  // Signs in: an HttpOnly session cookie, which page script cannot read.
  '/login': (req, res) => {
    res.setHeader('set-cookie', `sid=${SESSION_SECRET}; HttpOnly; Path=/`);
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>signed in</title>ok');
  },
  '/redirect': (req, res) => { res.statusCode = 302; res.setHeader('location', 'http://offlist.test/'); res.end(); },
  '/framer': html('<title>framer</title><iframe src="http://offlist.test/"></iframe>'),
  '/xframe': html('<title>xframe</title><iframe src="http://allowed2.test/two"></iframe>'),
  '/file': (req, res) => { res.setHeader('content-type', 'application/octet-stream'); res.setHeader('content-disposition', 'attachment; filename="report.bin"'); res.end('secret bytes'); },
  // Workers and a cross-site frame that fetch whatever URL they are handed.
  '/workers': html('<title>workers</title>workers'),
  '/ping': (req, res) => res.end('pong'),
  // Counts the pages an injected new-document script has run on.
  '/injected': (req, res) => res.end('seen'),
  '/dedicated.js': js(`onmessage = (m) => (${TRY_FETCH})(m.data).then((r) => postMessage(r));`),
  '/shared.js': js(`onconnect = (e) => { const port = e.ports[0]; port.onmessage = (m) => (${TRY_FETCH})(m.data).then((r) => port.postMessage(r)); };`),
  '/sw.js': js(`self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
    self.addEventListener('message', (e) => e.waitUntil((${TRY_FETCH})(e.data).then((r) => e.source.postMessage(r))));`),
  '/frame-fetch': html(`<script>(${TRY_FETCH})(new URLSearchParams(location.search).get('u')).then((r) => parent.postMessage(r, '*'));</script>`),
  '/dl': html(`<title>downloads</title>
    <a id="attach" href="/file">attachment</a>
    <a id="blob" download="note.txt" href="#">blob</a>
    <script>document.querySelector('#blob').href = URL.createObjectURL(new Blob(['local note']));</script>`),
});

const rules = `MAP allowed.test 127.0.0.1:${allowed.port}, MAP allowed2.test 127.0.0.1:${allowed.port}, MAP offlist.test 127.0.0.1:${offlist.port}`;
const { proc, port: cdpPort, tab, browserWs } = await launchChromium(rules);
const ALLOWED = 'http://allowed.test';
const policy = await startEgressPolicy(tab.webSocketDebuggerUrl, new Set([ALLOWED, 'http://allowed2.test']));
const caps = createCapabilityStore();
const relay = await startRelay(tab.webSocketDebuggerUrl, caps, new Set([ALLOWED, 'http://allowed2.test']));
const popups = await startPopupGuard(browserWs, tab.id, new Set([ALLOWED, 'http://allowed2.test']));
console.log(`Playwright ${require('playwright-core/package.json').version}\n`);

const offHits = () => offlist.hits.filter((h) => !h.startsWith('GET /lib.js')).length;
const navBlocked = async (label, action) => {
  const before = offHits();
  await action().catch(() => {});
  await sleep(400);
  const blocked = policy.decisions.some((d) => d.verdict === 'block' && originOf(d.url) === 'http://offlist.test' && d.resourceType === 'Document');
  check(`P2: ${label} is blocked before any request`, offHits() === before && blocked, `off-list server saw ${offHits() - before} request(s)`);
};

let browser;
try {
  // ── Lease and capabilities (O2, O3)
  const cap1 = caps.approveRun('run-1');
  browser = await chromium.connectOverCDP(relay.endpoint(cap1));
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 5000 });
  check('connect with a fresh capability', !!page);

  check('O3: same capability replayed on a second socket is refused', (await tryConnect(relay.endpoint(cap1))).startsWith('refused'), relay.state.refusals.at(-1));
  const capOther = caps.approveRun('run-2');
  check('O2: a second run is refused while the tab is leased', (await tryConnect(relay.endpoint(capOther))).startsWith('refused'), relay.state.refusals.at(-1));

  // ── Origin enforcement (P2)
  await page.goto(`${ALLOWED}/`);
  check('consented origin loads', (await page.title()) === 'allowed');
  const libHits = offlist.hits.filter((h) => h.startsWith('GET /lib.js')).length;
  check('LIMIT: public subresource from a non-consented origin is allowed', libHits === 1, 'page scripts and CDNs keep working; see §4.2');

  await navBlocked('agent navigation (page.goto) to an off-list origin', () => page.goto('http://offlist.test/', { timeout: 3000 }));
  await page.goto(`${ALLOWED}/`);
  await navBlocked('clicking an off-list link', () => page.click('#off', { timeout: 3000 }));
  await page.goto(`${ALLOWED}/`);
  await navBlocked('script navigation (location.href)', () => page.evaluate(() => { location.href = 'http://offlist.test/'; }));
  await page.goto(`${ALLOWED}/`);
  await navBlocked('form POST to an off-list origin', () => page.click('#f button', { timeout: 3000 }));
  await page.goto(`${ALLOWED}/`);
  {
    const before = offHits();
    const allowedRedirects = allowed.hits.filter((h) => h === 'GET /redirect').length;
    await page.click('#redir', { timeout: 3000 }).catch(() => {});
    await sleep(400);
    check('P2: server redirect to an off-list origin is blocked before the redirected request',
      allowed.hits.filter((h) => h === 'GET /redirect').length === allowedRedirects + 1 && offHits() === before,
      `consented server saw the redirect; off-list server saw ${offHits() - before}`);
  }
  await navBlocked('an off-list iframe', () => page.goto(`${ALLOWED}/framer`));

  {
    const before = priv.hits.length;
    const result = await page.evaluate((u) => fetch(u).then(() => 'reached', (e) => `failed: ${e.message}`), `http://127.0.0.1:${priv.port}/admin`);
    await sleep(200);
    const policyBlocked = policy.decisions.some((d) => d.verdict === 'block' && d.reason === 'private-network destination');
    check('P2: fetch to a private-network address is blocked by the policy', priv.hits.length === before && policyBlocked, result);
  }
  {
    // The same private server, reached through an IPv4-mapped IPv6 literal.
    const before = priv.hits.length;
    const result = await page.evaluate((u) => fetch(u).then(() => 'reached', (e) => `failed: ${e.message}`), `http://[::ffff:127.0.0.1]:${priv.port}/admin`);
    await sleep(200);
    const blocked = policy.decisions.some((d) => d.verdict === 'block' && d.reason === 'private-network destination' && d.url.includes('[::ffff:'));
    check('P2: fetch to a private address written as IPv4-mapped IPv6 is blocked', priv.hits.length === before && blocked, result);
  }
  {
    const cases = {
      private: ['::ffff:127.0.0.1', '[::ffff:7f00:1]', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '::', '::1', '::127.0.0.1', '0.0.0.0',
        'fe90::1', 'febf::1', 'fd00::1', '2002:7f00:1::', '2002:c0a8:101::', '224.0.0.1', '[fe80::1%25eth0]',
        'localhost.', 'printer.local.', 'app.localhost.', '127.0.0.1.'],
      public: ['8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::', 'fec0::1'],
    };
    const wrong = [...cases.private.filter((h) => !isPrivateHost(h)), ...cases.public.filter((h) => isPrivateHost(h))];
    check('P2: private-address check covers IPv6 forms that reach IPv4 (mapped, compatible, NAT64, 6to4), all of fe80::/10, and root-dot names', wrong.length === 0, wrong.join(', ') || `${cases.private.length} private, ${cases.public.length} public`);
  }
  {
    const opened = await page.goto('file:///etc/hostname').then(() => 'navigated', (e) => `refused: ${e.message.split('\n')[0]}`);
    check('P2: the agent cannot navigate the tab to a file: URL', opened.startsWith('refused') && !page.url().startsWith('file:'), opened);
    const verdicts = [
      ['file:///etc/hostname', 'Document'], ['chrome://settings/', 'Document'], ['data:text/html,hi', 'Document'],
      ['file:///etc/passwd', 'Image'],
    ].map(([u, t]) => egressVerdict(u, t, new Set([ALLOWED])).verdict);
    check('P2: non-http(s) documents and any file: request are blocked by the request policy', verdicts.every((v) => v === 'block'), verdicts.join(', '));
  }
  {
    // New pages the leased tab opens are outside its request policy and its
    // lease: closed before they send anything.
    const before = offHits();
    await page.goto(`${ALLOWED}/opener`, { timeout: 8000 });
    await page.evaluate(() => { window.open('http://offlist.test/popup-script'); });
    // One pop-up per user gesture: each in its own call.
    await page.evaluate(() => { window.open('http://offlist.test/popup-noopener', '_blank', 'noopener'); });
    await page.click('#nb', { timeout: 5000, noWaitAfter: true }).catch(() => {});
    await sleep(800);
    const pages = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).filter((t) => t.type === 'page');
    check('P2: pages opened by window.open or a target=_blank link send no request', offHits() === before, `off-list server saw ${offHits() - before}: ${offlist.hits.slice(-3).join(' | ')}; policy children: ${JSON.stringify(policy.children.filter((c) => c.type === 'page'))}`);
    check('the lease stays one tab: every new page is closed', pages.length === 1 && popups.closed.length >= 3, `${pages.length} page(s); closed ${popups.closed.length}; their requests failed: ${popups.blockedRequests.length}`);
  }

  {
    // Workers and out-of-process frames are their own targets, so the tab's
    // own request interception does not see their requests. A consented page
    // (or the agent through Runtime.evaluate) starts one and hands it a
    // private-network URL; it must be blocked like the page's own fetch,
    // while the same worker still reaches the consented origin.
    await page.goto(`${ALLOWED}/workers`);
    const PRIVATE = `http://127.0.0.1:${priv.port}/admin`;
    const viaWorker = (kind, url) => page.evaluate(async ({ kind, url }) => {
      const ask = (post, listen) => new Promise((resolve) => { listen(resolve); post(url); setTimeout(() => resolve('timeout'), 4000); });
      if (kind === 'dedicated worker') { const w = new Worker('/dedicated.js'); return ask((u) => w.postMessage(u), (f) => { w.onmessage = (e) => f(e.data); }); }
      if (kind === 'shared worker') { const w = new SharedWorker('/shared.js'); w.port.start(); return ask((u) => w.port.postMessage(u), (f) => { w.port.onmessage = (e) => f(e.data); }); }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sw = reg.active ?? reg.waiting ?? reg.installing;
      return ask((u) => sw.postMessage(u), (f) => { navigator.serviceWorker.onmessage = (e) => f(e.data); });
    }, { kind, url });
    // Counted from the policy's own decisions, so a block is the policy's and
    // not Chromium's private-network protection failing the fetch afterwards.
    const policyBlocks = (url) => [...policy.decisions, ...popups.decisions].filter((d) => d.verdict === 'block' && d.url === url).length;
    for (const kind of ['dedicated worker', 'shared worker', 'service worker']) {
      const before = priv.hits.length;
      const blocksBefore = policyBlocks(PRIVATE);
      const blocked = await viaWorker(kind, PRIVATE);
      await sleep(200);
      const reached = await viaWorker(kind, `${ALLOWED}/ping`);
      check(`P2: a ${kind} the page starts cannot reach a private-network address`,
        priv.hits.length === before && policyBlocks(PRIVATE) > blocksBefore && blocked !== 'reached' && reached === 'reached',
        `private server saw ${priv.hits.length - before}; policy blocks ${policyBlocks(PRIVATE) - blocksBefore}; private: ${blocked}; consented: ${reached}`);
    }
    await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); });
  }
  {
    // A consented cross-site frame runs in its own process (site isolation).
    const before = priv.hits.length;
    await page.goto(`${ALLOWED}/workers`);
    const result = await page.evaluate((src) => new Promise((resolve) => {
      addEventListener('message', (e) => resolve(e.data));
      const f = document.createElement('iframe'); f.src = src; document.body.append(f);
      setTimeout(() => resolve('timeout'), 4000);
    }), `http://allowed2.test/frame-fetch?u=${encodeURIComponent(`http://127.0.0.1:${priv.port}/admin`)}`);
    await sleep(200);
    const frameBlocked = policy.decisions.some((d) => d.verdict === 'block' && d.where === 'child' && d.url === `http://127.0.0.1:${priv.port}/admin`);
    check('P2: a consented cross-site frame cannot reach a private-network address', priv.hits.length === before && frameBlocked && result !== 'reached',
      `private server saw ${priv.hits.length - before}; blocked in the frame's own target: ${frameBlocked}; frame: ${result}`);
  }

  {
    // The same, ten times in a row. Pausing new targets alone let 1 to 3 of
    // ten send their first request; the browser-wide interception closes it.
    const before = offHits();
    await page.goto(`${ALLOWED}/opener`, { timeout: 8000 });
    for (let i = 0; i < 10; i++) await page.evaluate((n) => { window.open(`http://offlist.test/popup-burst-${n}`); }, i);
    await sleep(1000);
    check('P2: ten pop-ups in a row send no request', offHits() === before,
      `off-list server saw ${offHits() - before}`);
  }

  await page.goto(`${ALLOWED}/two`);
  check('navigation within the consented origin still works', (await page.title()) === 'allowed two');

  {
    // A compromised server enables Network events and signs in on a consented
    // page: Chromium reports the HttpOnly cookie in ExtraInfo events and
    // headers. None of it may reach the agent's side of the relay.
    relay.state.watch = SESSION_SECRET;
    await page.goto(`${ALLOWED}/login`);
    await page.goto(`${ALLOWED}/two`); // sends the cookie back
    await sleep(300);
    const { seenFromTab, sentToAgent } = relay.state;
    relay.state.watch = null;
    check('control: Chromium did emit the HttpOnly cookie in Network events', seenFromTab > 0, `${seenFromTab} frame(s)`);
    check('P1: no cookie or credential header reaches the agent through Network events', sentToAgent === 0, `${sentToAgent} frame(s)`);
  }
  {
    // The same for a request body: a form posts a value the agent never saw.
    relay.state.watch = BODY_SECRET; relay.state.seenFromTab = 0; relay.state.sentToAgent = 0;
    await page.goto(`${ALLOWED}/form`);
    await Promise.all([page.waitForURL(`${ALLOWED}/save`, { waitUntil: 'commit' }), page.click('#go')]);
    await sleep(300);
    const { seenFromTab, sentToAgent } = relay.state;
    relay.state.watch = null;
    check('control: Chromium did emit the posted body in Network events', seenFromTab > 0, `${seenFromTab} frame(s)`);
    check('P1: no request body reaches the agent through Network events', sentToAgent === 0, `${sentToAgent} frame(s)`);
    const ws = redactEvent('Network.webSocketFrameReceived', { response: { payloadData: 'x' } });
    const es = redactEvent('Network.eventSourceMessageReceived', { data: 'x' });
    check('WebSocket frames and EventSource messages are dropped', ws === null && es === null);
    check('navigation still works with ExtraInfo events dropped and bodies stripped', (await page.title()) === 'saved');
  }

  // ── Downloads (CLI path: the policy's own BROWSER-level session)
  {
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-poc2-dl-'));
    const files = () => fs.readdirSync(dlDir).filter((f) => !f.endsWith('.crdownload'));
    const browserPolicy = cdpClient(browserWs);
    await browserPolicy.ready;
    // Control: with downloads allowed, the test can see a file appear.
    await browserPolicy.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    await page.goto(`${ALLOWED}/dl`);
    await page.click('#attach');
    for (let i = 0; i < 30 && files().length === 0; i++) await sleep(100);
    check('control: an attachment download writes a file when allowed', files().length === 1, files().join(', '));
    // Policy during a lease: deny.
    await browserPolicy.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    const before = files().length;
    await page.click('#attach');
    await page.click('#blob');
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/file'; a.download = 'x.bin'; document.body.append(a); a.click(); });
    await sleep(1500);
    check('downloads during a lease write no file (link, blob, script)', files().length === before, `${files().length - before} new file(s)`);
    browserPolicy.close();
  }

  // ── Fail closed, no resume (model (a))
  relay.state.lease.tab.close();
  await sleep(300);
  check('S1: a dropped connection ends the lease', relay.state.lease === null && !browser.isConnected());
  check('O3: the same capability cannot reconnect after a drop', (await tryConnect(relay.endpoint(cap1))).startsWith('refused'), relay.state.refusals.at(-1));
  check('O3: a capability refused only because the tab was leased is still usable later', (await tryConnect(relay.endpoint(capOther))) === 'open');
  await sleep(200);

  const cap2 = caps.approveRun('run-1');
  const browser2 = await chromium.connectOverCDP(relay.endpoint(cap2));
  check('a NEW capability after re-approval opens a new lease', browser2.isConnected());
  check('O3: the old capability is still refused after the new lease', (await tryConnect(relay.endpoint(cap1))).startsWith('refused'));
  await browser2.close();
  await sleep(200);

  // Raw protocol client: nested sessions, unseen methods, and the policy's
  // own interception.
  {
    const raw = new WebSocket(relay.endpoint(caps.approveRun('run-4')));
    let nextId = 1;
    const waiters = new Map();
    let nested = null;
    raw.on('message', (m) => {
      const msg = JSON.parse(m);
      if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
      if (msg.method === 'Target.attachedToTarget' && msg.sessionId === TAB_SESSION && msg.params.targetInfo.type === 'iframe') nested = msg.params.sessionId;
    });
    await new Promise((r) => raw.on('open', r));
    const call = (method, params = {}, sessionId) => new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, (msg) => resolve(msg.error ? `error: ${msg.error.message}` : msg.result));
      raw.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => resolve('timeout'), 5000);
    });
    await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(200);
    await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, TAB_SESSION);
    await call('Page.enable', {}, TAB_SESSION);
    await call('Page.navigate', { url: `${ALLOWED}/xframe` }, TAB_SESSION);
    for (let i = 0; i < 40 && !nested; i++) await sleep(100);
    check('a cross-site consented iframe arrives as a nested session', !!nested, nested ?? 'none');

    const ok = await call('Runtime.evaluate', { expression: '6*7', returnByValue: true }, nested);
    check('allowlisted method works on the nested session', ok?.result?.value === 42, JSON.stringify(ok).slice(0, 80));
    const geo = await call('Emulation.setGeolocationOverride', { latitude: 1, longitude: 1, accuracy: 1 }, nested);
    check('P1: unseen method through a NESTED session is refused', String(geo).includes('not on the allowlist'), String(geo));
    const ua = await call('Emulation.setUserAgentOverride', { userAgent: 'spoof' }, TAB_SESSION);
    check('P1: Emulation.setUserAgentOverride is refused', String(ua).includes('not on the allowlist'), String(ua));
    const madeUp = await call('Runtime.evaluate', { expression: '1' }, 'fabricated-session');
    check('P1: a command on an unknown session id is refused', String(madeUp).includes('unknown session'), String(madeUp));
    const fd = await call('Fetch.disable', {}, TAB_SESSION);
    check('the agent cannot turn the policy off (Fetch.disable denied)', String(fd).includes('Denied'), String(fd));

    // History: a blocked navigation leaves an entry for the off-list site.
    await call('Page.navigate', { url: `${ALLOWED}/two` }, TAB_SESSION);
    await sleep(300);
    await call('Page.navigate', { url: 'http://offlist.test/history-probe' }, TAB_SESSION);
    await sleep(300);
    await call('Page.navigate', { url: `${ALLOWED}/two` }, TAB_SESSION);
    await sleep(300);
    const direct = cdpClient(tab.webSocketDebuggerUrl);
    await direct.ready;
    const truth = await direct.send('Page.getNavigationHistory');
    direct.close();
    const seenByAgent = await call('Page.getNavigationHistory', {}, TAB_SESSION);
    const offEntry = truth.entries.find((e) => e.url.includes('offlist.test'));
    check('control: the tab\'s real history has an entry for the off-list site', !!offEntry, truth.entries.map((e) => e.url).join(' | '));
    check('P2: the agent\'s view of history has no off-list URL or title', !JSON.stringify(seenByAgent).includes('offlist'), JSON.stringify(seenByAgent.entries?.map((e) => e.url)));
    const beforeBack = offHits();
    const back = await call('Page.navigateToHistoryEntry', { entryId: offEntry?.id ?? -1 }, TAB_SESSION);
    await sleep(300);
    check('P2: going back to an off-list entry is refused', String(back).includes('not on a consented site') && offHits() === beforeBack, String(back));
    const consentedEntry = truth.entries.find((e) => e.url === `${ALLOWED}/two`);
    const fine = await call('Page.navigateToHistoryEntry', { entryId: consentedEntry.id }, TAB_SESSION);
    check('going back to a consented entry still works', !String(fine).startsWith('error'), JSON.stringify(fine));
    raw.close();
    await sleep(200);
  }

  {
    // A buggy or hostile server sends a frame that is not JSON: the lease
    // ends and its capability burns, and the relay keeps serving.
    const cap = caps.approveRun('run-5');
    const raw = new WebSocket(relay.endpoint(cap));
    await new Promise((r) => raw.on('open', r));
    const closed = new Promise((r) => raw.on('close', r));
    raw.send('{not json');
    await Promise.race([closed, sleep(2000)]);
    check('a malformed frame ends the lease without stopping the relay', relay.state.lease === null && relay.state.refusals.at(-1) === 'malformed frame', relay.state.refusals.at(-1));
    check('its capability cannot reconnect', (await tryConnect(relay.endpoint(cap))).startsWith('refused'));
    check('the relay still serves a fresh capability', (await tryConnect(relay.endpoint(caps.approveRun('run-6')))) === 'open');
    await sleep(200);
  }

  {
    // A script the agent registers to run on every new document must not
    // outlive the lease: the user goes on using the tab afterwards.
    const injectedHits = () => allowed.hits.filter((h) => h.startsWith('GET /injected')).length;
    const cap = caps.approveRun('run-8');
    const raw = new WebSocket(relay.endpoint(cap));
    let nextId = 1;
    const waiters = new Map();
    raw.on('message', (m) => { const msg = JSON.parse(m); if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); } });
    await new Promise((r) => raw.on('open', r));
    const call = (method, params = {}, sessionId = TAB_SESSION) => new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, (msg) => resolve(msg.error ? `error: ${msg.error.message}` : msg.result));
      raw.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => resolve('timeout'), 5000);
    });
    await call('Page.enable');
    const added = await call('Page.addScriptToEvaluateOnNewDocument', { source: `fetch('${ALLOWED}/injected?' + location.pathname)` });
    const before = injectedHits();
    await call('Page.navigate', { url: `${ALLOWED}/two` });
    await sleep(600);
    const duringLease = injectedHits() - before;
    check('control: a script the agent injected runs on new documents during the lease', duringLease > 0, `identifier ${added?.identifier}; ran ${duringLease} time(s)`);
    raw.close();
    await sleep(400);
    // The user's own later use of the tab, not through the relay.
    const direct = cdpClient(tab.webSocketDebuggerUrl);
    await direct.ready;
    const afterLeaseBefore = injectedHits();
    await direct.send('Page.navigate', { url: `${ALLOWED}/` });
    await sleep(800);
    await direct.send('Page.navigate', { url: `${ALLOWED}/two` });
    await sleep(800);
    direct.close();
    check('P1: an injected new-document script does not run after the lease ends', injectedHits() === afterLeaseBefore,
      `ran ${injectedHits() - afterLeaseBefore} time(s) after the lease`);
  }

  {
    // A lease ends when its capability expires, even with the socket open.
    const cap = caps.approveRun('run-7', 1500);
    const raw = new WebSocket(relay.endpoint(cap));
    await new Promise((r) => raw.on('open', r));
    let closedAt = 0;
    const closed = new Promise((r) => raw.on('close', () => { closedAt = Date.now(); r(); }));
    const openedAt = Date.now();
    await Promise.race([closed, sleep(5000)]);
    check('O3: a lease ends when its capability expires, with the socket still open',
      closedAt > 0 && relay.state.lease === null && relay.state.refusals.at(-1) === 'lease ended: capability expired',
      `closed after ${closedAt ? closedAt - openedAt : 'never'} ms; ${relay.state.refusals.at(-1)}`);
    check('its capability cannot reconnect after expiry', (await tryConnect(relay.endpoint(cap))).startsWith('refused'));
  }

  {
    // What the tab already held before the lease loaded before any request
    // policy, so the policy never had a request to refuse. A second browser,
    // so its tab can load an off-list frame first.
    const second = await launchChromium(rules);
    try {
      const direct = cdpClient(second.tab.webSocketDebuggerUrl);
      await direct.ready;
      await direct.send('Page.navigate', { url: `${ALLOWED}/framer` });
      await sleep(1200);
      const targets = await (await fetch(`http://127.0.0.1:${second.port}/json/list`)).json();
      check('control: before the lease, the tab holds an off-list frame in its own process',
        targets.some((t) => t.type === 'iframe' && originOf(t.url) === 'http://offlist.test'), targets.map((t) => `${t.type} ${t.url}`).join(' | '));
      const caps2 = createCapabilityStore();
      const relay2 = await startRelay(second.tab.webSocketDebuggerUrl, caps2, new Set([ALLOWED, 'http://allowed2.test']));
      const raw = new WebSocket(relay2.endpoint(caps2.approveRun('pre-1')));
      const attached = [];
      let nextId = 1;
      const waiters = new Map();
      raw.on('message', (m) => {
        const msg = JSON.parse(m);
        if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
        if (msg.method === 'Target.attachedToTarget') attached.push(msg.params.targetInfo.url);
      });
      await new Promise((r) => raw.on('open', r));
      const call = (method, params = {}, sessionId) => new Promise((resolve) => {
        const id = nextId++;
        waiters.set(id, (msg) => resolve(msg.error ? `error: ${msg.error.message}` : msg.result));
        raw.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => resolve('timeout'), 5000);
      });
      await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, TAB_SESSION);
      await sleep(800);
      check('P2: a frame on an off-list site that the tab held before the lease is never given to the agent',
        !attached.some((u) => originOf(u) === 'http://offlist.test') && relay2.state.hidden.some((u) => originOf(u) === 'http://offlist.test'),
        `agent saw: ${attached.join(', ')}; hidden: ${relay2.state.hidden.join(', ')}`);
      raw.close();
      await sleep(300);

      // The tab itself on an off-list site when the lease starts.
      await direct.send('Page.navigate', { url: 'http://offlist.test/' });
      await sleep(800);
      const raw2 = new WebSocket(relay2.endpoint(caps2.approveRun('pre-2')));
      let answered = false;
      const closed2 = new Promise((r) => raw2.on('close', r));
      raw2.on('message', (m) => { if (JSON.parse(m).result) answered = true; });
      await new Promise((r) => raw2.on('open', r));
      // Sent at once, before the relay has looked at the tab.
      raw2.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.title' }, sessionId: TAB_SESSION }));
      await Promise.race([closed2, sleep(3000)]);
      check('P2: no lease is served on a tab that is on a site without consent',
        !answered && relay2.state.lease === null && String(relay2.state.refusals.at(-1)).startsWith('the tab is on a site without consent'),
        relay2.state.refusals.at(-1));
      direct.close();
      relay2.server.close();
    } finally {
      second.proc.kill();
    }
  }

  const expired = caps.approveRun('run-3', -1);
  check('O3: an expired capability is refused', (await tryConnect(relay.endpoint(expired))).startsWith('refused'), relay.state.refusals.at(-1));
} catch (e) {
  check('unexpected error', false, e.stack?.split('\n').slice(0, 3).join(' / '));
} finally {
  await browser?.close().catch(() => {});
  policy.close();
  popups.close();
  relay.server.close();
  for (const s of [allowed, offlist, priv]) s.server.close();
  proc.kill();
}

console.log('\nPolicy decisions (blocked):');
for (const d of policy.decisions.filter((x) => x.verdict === 'block')) console.log(`  ${d.resourceType.padEnd(9)} ${d.url} — ${d.reason}`);
console.log(`Methods refused as not allowlisted (expected: only the two Emulation probes): ${[...allowlistMisses].join(', ') || 'none'}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
