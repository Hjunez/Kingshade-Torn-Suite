# Development and testing

The repository uses a small, read-only test harness around the published userscripts. Production
`*.user.js` files are executed or read as fixtures; the tooling never bundles, rewrites, or formats
them.

## Requirements

- Node.js 22.15 or newer (CI uses Node.js 24)
- npm
- Chromium installed through Playwright
- Bash for the existing `tools/validate-suite.sh` check

On Windows, the suite-validator wrapper automatically finds Git for Windows Bash in its standard
installation paths. Set `BASH_PATH` when Bash is installed elsewhere. If PowerShell blocks the
`npm.ps1` shim, use `npm.cmd` in the commands below.

## First-time setup

```powershell
npm.cmd ci
npm.cmd run browser:install
```

On macOS or Linux, use `npm` instead of `npm.cmd`.

## Complete verification

```powershell
npm.cmd run verify
```

The single verification command runs, in order:

1. The existing Suite filename/version/update-channel validator.
2. Node syntax validation for every `.js`, `.mjs`, and `.cjs` file, including all userscripts.
3. ESLint static analysis.
4. Prettier checks for development, test, configuration, fixture, and new documentation files.
5. Strict TypeScript `checkJs` analysis for new JavaScript/JSDoc infrastructure.
6. Vitest unit, integrity, jsdom, and stale-response regression tests.
7. Playwright's deterministic Chromium smoke and userscript regression tests.

Useful focused commands:

| Command                    | Purpose                                      |
| -------------------------- | -------------------------------------------- |
| `npm.cmd run syntax`       | Parse-check repository JavaScript with Node. |
| `npm.cmd run lint`         | Run ESLint without applying fixes.           |
| `npm.cmd run format:check` | Check formatting without writing files.      |
| `npm.cmd run typecheck`    | Run strict `checkJs`/JSDoc type analysis.    |
| `npm.cmd test`             | Run Vitest once.                             |
| `npm.cmd run test:watch`   | Run Vitest in watch mode.                    |
| `npm.cmd run test:browser` | Run the Playwright Chromium tests.           |

Run only the War Dibs browser regressions with:

```powershell
npx.cmd playwright test tests/browser/war-dibs-*.spec.js
```

## Test structure

- `tests/fixtures/` contains fixed DOM, API-response, metadata, and SHA-256 fixtures.
- `tests/unit/` checks the published inventory, byte integrity, metadata, and stale-guard contracts.
- `tests/dom/` executes an unchanged userscript in jsdom and verifies DOM lifecycle behavior.
- `tests/race/` resolves API responses out of order to verify newest-response-wins behavior.
- `tests/browser/` executes an unchanged userscript in headless Chromium.
- `test-support/` contains typed, test-only loaders and async helpers.

The userscript hash fixture intentionally makes any production-file change explicit. Update it only
as part of an authorized production release; infrastructure-only changes must leave it untouched.

## KS Torn War Dibs regression harness

The War Dibs browser suite loads `KS_Torn_War_Dibs.user.js` directly from the repository as an
opaque system under test. It does not extract functions, rewrite the source, or add production
hooks. A deterministic Torn faction page, fixed clock, encrypted browser key storage, and a mocked
`GM_xmlhttpRequest` boundary provide repeatable Torn and FFScouter responses. Browser routing blocks
and records any unexpected live request.

The scenarios cover Hospital and Fair Fight boundaries, countdown second transitions, request
contracts, claim/release/reclaim, shared claimant identity, race-loser cleanup, stale and
out-of-order responses, foreground inactivity, blur/resume, SPA remounts, and player-ID integrity.
The mock deliberately returns FF rows in reverse order so tests cannot accidentally rely on API
array position.

Hospital countdowns intentionally use local client `Date.now()` so their displayed seconds follow
the same wall-clock phase observed in FFScouter War Room. Deterministic tests skew Torn synchronized
time by +1 second and -1 second while checking exact and sub-second transitions through
2:01 → 2:00 → 1:59, including inactive recovery. Torn response-time offsets and
`getCurrentTimestamp()` remain available for Torn-specific timing but do not drive Hospital
countdowns; claim expiry remains on its existing local-clock path. Live FFScouter atomicity, live
Torn/FFScouter schema drift, and Torn PDA-specific generated CSS remain integration concerns; the
offline suite verifies the userscript's client-side contracts without making prohibited live
requests.

## Continuous integration

`.github/workflows/development-tests.yml` installs the locked npm dependencies and Chromium, then
runs `npm run verify` in one non-publishing job. Generated reports, browser output, coverage, and
dependencies are ignored by Git.
