# API and SDK

Cascade exposes its orchestration engine through a Node SDK and a **limited OpenAI-compatible** HTTP API.

## Node SDK

Install `cascade-ai` in a Node.js 22.22.2+ project:

```typescript
import { runCascade, createCascade, streamCascade } from 'cascade-ai';

const result = await runCascade('Explain this repository');
console.log(result.output);

await streamCascade('Summarize the module', (token) => process.stdout.write(token));

const cascade = createCascade({
  providers: [{ type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }],
});
await cascade.init();
const detailed = await cascade.run({ prompt: 'Design integration tests' });
```

The `Cascade` class supports event listeners and run cancellation through an AbortSignal; integrations that enable risky tools should supply meaningful approval handling. See [SDK exports](https://github.com/Varun-SV/Cascade-AI/tree/main/src/sdk) and [README SDK examples](https://github.com/Varun-SV/Cascade-AI/blob/main/README.md).

## OpenAI-compatible HTTP

API base: `https://your-cascade-instance/v1` (or the self-hosted `http://localhost:8787/v1`).

| Route | Purpose |
| --- | --- |
| `GET /v1/models` | Discover routing modes |
| `POST /v1/chat/completions` | Run an orchestrated chat completion, streaming or buffered |

The `model` parameter is a routing mode:

| Model identifier | Meaning |
| --- | --- |
| `cascade` | Automatic balanced orchestration |
| `cascade-fast` | Fast response without full orchestration |
| `cascade-quality` | Quality-weighted orchestration |

Other names return an error rather than silently switching routing.

```python
from openai import OpenAI
client = OpenAI(
    api_key="YOUR_CASCADE_ACCESS_TOKEN",
    base_url="http://localhost:8787/v1",
)
response = client.chat.completions.create(
    model="cascade",
    messages=[{"role": "user", "content": "Compare two designs."}],
)
print(response.choices[0].message.content)
```

Use a **Cascade access token**, not a provider API key, for HTTP bearer authentication. Unsupported OpenAI parameters are rejected; this is not full tools/function-calling or vision-input OpenAI API parity. HTTP requests run non-interactively, so human-gated approvals are not available and noninteractive defaults apply.

For provider keys, a request may supply `extra_body.providers`. Operator environment credentials are used only on single-account instances; once more than one account exists, the service stops sharing the operator's keys.

Reference: [API implementation](https://github.com/Varun-SV/Cascade-AI/blob/main/cloud/server/src/openai-compat.ts), [design/security notes](https://github.com/Varun-SV/Cascade-AI/blob/main/docs/openai-compat.md).
