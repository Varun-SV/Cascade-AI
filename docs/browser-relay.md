# Your own browser for cloud runs

A run on Cascade Cloud, or on a server you host, can use a browser on your own
machine instead of one the server hosts. The server keeps no browser of its own:
your device opens one, asks you first, and serves the run a single tab in it.

The design, threat model and tests behind this are in
[`design/byo-browser-and-routing-data.md`](design/byo-browser-and-routing-data.md)
and [`design/stage-1-plan.md`](design/stage-1-plan.md).

## What you agree to, each time

Nothing happens without a yes on your device. When a run asks for a browser, your
device shows which run is asking, and you type the sites it may use. Then:

- The run gets **a new window with one tab**, never a tab you already have open.
  With the CLI it gets a fresh browser with its own empty profile, closed afterwards.
- Pages load only from the sites you typed. Anything else the page tries to open
  is blocked before it's sent.
- Private-network addresses (`localhost`, `10.x`, `192.168.x`, `.local` and the
  like) are blocked, for the tab and for workers those sites start. The extension
  matches names and addresses as written, and can't see a public name that resolves
  to a private address; the CLI checks the resolved address too. A run that needs a
  site on your own network has to use the CLI.
- In the extension, two things reach past the run's window, so that nothing the
  run's sites start can get onto your private network another way:
  - **WebRTC, while a run is open:** Chrome sends no WebRTC traffic over UDP, in
    any tab, and the run's own tab has no WebRTC at all. A call in another tab may
    drop to a slower relay, or fail, until the run ends; your setting comes back
    when it does.
  - **Workers, until Chrome restarts:** background workers of the sites you allowed
    can't reach private-network addresses, even in your own tabs, because a worker
    can outlive the run that started it. Other sites are untouched.
- One gap the extension can't close: a frame from another site, in a process of its
  own inside the run's page, still has WebRTC over TCP. The CLI has no such gap: its
  browser sends everything through Cascade's own proxy.
- Popups the page opens are closed, and dialogs are dismissed.
- Downloads: the CLI's browser refuses them. In the extension a download ends the
  run (Chrome can't tell it which download is the run's, so none is touched), and
  the file stays in your Downloads folder.
- No screenshot leaves your device, and there's no live view on the web: you
  watch the run, and take it over, where it runs.
- Stop it from the extension's toolbar button, by closing its window, or with
  Ctrl-C in `cascade relay serve`.

## Chrome extension

1. Build it: `node extension/build.mjs`. The result is in `extension/dist`.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose
   **Load unpacked** and pick `extension/dist`.
3. Open the extension from the toolbar, type your server's address (for example
   `https://cascadeai.in`) and a name for this browser, and approve the code it
   shows on the server's page, signed in.

The extension keeps a key made in your browser. The server gets its public half
only, and the sign-in used for pairing is revoked straight away. **Forget** in the
extension deletes that key from this browser, so it can't connect again; the server
keeps only the public half, which proves nothing without it. `cascade relay devices`
lists every device the server knows, and `cascade relay forget` removes the CLI's
machine on the server and locally.

## CLI

```bash
cascade login                # if you haven't
cascade relay pair           # register this machine (--name to choose what it's called)
cascade relay serve          # stay connected; runs ask here first
cascade relay devices        # your devices, and which are online
cascade relay forget         # remove this machine, on the server and here
```

`serve` uses Playwright's Chromium, or `--chromium <path>` / `CASCADE_RELAY_CHROMIUM`.

## Desktop app

**Settings → Cloud runs** in the Cascade desktop app turns the app itself into a
device, while you're signed in to Cascade Cloud. It pairs once (the key is kept by
your operating system's keychain), and then stays connected while the app is open.
A run that asks is shown in the app: type the sites it may use, or say no. A yes
opens a **Cascade run** window with an empty, in-memory profile; it is not the
app's own browser, and nothing you're signed in to is in it. The app's main
process polices that window as the CLI does: its traffic goes through a proxy that
resolves and checks every address, other sites' pages, downloads, permissions and
pop-ups are refused, and the window and its storage go when the run ends.
**Remove this app as a device** removes it on the server and here.

## Using it from the web

Turn on **Browser** in the composer's Tools menu. A run that needs a browser asks
your most recently seen online device. If none is online, the run goes on without
a browser, so keep the extension or `cascade relay serve` running.

You can register up to 10 devices. **Settings → Browser** lists them, shows which
are online, and removes one; removing a device also ends a run it is serving.

**Settings → Browser** also chooses where your runs' browser comes from:

- **My devices**: the extension, the CLI or the desktop app, as above.
- **My CDP endpoint**, where the server offers it: a `wss://` address of a browser
  you run (Browserless, your own Chromium with `--remote-debugging-port` behind
  TLS, and so on). The server keeps it encrypted, never shows it back (only its
  host), and accepts only public addresses: the host is resolved once, every
  address it gives is checked, and the run connects to the address checked, so a
  name can't be pointed at the server's own network afterwards. A run on it is
  approved in the chat, as with a hosted browser.
- **Run on my desktop**: a message that needs the browser hands the chat to the
  Cascade desktop app instead, with a one-time code, and the run happens there,
  with the app's own browser.

## Running your own server

The relay is off by default. Set `BROWSER_RELAY=true` on the server to turn it on.
It needs no other setting: the server makes its own relay key in `DATA_DIR`, and
devices pin it when they pair.

It can run alongside a hosted browser (`REMOTE_BROWSER_PROVIDER`). When both are on,
a run uses the user's own device if one is online, and otherwise the hosted
browser. Only the hosted browser counts against a plan's daily browser sessions.

To retire the hosted browser, set `HOSTED_BROWSER=off`. `REMOTE_BROWSER_*` are then
ignored, the daily browser-session allowance goes with them, and every run's browser
is the user's own. Turn `BROWSER_RELAY` on first, or runs have no browser at all
(the server warns about this at start).

`BROWSER_ENDPOINTS=true` offers users **My CDP endpoint**. Endpoints must be
public `wss://` addresses; `BROWSER_ENDPOINTS_PRIVATE=true` also accepts private
ones, and `ws://`, for a server whose users' browsers are on its own network. Leave
it off on a public server: it lets any user point a run at the server's network.

The relay keeps its connections in the server process, so run one instance (one
replica) per deployment.
