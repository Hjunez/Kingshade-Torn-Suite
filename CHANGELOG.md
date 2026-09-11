# Changelog

All notable changes to Kingshade Suite are documented here.

## KS FFScouter Call Guard — 2026-09-11 — War Room release

### KS FFScouter Call Guard 1.1.4

Publishes the build the owner already runs to the permanent War Room stable
update channel, plus an immutable 1.1.4 snapshot. The channel had been left at
1.1.3 since the 2026-08-29 emergency release.

**FIXED**

- `normalizeSharedClaims` no longer discards the entire shared claims response
  the moment a single queue entry cannot be read. PC and PDA already skip the
  bad entry and flag its target instead; Call Guard discarded the whole
  response and went offline, so one broken entry made Call Guard show nothing
  while PC and PDA kept working on the exact same server response. The base
  requirement — PC, PDA and Call Guard say the same thing about the same
  target — was broken by this divergence.
- The practical consequence on 1.1.3 is that a claimed target can be shown as
  free. 1.1.4 flags it `DIBS?` and disables the button instead, so two members
  cannot be sent at the same target by a response Call Guard could not fully
  read.

**ADDED**

- `sharedClaimsUnreadable`, a Set of target IDs the shared server sent a claim
  for that could not be read. A flagged target renders as `DIBS?` / `UNKNOWN`
  with the button disabled — it can never be claimed and is never shown as
  free.
- Panel `degraded` state: when one or more targets are flagged unreadable the
  status line reports both counts (`Shared: online · N targets · M
  unreadable`) instead of the whole panel dropping to `offline`. The
  unreadable count is never hidden.

**CHANGED**

- `normalizeSharedClaims` returns `{ claims: Map, unreadable: Set }` instead
  of a bare `Map`. The read call site now requires an object carrying a `Map`
  in `claims`; a shape fault (missing/non-object `claims.faction`, a
  non-empty array, or a key that is not a Torn ID) still returns `null` and
  still throws `"malformed claims response"`, taking the panel fully offline
  exactly as before — there is no row to warn on for a shape fault, so it is
  still rejected whole.
- Ported verbatim from the sealed PC reference implementation so PC, PDA and
  Call Guard read the same server response the same way. No new network calls
  and no new `@connect` host; this is parsing and rendering of a response the
  script already fetches.

**KNOWN ISSUES**

- Call Guard has no war-phase gate. Before a war goes live it shows `READY`
  on a target where PC and PDA show `LOCKED` / `rw-not-started` — the words
  `PREWAR`, `rwPhase` and `LIVE` do not appear in the file at all, and the
  button is driven only by hospital time, Fair Fight and shared claims. This
  is deliberate: without phase detection, the lockout that made PDA unusable
  during the previous war cannot recur. No double hit results — reading works
  in every direction — but a target can be locked from the War Room page
  before the war is live, and PC and the phone will then show it as taken
  without being able to claim it themselves. Adding a phase gate is an owner
  decision and its own version, after the war.
- Call Guard reads raw `Date.now()` for claim expiry, where PC reads Torn time
  from the server response interval and PDA reads Torn PDA's own
  `getCurrentTimestamp()`. Measured 2026-09-11: with the machine clock correct
  Call Guard says exactly what PC says. A divergence appears at one second of
  clock error, and it is visible only in the seconds nearest a claim's expiry
  — never in the hospital gate, because hospital time is read from FFScouter's
  own page text. With an NTP-synchronised Windows clock this has no practical
  effect.
- v1.1.3 never received a documented runtime verification on the War Room
  page. v1.1.4 is the first live confirmation of both the v1.1.3 shared-claim
  correction and this fix.

**VERIFICATION**

