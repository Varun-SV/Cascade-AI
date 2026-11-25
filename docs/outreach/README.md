# Outreach drafts

Status of everything in this folder: **draft, not submitted.** Nothing here has been opened as a pull request, and no external repository has been forked or commented on. These files are for the owner to review, edit and submit by hand.

Cascade is in early access. Listing text in these drafts makes no performance, cost, quality or ranking claims, and uses no third-party logos.

| Draft | Target | Status | Blocker |
| --- | --- | --- | --- |
| [ollama-community-integrations.md](ollama-community-integrations.md) | "Community Integrations" in `ollama/ollama` `README.md` | Draft, not submitted | None found. Ready to submit when the owner wants. |
| [openrouter.md](openrouter.md) | `OpenRouterTeam/awesome-openrouter` (the "Works with OpenRouter" list, published at https://openrouter.ai/awesome) | Draft, not submitted | Owner decision needed. Cascade sends no OpenRouter attribution headers, and the list's requirements say apps with no usage shown on their OpenRouter app page "won't be merged". |

## Submission steps: Ollama

1. Fork https://github.com/ollama/ollama to the owner's account.
2. Create a branch, for example `readme-add-cascade`.
3. Edit `README.md`: under `## Community Integrations`, in `### Terminal & CLI`, add the line from the draft **at the end of the list** (after the `VT` line). The lists are not alphabetical, so new entries are appended. Re-check the neighbouring lines against the current README on the day, since it changes often.
4. Commit with the title from the draft, push, and open a PR against `ollama/ollama` `main`.
5. Use the PR body from the draft. Ollama has no PR template, and its CONTRIBUTING asks for titles like `<package>: <short description>`, lowercase after the colon.

## Submission steps: OpenRouter

Do not start until the decision in [openrouter.md](openrouter.md) is made. If the owner decides to go ahead:

1. Fork https://github.com/OpenRouterTeam/awesome-openrouter.
2. Create a branch, for example `add-cascade-ai`.
3. Add `apps/cascade-ai/app.yaml` (content in the draft) and `apps/cascade-ai/logo.png` (Cascade's own logo, square PNG, 128x128 or 256x256).
4. Do **not** edit `README.md`; it is auto-generated after merge.
5. Open the PR with the title and body from the draft, including the link to Cascade's OpenRouter app page (which exists only once attribution headers have been sent).

Re-read https://github.com/OpenRouterTeam/awesome-openrouter/blob/main/CONTRIBUTING.md before submitting; the requirements have already changed shape over time.
