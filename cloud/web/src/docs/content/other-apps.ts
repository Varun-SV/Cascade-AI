import type { DocPage } from './types.js';
import { code, h2, h3, note, ol, p, table, tip, ul, warn } from './dsl.js';

export const OTHER_APPS: DocPage = {
  slug: 'other-apps',
  section: 'getting-started',
  title: 'Use Cascade from other apps',
  summary: 'Point AnythingLLM, Open WebUI, LibreChat or an OpenAI SDK at a Cascade server\'s /v1 API.',
  blocks: [
    p('A Cascade server speaks the OpenAI Chat Completions API, so any app that lets you set an OpenAI-compatible base URL can use it. This page shows the settings for AnythingLLM, Open WebUI, LibreChat and the OpenAI Python and Node SDKs. What the API supports is on [OpenAI-compatible API](/docs/openai-api).'),
    note('Cascade is in early access, and so are these steps. The server side was checked against a local server with the official `openai` packages (see "What was checked" at the end). The three apps\' settings follow each app\'s own docs and source and were not run here. Apps change their screens, so check the field names against the version you have.'),

    h2('What you need'),
    ul(
      '**The base URL.** On a self-hosted server that is `http://localhost:8787/v1`, with `8787` being the default `PORT`. On the hosted site it is `https://cascadeai.in/v1`. The `/v1` at the end matters.',
      '**An access token as the API key.** It goes in the usual `Authorization: Bearer <token>` header, which every app below sets for you.',
      '**A way for the server to reach a model.** See "Provider keys" below.',
    ),
    p('There is no setting to turn the API on. It is served by every Cascade server.'),

    h2('Get an access token'),
    p('Sign in with the CLI, pointing it at your server:'),
    code(`cascade login --server http://localhost:8787`),
    p('Leave out `--server` to sign in to `https://cascadeai.in`. The CLI saves the session in `~/.cascade-ai/cloud-session.json`. The `accessToken` field in that file is the value to paste as the API key.'),
    warn('Access tokens last about an hour. An app that stores one fixed key will start getting `401 invalid_api_key` after that, and you paste in a fresh token. Any CLI command that talks to the server, such as `cascade whoami`, renews an expiring token in that file. There is no long-lived API key today. Treat the token like a password: it acts as your account.', 'Tokens are short-lived'),
    p('Server-side code can do better than pasting: sign in, keep the refresh token, and renew the access token before it expires. See [Authentication and limits](/docs/openai-api#authentication-and-limits).'),

    h2('Model names'),
    p('`model` is a routing mode, not a model. Use one of these:'),
    table(
      ['model', 'What runs'],
      ['`cascade`', 'Full orchestration, balancing quality against cost.'],
      ['`cascade-fast`', 'One mid-tier model, no orchestration.'],
      ['`cascade-quality`', 'Full orchestration, biased toward quality.'],
    ),
    p('`GET /v1/models` returns exactly these three, in the usual `{"object": "list", "data": [...]}` shape. That is what an app\'s "fetch models" button reads. Any other name, such as `gpt-4o`, returns `404 model_not_found`.'),

    h2('Provider keys'),
    p('Cascade needs a provider key to call a model. Two ways to supply it:'),
    ul(
      '**A self-hosted server with one account.** The server uses the provider keys in its own `.env`. This is the setup that works with the chat apps below.',
      '**A `providers` array in the request body.** The OpenAI SDKs can send it (`extra_body` in Python, extra body fields in Node). The chat apps below have no field for it.',
    ),
    p('Once a second account is created on a server, it stops using its own `.env` keys. With neither, a call fails with `400 no_provider_keys`. In practice: for AnythingLLM, Open WebUI and LibreChat, use a server you host for yourself. On the hosted site, use an SDK and send `providers`.'),

    h2('What these apps may send'),
    p('Cascade rejects settings it cannot honour instead of ignoring them. These matter when you set up an app:'),
    ul(
      '`temperature` (0 to 2) and `max_tokens` are honoured. **A `max_tokens` below 256 is refused** with a `500` error ("Too little of this task\'s budget is left to write an answer"). Leave it unset, or use 256 or more.',
      '`top_p`, `presence_penalty` and `frequency_penalty` are fine at their neutral values (`1`, `0`, `0`) and rejected with `400` at anything else. `stop`, `seed`, `logit_bias`, `logprobs`, `n` above 1 and `response_format` are rejected when set.',
      '`tools`, `functions` and `tool` messages are rejected. Turn off any app feature that sends tool calls to the model (for example native function calling).',
      'Text only. An image attached in the app is rejected.',
      '`stream_options` is accepted only on a streaming request.',
    ),
    p('Each request starts a new Cascade conversation, because these apps resend the whole history every time. It appears in your own chat list on the server. Every call counts as a run against your plan\'s daily and concurrency limits, including the small calls an app makes to title a chat. `/v1` also allows 60 requests a minute.'),

    h2('AnythingLLM'),
    p('AnythingLLM talks to Cascade through its "Generic OpenAI" LLM provider.'),
    ol(
      'Open **Settings**, then **LLM Preference**, and choose **Generic OpenAI** as the provider.',
      'Set **Base URL** to `http://localhost:8787/v1` (or your server\'s address, ending in `/v1`).',
      'Set **API Key** to your access token.',
      'Under **Selected Model**, pick `cascade` from the list. AnythingLLM loads the list from `GET /v1/models`. If the list stays empty, type `cascade` into the "Model id used for chat requests" box.',
      'Under the advanced settings, set **Model context window** (the field asks for a number such as `4096`) and **Max Tokens** (such as `1024`). Keep Max Tokens at 256 or more.',
      'Save.',
    ),
    table(
      ['In the app', 'Setting in AnythingLLM\'s `.env`', 'Value'],
      ['Base URL', '`GENERIC_OPEN_AI_BASE_PATH`', '`http://localhost:8787/v1`'],
      ['API Key', '`GENERIC_OPEN_AI_API_KEY`', 'your access token'],
      ['Selected Model', '`GENERIC_OPEN_AI_MODEL_PREF`', '`cascade`'],
      ['Model context window', '`GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT`', 'a number, such as `4096`'],
      ['Max Tokens', '`GENERIC_OPEN_AI_MAX_TOKENS`', 'a number, `256` or more'],
    ),
    p('The context window is AnythingLLM\'s own budget for how much history and context it sends. Cascade chooses different models for different subtasks, so there is no single window to copy. Set it to what you want AnythingLLM to send.'),
    tip('If AnythingLLM runs in Docker, `localhost` is the container, not your machine. Use an address the container can reach, such as `http://host.docker.internal:8787/v1` on Docker Desktop. The self-hosting compose file publishes the server on `127.0.0.1` only, so a container on a Linux host may not reach it until you change that mapping or put both on one network.', 'Running in Docker'),

    h2('Open WebUI'),
    p('Open WebUI connects through an OpenAI API connection.'),
    ol(
      'Sign in as an admin. Open **Admin Settings**, then **Connections**, then the **OpenAI API** section, and use the plus button to **Add Connection**.',
      'Set **URL** to `http://localhost:8787/v1`. The field is labelled "API Base URL".',
      'Set **Auth** to **Bearer** and paste your access token as the **API Key**.',
      'Set **API Type** to **Chat Completions**. Cascade does not serve the Responses API.',
      'Under **Model IDs**, either leave it empty, so Open WebUI lists whatever `GET /v1/models` returns, or add `cascade`, `cascade-fast` and `cascade-quality` yourself.',
      'Use the **Verify Connection** button, then **Save**. Pick one of the Cascade models in a new chat.',
    ),
    p('To set it up from the environment instead, Open WebUI reads these variables:'),
    code(`OPENAI_API_BASE_URL=http://localhost:8787/v1
OPENAI_API_KEY=<your access token>

# For several connections, separate the entries with ";" (matched by position):
# OPENAI_API_BASE_URLS=https://api.openai.com/v1;http://localhost:8787/v1
# OPENAI_API_KEYS=<openai key>;<your access token>`, 'bash'),
    tip('Open WebUI also uses a model for small jobs such as chat titles and follow-up suggestions. By default that is the model you are chatting with, so each of those is a Cascade run too. In **Admin Settings** you can point the task model at a different connection, or turn the helpers off, if you want to save your daily runs.', 'Background tasks'),
    p('If Open WebUI runs in Docker, the same `localhost` caveat as for AnythingLLM applies.'),

    h2('LibreChat'),
    p('LibreChat reads custom endpoints from `librechat.yaml`. Add Cascade under `endpoints.custom`:'),
    code(`version: 1.3.19   # keep the version line your LibreChat release ships in librechat.example.yaml
cache: true
endpoints:
  custom:
    - name: "Cascade"
      apiKey: "\${CASCADE_ACCESS_TOKEN}"
      baseURL: "http://localhost:8787/v1"
      models:
        default: ["cascade", "cascade-fast", "cascade-quality"]
        fetch: true
      titleConvo: true
      titleModel: "cascade-fast"
      modelDisplayLabel: "Cascade"
      dropParams: ["stop", "frequency_penalty", "presence_penalty", "top_p"]`, 'yaml', 'librechat.yaml'),
    p('Put the token in LibreChat\'s `.env` file. `${CASCADE_ACCESS_TOKEN}` in the yaml is replaced with it:'),
    code(`CASCADE_ACCESS_TOKEN=<your access token>`, 'bash', '.env'),
    ul(
      '`name` is the label in the endpoint menu. `apiKey` and `baseURL` are the key and the server\'s `/v1` address.',
      '`models.default` is required and must list at least one model. `models.fetch: true` also asks the server for `GET /v1/models`.',
      '`titleConvo: true` makes LibreChat generate a chat title, and `titleModel` is the model it uses. `cascade-fast` runs one model with no orchestration. Leave `titleConvo` off if you would rather not spend a run on titles.',
      '`modelDisplayLabel` is the name shown on replies.',
      '`dropParams` removes default request parameters before sending. Dropping the four above is a precaution so a stray `stop` or non-neutral sampling value cannot make Cascade answer `400`. LibreChat\'s own docs list its default parameters.',
    ),
    p('LibreChat reads `librechat.yaml` from its own folder. If your copy lives elsewhere, point to it with the `CONFIG_PATH` variable in `.env`. In Docker the file has to be mounted into the container, and `localhost` has the same meaning as above. Restart LibreChat after you edit the file.'),

    h2('OpenAI SDKs'),
    h3('Python'),
    code(`from openai import OpenAI

client = OpenAI(api_key="<your access token>", base_url="http://localhost:8787/v1")

reply = client.chat.completions.create(
    model="cascade",
    messages=[{"role": "user", "content": "Summarise the trade-offs of SQLite vs Postgres."}],
)
print(reply.choices[0].message.content)
print(reply.cascade)  # conversation_id, tier, model, cost_usd, saved_usd, saved_pct, cancelled`, 'python'),
    p('Streaming works the same as with OpenAI. The `cascade` object rides the last chunk that has a `choices` entry:'),
    code(`stream = client.chat.completions.create(
    model="cascade-fast",
    messages=[{"role": "user", "content": "Say hello."}],
    stream=True,
)
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="")`, 'python'),
    p('To send provider keys with a request (needed on the hosted site, or on a server with more than one account):'),
    code(`reply = client.chat.completions.create(
    model="cascade",
    messages=[{"role": "user", "content": "Hello"}],
    extra_body={"providers": [{"type": "anthropic", "apiKey": "<your provider key>"}]},
)`, 'python'),
    h3('Node and TypeScript'),
    code(`import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.CASCADE_ACCESS_TOKEN,
  baseURL: 'http://localhost:8787/v1',
});

const stream = await client.chat.completions.create({
  model: 'cascade-fast',
  messages: [{ role: 'user', content: 'Say hello.' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}`, 'ts'),
    p('Run it in Node or on a server, not in a browser. The server does not allow the `Authorization` header from other origins, so a browser-side SDK is not served.'),

    h2('If something fails'),
    table(
      ['You see', 'Why'],
      ['`401 invalid_api_key`', 'The token is missing, wrong or expired. Get a fresh one.'],
      ['`404 model_not_found`', 'The model is not `cascade`, `cascade-fast` or `cascade-quality`.'],
      ['`400 no_provider_keys`', 'The server has no provider keys of its own for you (more than one account, or none set in `.env`), and the request carried no `providers`.'],
      ['`400` naming a parameter', 'The app sent a setting Cascade does not support. Turn it off in the app, or add it to LibreChat\'s `dropParams`.'],
      ['`500` "Too little of this task\'s budget"', '`max_tokens` is below 256. Raise it or leave it unset.'],
      ['`429`', 'A daily run limit or concurrency limit was hit, or more than 60 requests in a minute.'],
    ),
    p('Errors use OpenAI\'s envelope, so apps show the message as they would for OpenAI. More on limits: [Authentication and limits](/docs/openai-api#authentication-and-limits). Server settings: [Server environment](/docs/server-environment).'),

    h2('What was checked'),
    ul(
      '**Run against a local self-hosted server:** `GET /v1/models`; streaming and non-streaming `POST /v1/chat/completions` for all three model names; a title-style call (a `system` and a `user` message with `temperature`); the neutral `top_p`, penalty and `user` fields; `stream_options`; the `max_tokens` floor; and the `401` and `404` errors. These went through the official `openai` Python and Node packages and plain HTTP, with a small local stand-in as the model.',
      '**Taken from each app\'s docs and source, not run:** every step and field name in the AnythingLLM, Open WebUI and LibreChat sections, and what each app sends on the wire.',
    ),
  ],
};
