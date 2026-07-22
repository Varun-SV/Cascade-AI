# Domain setup — one host: `cascadeai.in`

Everything lives under a **single host**: the app at `/` (a marketing landing
when logged out, the chat when logged in), the docs at `/docs`, and the API +
OAuth under `/api` + `/auth`. There is **no `app.` subdomain** and **no GitHub
Pages site** — one clean URL to remember, one surface to secure.

> Ops runbook. The code side is done in-repo — the app, landing and `/docs` are
> served by the cloud server, and the CLI/desktop default (`DEFAULT_CLOUD_URL`)
> already points at `https://cascadeai.in`. The rest is DNS / Railway / OAuth-
> console config the account owner runs. No secrets in this file.

## Why this is clean (no alias needed)

The CLI and desktop are **pre-launch** — nothing is installed in the wild
pointing at an old `app.cascadeai.in`, so that host never has to exist. New
CLI/desktop builds target `cascadeai.in` directly. If you were ever mid-launch
with installed clients, you'd instead keep the old host answering the API during
a transition; that is not the case here.

## Steps (in order)

1. **Railway — attach the apex.** Cloud service → Settings → Networking → add
   the custom domain `cascadeai.in`. Railway shows the DNS target to point at.

2. **DNS — point the apex at Railway.** At the registrar, point the root
   `cascadeai.in` at Railway's target. A root domain needs an **ALIAS/ANAME**
   record (or Cloudflare's CNAME-flattening) — a plain root `CNAME` is not valid
   DNS. If your registrar can't do ALIAS at the root, put the domain on
   **Cloudflare** (free), which can. **Remove** any old apex A-records that
   pointed `cascadeai.in` at GitHub Pages.

3. **GitHub Pages — retire it.** The landing now lives in the app, so the
   standalone Pages site is gone: the `static.yml` workflow and the root
   `index.html` have been removed, so nothing publishes to Pages anymore. Finish
   the one-click part in the repo's **Settings → Pages → Source: None** to
   unpublish the `github.io` site.

4. **OAuth consoles — point callbacks at the host:**
   - **GitHub OAuth App** → Authorization callback URL:
     `https://cascadeai.in/auth/github/callback` (one app, one callback — no
     second OAuth app needed).
   - **Google OAuth client** → Authorized redirect URIs:
     `https://cascadeai.in/auth/google/callback`; Authorized JavaScript origins:
     `https://cascadeai.in`.

5. **Railway — set the env vars** on the cloud service, then redeploy:
   - `WEB_ORIGIN=https://cascadeai.in`
   - `OAUTH_REDIRECT_BASE_URL=https://cascadeai.in`

6. **Verify:**
   - `https://cascadeai.in` loads the app (landing when logged out).
   - `https://cascadeai.in/docs` loads the docs.
   - `https://cascadeai.in/health` returns `{"ok":true}`.
   - GitHub and Google sign-in complete the round-trip.

## Clients

`DEFAULT_CLOUD_URL` (SDK `src/cloud/client.ts`, desktop
`app/src/lib/cloudHandoff.ts`) is `https://cascadeai.in`, so freshly built
CLI/desktop apps talk to the one host. A local dev server is still targetable via
`--server` / `CASCADE_CLOUD_URL` / the `cascade-cloud-url` localStorage override.

## Rollback

Nothing here is destructive: revert the two env vars and restore the apex DNS to
its previous target. The database on the `/data` volume is untouched throughout.
