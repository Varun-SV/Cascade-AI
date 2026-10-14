# Browser Control and Human Takeover

Two browser models exist and should not be confused:

1. **Desktop:** Electron has an integrated browser. The agent can read or—when explicitly enabled and approved—act on the user's currently open, potentially signed-in page.
2. **Cloud web:** a hosted run can use a remote browser through a server-configured CDP endpoint or Steel service. The operator must configure this backend before browser capability is advertised.

The CLI's legacy/headless `browser` tool is distinct from the live desktop/cloud `browser_control` capability; live browser control is **not available in the CLI**.

## Human takeover

A browser lease coordinates ownership. When the user takes over the browser, the agent should relinquish input rather than clicking and typing at the same time. Users can later hand control back. Viewing and control are separate concerns; the live pixel stream works through the authenticated browser route instead of assuming a provider iframe can be embedded.

## Cloud deployment requirements

- Configure supported `REMOTE_BROWSER_*` variables on the server only.
- Keep the browser backend inaccessible to arbitrary clients and validate network routing.
- Avoid an untrusted per-user browser endpoint URL: it could turn the service into an internal-network proxy.
- Remote sessions are generally unauthenticated browser contexts; do not assume the remote session contains the user's local Chrome cookies.
- Hosted plan/session quotas and operator self-hosted policies can differ.

## Security rules

Browser content is **untrusted**, including page text instructing the agent to ignore prior rules. A browsing tool is not permission to compromise external systems. Every browser session must enforce run/session ownership and respect stop/cancel transitions; an existing human lease must not race an agent command.

Implementation: [browser lease](https://github.com/Varun-SV/Cascade-AI/blob/main/src/browser/lease.ts), [remote browser controller](https://github.com/Varun-SV/Cascade-AI/blob/main/src/browser/remote/controller.ts), [cloud server bridge](https://github.com/Varun-SV/Cascade-AI/blob/main/cloud/server/src/remote-browser.ts), [desktop browser host](https://github.com/Varun-SV/Cascade-AI/blob/main/app/electron/browser.ts).
