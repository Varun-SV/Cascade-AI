# Bring-your-own browser, and routing data for users

Status: **design for review** (council: discussion #315). No feature code lands
until the open questions below are settled.

## 1. Decisions already made by the maintainer

- Browser control stays available to **every** user, free or paid.
- The platform **does not host browsers** for cascadeai.in users. Each user
  brings their own. Misuse then originates from the user's own browser, and
  page data stays on the user's machine or infrastructure.
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

## 2. One attach path on the server

The cloud server already attaches browsers through `GenericCdpProvider`
(`src/browser/remote/provider.ts`, `cloud/server/src/remote-browser.ts`).
Every source ends at that seam, so the browser tool, page views, approvals
and run cleanup stay as they are.

```
                cascadeai.in (Railway)
  run ──► RemoteBrowserController ──► GenericCdpProvider ──► CDP endpoint
                                                               │
          ┌────────────────────────────────────────────────────┤
          │ A/B: per-user relay (outbound WSS from the user)   │ C: user URL
          ▼                                                    ▼
  desktop app / CLI / extension                     user's Steel / Chrome
```

The new pieces are the **relay** and the **per-user browser setting**.

## 3. The relay (A and B)

- **Direction:** the user's side always dials out to
  `wss://cascadeai.in/api/browser-relay`. Nothing on the user's machine
  listens on a public port.
- **Auth:** desktop and CLI reuse the existing native sign-in (refresh
  tokens in `native_refresh_tokens`). The extension uses a short-lived token
  minted from the signed-in web session. Every connection is bound to one
  user. A run can only attach that user's relay.
- **Per run:** the server gives the run a one-time local endpoint that pipes
  CDP frames to the relay. It is closed when the run ends (task id, as
  `remote-browser.ts` already does).
- **CDP shape.** Playwright's `connectOverCDP` expects a browser-level
  endpoint (the `Target` domain). Two of the sources only expose tab-level
  CDP:
  - **CLI:** launches Chrome or Chromium with a dedicated profile and
    `--remote-debugging-port` bound to 127.0.0.1, then relays the browser
    endpoint as is. Simplest.
  - **Desktop:** the built-in browser is a `WebContentsView`.
    `webContents.debugger` speaks tab-level CDP, so the relay needs a small
    adapter that answers the browser-level `Target.*` calls for one tab.
  - **Extension:** `chrome.debugger` is also tab-level, so it needs the same
    adapter. Build it once, share it between desktop and extension.

## 4. Safety rules (all sources)

- **Consent per run**, naming the sites the run wants. "Always allow for
  this site" is opt-in.
- **Site allowlist** in Settings; empty means ask.
- **Visible indicator** while a run controls the browser, with a **stop**
  button that cuts the relay at once.
- **Separate profile by default** (CLI, desktop). The extension acts in the
  user's real profile, so it shows the strongest warning and defaults to
  asking every time.
- **Nothing sensitive leaves the browser:** no cookies, storage or saved
  passwords are relayed as data. Existing page-view redaction of typed
  values stays on.
- **Page content is untrusted:** instructions found on pages are data,
  never commands. This is unchanged from today, but restated because the
  browser is now the user's own.
- **Relay limits:** frame size, rate and an idle timeout per connection.

## 5. Settings

`Settings → Browser`:

- Source: `None` (default) · `Desktop app` · `CLI` · `Extension` · `My CDP endpoint` · `Run on my desktop`
- Per source: connection status, last seen, and the allowlist.
- `My CDP endpoint`: URL and token, stored encrypted. Never logged.

## 6. The hosted browser

- cascadeai.in stops attaching an operator-provided browser. The Steel
  service and `REMOTE_BROWSER_*` variables on the hosted deployment can then
  be removed.
- **Open question Q1:** self-hosters of Cascade Cloud configure
  `REMOTE_BROWSER_*` for their own deployment. Is that the operator being
  the user (keep the env path for self-host), or should the env path go
  entirely in favour of per-user settings?
- The daily browser-session allowance exists to ration billed hosted
  sessions. With BYO there is nothing to bill, so it goes.

## 7. Routing and spend data for users

- **Source of truth:** the per-run spend ledger from #305 (`spend_ledger`,
  `spend_ledger_models`) plus each reply's stored /why report.
- **Show now:**
  - which model ran at each tier
  - cost, tokens and time
  - each agent's final status
  - failovers
- **Hold back until outcomes are truthful:** learned success rates and
  task-type labels. The router currently records one label per run and
  credits it to every model (council proposal: truthful outcomes).
- **You:** computed from the user's own rows.
- **Everyone:** aggregated across users, shown only for cells with at least
  20 outcomes from at least 5 users.
- **Desktop / CLI:**
  - Their personal tabs are computed locally from local data, with no
    upload.
  - Runs a user syncs to their account already arrive through
    `cloudRunReport` (#305).
  - **Open question Q2:** should unsynced desktop/CLI runs contribute
    aggregates to Everyone? If so, opt-in or opt-out?
- Each ledger row gains `surface: cloud | desktop | cli` so the tabs can
  split.

## 8. Acceptance criteria

- A1. A cloud run uses the user's desktop browser over the relay: navigate,
  read, click, type, page views. The stop button ends control within 1 s.
- A2. The same through the CLI relay with a dedicated profile.
- B1. The extension attaches only after the user approves the run. It shows
  the indicator, and detaches on stop or when the run ends.
- All: a run cannot reach another user's relay (test). No relay port listens
  on a non-loopback interface (test). Settings default is `None`.
- R1. The All / Cloud / Desktop / CLI tabs match ledger totals exactly.
  "Everyone" cells under the threshold are hidden (test).

## 9. Open questions

- **Q1.** Keep `REMOTE_BROWSER_*` for self-hosters, or remove it? (§6)
- **Q2.** Desktop/CLI aggregates to Everyone: off, opt-in, or opt-out? (§7)
- **Q3.** Desktop source: drive the built-in `WebContentsView` (visible in
  the app, needs the tab adapter) or launch system Chrome like the CLI?
- **Q4.** Extension scope: Chrome only first, or Chromium-based browsers in
  general from the start?
