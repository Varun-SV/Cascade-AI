# Deploying Cascade Cloud

`cloud/server` and the built `cloud/web` SPA ship as a single service (see
`Dockerfile.cloud` — `cloud/server` serves `cloud/web/dist` statically, so
there's nothing else to deploy separately). Everything lives under **one
host, `cascadeai.in`**: the app at `/` (a marketing landing when logged out,
the chat when logged in), the docs at `/docs`, and the API/OAuth under
`/api` + `/auth`. There is no separate `app.` subdomain and no GitHub Pages
site. None of these steps can be done from this repo alone — they need your
Railway account, OAuth app credentials, and DNS access.

> Already live on an older two-host setup (`cascadeai.in` on Pages +
> `app.cascadeai.in` on Railway)? Follow `docs/domain-move.md` to collapse to
> the single host below.

## 1. Railway service (`cascadeai.in`)

1. Create a Railway project → "Deploy from GitHub repo" → select this repo.
   Railway picks up `railway.json` automatically, which points the build at
   `Dockerfile.cloud`.
2. Add a **persistent volume**, mounted at `/data`, and set `DATA_DIR=/data`
   in the service's environment variables. Without this, the SQLite DB
   (users/conversations/messages) and per-tenant scratch dirs are wiped on
   every redeploy.
3. Set the remaining environment variables (see `cloud/server/.env.example`
   for the full list):
   - `SESSION_SECRET` — a long random string (`openssl rand -hex 32`).
   - `WEB_ORIGIN` = `https://cascadeai.in`
   - `OAUTH_REDIRECT_BASE_URL` = `https://cascadeai.in`
   - `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from a GitHub OAuth App
     (github.com/settings/developers) with callback URL
     `https://cascadeai.in/auth/github/callback`.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from a Google Cloud OAuth
     client (console.cloud.google.com/apis/credentials) with callback URL
     `https://cascadeai.in/auth/google/callback`. The same client ID is
     reused client-side for the Google Drive key-sync consent flow — no
     separate credential needed.
   - Leave `CLOUD_DEV_BYPASS` unset (or `0`) — this must never be enabled on
     a real deployment.
   - `PORT` — Railway injects this automatically; don't set it manually.
4. Deploy. Railway builds `Dockerfile.cloud` (core SDK → cloud/web → cloud/
   server) and starts `node dist/index.js`, which listens on Railway's
   injected `PORT` and health-checks at `/health` (configured in
   `railway.json`).
5. Railway → Settings → Networking → add the custom domain `cascadeai.in`
   (the apex). Railway shows the DNS target to use; add it at your DNS
   provider as an **ALIAS/ANAME at the root** (or Cloudflare's CNAME
   flattening — a plain root `CNAME` is not valid DNS). Optionally forward a
   secondary domain like `cascade-ai.in` to `https://cascadeai.in` with a
   registrar 301.

## 2. Smoke test

Once DNS has propagated:
1. `https://cascadeai.in` loads the app (the landing page when logged out).
2. `https://cascadeai.in/docs` loads the documentation.
3. `https://cascadeai.in/health` returns `{"ok":true}`.
4. Sign in with GitHub and with Google; confirm both land in the chat UI.
5. Add a real provider key in the KeyVault, send a message, confirm a
   streamed reply renders.
6. Grep the Railway service logs and the mounted `/data` volume for any of
   the API keys you just used — there should be no hits. Keys only ever
   travel in the `chat:run` request payload and the provider's own HTTP
   calls; `db.ts` has no column that could persist one.
