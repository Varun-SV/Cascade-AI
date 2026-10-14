# Documentation Maintenance

This wiki is maintained from **reviewed Markdown in `docs/wiki/` on the main repository**. Do not edit the GitHub Wiki directly for changes intended to survive future publishing; make a PR against these source files instead.

## How updates work

1. Code changes merge into `main`. The weekly reviewer compares merged code and configuration against these pages.
2. Changes that alter visible behavior, setup steps, authentication, security, CLI arguments, API compatibility or tooling should update the relevant page(s) by PR.
3. When documentation changes merge, `Wiki Publish` copies the versioned Markdown to the GitHub Wiki.
4. Every Friday, the workflow also summarizes first-parent commits from the last seven days into `Weekly-Code-Changes.md`. If there were no commits, it does not rewrite that digest.
5. Pages outside this managed set are left untouched; source-controlled page titles can overwrite wiki pages with the same name.

## One-time publisher setup

The connected GitHub application currently has **no Wiki write API**, because GitHub Wikis are separate Git repositories. Complete these steps to activate publishing:

1. Open [the repository Wiki](https://github.com/Varun-SV/Cascade-AI/wiki). If empty, create its initial `Home` page using GitHub's interface.
2. Create a restricted GitHub access token that **can push to this repository's wiki Git remote**. Use least privilege, short expiry and verify wiki Git access (token capabilities vary).
3. Store the token as the Actions repository secret **`WIKI_PUSH_TOKEN`**. Never paste it into an issue, PR, documentation file, or chat.
4. Merge the documentation PR. Use **Actions → Wiki Publish → Run workflow** to publish immediately; afterwards the weekly scheduled run and doc-change pushes handle updates.
5. Inspect the workflow logs and the public Wiki to confirm success. A missing token makes the workflow fail rather than silently reporting success.

The workflow runs on doc-source pushes to `main`, manual dispatch and a weekly Friday schedule (03:30 UTC / 09:00 IST). The digest is deterministic and uses actual Git history—**not an AI-generated claim about what changed**. The weekly AI review is responsible for proposing substantive page updates and should not publish guesses.

## Review checklist

- Update only for functionality **merged** to `main`; an open PR is not a release.
- Compare README, source routes, config schema, tests, deployment and changelog.
- Link to source paths and clearly label optional, deprecated or incomplete features.
- Never include secrets, raw tokens, personal data or private incident details.
- Run doc link checks where practical and verify example commands against code.
- If no meaningful behavior changed, avoid churn; the weekly digest may still summarize internal work.

Source: [wiki publisher workflow](https://github.com/Varun-SV/Cascade-AI/blob/main/.github/workflows/wiki-publish.yml).
