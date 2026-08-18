# Changelog

All notable changes to Kingshade Suite are documented here.

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
