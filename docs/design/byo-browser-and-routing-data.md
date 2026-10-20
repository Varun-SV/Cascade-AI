# Bring-your-own browser, and routing data for users

Status: **design for review**, revision 2 (council: discussion #315, review
on PR #316 as inline comments). Q1–Q5 decided by the maintainer.
No feature code lands until the design is agreed.

Revision 2 answers ChatGPT's review on #316:
- **A:** the tab-level adapter has been prototyped against Playwright (§3.3).
- **B:** the privacy promise is replaced by an explicit egress list and
  command contract (§4).
- **C:** ownership, the browser lease and fail-closed rules are now
  acceptance criteria (§5, §9).
- **D:** aggregation protections are added (§8).
- **E:** staged delivery behind flags (§10).

## 1. Decisions already made by the maintainer

- Browser control stays available to **every** user, free or paid.
- The platform **does not host browsers** for cascadeai.in users. Each user
  brings their own. Misuse then originates from the user's own browser. This
  removes Cascade's hosted-browser infrastructure. It does **not** remove
  Cascade's responsibility for what its runs do with the user's browser
  (§4).
- Four ways to bring a browser, all chosen and configured in **Settings**:

  | | Source | Order |
  |---|---|---|
  | A | Desktop app's built-in browser, or a browser the CLI launches, relayed to the cloud | first |
  | B | A browser extension for cascadeai.in that drives the user's own Chrome | first |
  | C | A CDP endpoint the user runs (Steel, Browserless, Chrome) | later |
  | D | Hand the run to the user's desktop app, which runs it locally | later |

- Users get to see routing and spend data: which model ran at which tier,
  cost, time and outcome. Tabs: **All / Cloud / Desktop / CLI**, each with
  **You / Everyone**.

## 2. One attach boundary on the server

The cloud server already attaches browsers through `GenericCdpProvider`
(`src/browser/remote/provider.ts`, `cloud/server/src/remote-browser.ts`).
Every source ends at that **boundary**: the browser tool, page views,
approvals and run cleanup see one CDP endpoint, whatever is behind it.

What sits behind the boundary is new code. It is not an unchanged reuse.

```
                cascadeai.in (Railway)
  run ──► RemoteBrowserController ──► GenericCdpProvider ──► per-run endpoint
                                                               │
                                     policy + lease (§4, §5) ──┤
          ┌────────────────────────────────────────────────────┤
          │ A/B: relay (outbound WSS from the user's device)   │ C: user URL
          ▼                                                    ▼
  desktop app / CLI / extension                     user's Steel / Chrome
```

## 3. The relay (A and B)

### 3.1 Transport

- **Direction:** the user's side always dials out to
  `wss://cascadeai.in/api/browser-relay`. Nothing on the user's machine
  listens on a public port.
- **Auth:** see §5.
- **Per run:** the server gives the run a one-time endpoint that pipes CDP
  frames to the relay. It closes when the run ends (keyed by task id, as
  `remote-browser.ts` already does).

### 3.2 CDP shape per source

Playwright's `connectOverCDP` expects a browser-level endpoint (the `Target`
domain).
- **CLI:** launches Chrome or Chromium with a dedicated profile and
  `--remote-debugging-port` bound to 127.0.0.1. It relays the real browser
  endpoint, so no adapter is needed.
- **Desktop:** `webContents.debugger` is tab-scoped, so it needs the adapter
  in §3.3.
- **Extension:** `chrome.debugger` is tab-scoped, so it needs the same
  adapter.

The adapter is shared as a **protocol contract** (the browser-level methods
and session rules below), not as one transport-specific implementation.

### 3.3 Prototype result: tab-scoped CDP behind Playwright

`docs/design/poc/tab-cdp-relay/poc.mjs` connects to **one page target's**
WebSocket, which stands in for a tab-scoped debugger. It presents that tab
to Playwright 1.64.1 as a browser through a relay and drives it. **18 of 18
checks pass.** It is a protocol prototype. Its policy is only a deny set, so
it is **not** evidence for the security contract. That is
`poc-egress-and-lease.mjs` (§4.2, §4.3), which uses a default-deny
allowlist.

