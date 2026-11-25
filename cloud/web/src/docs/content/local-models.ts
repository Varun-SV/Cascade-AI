import type { DocPage } from './types.js';
import { code, h2, h3, note, ol, p, table, tip, ul, warn } from './dsl.js';

export const LOCAL_MODELS: DocPage = {
  slug: 'local-models',
  section: 'using',
  title: 'Local models',
  summary: 'Run Cascade\'s workers on models on your own machine with Ollama, LM Studio, llama.cpp or vLLM.',
  blocks: [
    p('Cascade can send work to a model that runs on your own machine or network. There is no per-token API charge from a provider, but you supply the hardware, and a small local model may handle a tool-heavy task differently from a hosted one. This page shows how to set up each runtime and what to check first.'),
    p('Local models are most often used for **T3**, the workers that do the actual work. You can pin T1 and T2 to a local model too, with the same steps.'),
    h2('Where local models work'),
    table(
      ['Surface', 'Local models'],
      ['**CLI**', 'Yes. Ollama and OpenAI-compatible endpoints.'],
      ['**Desktop app**', 'Yes. Add the endpoints in Settings, then pin them to a tier in the Models tab.'],
      ['**Self-hosted Cascade Cloud**', 'Only if the server can reach the model\'s address. Inside a container, `localhost` is the container itself, not your computer.'],
      ['**Hosted web app (cascadeai.in)**', 'No. The server cannot reach a model on your own machine, and the web app\'s key vault does not offer Ollama. An OpenAI-compatible endpoint only works there if it is reachable from the public internet.'],
    ),
    h2('What the model must support'),
    p('A T3 worker does not just chat. It calls tools to read files, run commands and search. So the model you pick needs **tool calling** (also called function calling), and the server must pass tools through to it.'),
    ul(
      'If a model has no native tool calling, or its chat template cannot describe tools, Cascade switches that model to a **text tool format**, where the model writes its tool calls as text and Cascade parses them. The switch is remembered for Ollama and OpenAI-compatible servers. Native tool calling is the first thing to try; the text format is a fallback.',
      'For Ollama, Cascade asks the server what each model can do and marks it tool-capable from that answer. If the server does not say, Cascade guesses from the model name (Llama 3.1 to 3.3, Qwen 2 to 3, Mistral Nemo and Small, Command R and Firefunction are on its list).',
      'For OpenAI-compatible endpoints, Cascade cannot tell what a model supports, so check your runtime\'s own notes on tool calling. Each section below says what to switch on.',
    ),
    p('**Context length matters.** Tool output such as a file read or a command log fills the context window. A small default can cut it off, and the worker loses part of what it was working on. Raise the window in the runtime (each section below shows how). The window is set by the runtime, not by Cascade.'),
    note('**Thinking levels are not sent.** The [thinking level](/docs/thinking-levels) setting has no effect on Ollama or OpenAI-compatible endpoints. Cascade sends nothing for it, so a model\'s reasoning behaviour is whatever the model and server do by default.'),
    h2('Pin a local model to a tier'),
    p('Once the runtime below is running, tell Cascade where it is and choose the model for a tier. A tier you do not pin stays on Cascade Auto, which may still choose a hosted model if you have one.'),
    ul(
      '**CLI:** run `cascade doctor` to check the runtime is found, then `/model` in the REPL to choose a provider and model for a tier, or `cascade models` to list and pin them.',
      '**Config file:** `providers` lists the endpoints and `models.t3` (or `t1`, `t2`) pins a model. See [the config file](/docs/config-file).',
      '**Desktop app:** Settings, Providers tab for the endpoint, then the Models tab to pin a model to a tier.',
    ),
    code(`cascade models set t3 ollama:llama3.2:3b
cascade models                       # check what each tier now uses`),
    p('The part before the first colon is the provider (`ollama` or `openai-compatible`) and the rest is the model name as the server reports it. A bare model name also works. Use `/model` to see the exact names.'),
    note('Local models run one worker at a time by default (`t3Execution: "auto"` and `localConcurrency: 1`), because most machines cannot serve several at once. A single call also waits up to five minutes (`localInferenceTimeoutMs`) before it is treated as failed. See [the config file](/docs/config-file#routing-and-models).'),
    h2('Ollama'),
    p('Ollama is the simplest start. Cascade talks to its own API (`/api/chat`), not the OpenAI-style one, and finds it with no setup at its default address, `http://localhost:11434`.'),
    ol(
      'Install Ollama from [ollama.com](https://ollama.com) and start it. The desktop app starts the server for you. Without it, run `ollama serve`.',
      'Pull a model that supports tools, for example `ollama pull llama3.2:3b`. Check the model\'s page on ollama.com for tool support.',
      'Run `cascade doctor`. It reports whether Ollama is running at `localhost:11434`.',
      'Pin the model to a tier (see above), or let it be the only model you have.',
    ),
    code(`ollama pull llama3.2:3b
cascade doctor`),
    h3('Another address'),
    p('Ollama listens on `127.0.0.1:11434` by default. To use Ollama on another machine, bind it to a network address with `OLLAMA_HOST` on that machine, for example `OLLAMA_HOST=0.0.0.0:11434 ollama serve`. Then give Cascade the address:'),
    ul(
      'In the setup wizard, type the address when it asks for the Ollama URL.',
      'In the CLI, `/settings ollama http://192.168.1.20:11434`.',
      'In the config file, `{ "type": "ollama", "baseUrl": "http://192.168.1.20:11434" }`.',
      'In the desktop app, the **Ollama endpoint** box in Settings.',
    ),
    p('Cascade calls Ollama from outside a browser, so `OLLAMA_ORIGINS` (which controls browser cross-origin requests) is not needed for it. Ollama has no login by default, so bind to the network only on one you trust.'),
    h3('Context length'),
    p('Ollama sets the context window itself, and **Cascade does not send `num_ctx`**. The window Ollama loads is what a worker has to work with, however large the model could handle. Ollama\'s docs say the default depends on your VRAM: 4k tokens under 24 GiB, 32k from 24 to 48 GiB and 256k above that. Check your version\'s docs, because older releases used 4096 for everyone.'),
    p('Raise it when you start the server:'),
    code(`OLLAMA_CONTEXT_LENGTH=32768 ollama serve`),
    p('The Ollama desktop app has a context length slider in its settings. After a run starts, `ollama ps` shows what is loaded and whether it sits on the GPU, the CPU or both. A larger window uses more memory.'),
    note('The context size Cascade shows for an Ollama model is the model\'s maximum from `/api/show`, not the window the server actually loaded. A model can look roomy in Cascade while Ollama runs it at a smaller window.'),
    h2('LM Studio'),
    p('LM Studio can run a local server that speaks the OpenAI API. Cascade uses it as an **OpenAI-compatible endpoint**, and `cascade doctor` checks for it at `http://localhost:1234`.'),
    ol(
      'In LM Studio, download a model and load it.',
      'Start the local server from LM Studio\'s Developer tab, or with `lms server start` if you have the `lms` command line tool installed.',
      'The server\'s address is shown there. The default Cascade checks is `http://localhost:1234`, and the API base is that address plus `/v1`.',
      'Add it to Cascade as an OpenAI-compatible endpoint with that `/v1` address. The key can stay empty.',
      'Pin the model to a tier, using the model name that `/model` lists.',
    ),
    p('Choose a model that supports tool use, and check LM Studio\'s own documentation on how it handles tools for your model. Set the context length in LM Studio when you load the model; Cascade does not set it. Check that setting if long tool output is cut off.'),
    h2('llama.cpp (llama-server)'),
    p('`llama-server` ships with [llama.cpp](https://github.com/ggml-org/llama.cpp) and serves an OpenAI-compatible API at `/v1`. Always pass `--host` and `--port` yourself, so the address does not depend on your version.'),
    code(`llama-server -hf ggml-org/gemma-3-4b-it-GGUF \\
  --jinja -c 16384 --host 127.0.0.1 --port 8080`),
    ul(
      '`--jinja` turns on the chat-template engine that tool calling needs. The current llama.cpp README lists it as on by default; passing it keeps the command correct on older builds. A model may also need `--chat-template-file` for a tool-compatible template.',
      '`-c` (`--ctx-size`) sets the context window. The README says `0` means use the model\'s own length. Servers also split the window between parallel slots (`-np`), so a larger `-np` leaves each slot less. Check the `n_ctx` the server reports at `GET /slots`.',
      '`--api-key KEY` makes the server require a key. Put the same key in Cascade\'s endpoint settings. Without it, the key is not needed.',
      '`-ngl` sets how many layers go to the GPU. It defaults to `auto`.',
    ),
    p('Then add `http://localhost:8080/v1` to Cascade as an OpenAI-compatible endpoint and pin the model.'),
    warn('The current llama.cpp server README gives the default port as **9931**, not the 8080 many guides use. That is why the command above passes `--port 8080`. If you leave `--port` out, use whatever port the server prints at start.', 'Check the port'),
    h2('vLLM'),
    p('[vLLM](https://docs.vllm.ai) serves an OpenAI-compatible API, by default at `http://localhost:8000`, with the API under `/v1`. It runs on a GPU machine, and is often on another computer on your network.'),
    code(`vllm serve meta-llama/Llama-3.1-8B-Instruct \\
  --enable-auto-tool-choice \\
  --tool-call-parser llama3_json \\
  --max-model-len 16384`),
    ul(
      '`--enable-auto-tool-choice` and `--tool-call-parser` are both needed for the model to produce tool calls. The parser has to match the model family (`hermes` for Hermes models and many Qwen models, `llama3_json` for Llama 3.1, and so on). vLLM\'s tool calling page lists them.',
      'Some models also need `--chat-template` with a template that handles tool messages. vLLM ships example templates.',
      '`--max-model-len` sets the context length the server will use.',
      '`--api-key` (or `VLLM_API_KEY`) makes the server require a key. Put the same key in Cascade.',
      '`--host` and `--port` change the address.',
    ),
    p('Add `http://localhost:8000/v1` (or the machine\'s address) to Cascade as an OpenAI-compatible endpoint, then pin the model.'),
    h2('Add an OpenAI-compatible endpoint'),
    p('LM Studio, llama.cpp and vLLM all use this path. An endpoint needs a **base URL**. A key is optional for a local server. Cascade requires the URL, so a missing one fails early instead of sending your key to OpenAI.'),
    ul(
      '**Setup wizard:** choose the OpenAI-compatible option, then enter a label, the base URL and an optional key.',
      '**CLI settings:** `/settings` has the endpoint and key under Models.',
      '**Config file:** an entry in `providers`.',
      '**Desktop app:** the OpenAI-Compatible base URL and key in Settings, Providers.',
    ),
    code(`{
  "providers": [
    { "type": "openai-compatible", "label": "llama.cpp",
      "baseUrl": "http://localhost:8080/v1" }
  ],
  "models": { "t3": "openai-compatible:your-model-name" }
}`, 'json', 'Config file'),
    p('Cascade lists the models the endpoint reports at `<baseUrl>/models`. Non-chat models such as embedders are hidden from the list. A server that serves one model reports it there, so use the name it shows. Cascade assumes a 32,000 token window for these models, because the endpoint does not say.'),
    h3('Is it local?'),
    p('Cascade treats an endpoint as local, so its calls cost nothing, when the address is on your machine or LAN. Set `"local": true` or `"local": false` to override. A bare hostname such as `http://ollama:11434` in a compose file cannot show it is private, so add `"privateNetwork": true`. Both fields are in [the config file](/docs/config-file#providers).'),
    tip('Local-only [privacy paths](/docs/privacy-paths) send work on those folders only to a local model. With no local model configured, Cascade refuses the read instead of falling back to the cloud.'),
    h2('If something does not work'),
    ul(
      '**Not found:** run `cascade doctor`. For Ollama and LM Studio it checks their default addresses. For other endpoints, open `<baseUrl>/models` in a browser to see whether the server answers.',
      '**Tool errors, or the model ignores tools:** check the tool settings above (`--jinja`, the vLLM flags, a model that supports tools in Ollama). Cascade retries in text tool format when a template cannot render tools. See [Troubleshooting](/docs/troubleshooting).',
      '**Answers stop early or long outputs are cut off:** raise the context length in the runtime, as above.',
      '**Slow or timing out:** a big model on a CPU can take minutes per call. Pick a smaller one, or raise `localInferenceTimeoutMs`.',
    ),
  ],
};