- Source: byte-identical to the runtime-verified artifact
  `FFScouter War Room/Test Artifacts/KS_FFScouter_Call_Guard_v1.1.4_UNREADABLE_CLAIM_TEST.txt`
  — 69 182 bytes, SHA-256 `03D1D927…E8E300E`. Both the stable channel file and
  the 1.1.4 snapshot carry that digest, pinned in
  `tests/fixtures/userscripts.json`.
- Cross-client: measured 2026-09-11 in the three-party simulation against the
  versions the owner actually runs. `normalizeSharedClaims` is 1 308
  characters in both Call Guard 1.1.4 and PC 1.0.40 once whitespace and
  comments are stripped, and the two agree on 20 000 randomised server
  responses.
- Runtime: verified live on ffscouter.com/war-room on 2026-09-06 by the owner
  — panel online with the correct target count, DIBS buttons rendered in every
  state (hospital countdown, travel lock, okay), Tampermonkey showing 1.1.4
  active and 1.1.3 disabled, and a claim followed by a release both completed.
  **Call Guard v1.1.4 = VERIFIED.**
- The three-party simulation is an offline measurement and does not by itself
  carry the VERIFIED status word; the live War Room run above does.

## KS Ranked War DIBS — 2026-09-11 — Torn PC release

### Torn PC — KS Torn War Dibs PC 1.0.40

Publishes the build the owner already runs to the permanent Torn PC stable
update channel, plus an immutable 1.0.40 snapshot. The stable channel had been
left at 1.0.13 since 2026-08-29, so faction members who installed from the
GitHub URL were 27 versions behind the owner's own install.

**FIXED**

- The queue notice a caller gets when their claim lands at position 2 now
  survives long enough to be read. `claimSharedTarget` writes
  `Shared: queued behind <name> · RELEASE required` and then its own `finally`
  block starts a shared poll, which overwrote the line within roughly 100 ms.
  That line is the only place the owner is told they hold a queue position they
  must release by hand, so losing it left a claim silently parked on the server.

**ADDED**

- Nothing. 1.0.40 adds no feature, no request, no stored record and no new
  `@connect` host over 1.0.39.

**CHANGED**

- The position-2 notice goes through `holdSharedWriteFailure` instead of
  `setSharedStatus("error", …)`, so it is held for `CONFIG.sharedErrorHoldMs`
  (6000 ms) exactly like a failed claim or release. Routine `syncing`/`online`
  updates are suppressed while the hold runs, a newer error replaces an older
  one immediately, and `beginSharedWriteFeedback` drops the hold the moment the
  owner starts another write — so the hold can never mask the state of
  something they are doing right now.
- This is the presentation layer only. Queue order, claim and release
  authority, and the request itself are untouched.

**KNOWN ISSUES**

- The stable channel moves 1.0.13 → 1.0.40 in one step. Members updating
  receive every change from 1.0.14 through 1.0.39 at the same time — the
  in-column countdown, the Torn clock-offset sources, DIBS sorting, the Est
  column, auto-release and the unreadable-claim handling. Those versions were
  verified individually in the owner's runtime but were never published here,
  so this is the first time anyone else receives them.
- The banner comment at the top of the file still reads
  `v1.0.20 COUNTDOWN TEST -- CANDIDATE`. It is stale narrative inside a
  comment block; the `@version` metadata, `SCRIPT.version` and `instanceKey`
  all say 1.0.40. Left exactly as sealed rather than edited, because a
  one-character change would break the byte-for-byte tie to the
  runtime-verified artifact.
- `KS_Torn_War_Dibs.user.js` (Torn PDA) stays at 1.5.145 and is not part of
  this release. The PDA build the owner runs is named `KS Torn War Dibs PDA`
  and declares no `@updateURL`/`@downloadURL`; publishing it here would rename
  members' installed script and cut their update path. That is a separate
  decision.

**VERIFICATION**

- Source: byte-identical to
  `KS Torn War Dibs/Test Artifacts/KS_Torn_War_Dibs_PC_v1.0.40_QUEUE_NOTICE_TEST.txt`,
  SHA-256 `B957F971…CC800B`. Both the stable channel file and the 1.0.40
  snapshot carry that digest, pinned in `tests/fixtures/userscripts.json`.
