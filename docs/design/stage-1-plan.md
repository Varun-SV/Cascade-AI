# Stage 1 plan: relay contract library

Status: **implemented in `src/browser/relay/`, under review.** Revision 4. Varun
directed on 5 Nov that the complete stage 1 code goes in PR #338, with Claude and
ChatGPT reviewing until both state "Stage 1 implementation complete — agree" on the
same commit. Nothing here is approved until then. Section 9 lists what differs from
the earlier text and what's still a gap. The design is
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
- The server claims through an injected `NonceStore.claimOnce(grantNonce, exp)`,
  keyed by the grant so each grant yields one lease however many approvals exist,
  which must be an atomic insert visible to every server instance. Stage 2
  supplies the real store. Stage 1 ships an in-memory one and a contract test
  that any store must pass.
- The device keeps its own used set too, so it refuses a replay even if the
  server is compromised.

**Claim order.** Reserving the tab comes first, because it is local, atomic and
can't fail for outside reasons:

1. The device takes a synchronous `lease.reserve(tab)`. If the tab is reserved or
   leased, it refuses with "tab leased", without contacting the store. The nonce
   stays unused and the approval stays valid.
2. The server calls `claimOnce(nonce, exp)`. Exactly one caller wins.
3. On a win, the device adds the nonce to its used set and promotes the
   reservation to a lease with a new generation.

| Outcome of step 2 | Reservation | Nonce |
|---|---|---|
| Won | Promoted | Used |
| Already claimed | Released | Used; refused as a replay |
| Store says it did not insert (down, refused) | Released | Unused; retryable |
| Unknown (timeout, connection lost mid-call) | Released | Treated as used; takes a new approval |

The last row fails closed: a retry after an unknown result could otherwise claim
twice, so the user is asked again.

**Tests:**
- Simultaneous contenders, with barriers: two approvals for one tab, and one approval
  on two sockets. One lease results, and the losing approval still works afterwards.
- Each row of the table, using a store that fails on demand.
- **Cross-process contract test** that any store must pass: N forked processes race
  `claimOnce` on one nonce against a store shared between them, and exactly one wins.
  Stage 1's production store is in-memory and so can't pass this by nature; the test
  runs against a file-backed test store, so the contract exists before stage 2 needs it.

**When something is unavailable: fail closed.**
- The nonce store or a verifier being down refuses new claims, with a
  retryable error.
- A lease already claimed keeps running until its `exp` or a revoke, because
  the device enforces it locally and its claim is already recorded. Tests: with the
  store down, local expiry and revoke still end the lease, and no new approval can be
  claimed. Varun hasn't decided this yet.
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
--disable-quic
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
- QUIC, WebTransport, STUN and TURN, as below

**QUIC and WebTransport** (`poc-bypass-and-revoke.mjs`, 26/26 with the revoke and
dialog checks, Chromium 1243). A client sends its first packets whether or not a server
answers, so a counting UDP socket shows a leak without an HTTP/3 server.

| Case | No proxy (control) | With the plan's flags |
|---|---|---|
| WebTransport from page, iframe, dedicated, shared and service worker | 4–6 UDP packets each | 0 each; worker confirmed running |
| QUIC forced for an origin (`--origin-to-force-quic-on`) | 6 packets | 0 |
| TURN over UDP, proxy down | 6 packets | 0 |
| TURN over TCP, proxy down | 1 accept | 0 |

So no script-level removal of WebTransport is needed: the network layer stopped it in
workers too. `--disable-quic` stays as a second layer, though forced QUIC was already 0
with the proxy flags alone, and it is added to the launch arguments above.

**`Alt-Svc`** is covered in the vitest suite, with a control: with no proxy, and a locally
trusted CA, the header made Chromium send UDP to the advertised port, and behind the proxy it sent 0. No HTTP/3 server is
needed, as the first packets show the attempt.