**Browser-level methods Playwright sent, and how the relay answers:**

| Method | Relay answer |
|---|---|
| `Browser.getVersion` | fixed version object |
| `Target.setAutoAttach` (no session) | `{}`, then emits `Target.attachedToTarget` for the one tab under a synthetic session id |
| `Browser.setDownloadBehavior` | `{}`, **not applied**: the agent cannot configure downloads. Preventing downloads is the policy's job (§4.1) |
| `Target.getTargetInfo` | the tab's target info |

Everything else carries a session id:
- **The synthetic tab session:** stripped and forwarded to the tab.
- **Nested sessions** (iframes, workers): passed through unchanged.

This is four methods. Extension relays built on Playwright MCP handle
the same four.

**Worked through the relay:**
- navigate
- fill, select, click
- console events
- `evaluate`
- same-origin iframe content
- accessibility snapshot (page views)
- screenshot
- link navigation with `waitForURL`
- history back

Playwright used 25 tab-level methods across Page, Runtime, DOM, Input,
Emulation, Network, Log, Inspector and `Target.setAutoAttach` (for child
frames). This is the allowlist baseline in §4.2.

**Refused, by design:**
- `context.newPage()`: `Target.createTarget` is denied, which enforces the
  single-tab lease.
- `context.cookies()`: `Storage.getCookies` is denied.

**Stop:**
- Closing the tab connection rejected an in-flight command in **8 ms**.
- Playwright reported disconnected.
- The user's tab survived.

**Two findings that change the design:**
1. **History back/forward hangs with `waitUntil: 'load'`.** In a browser
   Playwright did not launch, the back-forward cache restores the page
   without a load event. This is **not** caused by the relay: a direct
   `connectOverCDP` without the relay hangs the same way. Cascade's browser
   tool must navigate history with `waitUntil: 'commit'` and then wait for
   content.
2. **Method filtering cannot stop page script.** With cookie APIs denied,
   `Runtime.evaluate('document.cookie')` still returned the non-HttpOnly
   cookie. Playwright cannot work without `Runtime.evaluate` and
   `Runtime.callFunctionOn`. So §4 does not claim that filtering protects
   page data. The real controls are origin scope, consent and a separate
   profile.

**Not yet proven:**
- `chrome.debugger` refuses some pages (`chrome://`, the Web Store) and may
  refuse some methods.
- An MV3 service worker can be suspended, which drops the WebSocket.
- `webContents.debugger` has its own attach/detach lifecycle.

Each needs its own smoke test with the same 18 checks before its source
ships (stage 2 and 3 gates, §10).

## 4. What leaves the user's device, and the command contract

### 4.1 Egress: what actually leaves the device

While a run controls the user's browser, the following can leave the
device. It goes to the relay, then the Cascade server, then the model
provider the user chose:

| Data | When | Goes to |
|---|---|---|
| Page URLs and titles | every navigation | relay, server, model |
| Page text and the accessibility tree (page views) | each observation | relay, server, model |
| Form field values | only as the run's own typed input; page views redact values typed into fields | relay, server |
| Screenshots | when `browserVision` is `image` or `marked` | relay, server, model |
| Results of script the run evaluates (`evaluate`) | each call; can include anything page script can read, e.g. non-HttpOnly cookies, `localStorage` | relay, server, model |
| Console messages and errors | while attached | relay, server |
| Downloads | **prevented** while a run holds the lease: no file is written to the user's disk, and no bytes go to the cloud (see below) | — |

**Downloads during a lease are prevented, not just unrelayed.** Covered:
link, attachment, `blob:`/`download` attribute and script-triggered
downloads, enforced on the device:

| Source | Mechanism |
|---|---|
| CLI | the policy's own browser-level session sets `Browser.setDownloadBehavior: deny` for the lease and restores it after |
| Desktop | the built-in browser's session cancels every `will-download` while leased |
| Extension | `chrome.downloads.onCreated` cancels and erases downloads that start while a lease is held, with a notice |

The extension cannot always tie a download to a tab, so while a lease is
held it may also cancel a download the user starts in another tab. The
notice says so. `poc-egress-and-lease.mjs` checks the CLI path: with
downloads allowed, an attachment writes a file (the control). During the
lease, an attachment, a `blob:` link and a script-made `download` link
write **0 files**.

