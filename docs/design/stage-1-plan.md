# Stage 1 plan: relay contract library

Status: **plan under review. Scope is not agreed.** Revision 2, answering
ChatGPT's review of 4 Nov on PR #316 (thread 4331289034). No stage-1 code may
land until Claude and ChatGPT have each stated "Stage 1 scope agreed for
implementation" on this PR. The design is
[`byo-browser-and-routing-data.md`](byo-browser-and-routing-data.md); this
plan does not replace it.

## 1. Library boundary

New directory `src/browser/relay/`. No runtime path imports it and
`src/index.ts` does not export it, so stage 1 changes nothing for users, adds
no flag and has no production overhead. `BrowserLease` (`src/browser/lease.ts`)
decides which worker holds a browser within a run; it is a different thing and
stays unchanged.

| Module | API | Depends on |
|---|---|---|
| `command-policy.ts` | `parseFrame(raw)`, `checkCommand(frame, ctx)`, `filterEvent(method, params, ctx)`, `POLICY_VERSION` | nothing (pure) |
| `egress-rules.ts` | `classifyHost(host)`, `requestVerdict(url, resourceType, consent)` | nothing (pure) |
| `egress-proxy.ts` | `startEgressProxy({ resolve, consent })`, `browserProxyArgs(port)` | `node:net`, injected resolver |
| `request-enforcer.ts` | `startRequestPolicy({ browserWs, tabTargetId, consent })` | CDP socket |
| `capability.ts` | `issueGrant`, `approveGrant`, `verifyApproval`, `claim`, `burn` | injected keys, nonce store, clock |
| `tab-lease.ts` | `createTabLease()`: `acquire`, `suspend`, `handBack`, `revoke(reason)`, `fence()` | injected clock |
| `relay.ts` | `createDeviceRelay({ tab, capabilities, lease, policy, transport })` | the above |
| `history.ts` | `navigateHistory(page, delta)`: `waitUntil: 'commit'`, then a separate readiness wait (R-A2) | Playwright types |

## 2. Trust model (blocker 1)

**Correction.** Revision 1 proposed device-signed tokens and said a server
compromise then couldn't forge a capability. That was incomplete: a device
signature doesn't show the server authorized anything. Two parties each hold
something the other must not be able to produce, so there are two signed
objects.

| Object | Issued by | Verified by | Proves |
|---|---|---|---|
| **Run grant** | Server (server key) | Device and server | This server asks this device to serve this run for this user |
| **Device approval** | Device (device key), only after the user approves | Server | This user approved on this device, for this tab and these origins, against this grant |

**Authority is the intersection.** The device enforces its own record of the
approval, never a list the server sends back, so a compromised server can ask
but cannot widen what the user approved. A compromised device can sign only
for itself: the server rejects an approval whose grant doesn't match the user,
device and run it issued, so it can't reach another user's run. It does
already control its own browser, which is out of scope.

**Signed payloads.** Ed25519 over canonical JSON (RFC 8785), with a domain
string so one object can't pass as the other:

- `cascade.relay.grant.v1`: `iss`, `aud` (device id), `userId`, `deviceId`,
  `runId`, `iat`, `exp`, `nonce`, `policyVersion`
- `cascade.relay.approval.v1`: `grantHash`, `iss` (device id), `aud` (server
  id), `tabTargetId`, `allowedOrigins`, `privateOrigins`, `iat`, `exp`,
  `nonce`, `policyVersion`

`exp` is at most 30 minutes and never later than the grant's. Unknown fields,
an unknown version or a mismatched `policyVersion` are refused. §5's
"renewable while the run is active" is dropped for stage 1: more time takes a
new grant and a new approval.

**Single use.**
- The server claims through an injected `NonceStore.claimOnce(nonce, exp)`,
  which must be an atomic insert visible to every server instance. Stage 2
  supplies the real store. Stage 1 ships an in-memory one and a contract test
  that any store must pass.
- The device keeps its own used set too, so it refuses a replay even if the
  server is compromised.
- A connection refused only because the tab is leased doesn't claim the nonce.

**When something is unavailable: fail closed.**
- The nonce store or a verifier being down refuses new claims, with a
  retryable error.