**P2 gate.** Stage 1 can't pass P2 until these controls pass on the Chromium version
pinned in CI, in every context in the table. A path the tests don't cover fails closed
or is named as not covered; Cascade makes no claim of egress isolation for it.

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

**Revoke does not undo what has already started.** The fence stops new forwarding only.
Measured on Chromium 1243 (`poc-bypass-and-revoke.mjs`):

| After the session ends | Result at the server |
|---|---|
| A `Page.navigate` already written to the socket | Still happened (1 request) |
| A `setInterval` the agent set earlier | Kept sending (10 requests in 500 ms) |
| Then: navigate the tab to `about:blank` | Stopped (0), tab stays open |
| Or: close the target | Stopped (0) |

So detaching isn't enough, and this limit goes in the consent text and security docs.
Replies to earlier commands are dropped.

**What `revoke` does,** in order: change the fence, reject the queue, end the page's
activity, then detach. Ending the page's activity:
- **CLI:** close the target. It's a dedicated profile, so the tab isn't the user's.
- **Desktop and extension:** the tab is the user's, and S1 says it stays open, so closing
  it isn't available. `about:blank` stops the script but loses their page. Stage 1 takes
  this as a parameter and tests both; the choice is Varun's, before stage 2.

The request policy and the proxy stay in place until this step finishes.

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
| A timer set before `revoke` (real browser) | `revoke` | 0 requests at the server afterwards |

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

### Dialogs

**The device dismisses them; `Page.handleJavaScriptDialog` stays off the list.** An
unanswered `alert()` blocks the agent's command. A privileged device session answering
with `accept: false` freed it: `alert` returned, `confirm` returned `false`, `prompt`
returned `null`, and the agent saw neither the dialog nor its text.

The cost is that the agent can't accept a dialog, so a flow that needs "OK" on a
`confirm` fails. That is the safer default for an action the user hasn't seen. Dialog
events stay dropped, and `beforeunload` needs its own test.

### Allowed events

**Default deny at three levels:** event name, field and URL. The same filter runs on every
session, nested ones included, and on replies that carry URLs (`Page.getFrameTree`,
`Page.getNavigationHistory`). Events from a session on a site without consent are dropped.
An event isn't added because Playwright asks for it; it's added when a test shows what
breaks without it and its fields have been reviewed.

**Why this is needed.** In a full prototype run, frames naming an off-list or private
destination reached the agent from `Network.requestWillBeSent` (11), `Page.windowOpen` (13),
`Page.frameStartedNavigating` (6), `Page.frameNavigated` (7), `Network.responseReceived` (5),
`Page.frameRequestedNavigation` (4) and `Page.frameScheduledNavigation` (3). Some of these are
public subresources the design allows and some are the blocked cases; I didn't separate them.
The prototype's "0 requests" results stand, but the agent can learn a blocked URL from these.

**URL rule,** applied to every URL field in an allowed event:

| Destination | Treatment |
|---|---|
| Consented origin | Kept, without any `user:password@` |
| Public subresource on another origin (allowed by §4.3) | Origin and path only; query and fragment removed |
| Blocked, private without consent, or not http(s) | The whole event is dropped |

**Limit:** on a consented page, the agent can still read much of this through `evaluate`
(`location`, `performance.getEntries()`), as §4.3 states. The filter stops the event stream
disclosing things, in particular URLs the page never got to load. It doesn't hide what the
page can read.

**Allowed fields.** A field not listed is removed. `url` means the URL rule applies, and
each of these also carries its own `frameId`, `loaderId`, `requestId` and timestamps.

