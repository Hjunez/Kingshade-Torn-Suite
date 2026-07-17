# Changelog

All notable changes to Kingshade Suite are documented here.

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