- A lease already claimed keeps running until its `exp` or a revoke, because
  the device enforces it locally and its claim is already recorded. Say if you
  would rather revoke these too.
- An unreadable device key refuses to approve.

Key enrollment and revocation are stage 2. Stage 1 tests exercise this
boundary with injected identities: a forged grant, a forged approval, one
signed by another user's device, a grant replayed to another device, and one
object presented as the other.

## 3. Egress enforcement (blocker 2)

**Mandatory for every transport.** The relay launches the browser itself with
these arguments. It never attaches to a browser it didn't launch on this path:

```
--proxy-server=http://127.0.0.1:<port>
--proxy-bypass-list=<-loopback>
--webrtc-ip-handling-policy=disable_non_proxied_udp
```

The same WebRTC setting is written to the dedicated profile's preferences as a
second layer.

**New finding: WebRTC goes around the proxy.** The 73 checks in
`poc-egress-and-lease.mjs` don't cover it. With the proxy flags alone, a STUN
request from the page reached a private UDP socket (4 packets). A similarly
named flag, `--force-webrtc-ip-handling-policy`, had no effect on Chromium
1243. With `--webrtc-ip-handling-policy=disable_non_proxied_udp`, 0 packets;
setting it in the profile preferences also gave 0 in a separate throwaway run.

**Evidence** (`poc-proxy-fail-closed.mjs`, 8/8, Chromium 1243, each asserted at
the destination, with a no-proxy control that does reach it):

| Case | Result at destination |
|---|---|
| Proxy never up: `fetch`, WebSocket, iframe | 0 TCP accepts |
| Proxy never up: navigation | `ERR_PROXY_CONNECTION_FAILED`, 0 TCP accepts |
| Proxy killed mid-session, on a page it served | 0 TCP accepts |
| WebRTC with proxy flags only | 4 UDP packets (the leak) |
| WebRTC with the policy above | 0 UDP packets |

So Chromium has no direct-connect fallback in these cases, but this is one
Chromium version and a test must keep proving it.

**Fail closed.** No lease is granted until a canary request from the leased tab
is seen by the proxy carrying a per-launch nonce. If the proxy exits, the relay
revokes the lease (reason `egress-proxy-down`) and does not restart it under a
live lease.

**TLS and WSS.** `https:` and `wss:` cross the proxy as `CONNECT host:port`. The
proxy doesn't terminate TLS, installs no certificate and never sees content. It
checks the name and every resolved address, then dials exactly the checked
address. Plain `http:` and `ws:` are handled as in §4.3 of the design. Non-TLS
ports are not special-cased.

**Required tests,** each asserted at the destination:
- service, shared and dedicated workers, WebSocket upgrades, IPv4 and IPv6
- redirects across scheme and across host, counting each hop
- an origin whose DNS answer changes between connections
- forced proxy failure before launch and mid-session
- WebRTC, including a TURN-over-TCP candidate
- QUIC and WebTransport. **Not tested yet.** The plan adds `--disable-quic` and
  needs an HTTP/3 server to assert 0 packets. If WebTransport still gets out, the
  page gets it removed through the privileged session, as done for WebRTC in a
  throwaway check (`RTCPeerConnection` removed before page scripts, in the main
  frame and in an iframe)

**Decided by Varun (4 Nov).**
- The proxy is on by default, with a per-device opt-out only the user can set.
  With it off, that source makes no private-network claim and the consent prompt
  says so. A failure while on still fails closed. Stage 1 builds only the on
  path; the setting comes with the CLI adapter.
- An exact private origin stays allowed but always needs a separate confirmation
  naming the exact origin and that it's on the user's private network, for that
  run only. It's carried in `privateOrigins` above.
- Public-looking names that resolve to private addresses stay denied. No intranet
  opt-in ships in stage 1.

**Carried limit:** why the browser-wide interception stops a pop-up's first
request isn't understood, so the burst test (ten `window.open`) stays as a
regression gate.

## 4. Lease races (blocker 3)

Every command carries the fence (`generation` plus lease state) it was accepted
under. It is checked twice:

1. **At dispatch,** when it leaves the queue.
2. **At forwarding,** in the same synchronous step as the socket write, with no
   `await` between check and write.

`revoke`, `suspend` and a disconnect change the fence synchronously, before
anything else runs, then reject everything queued and detach the debugger.

**Precise limit.** A command already written to the browser's socket can't be
recalled. So the guarantee is: nothing is *forwarded* after the fence changes,
and any reply to an earlier command is dropped rather than delivered. The
ordering is what the tests pin down. Suspend works the same way, except queued
commands are rejected, not held for hand-back.

**Deterministic race tests,** using an injected transport with barriers rather
than timing, and a fake browser that logs every frame it receives:

| Barrier held at | Then | Assert |
|---|---|---|
| Between dispatch and forward | `revoke` | Fake browser received 0; caller rejected |
| Between dispatch and forward | `suspend` | Same; after hand-back the command has still not run |
| Between dispatch and forward | socket drop | Same |
| N commands queued | `revoke` | All N rejected, 0 received |
| Old-generation frame arriving after a new lease | none | Refused, new lease unaffected |
| Reply to a forwarded command, after `revoke` | none | Not delivered |

The barrier lives in the test's transport; production code gets no hook or off
switch.

## 5. Policy (blocker 4)

**Default deny, for commands and for events.** Revision 1 kept the prototype's
event handling, which forwards anything not on a drop list, so a new Chromium
event would pass. Stage 1 changes that: an event not listed is dropped and
counted.

### Allowed commands (29)

```
DOM.describeNode
DOM.getContentQuads
DOM.resolveNode
DOM.scrollIntoViewIfNeeded
Emulation.setEmulatedMedia
Emulation.setFocusEmulationEnabled
Input.dispatchKeyEvent
Input.dispatchMouseEvent
Input.insertText
Inspector.enable
Log.enable
Network.enable
Page.addScriptToEvaluateOnNewDocument
Page.captureScreenshot
Page.createIsolatedWorld
Page.enable
Page.getFrameTree
Page.getLayoutMetrics
Page.getNavigationHistory
Page.navigate
Page.navigateToHistoryEntry
Page.setLifecycleEventsEnabled
Runtime.callFunctionOn
Runtime.enable
Runtime.evaluate
Runtime.getProperties
Runtime.releaseObject
Runtime.runIfWaitingForDebugger
Target.setAutoAttach
```

### Always denied

Prefixes `Fetch.`, `Storage.`, `SystemInfo.`, `Browser.`, plus:

```
Network.clearBrowserCookies
Network.deleteCookies
Network.getAllCookies
Network.getCookies
Network.getRequestPostData
Network.getResponseBody
Network.getResponseBodyForInterception
Network.searchInResponseBody
Network.setCookie
Network.setCookies
Network.setRequestInterception
Network.streamResourceContent
Network.takeResponseBodyForInterceptionAsStream
Page.setDownloadBehavior
Target.attachToTarget
Target.closeTarget
Target.createBrowserContext
Target.createTarget
```

`Browser.setDownloadBehavior` is answered `{}` and never applied.

### Allowed events

Seen forwarded in a full run of `poc-egress-and-lease.mjs` (31):

```
Inspector.workerScriptLoaded
Log.entryAdded
Network.dataReceived
Network.loadingFailed
Network.loadingFinished
Network.policyUpdated
Network.requestServedFromCache
Network.requestWillBeSent      (redacted)
Network.responseReceived       (redacted)
Network.webSocketClosed
Network.webSocketCreated
Page.domContentEventFired
Page.downloadProgress
Page.downloadWillBegin
Page.frameAttached
Page.frameClearedScheduledNavigation
Page.frameDetached
Page.frameNavigated
Page.frameRequestedNavigation
Page.frameScheduledNavigation
Page.frameStartedLoading
Page.frameStartedNavigating
Page.frameStoppedLoading
Page.lifecycleEvent
Page.loadEventFired
Page.windowOpen
Runtime.executionContextCreated
Runtime.executionContextsCleared
Target.attachedToTarget
Target.detachedFromTarget
Target.targetInfoChanged
```