**Where the user sees it (decided, Q5):**
- **Consent prompt:** shows this full list in plain words the first time a
  run uses a site. It shows it again whenever a run turns on screenshots, or
  the privacy profile moves to a looser one. Otherwise it links to the list.
- **Always-visible indicator:** whenever data from the user's browser is
  being sent off the device, an "Online" indicator stays visible. It's on
  the cascadeai.in chat, the desktop app's browser bar and the extension
  icon. Hovering (or focusing it, for keyboard and screen-reader users)
  lists **which** of the categories above this run is sending right now,
  e.g. "URLs, page text, screenshots". Not the full list, and never the data
  itself. The indicator turns off as soon as the relay detaches.
- **Settings:** shows the full list per source.

The privacy
profile (Strict / Controlled abstraction / Explicit approval) applies at each
egress point:

| Profile | Rule |
|---|---|
| Strict | No cloud runs on the user's browser. Only D (run on desktop) is offered. |
| Controlled abstraction | Screenshots off. `evaluate` results are size-capped and redacted for token-like strings. |
| Explicit approval | Each screenshot and each `evaluate` returning more than a size cap asks the user. |

### 4.2 Command contract (enforced on the user's device)

The policy runs **on the device**, in the desktop app, CLI or extension,
before a command reaches the browser. A compromised or buggy server
therefore cannot widen it. The server runs the same check as defence in
depth.

- **Default-deny allowlist of exact methods** (never wildcards such as
  `Emulation.*`):
  - It's an explicit set reviewed with the code. It starts from the methods
    Playwright used in §3.3 plus those the page-view and vision code need.
  - A command is forwarded only if its method is on the list **and** its
    session id is the tab's or a nested session the tab announced
    (frames, workers).
  - Anything else is refused and logged, at the root or in a nested
    session.
  - Parameters are validated where they carry side effects:
    `Page.navigate` URLs go through §4.3, and `Input.*` must target the
    leased tab.
  - Changing the list is a reviewed policy change with a version number.
  - Method names alone don't express side effects. `Runtime.evaluate`
    stays privileged page script by design (§4.3, honest limit).
  - `poc-egress-and-lease.mjs` checks all of this (27/27):
    - an allowlisted method works on a nested cross-site iframe session
    - `Emulation.setGeolocationOverride` through that nested session is
      refused
    - `Emulation.setUserAgentOverride` is refused
    - a fabricated session id is refused
    - normal Playwright use hit no allowlist refusals
- **Always denied:**
  - cookie and storage reads and writes (`Network.getCookies`,
    `getAllCookies`, `setCookie(s)`, `deleteCookies`,
    `clearBrowserCookies`; `Storage.getCookies`, `setCookies`,
    `clearCookies`, `clearDataForOrigin`)
  - `Target.createTarget`, `closeTarget`, `attachToTarget`,
    `createBrowserContext`
  - `Page.setDownloadBehavior` (`Browser.setDownloadBehavior` is answered
    `{}` and never applied)
  - `SystemInfo.*`
  - `Fetch.*` and `Network.setRequestInterception`. They're the way to
    read or rewrite authenticated traffic, and the policy itself uses
    `Fetch` (below), so the agent must not be able to turn it off.

### 4.3 Request-level egress enforcement (enforced on the user's device)

Blocking the agent's next command is too late: a click, a form, page script
or a redirect has already sent the request. So the policy stops **requests**,
before they leave the browser, through its own privileged channel. The agent
can neither see nor disable that channel:

| Source | Mechanism |
|---|---|
| CLI | The policy's own CDP session on the tab: `Fetch.enable` for every URL at the **Request** stage |
| Desktop | `session.webRequest.onBeforeRequest` on the built-in browser's partition, in Electron's main process |
| Extension | `declarativeNetRequest` session rules scoped to the leased tab; `Fetch` through `chrome.debugger` as a fallback |

**Rules, applied to every request before it is sent:**