| Event | Other allowed fields |
|---|---|
| `Network.requestWillBeSent` | `request.url`, `request.method`, `type`, `documentURL` (`url`), `redirectResponse` as below; `request.headers` per the header rule; no `postData`, `postDataEntries` or `initiator` |
| `Network.responseReceived` | `response.url`, `response.status`, `response.mimeType`, `type`; `response.headers` per the header rule; no `securityDetails`, `remoteIPAddress` or `headersText` |
| `Network.loadingFailed` | `type`, `canceled`; only when the request was forwarded; no `errorText` for a blocked request, because it names the policy |
| `Network.dataReceived`, `loadingFinished`, `requestServedFromCache` | Sizes only |
| `Network.webSocketCreated` | `url` |
| `Network.webSocketClosed` | None |
| `Page.frameAttached`, `frameDetached`, `frameStartedLoading`, `frameStoppedLoading`, `frameClearedScheduledNavigation`, `lifecycleEvent`, `domContentEventFired`, `loadEventFired` | Ids and names |
| `Page.frameNavigated` | `frame.id`, `frame.parentId`, `frame.url`, `frame.urlFragment`, `frame.securityOrigin` (`url`); no `unreachableUrl` |
| `Page.frameRequestedNavigation`, `frameScheduledNavigation`, `frameStartedNavigating` | `url`, `reason` |
| `Page.downloadWillBegin`, `downloadProgress` | `url` only on the first; no `suggestedFilename` |
| `Runtime.executionContextCreated` | `context.id`, `context.origin` (`url`), `context.auxData` |
| `Runtime.executionContextsCleared`, `Inspector.workerScriptLoaded` | None |
| `Target.attachedToTarget`, `detachedFromTarget`, `targetInfoChanged` | `sessionId`, `targetInfo.targetId`, `targetInfo.type`, `targetInfo.url` (`url`), `waitingForDebugger` |

**Header rule:** an allowlist, not a removal list: `content-type`, `content-length`, and
`location` with the URL rule. Everything else is removed, credential headers included.

**Removed from the list since revision 2:**
- `Page.windowOpen`: a second page is always closed, and this names where it was going.
- `Log.entryAdded` and `Network.policyUpdated`: log text can name a blocked URL, and neither
  is needed to drive a page. `Log.enable` is answered without being applied.

