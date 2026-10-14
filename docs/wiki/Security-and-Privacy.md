# Security and Privacy

Cascade can act on local files, call third-party APIs and browse external sites. Treat it as an automation system with real permissions, not as a chat widget.

## Credentials

- Supply keys via supported environment/config, native local stores or opt-in encrypted account sync. **Do not commit credentials.**
- Encrypted settings sync is manual (`push` / `pull`). The account server relays a ciphertext envelope; the passphrase stays on the client.
- The cloud web chat's provider credentials are not intended to be stored as plaintext in the server database.
- Tokens issued to a gateway must remain bound to the base URL that issued them. Provider credentials should never follow redirects to a different origin.
- Azure deployment credentials and model access are scoped to their configured resource.

## Approval and isolation

- Risky shell, filesystem, git and browser tools require appropriate authorization/escalation.
- Network fetches have SSRF safeguards; remote browser/CDP configuration is operator-controlled.
- Cloud is multi-tenant: session authentication, file ownership and encrypted connector token handling are required at every boundary.
- The local dashboard binds to loopback by default.

## Self-host warning

`CLOUD_DEV_BYPASS=1` is **not authentication**. It is suitable only for development on loopback-bound infrastructure. Never expose it to any other user or host. Production instances need actual OAuth and HTTPS.

## Threat model and disclosure

Prompts, retrieved documents, websites, third-party MCP outputs, and generated code are **untrusted input**. Do not allow them to override user/administrator authority or consent. A browser tool must not bypass the policies applied to native tools just because actions are delegated to a lower-tier model.

Report vulnerabilities **privately**, not as a public GitHub issue:
[GitHub security advisory reporting](https://github.com/Varun-SV/Cascade-AI/security/advisories/new).

## Current boundaries

Security is continuously improved; neither sandboxing nor model policy enforcement can be assumed perfect. The optional dynamic code sandbox is stronger when `isolated-vm` is installed; otherwise process-level access may be broader. Keep untrusted execution off unless necessary.

Sources: [SECURITY.md](https://github.com/Varun-SV/Cascade-AI/blob/main/SECURITY.md), [credentials](https://github.com/Varun-SV/Cascade-AI/tree/main/src/config), [sync design](https://github.com/Varun-SV/Cascade-AI/blob/main/docs/key-sync.md), [safe fetch](https://github.com/Varun-SV/Cascade-AI/blob/main/src/tools/utils/safe-fetch.ts).