| Request | Rule |
|---|---|
| Document (top-level navigation or iframe), any initiator: agent command, click, form, page script or redirect hop | Allowed only to a **consented origin**. Otherwise failed before sending |
| Any request to a **private-network destination** (loopback, RFC 1918, link-local, CGNAT, unique-local IPv6, `localhost`, `*.local`) | Failed unless that exact origin was consented |
| Subresources (script, style, image, font, fetch/XHR, WebSocket) to **public** origins | **Allowed** |

**Hostnames:** the policy resolves the name on the device and checks the
resulting address. It pins that address for the request (CLI and desktop),
which defends against DNS rebinding. The extension cannot resolve names
itself; it relies on Chrome's Private Network Access checks for that part,
and the doc says so.

**What is guaranteed, and what is not.** This is not network egress
isolation:
- **Guaranteed:** a leased tab cannot navigate, frame or be redirected to a
  site the user did not consent to. It cannot reach the user's private
  network unless the user consented that origin.
- **Not guaranteed:** a consented page, or the agent through `evaluate` on
  it, can still send data to public third-party hosts as subresource
  requests. Cascade cannot tell page script from agent script, and blocking
  public subresources breaks most sites.
- **The real limits on that:** the consent list (which pages the run may
  be on), the egress list (§4.1), and the "Online" indicator.

`poc-egress-and-lease.mjs` checks this with servers that count the requests
they receive. An off-list server saw **0 requests** for each of the
following:
- agent navigation
- a link click
- `location.href`
- a form POST
- a 302 redirect from a consented site
- an iframe

A `fetch` to a 127.0.0.1 address was failed by the policy, not merely by
the browser. A public script from a non-consented origin loaded, which is
the stated limit. `Fetch.disable` from the agent was refused.

- **Honest limit (page data):** page script reachable through
  `Runtime.evaluate` can read what the page can (§3.3, finding 2). The
  contract limits which pages a run can be on, not what is readable on a
  page it is allowed to be on.

## 5. Ownership, lease and stop

**Capabilities:**
- Per user, per device, per run.
- A device registers with the user's account. It is the existing native
  sign-in for desktop and CLI, and a short-lived token minted from the web
  session for the extension.
- A run receives a **run capability**: a signed, single-use token naming
  user, device, run id and expiry (≤ the run's budget time, max 30 min,
  renewable while the run is active).

**Single use, and no resume (model (a)):**
- A capability opens **one** connection and **one** lease. It is consumed
  when claimed, and burned when that connection ends for any reason.
- A dropped connection is **never resumed**. The run sees a disconnect.
- Getting control back needs a **new capability**, which the device mints
  only after the user approves the run again, with the same consent prompt.
  A bounded resume protocol (reconnect credentials, generation tokens) is
  deferred until there's evidence drops are common enough to need it.
- A connection refused only because the tab is leased does **not** consume
  its capability.
- Each lease has a generation number. Frames from an older generation are
  never served (fencing).
- Capabilities carry a nonce. The used set is kept until expiry.
- Relay frames carry a monotonically increasing sequence number per
  connection.

**Lease:**
- A device grants **one exclusive lease** per browser tab.
- A second run, or a second connection for the same run, is refused while a
  lease is held.
- **Human takeover:** when the user interacts with the tab or presses Take
  over, the device suspends the lease. Commands are refused until the user
  hands back control.

**Fail closed.** Each of the following revokes the lease, rejects in-flight
commands and detaches the debugger, all on the device:
- Stop
- logout
- token rotation
- device unregistered
- network drop
- tab closed
- run ended
- capability expired

**Routing:**
- The server maps a run capability to exactly one device connection.
- There is no lookup by user alone, so user A's run cannot be routed to user
  B's device.
- There are no reconnects with an old capability (see Single use). A
  burned, revoked or expired capability is never admitted.

## 6. Settings

`Settings → Browser`:

- **Source:** `None` (default) · `Desktop app` · `CLI` · `Extension` · `My CDP endpoint` · `Run on my desktop`
- **Per source:** connection status, last seen, the site allowlist, and the
  egress list from §4.1 in plain words.
- **`My CDP endpoint`:** URL and token, stored encrypted, never logged.

## 7. The hosted browser

