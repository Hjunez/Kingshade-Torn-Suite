# Changelog

All notable changes to Kingshade Suite are documented here.

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
