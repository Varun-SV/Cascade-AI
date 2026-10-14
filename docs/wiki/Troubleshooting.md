# Troubleshooting

## CLI does not find a provider

Run `cascade doctor` and check whether your selected provider has credentials, network access and the chosen model/deployment. Ollama normally expects a listening local instance at `localhost:11434`. Invalid Azure deployment names and expired/insufficient keys are not interchangeable errors.

## Unexpected model or high cost

Check `/model`, `/models` and `/why`. A pinned tier bypasses Auto selection for that tier. Confirm `autoBias`, model capabilities, benchmark availability and whether endpoints are correctly marked `local`. Use `/cost` to inspect charged/estimated usage. A configured per-run cap can deliberately reduce task coverage.

## Nothing happens after an approval prompt

The run may be waiting for plan approval, a dangerous tool confirmation, escalation, context approval or an MCP trust decision. See [[Agent-Orchestration]] and [[Security-and-Privacy]]. An unattended HTTP call does **not** support interactive approvals.

## Self-hosted web starts but cannot sign in

Set up GitHub or Google OAuth with correct callback URL. For private local testing only, `CLOUD_DEV_BYPASS=1` enables login but is intentionally unsafe on shared networks. Check the service's origin, port and `/health` endpoint.

## Cloud data vanished after deploy

Verify that a persistent volume is mounted at `DATA_DIR`. Without a volume, local SQLite and file storage can reset on redeploy. Do not attempt speculative database repairs before backing up the available data.

## Remote browser not offered or not connecting

Remote browser is unavailable until `REMOTE_BROWSER_*` server configuration is valid. Validate Steel/CDP transport, supported URI scheme, auth, concurrency and container networking; do not simply expose a private websocket port to the public.

## Files open as corrupted documents

Use `generate_document` or browser export renderers, not `file_write` with an Office extension. An OOXML file requires actual binary rendering.

## Wiki publishing fails

Confirm that the wiki was initialized with a Home page in the GitHub UI, that `WIKI_PUSH_TOKEN` exists as an Actions secret with write access to this repository's wiki Git remote, and that the `Wiki Publish` workflow was run after merging the docs PR.

When reporting defects, include the git commit/version, surface (CLI/desktop/web), OS, provider, reproduction steps and **redacted** logs. See [issue templates](https://github.com/Varun-SV/Cascade-AI/issues/new/choose).