- Diff against the sealed 1.0.39 artifact is one behavioural line plus the
  version, `SCRIPT.version` and `instanceKey` strings — one main change, as
  required.
- Runtime: installed in real Torn PC runtime and screenshot-verified by the
  owner on 2026-09-06. No repository test exercises the six-second hold; the
  jsdom compliance harness cannot produce the trusted interaction War Dibs
  gates its runtime on, so live runtime is the only evidence for this fix.

## Bootlegging — 2026-09-01

### Kingshade's Bootlegging Advisor 5.2.14

Replaces Kingshade's Bootlegging Clean 4.1.1, which is retired.

**This does not arrive as an update — existing users must migrate by hand.** The
script name changed from `Kingshade's Bootlegging Clean` to `Kingshade's Bootlegging
Advisor`, and Clean shipped without `@updateURL`/`@downloadURL`, so no script manager
can turn an installed Clean into an Advisor. Remove Bootlegging Clean first, then
install Advisor; running both leaves two scripts contending for one instance guard,
with no guarantee which version renders. Migration steps are in the README.

Advisor adds `@updateURL`/`@downloadURL` pointing at a new unversioned stable
endpoint, `Kingshades_Bootlegging_Advisor.user.js`, so Bootlegging now follows the
same stable-channel arrangement as Scout and War Tools and future releases do update
in place. `tools/validate-suite.sh` gained the matching channel checks.

- Multi-page desktop capture fix: the stats capture now settles across paginated
  stats pages instead of reading only the first.
- Strict visibility oracle, fail-closed: `paintedStatsPageAtPoint` requires the
  topmost element at each sampled point to belong to the panel, so a point covered
  by a modal, tooltip or notification counts as zero hits rather than silently
  reading the page underneath it.
- The flat/non-paginated-layout fallback added in 5.2.12 is removed.
- `@grant` drops from `unsafeWindow` to `none`; `@match` adds the `loader.php`
  crimes route.

**Removed: the page `fetch` wrapper.** Bootlegging Clean monkey-patched
`window.fetch` to inspect Torn's own `crimesData` responses. Advisor does not touch
`fetch`, `XMLHttpRequest` or any network API at all — it reads the rendered DOM.
The script now makes and observes zero network traffic.

Test-suite consequences of that removal:

- `tests/race/bootlegging-stale-response.test.js` is deleted. It existed solely to
  prove that an older intercepted `fetch` reply could not overwrite a newer one;
  with no interception there is no such ordering to defend. Its fixtures
  (`bootlegging-responses.json`, `bootlegging-shell.html`) are deleted with it.
- The stale-response contract test now asserts Advisor's replacement guard, the
  `statsCaptureGeneration` counter, which enforces the same rule for stats capture:
  work started under an older generation never applies over newer work.
- `tests/dom/bootlegging.dom.test.js` no longer asserts the "highlight the
  lowest-stock genre" behaviour. That path now needs a capture of the real
  Bootlegging stats DOM, which does not exist yet; the file documents the gap and
  covers boot, DOM ownership, no-marking-without-evidence, and full cleanup on
  destroy in the meantime. **Restore the behavioural assertions once a real
  stats-panel capture is available.**
## KS Ranked War DIBS — 2026-08-29 — Emergency release

This emergency release publishes the three already selected and sealed Ranked War builds without product-logic changes.

### Torn PDA — KS Torn War Dibs 1.5.145

- Published the sealed PDA build to the permanent stable update channel and an immutable 1.5.145 snapshot.
- FF and shared DIBS are operational, and the new row/name stability solution passed live smoke.
- Known limitation: the Est overlay was not visible on the tested current Torn PDA layout. Est is not claimed as working in this release.

### Torn PC — KS Torn War Dibs PC 1.0.13

