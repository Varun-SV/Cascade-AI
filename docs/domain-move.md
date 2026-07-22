# Domain move — `cascadeai.in` → the cloud app (+ `/docs`)

Goal: serve the **cloud app at the apex `cascadeai.in`** and the **docs at
`cascadeai.in/docs`**, while keeping **`app.cascadeai.in` working** so already-
installed CLIs and desktop apps (which point at `https://app.cascadeai.in`) keep
signing in.

> Ops runbook. The code side is done (a `/docs` route lives in the cloud server);
> the rest is DNS / Railway / OAuth-console config that must be done by the
> account owner. No secrets in this file.

## Current state

| Host | Serves | How |
| --- | --- | --- |
| `cascadeai.in` (apex) | Landing page | GitHub Pages, pinned by `.github/workflows/static.yml` writing a `CNAME` |
| `app.cascadeai.in` | Cloud app (SPA + API) | Railway |

The cloud server reads two env vars that drive everything domain-specific:
- **`WEB_ORIGIN`** — CORS origin + where OAuth bounces the browser back + the
  `/activate` verification URL.
- **`OAUTH_REDIRECT_BASE_URL`** — the base used to build the provider callback
  URLs (`/auth/github/callback`, `/auth/google/callback`, MCP callback).

So the cutover is mostly **config**, not code.

## Steps (in order)

1. **Railway — attach the apex.** In the cloud service's Settings → Networking,
   add the custom domain `cascadeai.in` **alongside** `app.cascadeai.in` (keep
   both attached to the same service). Railway shows the DNS target to use.

2. **DNS — point the apex at Railway.** At the registrar, point `cascadeai.in`
   at the Railway target (apex needs an `ALIAS`/`ANAME`, or the registrar's
   flattened `CNAME`, per provider). **Remove** the existing apex records that
   pointed it at GitHub Pages. Leave the `app` CNAME as-is.

3. **GitHub Pages — release the apex.** The apex can no longer be a Pages custom
   domain. In `.github/workflows/static.yml`, stop writing `cascadeai.in` to
   `_site/CNAME` (or retire the Pages deploy). The marketing landing's new home
   is the app's logged-out page (a follow-up); until then, `cascadeai.in` shows
   the app sign-in.

4. **OAuth consoles — add the new host** (keep the `app.` entries too):
   - **GitHub OAuth App** → Authorization callback URL: add
     `https://cascadeai.in/auth/github/callback`.
   - **Google OAuth client** → Authorized redirect URIs: add
     `https://cascadeai.in/auth/google/callback`; Authorized JavaScript origins:
     add `https://cascadeai.in`.

5. **Railway — set the env vars** on the cloud service, then redeploy:
   - `WEB_ORIGIN=https://cascadeai.in`
   - `OAUTH_REDIRECT_BASE_URL=https://cascadeai.in`

6. **Verify:**
   - `https://cascadeai.in` loads the app; `https://cascadeai.in/docs` loads the
     docs page.
   - GitHub and Google sign-in complete the round-trip on the apex.
   - `https://app.cascadeai.in` still loads and signs in (installed clients).

## Keep `app.cascadeai.in` alive

`DEFAULT_CLOUD_URL` is baked into the SDK (`src/cloud/client.ts`) and desktop
(`app/src/lib/cloudHandoff.ts`) as `https://app.cascadeai.in`. Leaving that host
attached to the same Railway service means existing installs keep working with
no update. A future desktop/CLI release can flip the default to
`https://cascadeai.in` — that is a client change and needs a **version bump**.

## Rollback

Revert the two env vars to their previous values and restore the apex DNS
records to GitHub Pages. Nothing is destructive; `app.cascadeai.in` is unaffected
throughout.
