# OpenRouter: awesome-openrouter ("Works with OpenRouter") listing

Status: **draft, not submitted. Do not submit until the owner decision below is made.**

## Sources (read 2026-11-25)

- List repo: https://github.com/OpenRouterTeam/awesome-openrouter (branch `main`)
- Rules: https://raw.githubusercontent.com/OpenRouterTeam/awesome-openrouter/main/CONTRIBUTING.md
- README (auto-generated, do not edit): https://raw.githubusercontent.com/OpenRouterTeam/awesome-openrouter/main/README.md
- Example entry: https://raw.githubusercontent.com/OpenRouterTeam/awesome-openrouter/main/apps/kilocode/app.yaml
- Published list: https://openrouter.ai/awesome
- Attribution headers: https://openrouter.ai/docs/app-attribution

CONTRIBUTING.md calls this list the "Works with OpenRouter" list, and https://openrouter.ai/awesome publishes it. So there is **one** path, not two: a PR to awesome-openrouter. No separate "works with" form was found. The only other route to visibility is the attribution headers below, which create an app page and rankings entry on openrouter.ai.

## Format

The list is not edited by hand. A PR adds a folder, and a GitHub Action regenerates the README after merge. The PR must not touch `README.md`.

```
apps/cascade-ai/
  app.yaml
  logo.png      (square PNG, 128x128 or 256x256)
```

Valid tags: `chat`, `coding`, `productivity`, `creative`, `research`, `other`. Folder name: lowercase letters, digits, hyphens. `description` is 1 to 2 sentences, at most 300 characters. `date_added` is the submission date as YYYY-MM-DD. PRs are validated automatically.

### Draft `apps/cascade-ai/app.yaml`

```yaml
name: "Cascade AI"
description: "Open-source, bring-your-own-key tool that splits one prompt across planner, manager and worker agents. It can use OpenRouter through its OpenAI-compatible API."
url: "https://cascadeai.in"
docs: "https://github.com/Varun-SV/Cascade-AI#providers-and-your-own-keys"  # TODO owner: replace with a page that actually shows OpenRouter setup
tags:
  - coding
open_source: "https://github.com/Varun-SV/Cascade-AI"
date_added: "YYYY-MM-DD"  # fill in on the day of submission
```

(The description is under 200 characters. Swap or add `productivity` if preferred.)

`logo.png`: use Cascade's own mark only. The repo has `app/assets/icon.png` (desktop app icon); check it is square at 128 or 256 px, or export one. Do not use OpenRouter's logo.

## Requirements vs. Cascade today

| Requirement from CONTRIBUTING.md | Cascade | Met? |
| --- | --- | --- |
| Uses OpenRouter for model access | Through the `openai-compatible` provider with `baseUrl` `https://openrouter.ai/api/v1`. There is no dedicated `openrouter` provider type. | Yes, as a generic OpenAI-compatible endpoint |
| Users bring their own OpenRouter key | Yes. `cascade link` adopts `OPENROUTER_API_KEY` together with the OpenRouter endpoint (`src/config/credential-discovery.ts` line 122). Keys can also be entered in setup or settings. | Yes |
| Publicly accessible or public landing page | https://cascadeai.in and the repo on GitHub | Yes |
| Has a logo image (`logo.png`) | An app icon exists in the repo, not yet prepared as `logo.png` | Needs a small file prep |
| **Sends app attribution headers and links its OpenRouter app page; the decision rests mainly on usage shown there** | **No.** `src/providers/openai-compatible.ts` builds the OpenAI client with no `defaultHeaders`; a repo-wide search finds no `HTTP-Referer`, `X-Title` or `X-OpenRouter-Title`. | **No** |
| Docs link with OpenRouter setup instructions | The docs mention OpenRouter in a list of OpenAI-compatible services only. There is no OpenRouter-specific page. | Partly |

Other OpenRouter touchpoints in Cascade, none of which are usage attribution: live per-token prices and model capability data are fetched from the public `https://openrouter.ai/api/v1/models` catalog without a key (`src/core/router/live-data.ts`, can be switched off in config).

## Decision for the owner

OpenRouter's rule: "an app with little or no OpenRouter usage won't be merged", with exceptions only for "particularly unique or innovative projects, or those from established developers with a track record". Cascade is early access and currently shows no OpenRouter usage, so a PR today would very likely be closed. Options:

1. **Wait.** Do not submit now. Revisit once there is real OpenRouter traffic through Cascade.
2. **Add attribution headers first (a code change, not made here).** When the configured endpoint is OpenRouter, send `HTTP-Referer: https://cascadeai.in` (required, it is the app's identifier) and `X-OpenRouter-Title: Cascade AI` (`X-Title` still works), optionally `X-OpenRouter-Categories` (for example `cli-agent`). This is a product choice because it tells OpenRouter which app a user's requests came from, and it makes Cascade appear on public rankings. It should be limited to requests going to `openrouter.ai`, documented, and ideally switchable. `X-OpenRouter-App-Visibility: hidden` exists for apps that should stay unlisted. After shipping it and accumulating usage, submit with the app page linked.
3. **Submit anyway** as an exception request, with the honest framing below. Low odds, low cost, but a rejected PR is public.

## PR title and body (for use after the decision)

Title:

```
Add Cascade AI
```

Body:

```markdown
Adds Cascade AI (`apps/cascade-ai/`).

Cascade AI is an open-source (MIT) tool that splits one prompt across planner, manager and worker agents. It works with OpenRouter through its OpenAI-compatible API: users bring their own OpenRouter key (`cascade link` picks up `OPENROUTER_API_KEY` and the OpenRouter endpoint). It is in early access.

- Site: https://cascadeai.in
- Source: https://github.com/Varun-SV/Cascade-AI
- OpenRouter app page: <link, once attribution headers have been sent; remove this line if none>
- Logo: Cascade's own, 256x256 PNG

README.md is untouched, per CONTRIBUTING.md.
```

If submitting before there is usage, add one honest sentence to the body: "This is a young project and has little OpenRouter usage so far; happy to resubmit later if that is a blocker."