- Added the dedicated Torn PC stable update channel and 1.0.13 snapshot.
- Preserves the live-smoked PREWAR, FFScouter sort/filter, scrolling, route remount, native Attack and React-safe presentation behavior of the sealed build.

### FFScouter War Room — KS FFScouter Call Guard 1.1.3

- Published the sealed shared-claim correction to the permanent War Room stable channel and a 1.1.3 snapshot.
- Preserves server queue order, claim/release authority and fail-closed shared-claim handling.
- Shared DIBS depends on FFScouter Hit Calling, which FFScouter's current API documentation identifies as a Premium feature.

All stable files and their matching versioned snapshots use the corresponding permanent stable update/download URL. No Cloudflare/backend file is part of this release.

## KS Ranked War DIBS — 2026-08-20 — Release

### KS Torn War Dibs 1.5.91
- Multi-user verified compliance release.
- Real Hospital <=2:00 gate and FF 2.00–5.00 eligibility.
- Shared DIBS/TAKEN/claimant-name/RELEASE through FFScouter Hit Calling.
- Test simulation/Worker removed; claim polling reduced to 2.5 seconds; API/data disclosure and active-view lifecycle hardened.

### KS FFScouter Call Guard 1.1.2
- PC/Tampermonkey compliance release with Hospital/FF parity.
- Deterministic no-flicker rendering retained.
- No direct Torn API requests; shared claim polling 2.5 seconds.

## [0.8.7] — 2026-08-18 — Release

### War Tools timer synchronization

- Exact Hospital, Jail and Federal countdowns now use Torn's visible TCT clock second as their phase source instead of the device/browser clock.
- Exact timer updates are driven directly by the visible TCT clock DOM transition, with a guarded fallback/reconnect loop.
- Exact countdowns continue to update while scrolling; travel estimates remain explicitly separate from exact status timers.
- Removed the previously observed early/late phase error that was operationally significant near hospital release.

### Validation

- Device diagnostics verified that `window.getCurrentTimestamp()` leads Torn's visible TCT clock by about 500 ms on the tested Torn PDA environment, so it is not used as the exact-timer phase source.
- Torn PDA regression video 12195 verified stable exact HOSP countdown rate through list scrolling.
- Torn PDA expiry video 12354 verified `0m02s` at TCT `08:41:06`, `0m01s` at `08:41:07`, and timer expiry at `08:41:08` without advancing early. The row refreshed/reordered shortly after expiry; the video did not directly prove an attack-screen transition.
- Scout has no functional behavior change in 0.8.7 beyond synchronized Suite version identity.
- Release candidates passed JavaScript syntax checks and exact SHA-256 verification before publication.

## [0.8.6] — 2026-08-11 — Release

### FFScouter integration

- Added FFScouter Premium flight data with landing midpoint, landing window and travel method when available.
- Kept clearly marked travel estimates as fallback when Premium flight data is unavailable.
- Added explicit, user-triggered FFScouter key registration and registration-status checking.
- Updated disclosure for the documented `/register`, `/check-key`, `/get-stats` and `/player-flights` flows.

### Reliability and compliance

- Hardened active-page visibility/focus lifecycle behavior and request aborts when Torn is hidden or unfocused.
- Consent removal now immediately clears Suite API-derived row styling, FF/EST overlays and status/travel timers.
- Improved first-load/onboarding and KS-panel reliability on Torn PDA.
- Preserved read-only behavior: no attacks, clicks, travel, purchases, crimes or other Torn actions are automated.

### UI and status

- Improved full-row readability with stronger white Level/Days/Status/Travel text while preserving Torn player-name/banner styling.
- Updated the shared collapsed panel label to `Suite Status`.
- Fixed Overview so completed FF/EST loads show `FF/EST data loaded` instead of remaining on a loading state.
- Kept Scout and War Tools version identity synchronized throughout the Suite.