**Stays denied:** `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, and the dialog events.
Page script can write anything to the console, and enabling them later needs its own review.

**May be added if a test shows the need:** `Inspector.targetCrashed`,
`Page.navigatedWithinDocument` (`url`), `Runtime.executionContextDestroyed`.

**Regression test.** Trigger blocked private and cross-origin destinations, through each of
navigation, redirect, `window.open`, WebSocket, iframe and a nested session, using URLs with a
unique marker in the path, query, fragment and userinfo, plus a unique cookie, `Authorization`
header and POST body. No frame to the agent, on any session, contains any marker. **Control:**
with the filter off, the markers do appear. Playwright must still drive normal pages with the
filter on; any breakage shows here, and is the case for adding an event or field.

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
  check, the WebRTC setting, fencing and revoke's page step.

**CI.** `CHROMIUM` is set to a pinned browser version in the workflow, and browser tests **fail
rather than skip** when `CI` is set and none is found. CI has no browser step
today.

**Performance.** Measurements, with no target or overhead claim until there is a
baseline: median and p95 navigation latency, per-request proxy overhead, proxy CPU and
memory, connection count, and how long failure and recovery take, baseline against
enforced, on the same browser and local site. Reported in the PR before the adapter
stage. The unused library adds no production overhead in stage 1.

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

## 9. As built

**Where the code differs from the text above**

- **Headers:** only `content-type` and `content-length` pass. `location` is dropped
  rather than filtered, as nothing needed it.
- **`initiator`:** `Network.requestWillBeSent` keeps `initiator.type` alone, which
  Playwright reads. Its URL and stack are removed.
- **Fields removed in review (policy version 2):** `urlFragment`, frame `name`,
  `domainAndRegistry` and target `title`. `auxData` is reduced to `isDefault`, `type` and
  `frameId`. `statusText` is blanked, as Playwright needs the field to exist. A consented URL
  still keeps its fragment under the URL rule, as `location` shows it to the page anyway.
- **Child targets:** every setup step must succeed before a target resumes, or it stays paused and
  is closed. Only a dedicated worker may lack its own interception; the test asserts the block in the
  policy's own log for each worker type, not only at the proxy.
- **Fields added after testing:** `Page.documentOpened`, `Page.navigatedWithinDocument`,
  `Runtime.executionContextDestroyed` and `Inspector.targetCrashed`. A blocked-field
  test covers each URL they carry.
- **ExtraInfo flags** are forced to `false`, as nothing forwards those events and
  Playwright would otherwise wait for ever.
- **Workers on revoke:** a shared or service worker outlives a navigation, so
  `endPageActivity` closes them first, in either mode. Tested with a service worker's timer.
- **Frame ids** must rise on a connection. A lower one fails closed, like a malformed
  frame. This stands in for the sequence numbers in design §5.

**Known limits**

- **Playwright's `page.setContent` hangs over the relay.** It waits for a console message,
  and console events stay denied. Nothing in `src/` calls it today. Stage 2 must keep it that
  way, or decide otherwise deliberately.
- **Dialogs can't be accepted** by the agent. `beforeunload` is the exception, which the device
  accepts so a page can't hold itself open through a revoke. If leaving still doesn't finish in 3 s,
  revoke closes the tab.
- **A command already written can't be recalled.** Revoke then ends the page's activity,
  so the tab doesn't stay on what it did.
- **A page that doesn't answer loses its tab, in either mode.** A spinning page answers no CDP call,
  so every step of revoke's page step is bounded. If `about:blank` isn't reached in 3 s the tab is
  closed, and if an agent's new-document script can't be removed in 1 s it's closed straight away, as
  that script would run on `about:blank` too. This bears on Varun's revoke decision for the user's own tab.
- **Consented pages can read much of this anyway** through `evaluate`, as §4.3 states.

**Known gaps**

- **IPv6 at the destination:** a real server on `::1` is asserted on CI, with a no-proxy control. The
  test fails on CI if `::1` can't be bound, and skips only elsewhere, because some sandboxes have no IPv6.
- **The real nonce store,** device keys and server endpoint are stage 2. O1 is proved at
  library level only.
- **The browser suite grants its lease directly.** `capability.test.ts` runs the real grant,
  approval, claim and lease together; a server connecting them to a live relay is stage 2.
- **Open for Varun:** tab behaviour on revoke for desktop and extension, and whether leases
  survive a store outage.

**Measurements** (`docs/design/poc/tab-cdp-relay/measure-relay.ts`, Chromium 1243, one local run on this sandbox,
local site with no real network, so a comparison and not a bound):

| Measure (ms) | Baseline median | Baseline p95 | Enforced median | Enforced p95 |
|---|---|---|---|---|
| Navigation | 26.72 | 41.13 | 40.25 | 60.99 |
| Fetch | 1.90 | 3.10 | 4.10 | 6.10 |

- Device process during the enforced run, including the script's own CDP client: 21.9% of one core
  over 3.4 s; RSS 106.8 MB before, 111.7 MB after.
- 463 proxy decisions and 640 policy decisions in that run.
- Proxy close noticed in 2.11 ms; ending page activity 15.29 ms; a new proxy and browser through
  the canary 487 ms.

**Correction:** an earlier revision had no `Alt-Svc` control. With a self-signed certificate and
`--ignore-certificate-errors`, Chromium 1243 sent no UDP after the header. With a certificate from a
CA trusted in a throwaway browser profile it did, so the control now uses that. CI installs
`certutil` for this, and the tests fail on CI without it.

**Revert checks run on the final code,** each failing as it should with the guard removed: the
unlisted-event filter, both fence checks (5 race tests), the resolved-address check, both WebRTC
layers together (one alone still holds, by design), revoke's page step (2 tests), closing
workers, accepting `beforeunload`, bounding the page step (the revoke never finishes without it) and
closing when a script can't be removed. A first version of the worker test, using a shared worker, passed with the guard removed,
because a shared worker dies with its last page, so it was replaced.