- cascadeai.in stops attaching an operator-provided browser.
- **Decided (Q1):** the `REMOTE_BROWSER_*` operator path is removed
  entirely, self-host included. Every deployment uses per-user browser
  settings (sources A–D).
- The daily browser-session allowance existed to ration billed hosted
  sessions. With BYO there is nothing to bill, so it goes.

## 8. Routing and spend data for users

- **Source of truth:** the per-run spend ledger from #305 (`spend_ledger`,
  `spend_ledger_models`) plus each reply's stored /why report.
- **Show now:**
  - which model ran at each tier
  - cost, tokens and time
  - each agent's final status
  - failovers
- **Hold back until truthful outcomes exist:**
  - learned success rates
  - task-type labels
  - any success-rate comparison between models

  Spend accounting does not depend on that work. Performance claims do.
- **You:** computed from the user's own rows.
- **Everyone:** aggregated across users, with these protections:
  - **Minimum cell:** at least 20 outcomes from at least 5 users.
  - **Complementary suppression:** if hiding one cell lets a total minus the
    visible cells reveal it, a second cell is hidden too.
  - **Immutable, non-overlapping releases.** Rolling windows don't stop
    differencing: windows released on successive days overlap, and their
    difference can reveal one boundary day. So Everyone is published only
    as closed calendar buckets (ISO weeks; months built only from published
    weeks):
    - each bucket is released once, after it closes, and **never revised**
    - late data for a closed bucket is dropped from Everyone, not
      back-filled
    - there are no rolling windows and no free-form filters
  - **Suppression across every released cut.** A cell is suppressed when it
    is under the minimum, or when it could be derived by subtraction from
    any combination of released cells: across dimensions and across
    buckets. That includes totals and any longer-range figure, which are
    built only from released, unsuppressed cells.
  - **Later option:** a formal privacy budget with calibrated noise, if
    Everyone ever needs finer cuts. Not in v1.
  - **Gate:** this is a blocker for publishing Everyone, not for the private
    You tabs.
  - **Provenance kept separate:** synced runs, opt-in desktop/CLI aggregates
    and cloud runs are stored and counted separately. Opt-in uploads are
    rate-limited per device and checked against plausible ranges. A device
    whose uploads fail the checks is excluded and flagged for review.
- **Desktop / CLI:**
  - Their personal tabs are computed locally, with no upload.
  - Runs a user syncs to their account arrive through `cloudRunReport`
    (#305).
  - **Decided (Q2):** unsynced desktop/CLI runs contribute aggregates to
    Everyone only if the user opts in. Off by default.
- Each ledger row gains `surface: cloud | desktop | cli`.

## 9. Acceptance criteria

**Relay and adapter**
- **R-A1.** The 18 checks in `poc.mjs` pass on an **uninterrupted** session
  against:
  - the desktop app's `webContents.debugger` adapter
  - the Chrome MV3 extension's `chrome.debugger` adapter
  - the CLI's browser endpoint
- **R-A3 (extension lifecycle, fail closed).** Covers service-worker
  suspension or a `chrome.debugger` detach mid-run:
  - the device detaches
  - in-flight operations reject
  - later same-run operations reject
  - the lease and capability are invalidated
  - there is **no automatic reattach**
  - control returns only after a new user approval

  Cascade receives a clear, recoverable error. This is a separate test from
  R-A1.
- **R-A4.** Attaching to protected Chrome pages (`chrome://`, the Web Store)
  is refused cleanly, with a message to the user and no partial lease.
- **R-A2.** History navigation uses `waitUntil: 'commit'`. A back/forward
  test passes with the back-forward cache enabled.

**Policy and egress**
- **P1.** Default deny:
  - every always-denied method, and every method **not** on the allowlist,
    is refused and never reaches the browser
  - this holds at the root and through nested sessions
  - commands on unknown session ids are refused
  - `Emulation.setGeolocationOverride` and `setUserAgentOverride` are
    refused by name (tests)
- **P4.** No download writes a file while a lease is held: link,
  attachment, `blob:` and script-triggered. There's a control test proving a
  download is detectable when allowed. Run on each source.
- **P2.** No request reaches a non-consented origin for each of: agent
  navigation, link click, script navigation, form submission, server
  redirect, and iframe. The test asserts the destination server saw 0
  requests. No request reaches a private-network address unless consented.
  The agent cannot disable the policy's interception. Run on each adapter.
  Today `poc-egress-and-lease.mjs` covers the CLI-style path (a
  privileged CDP session); desktop and extension need their own runs.
- **P3.** Under Strict, no cloud run can attach (test). Under Controlled
  abstraction, screenshots are off (test).

**Ownership**
- **O1.** A run capability for user A can never reach user B's device (test
  with two users, two devices).
