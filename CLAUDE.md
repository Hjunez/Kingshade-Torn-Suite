# Kingshade Torn Suite

Read-only Torn userscripts by Kingshade, published straight from this repository —
there is no build step. The `*.user.js` files in the repository root **are** the
release artifacts.

## The one rule that outranks the rest

These scripts run inside a live game whose staff can ban the author. Everything
here is deliberately read-only: the scripts add information, filtering and visual
guidance, and never act in the game for the player.

Never add code that clicks, submits, navigates, injects an iframe, opens a socket,
polls in the background, or talks to a Torn game page. Network traffic goes to the
hosts declared in each script's `@connect` and nowhere else. If a change seems to
need one of those, stop and ask rather than working around the guard.

`docs/API_DISCLOSURE.md` and `docs/TORN_STAFF_REVIEW_REQUEST.md` are what has been
told to Torn staff. Code must not drift from them.

## Layout

| Path | What it is |
|---|---|
| `*.user.js` (root) | Published scripts. Unversioned name = stable update channel; `_vX.Y.Z` = immutable historical snapshot. |
| `VERSION` | Source of truth for Scout and War Tools, which always ship the same version. |
| `src/compliance/` | Runtime guards (`netGuard`, `actionBudget`). Shared library layer, ESM. |
| `test-support/` | Test harnesses. Not shipped. |
| `tests/unit`, `tests/dom`, `tests/race` | Vitest. Only these three directories are picked up — see `vitest.config.js`. |
| `tests/browser/` | Playwright. |
| `tests/fixtures/` | Capture fixtures and deterministic scenario data. |
| `tools/` | Node scripts behind the npm commands. |
| `worker.js`, `wrangler.jsonc` | Cloudflare Worker. |

## Commands

```bash
npm run verify
```

That is the gate: `validate:suite`, `syntax`, `lint`, `format:check`, `typecheck`,
`test`, `test:browser`, in that order. Run it before proposing anything as done.

Individually: `npm test` (Vitest), `npm run test:browser` (Playwright, needs
`npm run browser:install` once), `npm run lint`, `npm run typecheck`.

On Windows use `npm.cmd` if PowerShell blocks the `npm.ps1` shim. Bash is required
for `tools/validate-suite.sh`; set `BASH_PATH` if Git Bash is somewhere unusual.

## Working on the userscripts

The tooling reads and executes the production files but never rewrites them. Do not
bundle, transpile, or reformat a `*.user.js` — Prettier's `format:check` glob
deliberately excludes them, and `tests/unit/userscript-integrity.test.js` pins every
published file by SHA-256.

That integrity test is the usual reason a change "breaks the build": edit a
published script and its digest in `tests/fixtures/userscripts.json` must be updated
in the same commit, deliberately. Treat a failure there as a question — *was this
file supposed to change?* — not as a fixture to refresh on autopilot.

`ecmaVersion: latest`, `sourceType: script`, IIFE, `"use strict"`. Each script
guards against double-injection with an instance key on `window`
(e.g. `__ksTornWarDibsV1517`).

## Testing approach

Tests run the real published script; they do not import a rewritten copy.
`test-support/bootlegging.js` and `test-support/compliance.js` both install a
userscript by `window.eval` of its actual source, exactly as a userscript manager
would.

`test-support/compliance.js` additionally records what a script does — outgoing
requests via `GM_xmlhttpRequest`/`fetch`/XHR, programmatic clicks, dispatched
events — and `tests/unit/compliance.test.js` asserts against that recording.

A note on why that file is shaped the way it is: War Dibs gates its whole runtime on
`windowFocused && hasRecentTrustedInteraction()`, and jsdom cannot produce a trusted
event. So the script correctly does nothing under the harness, and a test asserting
"it made no requests" would pass even if the harness were broken. The negative
controls in that file exist to prevent exactly that — each installs deliberately
non-compliant source and requires the harness to catch it. **If you extend the
harness, extend the negative controls too.** A green compliance suite is only
meaningful while they are there.

Playwright covers what jsdom cannot: real trusted input, shadow DOM, the panel and
claim lifecycle. Reach for it when behaviour depends on genuine interaction.

## Compliance gates

`tools/compliance-syntax.mjs` exports `KS_FORBIDDEN_SYNTAX`, the AST patterns that
encode the KS baseline. It is wired two ways:

- **Blocking** for `src/**` via `eslint.config.mjs`. `src/compliance/**` is exempt —
  it implements the primitives it guards.
- **Reporting only** for the published scripts via `eslint.compliance.mjs`
  (`npm run lint:compliance`, and the `forbidden-syntax` job in
  `.github/workflows/compliance.yml`, which is `continue-on-error`).

The published scripts currently have open hits — mostly `setInterval` for visible
countdowns and `dispatchEvent` against the scripts' own shadow DOM, which may well
be legitimate. The baseline is **stricter than Torn's published rules**; it encodes
KS's own safety margin. Do not silence a hit globally and do not make the report
blocking until each hit has been reconciled against the actual rule text. Legitimate
ones get `// eslint-disable-next-line no-restricted-syntax` with a reason on the line
above, so the exception is visible in the diff.

`tools/check-metadata.mjs` is a stricter build-output gate carried over from the
compliance kit. It expects a `dist/` directory and allows only `api.torn.com` in
`@connect`, so it does not apply to this repository as it stands — Scout and War Dibs
legitimately declare `ffscouter.com`, and there is no build step. Left in place for a
future packaged build; do not wire it into `verify` without reconciling both points.

## Release

Full procedure in `docs/RELEASE_PROCESS.md`. The shape of it: `VERSION` first, then
new versioned snapshots for Scout and War Tools at the same version, then each
`@version`, then README and CHANGELOG, then `bash tools/validate-suite.sh`, then a PR
into `main`. Publishing is triggered by writing the exact version into
`.github/RELEASE_READY`. Bootlegging Clean versions independently.

Branches: `main` (released), `dev` (integration), `feature/**`, `release/v<version>`.
Several `ks-leslie/**` branches exist as git worktrees under
`../KS Leslie.worktrees/` and `../KS Leslie/.worktrees/`.

Never commit: ZIP archives, temporary test notes, diagnostic userscripts, throwaway
duplicate scripts, API keys, or logs containing keys. Published historical versioned
snapshots are the one allowed kind of duplicate.

## Language

Repository-facing prose — README, CHANGELOG, docs, commit messages, code comments in
the userscripts — is English. The compliance layer added later
(`src/compliance/`, `tools/compliance-syntax.mjs`, `tests/unit/compliance.test.js`)
is commented in Swedish, matching how it was written. Follow whichever language the
file you are editing already uses rather than converting it.

## Related, and off-limits

`KS Torn Performance` in the parent directory is a separate private project. Nothing
from it may be uploaded or shared anywhere, and nothing from it belongs in this
repository.
