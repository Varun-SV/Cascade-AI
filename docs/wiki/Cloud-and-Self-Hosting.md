# Cloud Web and Self-Hosting

Cascade Cloud combines a React/Vite web UI with an Express/Socket.IO server. The server serves the built SPA and supports chat, account sessions, files, model use and integrations.

## Hosted

- Main entry: [cascadeai.in](https://cascadeai.in).
- The application and docs use the same origin; API/auth endpoints run alongside the web UI.
- Users supply provider credentials; per-user hosted chat credentials are not stored as readable provider API keys in the cloud account database.
- Hosted browser access depends on an operator-configured backend and any applicable plan limits.

## Self-host: loopback-only quick start

```bash
git clone https://github.com/Varun-SV/Cascade-AI.git
cd Cascade-AI
cp .env.example .env
# Set a strong SESSION_SECRET in .env
# Configure a real GitHub or Google OAuth client, OR (local testing only)
# set CLOUD_DEV_BYPASS=1
docker compose up
# open http://localhost:8787
```

**Critical:** `CLOUD_DEV_BYPASS=1` accepts a user name without verifying identity. The supplied Compose configuration binds to `127.0.0.1` deliberately. Never expose this bypass to another machine or the public network. For accessible deployments, turn it **off** and configure OAuth and TLS before changing the network binding.

## Production deployment

The documented Railway shape is a single Dockerfile.cloud service, `DATA_DIR=/data` on a **persistent volume**, a properly random `SESSION_SECRET`, `WEB_ORIGIN` and `OAUTH_REDIRECT_BASE_URL` set to the canonical host, and GitHub/Google OAuth callback URLs configured correctly. Railway supplies the runtime port. Health check: `/health`.

Without a persistent `DATA_DIR`, SQLite conversations and uploaded files can be lost across rebuilds. Never hardcode OAuth client secrets or payment credentials in client-side variables.

## Remote browser

A hosted browser is **disabled unless configured by the operator**. `REMOTE_BROWSER_*` settings choose CDP/Steel endpoint, authentication and concurrency; do not accept a remote browser URL from arbitrary user input. See [[Browser-Control]] and [cloud env example](https://github.com/Varun-SV/Cascade-AI/blob/main/cloud/server/.env.example).

## Working with the service

- Frontend: `cloud/web/`.
- Backend: `cloud/server/`.
- Deployment definitions: `Dockerfile.cloud`, `railway.json`, `docker-compose.yml`.
- Refer to [deployment guide](https://github.com/Varun-SV/Cascade-AI/blob/main/cloud/DEPLOY.md) and [self-host source](https://github.com/Varun-SV/Cascade-AI/blob/main/docker-compose.yml) rather than copying production settings from examples unchanged.
