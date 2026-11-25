import type { DocPage } from './types.js';
import { code, h2, h3, note, ol, p, table, tip, ul, warn } from './dsl.js';

const S = 'getting-started';

export const GETTING_STARTED: DocPage[] = [
  {
    slug: 'overview',
    section: S,
    title: 'What is Cascade',
    summary: 'A multi-tier AI orchestrator: a planner, managers and workers share one job, and you bring your own provider keys.',
    blocks: [
      p('Cascade is an AI orchestrator. Instead of sending every request to one expensive model, it splits a job across three tiers and gives each tier a model that fits the work. Easy steps run on small, fast, cheap models. The strongest model is kept for planning and for the parts that need it.'),
      h2('The three tiers'),
      table(
        ['Tier', 'Role', 'What it does'],
        ['**T1**', 'Administrator (planner)', 'Reads your request, sizes it up and splits it into sections. For big jobs it can show you the plan first.'],
        ['**T2**', 'Manager', 'Takes one section, briefs its workers, checks what comes back and pushes back on anything unclear.'],
        ['**T3**', 'Worker', 'Does the work: searches, browses, reads and writes files, runs code, builds documents. Workers run in parallel.'],
      ),
      p('You do not always get all three. Cascade sizes each request: a simple ask goes straight to a single worker (T3), a moderate one to a manager and its workers (T2), and only a complex one uses the full T1, T2 and T3 hierarchy. You can also force one tier for a message, or turn on **Fast answer** to skip orchestration altogether. See [How tiers route](/docs/how-tiers-route).'),
      h2('Bring your own keys'),
      p('Cascade does not resell model access. You add your own API keys for the providers you already use (Anthropic, OpenAI, Google Gemini, Azure OpenAI, any OpenAI-compatible endpoint, or Ollama for local models), and Cascade calls those providers with your keys. See [Providers and API keys](/docs/providers-and-keys).'),
      h2('Where you can use it'),
      table(
        ['Surface', 'What it is', 'Start here'],
        ['**Web app**', 'Chat at cascadeai.in. Nothing to install. Works from any browser.', '[Quick start](/docs/quick-start)'],
        ['**Desktop app**', 'Chat, a live view of the agent tree, a code editor with a terminal, and a browser the agent can drive. Can also serve a folder to your Cloud runs.', '[Desktop app](/docs/desktop-app)'],
        ['**CLI**', 'An interactive terminal app and one-shot runs. Installed with npm.', '[CLI](/docs/cli)'],
        ['**SDK**', '`runCascade()` and friends, from Node.', '[SDK](/docs/sdk)'],
        ['**OpenAI-compatible API**', 'Point any OpenAI SDK at a Cascade server.', '[The /v1 API](/docs/openai-api)'],
      ),
      p('The web app, desktop app and CLI share one account. Your keys and settings can follow you between them through end-to-end encrypted sync that you start yourself, and a chat you began on the web can be continued elsewhere.'),
      note('Cascade shows its work. Every reply can show which tier and model handled each step, what it cost, and what the routing saved compared with running everything on the top model.', 'Receipts, not promises'),
    ],
  },
  {
    slug: 'quick-start',
    section: S,
    title: 'Quick start (web)',
    summary: 'Sign in, add one provider key, and send your first message in a few minutes.',
    blocks: [
      p('The web app is the fastest way to try Cascade. You need an account and one API key from any supported provider.'),
      ol(
        '**Open the app.** Go to cascadeai.in and sign in with GitHub or Google. (A server you host may offer different sign-in options.)',
        '**Add a key.** Open **Settings** and choose **API keys**, then add a key for at least one provider: Anthropic, OpenAI, Google Gemini, Azure OpenAI, or an OpenAI-compatible endpoint. Each provider then offers the models it actually serves, so you pick from real ones.',
        '**Send a message.** Type in the box and send. Cascade decides how much of the hierarchy the request needs.',
        '**Look at the receipt.** Under a reply, open **Why?** to see which tier and model did the work, what each tier cost, and what that saved compared with running it all on T1.',
      ),
      tip('No key yet? The composer says "Add an API key to start" until one is saved.'),
      h2('What you can turn on for a message'),
      p('The controls beside the message box apply to the run you are about to send:'),
      ul(
        '**Tools menu:** [web search](/docs/web-search), the **Browser** (your own Chrome, see [Browser relay](/docs/browser-relay)) where your server offers it, and your [connectors](/docs/connectors-and-mcp).',
        '**Mode menu:** routing (Auto, Quality or Fast), a single tier, the [thinking level](/docs/thinking-levels), and **Fast answer**.',
        '**Plus menu:** attach images and documents, and pick a [skill](/docs/skills).',
        '**Environment:** appears when your server has workspaces turned on. It lets a run work in a folder on your own computer. See [Workspaces](/docs/workspaces).',
      ),
      h2('Next steps'),
      ul(
        'Keep your keys on more than one device: [Providers and API keys](/docs/providers-and-keys).',
        'Understand the numbers you see: [Spend and budget](/docs/spend-and-budget).',
        'Prefer the terminal? [Install the CLI](/docs/cli).',
      ),
    ],
  },
  {
    slug: 'desktop-app',
    section: S,
    title: 'Desktop app',
    summary: 'Install the Cascade desktop app, sign in, and use it on your own files.',
    blocks: [
      p('The desktop app is the same Cascade with more of your computer in reach: a live view of the agent tree as it works, a code editor with a terminal, and a built-in browser the agent can drive while you watch. It can also let a Cascade Cloud run work in a folder you choose (see [Workspaces](/docs/workspaces)).'),
      h2('Install'),
      p('Download it from [cascadeai.in/download](/download). The page detects your system and offers the right build. The builds are:'),
      ul(
        '**macOS:** Apple silicon and Intel.',
        '**Windows:** an installer (x64).',
        '**Linux:** AppImage, `.deb` (Debian and Ubuntu), `.rpm` (Fedora and RHEL), and a pacman package (Arch).',
      ),
      p('Every release is also listed on [GitHub releases](https://github.com/Varun-SV/Cascade-AI/releases/latest).'),
      h2('First run'),
      ol(
        'Open the app. A short setup has you pick a provider, enter its key (kept in your system keychain), and choose a default workspace folder for new tasks. You can skip the folder and set it later. Ollama works too if you run models locally.',
        'To use your Cascade account (synced keys, Cloud runs), sign in from Settings.',
        'Ask for something. Open the Cockpit to watch the tiers work.',
      ),
      note('The app keeps settings in tabs: Providers, Models, Budget, Connectors, Cloud runs, Workspaces, Advanced, Data, Appearance and Updates.', 'Settings'),
      h2('Cloud runs and Workspaces'),
      p('Two settings let the desktop app serve your Cascade Cloud account. Both are off until you turn them on and both use one pairing of this computer to your account:'),
      ul(
        '**Cloud runs** pairs the app as one of your devices. A web run that needs a browser can then use the app\'s own browser window, after you say yes. See [Browser relay](/docs/browser-relay).',
        '**Workspaces** lets a web run work in a folder here. Each run asks you which folder and which tools. See [Workspaces](/docs/workspaces).',
      ),
      h2('Updates'),
      p('Updates are managed from the **Updates** tab in Settings.'),
    ],
  },
  {
    slug: 'cli',
    section: S,
    title: 'CLI',
    summary: 'Install Cascade from npm, run the setup wizard, and add your keys.',
    blocks: [
      p('The CLI is an interactive terminal app (a REPL), and it also runs single prompts non-interactively. It needs **Node.js 22.22.2 or newer**.'),
      h2('Install'),
      code('npm install -g cascade-ai'),
      p('Then start it in a project folder:'),
      code(`cd my-project
cascade`),
      h2('First run'),
      p('With no provider configured, the first start launches a setup wizard. Keys you add there are saved once for the whole machine, in `~/.cascade-ai/credentials.json`, readable only by your user. Every project then uses them.'),
      p('You can also set things up ahead of time:'),
      code(`cascade init            # create CASCADE.md and .cascadeignore, and run the wizard
cascade doctor          # check keys, local models and config
cascade link            # reuse credentials from other AI tools where possible`),
      h2('Keys'),
      p('Cascade reads the standard environment variables for the main providers, so an existing shell setup works with no extra step:'),
      table(
        ['Provider', 'Variable'],
        ['Anthropic', '`ANTHROPIC_API_KEY` (`ANTHROPIC_AUTH_TOKEN` together with `ANTHROPIC_BASE_URL`, for a gateway)'],
        ['OpenAI', '`OPENAI_API_KEY`'],
        ['Google Gemini', '`GOOGLE_API_KEY`'],
        ['Azure OpenAI', '`AZURE_OPENAI_KEY`, with `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_DEPLOYMENT`'],
      ),
      p('`cascade link` goes further. It lists the credentials it finds on the machine and adopts the usable ones: also `GEMINI_API_KEY`, and the keys of OpenAI-compatible services, each together with its endpoint: `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY` and `FIREWORKS_API_KEY`. For example `cascade link groq`.'),
      p('Inside the REPL, `/settings` opens a panel for keys and everything else ([the settings panel](/docs/settings-panel)), and `/model` picks a provider and model for a tier.'),
      warn('Subscription logins from other tools (for example a Claude Code or ChatGPT sign-in) cannot be used as API keys. `cascade link` shows what it finds and says why such a login cannot be adopted.', 'Subscriptions are not API keys'),
      h2('Running a prompt'),
      code(`cascade                          # interactive
cascade run "summarise this repo" # one prompt, then exit
cascade -p "summarise this repo"  # the same, as an option`),
      p('The full list of commands is in [CLI commands](/docs/cli-commands), and what you type inside the REPL is in [Slash commands](/docs/slash-commands).'),
      h2('Sign in to Cascade Cloud'),
      p('To continue your web chats in the terminal, or to sync keys and settings between machines, sign in:'),
      code(`cascade login        # opens your browser to approve this device
cascade whoami
cascade sync push    # encrypt and upload this machine's settings
cascade sync pull    # download and apply them on another machine`),
      p('Sync is explicit and encrypted with a passphrase only you know. See [Providers and API keys](/docs/providers-and-keys).'),
    ],
  },
  {
    slug: 'sdk',
    section: S,
    title: 'SDK',
    summary: 'Run Cascade from Node with runCascade, createCascade and streamCascade.',
    blocks: [
      p('The `cascade-ai` package is also a library. It exports the same orchestrator the CLI uses, so you can run a task from your own code.'),
      code('npm install cascade-ai'),
      h2('One call'),
      p('`runCascade(prompt, options)` loads the project\'s config (keys included), runs the task, and returns the result.'),
      code(`import { runCascade } from 'cascade-ai';

const result = await runCascade('Refactor the auth module to use JWT', {
  workspacePath: '/path/to/my/project',
  streamCallback: (chunk) => process.stdout.write(chunk.text ?? ''),
  approvalCallback: async (req) => {
    console.log(\`Approve \${req.toolName}?\`);
    return { approved: true, always: false };
  },
});
console.log(result.output);`, 'ts'),
      h2('Streaming'),
      p('`streamCascade(prompt, onToken, options)` is the same call with a token callback:'),
      code(`import { streamCascade } from 'cascade-ai';

await streamCascade('Summarise this codebase', (token) => process.stdout.write(token));`, 'ts'),
      h2('Your own config'),
      p('`createCascade(config, workspacePath)` builds an instance from a config you supply, with no files read. Use it in tests, serverless functions and embedded hosts. Missing fields take the schema defaults.'),
      code(`import { createCascade } from 'cascade-ai';

const cascade = createCascade({
  providers: [{ type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }],
});
cascade.on('stream:token', (e) => process.stdout.write(e.text));
await cascade.init();
await cascade.run({ prompt: 'Hello world', workspacePath: '.' });
await cascade.close();`, 'ts'),
      h2('Good to know'),
      ul(
        '`runCascade` and `streamCascade` close the instance for you. With `createCascade`, call `close()` yourself so MCP child processes are stopped.',
        'Pass an `AbortSignal` to stop a run. All tiers halt at the next safe point and the call resolves with whatever output exists.',
        'A run with no one listening does not stop to ask. A plan approval, for example, is approved automatically when nothing listens for it. Tool approvals go through your `approvalCallback`.',
        'The package also exports the building blocks: `ConfigManager`, `ToolRegistry`, `McpClient`, `CascadeIgnore`, `MemoryStore`, `HooksRunner` and `TaskScheduler`, plus the config schema `CascadeConfigSchema` so you can check a config before using it.',
      ),
      note('Hooks are defined in the config and validated, but runs do not call them yet, so hook scripts do not fire today.', 'Hooks'),
      p('The config shape is in [Configuration file](/docs/config-file).'),
    ],
  },
  {
    slug: 'openai-api',
    section: S,
    title: 'OpenAI-compatible API',
    summary: 'Point an OpenAI SDK at a Cascade server and get an orchestrated run back.',
    blocks: [
      p('A Cascade server speaks enough of the OpenAI API for existing clients to use it. Set the client\'s `base_url` to your server\'s `/v1` and use a Cascade access token as the API key. `POST /v1/chat/completions` and `GET /v1/models` work, streaming and not.'),
      code(`from openai import OpenAI

client = OpenAI(api_key=CASCADE_ACCESS_TOKEN, base_url="https://cascadeai.in/v1")

reply = client.chat.completions.create(
    model="cascade",
    messages=[{"role": "user", "content": "Compare Postgres and SQLite for a CLI tool."}],
)
print(reply.choices[0].message.content)
print(reply.cascade)   # the tier and model that served it, and what routing saved`, 'python'),
      h2('The model field is a routing mode'),
      p('Cascade picks a model for each subtask, so `model` does not name a model. It names how to run:'),
      table(
        ['model', 'What runs'],
        ['`cascade`', 'Full orchestration, balancing quality against cost.'],
        ['`cascade-fast`', 'One mid-tier model, no orchestration.'],
        ['`cascade-quality`', 'Full orchestration, biased toward quality.'],
      ),
      p('Any other name returns `404 model_not_found`, rather than quietly running something you did not ask for. `GET /v1/models` lists these three.'),
      h2('What a reply carries'),
      p('The usual fields, plus a `cascade` object with `conversation_id`, `tier`, `model`, `cost_usd`, `saved_usd`, `saved_pct` and `cancelled`. On a stream, the same object rides the final chunk. Token usage on a stream is sent only if you ask for it with `stream_options: {"include_usage": true}`.'),
      h2('Provider keys'),
      p('Keys reach the run in one of two ways:'),
      ul(
        '**On the request.** Any instance accepts a `providers` array in the body (with the OpenAI Python SDK, `extra_body={"providers": [...]}`). It is checked by the same schema the web app uses.',
        '**From the server\'s environment.** Only on an instance with a single account, such as one you host for yourself, the server may use the provider keys in its own `.env`. The moment a second account exists this stops on its own, so the operator\'s key never pays for someone else\'s runs.',
      ),
      p('With neither, the call fails with `400 no_provider_keys`.'),
      h2('What it does not do'),
      ul(
        'No tool or function calling: `tools`, `functions`, `tool_choice` and `tool` messages are rejected, because Cascade\'s tools run on the server.',
        'No `n` above 1, `logprobs`, `top_p`, `stop`, `seed`, `response_format` and similar. They are rejected, not ignored, because a silently dropped setting returns a reply that looks right and is not.',
        '`temperature` and `max_tokens` are honoured, applied across the tiers.',
        'Text only. Attachments go through `POST /api/uploads`.',
        'A conversation is created for each request, because an OpenAI client resends its whole history every turn. `system` and `developer` messages become the run\'s system prompt.',
      ),
      h2('Authentication and limits'),
      p('The API key is a Cascade access token, the same kind the desktop app and CLI get when you sign in. These are short-lived (about an hour) and renewed with a refresh token, so `/v1` suits server-side clients that can refresh. Browsers are deliberately not served: cross-origin `Authorization` headers are not allowed.'),
      p('Your plan\'s daily run and concurrency limits apply, and a refusal comes back as `429`. If the client disconnects, the run is stopped so it stops spending.'),
      h3('Errors'),
      p('Errors use OpenAI\'s envelope (`error.message`, `error.type`, `error.code`), so an SDK raises its usual exceptions. If a streamed answer ever ends up different from the final answer, the stream ends with an error chunk (`stream_reconciliation_failed`) instead of a clean stop. Retry without `stream` to get the authoritative reply.'),
    ],
  },
];