### Validation

- Passed Torn PDA regression tests covering fresh start, app switching, consent cleanup, full faction-list rendering and Suite tabs.
- Compared multiple Premium flight landing/window/method results directly with FFScouter and matched the displayed values.
- Passed RC1 and final v0.8.6 release smoke tests.

## [0.8.5] — 2026-07-14 — Compliance review beta

### API disclosure and consent

- Added Torn API ToS table directly beside the API-key field.
- Added explicit one-time acceptance before any new Torn API or FFScouter network request is allowed.
- Added a focus guard that pauses and aborts requests when the Torn page is hidden or loses focus.
- Added a startup probe and DocumentFragment-aware observer so the KS button appears on the first faction-page load.
- Replaced the wide horizontal disclosure table with mobile-readable stacked cards.
- Documented local storage, external recipients, purposes, key transmission and required selections.
- Added direct links to Torn API terms, Torn scripting rules, FFScouter terms/data policy, privacy policy and API documentation.
- Clarified that Kingshade Suite has no server and its developer cannot access users' keys or data.

### Integration and repository

- Documented use of FFScouter's public `GET /api/v1/get-stats` endpoint.
- Added a prepared Torn staff review request and FFScouter-owner review request.
- Advanced Scout and War Tools together to Suite version 0.8.5.

## [0.8.4] — 2026-07-14 — Beta

### Suite Control Center

- Replaced the Scout-only settings panel with a tabbed Suite Control Center.
- Added Overview diagnostics for component state, version matching, API-key state, status age, member count and local data.
- Added centralized Scout and War Tools settings with immediate synchronization.
- Added a Suite refresh action and a cache reset that preserves API key, preferences, manual FF values and notes.
- Kept the Control Center read-only with respect to Torn actions.

### Scout

- Added Control Center helpers and public Suite diagnostics.
- Added persistent tab selection and live status/settings updates.
- Added local-data inventory and targeted cache clearing.

### War Tools

- Added validated `getSettings`, `updateSettings`, `resetSettings` and `getStatus` interfaces.
- Added settings command/update events for loose coupling with Scout.
- Synchronized toolbar controls after external setting changes.

### Repository

- Advanced Scout and War Tools together to Suite version 0.8.4.
- Added the Control Center architecture document.

## [0.8.3] — 2026-07-13 — Beta

### Scout

- Added shared faction-status data for War Tools.
- Added exact Hospital, Jail and Federal timers when Torn exposes `status.until`.
- Added marked travel-time estimates where exact arrival timestamps are unavailable.
- Reduced observer scope and repeated DOM writes.
- Paused countdown rendering during active scrolling to improve mobile performance.
- Preserved the last scan status instead of replacing it with ambiguous output.
- Replaced `UNKNOWN` with `NO DATA`.

### War Tools

- Added synchronized Suite version checking.
- Added ALL, READY, EASY NOW, SOON and NO DATA filters.
- Added sorting by original order, FF, status and ending time.
- Added exact countdown display for supported status timestamps.
- Added clearly marked travel estimates and `TRAVEL ~?` fallback.
- Added safer information popups and direct profile links only for verifiable Torn IDs.
- Reduced mobile scrolling overhead.

### Repository

- Promoted the tested Scout and War Tools pair to Suite version 0.8.3.
- Standardized versioned filenames.
- Removed temporary status-diagnostic scripts and test notes.
- Added `VERSION` as the Suite version source of truth.
- Added branch and release documentation.
- Added pull-request and bug-report templates.
- Added automated version and repository-cleanliness validation.
- Retained Bootlegging Clean 4.1.1 as a standalone script with its own version.

## [0.7.4 / 0.1.0] — 2026-07-13

- Added Kingshade Scout PDA 0.7.4.
- Added KS War Tools 0.1.0.
- Retained Kingshade's Bootlegging Clean 4.1.1.
- Added suite-oriented repository documentation.