- **O2.** A second run is refused while a lease is held. Human takeover
  suspends the lease (test).
- **O3.** A capability is refused when:
  - replayed on a second socket while its lease is live
  - presented again after its connection dropped
  - presented after a new lease was issued from a fresh capability
  - expired

  A capability refused only because the tab was leased stays usable (test;
  covered for the relay in `poc-egress-and-lease.mjs`).

**Stop**
- **S1.** Each of Stop, logout, token rotation, network drop, tab close, run
  end and expiry:
  - rejects in-flight commands within 1 s
  - detaches the debugger
  - leaves the user's tab open (test per trigger)

**Visibility**
- **V1.** The "Online" indicator is visible on every surface while any
  category above is being sent. Its hover/focus text names exactly the
  categories in use. It clears within 1 s of detach (test per surface).
- **V2.** The consent prompt shows the full list on first use per site, on
  enabling screenshots, and on a move to a looser privacy profile, and not
  otherwise (test).

**Desktop**
- **E1.** A manual Electron 41 smoke test: app start, the built-in browser,
  terminal (`node-pty`), local history (`better-sqlite3`), and
  sign-in/sync.

**Routing data**
- **D1.** The All / Cloud / Desktop / CLI tabs match ledger totals exactly.
- **D2.** Everyone cells under threshold are hidden, and so are their
  complements (test).
- **D3.** Releases are immutable, non-overlapping buckets (test).
- **D4.** A differencing attack fails. The test queries the same metrics as
  published on successive days and across every released cut, and cannot
  recover a suppressed small cohort.

## 10. Delivery: stages and flags

Each stage is separate commits with its own tests, behind a flag that is
off by default:

| Stage | Contents | Flag | Gate |
|---|---|---|---|
| 0 | Dependency updates, #305 (done) | — | CI green; E1 manual smoke test |
| 1 | Threat model, command contract and lease library, with tests; history `commit` fix | — | P1, O1–O3 at library level |
| 2 | A: CLI relay, then desktop adapter | `browser.relay.cli`, `browser.relay.desktop` | R-A1 (CLI, desktop), S1, P2, P3 |
| 3 | B: Chrome extension | `browser.relay.extension` | R-A1 (extension), S1 incl. service-worker restart |
| 4 | Remove hosted browser and `REMOTE_BROWSER_*`; drop the allowance | — | no remaining references; self-host docs updated |
| 5 | `surface` on ledger rows; You tabs; opt-in Everyone with protections | `insights.everyone` | D1–D3 |
| 6 | C and D | per source | R-A1 against each |

Independent review happens per stage, from the diff and tests rather than
the implementer's summary. If the combined PR grows too large to review
well, stages 2+ can be split into stacked PRs. That's the maintainer's
call.

## 11. Open questions

Decided by the maintainer (21 Oct 2026):

- **Q1.** Remove `REMOTE_BROWSER_*` entirely, self-host included.
- **Q2.** Desktop/CLI aggregates to Everyone: opt-in.
- **Q3.** Desktop source: the built-in `WebContentsView`, through the
  shared tab-level adapter.
- **Q4.** Extension: **Chrome first**, behind a browser-agnostic interface.
  Other Chromium browsers are claimed only after their debugger permission,
  service-worker lifecycle and attach/detach behaviour are tested.
- **Q5.** The full list is shown in the consent prompt on first use per site
  and on screenshots or a looser profile. Plus an always-visible "Online"
  indicator whose hover lists which data is leaving the device (§4.1).

No open questions remain. The next gate is agreement on stage 1 (§10).
