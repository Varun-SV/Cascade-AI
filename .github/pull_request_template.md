## What & why

<!-- What does this change, and what problem does it solve? Link any issue. -->

## How it works

<!-- The approach, and anything a reviewer would otherwise have to reverse-engineer. -->

## Verification

<!-- How you know it works: tests added/run, builds, manual steps. -->

- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] `npm run build` passes
- [ ] Workspace checks pass, if this touches `app/` or `cloud/**`

## Release

- [ ] `CHANGELOG.md` updated
- [ ] Version bumped in root **and** `app/package.json` — required when this
      touches the SDK, CLI or desktop app; not needed for cloud-only changes

## Notes

<!-- Trade-offs, follow-ups, anything deliberately left out. -->
