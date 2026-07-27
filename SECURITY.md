# Security Policy

## Supported versions

Cascade ships from `main` and releases frequently. Security fixes land in the
**latest** release; there are no long-term support branches.

| Version | Supported |
| --- | --- |
| Latest release (see [Releases](https://github.com/Varun-SV/Cascade-AI/releases)) | ✅ |
| Anything older | ❌ — please upgrade |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately via GitHub's
[**Report a vulnerability**](https://github.com/Varun-SV/Cascade-AI/security/advisories/new)
form (Security → Advisories), which opens a private channel with the maintainer.

Please include:

- what the issue is and the impact you believe it has,
- steps to reproduce (a minimal repro helps enormously),
- affected version / commit, OS, and provider configuration if relevant,
- any logs or output — **with API keys and tokens redacted**.

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | within **3 business days** |
| Initial assessment (severity + whether we can reproduce) | within **7 business days** |
| Fix or documented mitigation for a confirmed high-severity issue | within **30 days** |

We'll keep you updated as we work, and we're happy to credit you in the advisory
and release notes unless you'd rather stay anonymous. Please give us a
reasonable window to ship a fix before disclosing publicly.

## Scope

In scope — anything in this repository: the CLI and SDK, the desktop app, and
the hosted cloud service (`cascadeai.in`).

Especially interesting to us:

- **Credential exposure.** Provider API keys are meant to stay on your machine
  (encrypted at rest; account sync relays only ciphertext the server can't
  read). Any path that leaks a key to a log, to disk in plaintext, or to our
  server is a valid report.
- **Sandbox / permission escapes.** Tool execution is gated by an approval
  chain (T3→T2→T1→you) with dangerous tools always escalating to a human. A way
  to run a dangerous tool without that approval is a valid report.
- **SSRF and network egress.** The fetch tool is SSRF-guarded; bypasses count.
- **Tenant isolation in the cloud.** Any way to read or write another account's
  chats, files, memories, or secrets.
- **Authentication.** Session/token handling, the loopback OAuth flow, and the
  native device-auth flow.

Out of scope: findings that require a compromised machine or a malicious model
provider you configured yourself; missing hardening headers with no demonstrated
impact; automated-scanner output without a working proof of concept; and denial
of service via sheer volume against the hosted service.

## Good to know

- Cascade is **bring-your-own-key**: your provider keys are used to call
  providers directly. Rotate a key immediately if you believe it was exposed.
- Never paste real API keys into issues, discussions, or PRs.
