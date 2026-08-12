# Release process

## Branches

- `main` — current released build
- `dev` — integration branch
- `feature/<name>` — isolated development work
- `release/v<version>` — release preparation
- `test-status-timers` — retained historical faction-test branch for v0.8.3

## Versioning

`VERSION` is the source of truth for Scout and War Tools.

For every Suite release:

1. Update `VERSION`.
2. Rename both userscript files to include the same version.
3. Update each userscript `@version`.
4. Update README and CHANGELOG.
5. Run `bash tools/validate-suite.sh`.
6. Open a pull request into `main`.
7. Merge only after testing.
8. Create a GitHub release and attach both userscript files.

Bootlegging Clean is standalone and keeps an independent version.

## Repository cleanliness

Do not commit:

- ZIP archives
- Temporary test notes
- Diagnostic userscripts
- Duplicate userscript copies
- API keys or sensitive logs

## Userscript update channel

- `Kingshade_Scout_Torn_PDA.user.js` and `KS_War_Tools_Torn_PDA.user.js` are permanent stable update endpoints.
- Every released Scout/War Tools file must set both `@updateURL` and `@downloadURL` to its matching stable endpoint.
- The stable endpoint files must be byte-identical to the current versioned release files.
- The legacy v0.8.5 endpoint filenames remain present and byte-identical to the current release so existing v0.8.5 installations can migrate through Torn PDA's Update action.
- Release validation must fail if any of those files, URLs or versions drift.
