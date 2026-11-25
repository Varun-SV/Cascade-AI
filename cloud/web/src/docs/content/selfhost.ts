import type { DocPage } from './types.js';
import { code, h2, h3, note, ol, p, table, tip, ul, warn } from './dsl.js';

const S = 'self-hosting';

export const SELFHOST: DocPage[] = [
  {
    slug: 'self-hosting',
    section: S,
    title: 'Self-hosting with Docker',
    summary: 'Run your own Cascade Cloud server, with the web app, in one container.',
    blocks: [
      p('You can run the whole of Cascade Cloud yourself: the API, the sign-in, the chat database and the web app, all served by one Node process on one port. The repository includes a `Dockerfile` and a `docker-compose.yml` for it.'),
      h2('Start it'),
      code(`git clone https://github.com/Varun-SV/Cascade-AI.git
cd Cascade-AI
cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -base64 32)" >> .env
echo "CLOUD_DEV_BYPASS=1" >> .env      # read the warning below first
docker compose up
# then open http://localhost:8787`),
      p('`docker compose up` builds the image and starts the server. Every setting is read from the `.env` file in the folder you run it from. The variables are listed in [Server environment](/docs/server-environment).'),
      warn('`CLOUD_DEV_BYPASS=1` is an authentication bypass. It signs in anyone who types any name, with no credential. It is acceptable on a first run only because the compose file publishes the port to `127.0.0.1` (your own machine). Without it, and without GitHub or Google sign-in configured, the server starts but nobody can sign in. Never turn it on for a server other people can reach.', 'Read this before the first run'),
      h2('What the compose file does'),
      ul(
        '**Builds** the image from the `Dockerfile` (Node 22, a multi-stage build: the SDK, the web app and the server, then a small runtime image that runs as a non-root user).',
        '**Publishes** `127.0.0.1:8787` only, so nothing else on your network can reach it by default. `PORT` in `.env` changes both sides of the mapping.',
        '**Keeps data** in a named volume, `cascade-data`, mounted at `/data`, which is where `DATA_DIR` points. It holds the SQLite database and every user\'s uploads. Without the volume, every restart starts empty.',
        '**Restarts** the container unless you stop it, and the image has a health check on `/health`.',
      ),
      h2('Making it reachable by others'),
      ol(
        'Create a GitHub OAuth app, a Google OAuth client, or both. Their callback URLs are `<OAUTH_REDIRECT_BASE_URL>/auth/github/callback` and `<OAUTH_REDIRECT_BASE_URL>/auth/google/callback`.',
        'Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and/or `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.',
        'Set `WEB_ORIGIN` and `OAUTH_REDIRECT_BASE_URL` to the public address, for example `https://cascade.example.com`.',
        'Remove `CLOUD_DEV_BYPASS` (or set it to `0`).',
        'Put TLS in front of it (a reverse proxy), and then either change the `ports` line to publish more widely or let the proxy reach the container.',
      ),
      h2('Your keys and the API'),
      p('On the web UI every user brings their own provider keys, held in their browser. The server has none. The one exception is the [OpenAI-compatible API](/docs/openai-api): while your instance has a **single account**, it may use provider keys from the server\'s environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `AZURE_OPENAI_*`, `OPENAI_COMPATIBLE_*`, `OLLAMA_BASE_URL`). When a second account appears, the server stops using them at once, so your key never pays for someone else\'s runs. The server logs which policy applies at start.'),
      h2('Turning on the optional features'),
      table(
        ['Feature', 'Switch', 'Read'],
        ['Users\' own browsers (extension, CLI, desktop)', '`BROWSER_RELAY=true`', '[Browser relay](/docs/browser-relay)'],
        ['Runs that work in a folder on a user\'s computer', '`WORKSPACE_RELAY=true`, and `BROWSER_RELAY=true` so desktops can pair', '[Workspaces](/docs/workspaces)'],
        ['A browser you host for runs', '`REMOTE_BROWSER_PROVIDER` and `REMOTE_BROWSER_URL`', '[Server environment](/docs/server-environment)'],
        ['Users\' own CDP endpoints', '`BROWSER_ENDPOINTS=true`', '[Server environment](/docs/server-environment)'],
        ['Billing (subscriptions)', '`RAZORPAY_*`', 'Off until configured'],
      ),
      note('Both relays hold their connections in the server process. Run **one instance** (one replica) per deployment.'),
      h2('Deploying to Railway'),
      p('The repository also deploys as one service on Railway with `Dockerfile.cloud` (see `railway.json`). `Dockerfile.cloud` builds the same three parts and serves the web app from the server too. Attach a persistent volume (Railway\'s mount path is picked up automatically as `DATA_DIR`, or set `DATA_DIR=/data` yourself), set the variables above, and Railway runs `node dist/index.js` and health-checks `/health`. Add your domain, and point your OAuth callbacks at it. The full checklist is `cloud/DEPLOY.md` in the repository.'),
      p('Smoke test a new deployment: the address loads the app, `/docs` loads these docs, `/health` returns `{"ok":true}`, you can sign in, and a message with a real key streams a reply.'),
      h2('Keeping it healthy'),
      ul(
        '**Back up** the data volume. It is the whole of your users\' chats, memories, saved files and device registrations.',
        '**Upgrade** by pulling, then `docker compose up --build`. The volume carries over.',
        '**Logs** do not contain keys. Keys travel only in the request that starts a run and in the provider\'s own calls, and the database has no column that could hold one.',
      ),
      h3('Running without Docker'),
      p('You need Node 22 or newer. From a clone: `npm ci`, `npm run build:cli`, then `npm run build -w cascade-cloud-web` and `npm run build -w cascade-cloud-server`, and run `node dist/index.js` from `cloud/server` with the environment set. For development, `npm run dev:cloud` and `npm run dev:cloud-web` run the server and the web app with live reload.'),
      tip('Not sure a setting did anything? The server prints what it enabled at start (storage location, the key policy for `/v1`, and warnings such as running without a persistent volume).'),
    ],
  },
  {
    slug: 'server-environment',
    section: S,
    title: 'Server environment',
    summary: 'Every environment variable a Cascade Cloud server reads, and what it does.',
    blocks: [
      p('These are read by `cloud/server` at start. In Docker they come from your `.env`. A value that is invalid stops the server at start, with the setting named.'),
      h2('Core'),
      table(
        ['Variable', 'Default', 'What it does'],
        ['`SESSION_SECRET`', 'required', 'Signs sessions. At least 16 characters. Use a long random string, for example `openssl rand -hex 32`.'],
        ['`PORT`', '`8787`', 'The port to listen on. Railway sets it for you.'],
        ['`DATA_DIR`', '`./data`', 'Where the SQLite database and users\' uploads live. Must be durable storage. On Railway it defaults to the attached volume.'],
        ['`WEB_ORIGIN`', '`http://localhost:5173`', 'The web app\'s public address. Cross-origin requests with credentials are allowed only from here.'],
        ['`OAUTH_REDIRECT_BASE_URL`', '`http://localhost:8787`', 'The address sign-in redirects back to. Callback URLs are `<this>/auth/github/callback` and `<this>/auth/google/callback`.'],
        ['`CLOUD_DEV_BYPASS`', 'off', '`1` or `true` enables `POST /auth/dev-login`: sign in with any name and no credential. For local use only.'],
        ['`MAX_COST_PER_RUN_USD`', '`0.5`', 'A hard cost ceiling for each run, a safety rail on a shared server.'],
        ['`CASCADE_DEPLOYMENT_MODE`', '`self-hosted`', '`self-hosted` or `hosted`. `hosted` keeps the Free and Pro daily browser-session limits even when you run your own browser backend. Leave it on `self-hosted` unless you run a managed service.'],
      ),
      h2('Sign in'),
      table(
        ['Variable', 'What it does'],
        ['`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`', 'Sign in with GitHub.'],
        ['`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`', 'Sign in with Google.'],
        ['`CONNECT_GITHUB_CLIENT_ID`, `CONNECT_GITHUB_CLIENT_SECRET`', 'Your own OAuth app for the one-click GitHub connector. Unset: users paste a token instead.'],
        ['`GITHUB_API_TOKEN`', 'A read-only token with no scopes, only to lift the desktop-download lookup off GitHub\'s unauthenticated rate limit. Optional.'],
      ),
      p('With neither OAuth provider set and `CLOUD_DEV_BYPASS` off, the server starts but offers no way to sign in.'),
      h2('Provider keys for the OpenAI-compatible API'),
      p('Used **only** by `POST /v1/chat/completions`, and only while the instance has at most one account. The web UI stays bring-your-own-key.'),
      table(
        ['Variable', 'Provider'],
        ['`ANTHROPIC_API_KEY`', 'Anthropic'],
        ['`OPENAI_API_KEY`', 'OpenAI'],
        ['`GEMINI_API_KEY`, `GOOGLE_API_KEY`', 'Google Gemini. `GEMINI_API_KEY` wins if both are set.'],
        ['`AZURE_OPENAI_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`', 'Azure OpenAI'],
        ['`OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL`', 'Any OpenAI-compatible endpoint'],
        ['`OLLAMA_BASE_URL`', 'Ollama'],
      ),
      h2('Your users\' browsers and folders'),
      table(
        ['Variable', 'Default', 'What it does'],
        ['`BROWSER_RELAY`', 'off', '`1` or `true`: users can pair their own Chrome (the extension), a computer (`cascade relay`) or the desktop app, and a run that asks for a browser opens a window there, on sites they allow each time. With it off the endpoints do not exist. The server makes its own relay key in `DATA_DIR`, and devices pin it when they pair.'],
        ['`WORKSPACE_RELAY`', 'off', '`1` or `true`: a run can work in a folder on a user\'s own computer, served by their desktop app. With it off, none of its endpoints exist and a run cannot ask for one. A desktop is registered through the browser relay\'s pairing, so turn `BROWSER_RELAY` on too, or desktops cannot be paired afresh.'],
        ['`BROWSER_ENDPOINTS`', 'off', 'Users can give their runs their own CDP endpoint (a `wss://` browser they run) in **Settings**, then **Browser**. Only public addresses are accepted, resolved once and pinned.'],
        ['`BROWSER_ENDPOINTS_PRIVATE`', 'off', 'Also accept private addresses and `ws://`, for a server whose users\' browsers are on its own network. Leave it off on a public server: it lets a user point a run at the server\'s network.'],
      ),
      h2('A browser the server provides'),
      p('Off unless you set a provider. There is no per-user setting by design: the address is one the server connects to, so taking it from a request would be a way to reach the server\'s network.'),
      table(
        ['Variable', 'Default', 'What it does'],
        ['`REMOTE_BROWSER_PROVIDER`', 'unset', '`cdp` for a browser you run (Browserless, a self-hosted Chrome, anything that speaks CDP), or `steel` for a Steel deployment. Unset: hosted runs have no browser of their own.'],
        ['`REMOTE_BROWSER_URL`', 'unset', 'For `cdp`, a `ws://` or `wss://` address. For `steel`, the API base (it defaults to Steel\'s hosted API).'],
        ['`REMOTE_BROWSER_API_KEY`', 'unset', 'The `steel` key.'],
        ['`REMOTE_BROWSER_MAX_SESSIONS`', '`1`', 'Concurrent browser sessions across the whole deployment, 1 to 16. Each is billed by the provider. A bare CDP endpoint is one browser, so it is capped at 1.'],
        ['`REMOTE_BROWSER_VISION`', '`list`', 'What the model sees of a page: `off`, `list`, `image` or `marked`. The image modes cost tokens on each browsing step.'],
        ['`REMOTE_BROWSER_CDP_HOST_HEADER`', 'unset', 'Advanced. `localhost` only. For a Chromium behind a proxy that forwards the Host header unchanged.'],
        ['`HOSTED_BROWSER`', 'on', '`off`, `0`, `false` or `no` retires the hosted browser: `REMOTE_BROWSER_*` are ignored, the daily browser-session allowance goes with them, and every run\'s browser is the user\'s own through the relay. Turn `BROWSER_RELAY` on first, or runs have no browser at all. The server warns at start if you have neither.'],
      ),
      h2('Billing'),
      table(
        ['Variable', 'What it does'],
        ['`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_PLAN_ID`', 'Razorpay recurring subscriptions for the Pro plan. Billing is off, and the upgrade page says "not configured", until all three are set.'],
        ['`RAZORPAY_WEBHOOK_SECRET`', 'Verifies webhooks at `/api/billing/webhook`.'],
        ['`RAZORPAY_PRICE_LABEL`', 'Display-only price text on the upgrade page. Default `₹499 / month`. The real price is on the Razorpay plan.'],
      ),
      h2('Set by the platform'),
      p('`RAILWAY_VOLUME_MOUNT_PATH`, set by Railway when a volume is attached, becomes the default for `DATA_DIR`. An explicit `DATA_DIR` always wins.'),
    ],
  },
];