Not seen in that run but likely needed by Playwright, each to be confirmed by a
test before it's added: `Inspector.targetCrashed`,
`Page.javascriptDialogClosed`, `Page.javascriptDialogOpening`,
`Page.navigatedWithinDocument`, `Runtime.consoleAPICalled`,
`Runtime.exceptionThrown`, `Runtime.executionContextDestroyed`.

**To review during implementation:**
- `Page.windowOpen`, `Page.frameRequestedNavigation`,
  `Page.frameScheduledNavigation` and `Network.webSocketCreated` carry URLs, and
  can name a destination the policy blocked. The history rule hides those, so
  these need the same treatment or a reason they don't.
- `Page.handleJavaScriptDialog` isn't allowed, so a dialog would stall the agent.
  Allow it, or have the device dismiss dialogs itself.

### Compatibility rule

- The lists live in one frozen module, and `POLICY_VERSION` is an integer.
- Any change to a list bumps the version, in a reviewed commit that says which
  Playwright or Chromium change required it.
- A snapshot test fails if a list changes without a version bump.
- A Playwright or Chromium upgrade never widens the lists automatically. CI runs
  the browser tests and reports refused methods and dropped events by name, so
  the upgrade fails visibly and someone decides.
- Grants and approvals carry `policyVersion`; a mismatch is refused, not
  negotiated.

## 6. Acceptance tests

Unit tests in vitest. Browser tests assert at counting servers.

- **P1:** every always-denied method and an unlisted method are refused, at the
  root and through a nested session, and never reach a fake browser. Named refusals
  for `Emulation.setGeolocationOverride` and `setUserAgentOverride`; a fabricated
  session id is refused. Unlisted events are dropped. **Control:** normal Playwright
  use records no refusals.
- **P2 (CLI-style path):** all of section 3's tests, plus agent navigation, link
  click, script navigation, form POST, 302 and iframe at 0 requests off-list;
  loopback, RFC 1918, `localhost` and IPv6 forms at 0 TCP accepts; `Fetch.disable`
  refused. **Control:** the same cases with no enforcer attached must reach the
  servers, or the test fails. The control composes the browser without the enforcer;
  production code has no off switch.
- **O1:** two users and two devices, through injected identities. No lookup by user
  alone, and section 2's forged and cross-user cases.
- **O2:** a second run and a second connection are refused while leased; suspended
  refuses commands until hand-back.
- **O3:** refused on replay on a second socket during a live lease, after a drop,
  after a new lease from a fresh approval, and after expiry. After a disconnect, a
  burned capability, a stale generation and an in-flight command each fail to regain
  control, and only a fresh approval works. A capability refused only for "tab leased"
  still works afterwards. Plus section 4's race tests.
- **R-A2:** back/forward with the back-forward cache on. **Control:** `waitUntil:
  'load'` hangs there.
- **Revert checks,** reported per commit, for the event filter, the resolved-address
  check, the WebRTC setting and fencing.

**CI.** `CHROMIUM` is set to a browser in the workflow, and browser tests **fail
rather than skip** when `CI` is set and none is found. CI has no browser step
today.

**Performance.** A measurement, with no target until there is a baseline: median
and p95 navigation latency, and per-request proxy overhead, baseline against
enforced, on the same browser and local site. Reported in the PR; no throughput
claim.

## 7. Excluded from stage 1

- The CLI, desktop and extension adapters, and P2 or P4 runs for desktop and the
  extension.
- The server's attach endpoint, routing, real nonce store, device registration and
  key storage.
- Consent UI, the Online indicator, privacy-profile enforcement (V1, V2, P3) and the
  proxy opt-out setting.
- S1 per trigger end to end. Stage 1 tests `revoke` only.
- Removing the hosted browser or `REMOTE_BROWSER_*`.
- Routing data, the truthful-outcomes proposal, the intranet opt-in and any resume
  protocol.

## 8. Other notes

- **History:** `goBack`/`goForward` aren't used in `src/` or `cloud/server/src`; only
  the desktop's `navigationHistory` has them. So R-A2 is a new helper and its test, not
  a change to an existing tool.
- **Gates:** R-A2 joins stage 1's gate and P4 joins the later stage gates, both
  supported by ChatGPT on 4 Nov (design §10).
