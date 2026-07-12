# Deploying Cascade Cloud

`cloud/server` and the built `cloud/web` SPA ship as a single service (see
`Dockerfile.cloud` — `cloud/server` serves `cloud/web/dist` statically, so
there's nothing else to deploy separately). This doc covers everything
needed to get `app.cascadeai.in` live on Railway, plus the landing page's
domain setup. None of these steps can be done from this repo alone — they
need your Railway account, OAuth app credentials, and DNS access.

## 1. GitHub Pages landing page (`cascadeai.in`)

`.github/workflows/static.yml` already publishes `index.html` to Pages on
every push to `main`, and writes a `CNAME` file for `cascadeai.in` into the
published output. What's left is DNS + repo settings, both outside this repo:

1. Repo Settings → Pages → confirm the custom domain shows `cascadeai.in`
   (GitHub picks this up automatically from the `CNAME` file after the next
   deploy) and enable "Enforce HTTPS" once available.
2. At your DNS provider for `cascadeai.in`, add **A records** for the apex
   domain pointing at GitHub Pages' IPs:
   ```
   185.199.108.153
   185.199.109.153
   185.199.110.153
   185.199.111.153
   ```
   (See GitHub's "Managing a custom domain" docs if `www.cascadeai.in`
   should also resolve — that needs a CNAME to `<you>.github.io` instead.)
3. `cascade-ai.in` → redirect to `cascadeai.in`: most registrars (Namecheap,
   GoDaddy, etc.) offer built-in "domain forwarding" for a secondary domain —
   point it at `https://cascadeai.in` with a permanent (301) redirect. No
   repo changes needed for this.

## 2. Railway service (`app.cascadeai.in`)

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
   - `WEB_ORIGIN` = `https://app.cascadeai.in`
   - `OAUTH_REDIRECT_BASE_URL` = `https://app.cascadeai.in`
   - `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from a GitHub OAuth App
     (github.com/settings/developers) with callback URL
     `https://app.cascadeai.in/auth/github/callback`.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from a Google Cloud OAuth
     client (console.cloud.google.com/apis/credentials) with callback URL
     `https://app.cascadeai.in/auth/google/callback`. The same client ID is
     reused client-side for the Google Drive key-sync consent flow — no
     separate credential needed.
   - Leave `CLOUD_DEV_BYPASS` unset (or `0`) — this must never be enabled on
     a real deployment.
   - `PORT` — Railway injects this automatically; don't set it manually.
4. Deploy. Railway builds `Dockerfile.cloud` (core SDK → cloud/web → cloud/
   server) and starts `node dist/index.js`, which listens on Railway's
   injected `PORT` and health-checks at `/health` (configured in
   `railway.json`).
5. Railway → Settings → Networking → add a custom domain `app.cascadeai.in`.
   Railway shows a CNAME target (something like `<service>.up.railway.app` —
   copy the exact value Railway gives you). Add that as a **CNAME record**
   for `app` under `cascadeai.in` at your DNS provider.

## 3. Smoke test

Once DNS has propagated:
1. `https://cascadeai.in` loads the landing page; the hero's "Launch Cascade
   Web" button points at `https://app.cascadeai.in`.
2. `https://app.cascadeai.in/health` returns `{"ok":true}`.
3. Sign in with GitHub and with Google; confirm both land in the chat UI.
4. Add a real provider key in the KeyVault, send a message, confirm a
   streamed reply renders.
5. Grep the Railway service logs and the mounted `/data` volume for any of
   the API keys you just used — there should be no hits. Keys only ever
   travel in the `chat:run` request payload and the provider's own HTTP
   calls; `db.ts` has no column that could persist one.
