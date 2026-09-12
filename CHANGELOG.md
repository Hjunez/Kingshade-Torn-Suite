# Changelog

All notable changes to Kingshade Suite are documented here.

## KS Torn War Dibs PDA — 2026-09-12

### KS Torn War Dibs PDA 1.5.169

**FIXED**

- The panel's control row did not respond to a tap in Torn PDA. Three
  independent causes, all confirmed in code and, for at least one member
  besides the owner, in the field:
  - While the shared FF key lacked fresh ownership proof (`Shared:
    syncing…`), `updatePanel()` set `disabled` on all four key controls. A
    disabled button dispatches no click. Fixed in 1.5.168: `aria-disabled`
    instead, so the tap reaches the handler and the action prints the
    reason.
  - Each control measured 9.8px tall, eight to a row. Fixed in 1.5.168: a
    minimum 44px hit target, a wrapping grid, a delegated handler, a
    visible pressed state.
  - The panel sits as a sibling of Torn's war card, inside the section Torn
    collapses. A click inside an open shadow root bubbles out through the
    host and up into Torn's tree, so every tap in the panel reached Torn's
    collapse handler. Fixed in 1.5.169: propagation is stopped on the
    panel's own host, which is a KS-owned element.

**ADDED**

- `isolatePanelHostInteraction`, `stopPanelInteractionPropagation`,
  `bindPanelControls`, `handlePanelControl`, `setPanelControlState`.

**CHANGED**

- `ensureInlinePanel`, `ensurePresentationLayer`, `updatePanel` — panel
  control-row wiring only. War-path functions (claim/release, clock,
  Ranked War phase, classification, auto-release, FFScouter/Torn fetch)
  are character-identical to 1.5.167.

**KNOWN ISSUES**

- The file still has no `@updateURL` / `@downloadURL`, so it does not
  update itself further. Addressed after the war, in its own version.
- `instanceKey` still ends in `Test`
  (`__ksTornWarDibsPdaV15169Test`) — left as-is deliberately: changing it
  would make this file no longer the runtime-verified artifact.

**VERIFICATION**

- PDA VERIFIED 2026-09-12 on the owner's phone: the key controls open
  their edit box, Save and Cancel close it, and Torn's own collapse
  function still works outside the panel. War paths unchanged against
  1.5.167.

## KS Ranked War DIBS — 2026-09-11 — Torn PC + War Stuff Enhanced release

### Torn PC — KS Torn War Dibs WSE PC 0.1.0

A new, standalone Torn PC script on its own stable update channel
(`KS_Torn_War_Dibs_WSE_PC.user.js`), plus an immutable 0.1.0 snapshot. It is a
copy of KS Torn War Dibs PC 1.0.40 with exactly the changes needed to run on
the same Ranked War roster as Torn War Stuff Enhanced 2.1. It does not replace
`KS_Torn_War_Dibs_PC.user.js` (1.0.40), which is untouched. The two must never
be enabled at the same time in one browser: two KS DIBS clients on one page
talk to the same shared server.

**FIXED**

- Nothing. 0.1.0 is the first version of this script.

**ADDED**

- New standalone PC script, `KS Torn War Dibs WSE PC` 0.1.0: a copy of War
  Dibs PC 1.0.40 that coexists with War Stuff Enhanced 2.1 instead of blocking
  on it. The decision core — clock, hospital arithmetic, Ranked War phase,
  classify, shared-claim normalisation, claim/release, unreadable entries, the
  Torn and FFScouter transport — is character-identical to 1.0.40, checked
  function by function (123 core functions).
- FF and Est come from FFScouter's `/api/v1/get-stats` endpoint, the same code
  as War Dibs PDA 1.5.167, instead of from FF Scouter V2's row attributes. One
  batched GET for the opponent roster, refreshed at most once a minute, also
  permitted in the read-only VIEW mode. Hit Calling stays refused in VIEW.
- Own storage namespace (`ks_torn_war_dibs_wse_*`, IndexedDB
  `KSTornWarDibsWseSecure`): the Torn key and the FFScouter key are entered
  once more in this script.

**CHANGED** (relative to War Dibs PC 1.0.40)

- The War Stuff Enhanced gate no longer blocks. Presence is still detected and
  shown as a panel line, `WSE: detected` / `WSE: not detected`; nothing is
  gated on it.
- The Status cell is left to War Stuff Enhanced: KS no longer hides Torn's
  Status column and no longer renders its own status cell. The hospital
  countdown stays in the DIBS cell, as it already was.
- The FFScouter Sort/filter warning is gone; the panel FF line reports the
  get-stats fetch instead (`FF: syncing…`, `FF: n of m targets`,
  `FF: offline · <error>`).
- DIBS sorting is permanently off: War Stuff Enhanced re-sorts
  `ul.members-list` on every childList change and would undo it at once. The
  DIBS header is a plain label.
- The row observer no longer watches FF Scouter V2's `data-ff-value` and
  `data-est-value`.
- The panel disclosure text names the get-stats request and War Stuff
  Enhanced; `docs/API_DISCLOSURE.md` carries the same text.
- `@name`, `SCRIPT.name`, every storage key and every DOM id carry a `wse`
  namespace, so the script cannot collide with 1.0.40 if both are installed.

**KNOWN ISSUES**

- **The file carries no `@updateURL` and no `@downloadURL`.** Deliberate: with
  `@version` 0.1.0 below the published PC channel, an inherited `@updateURL`
  pointing at `KS_Torn_War_Dibs_PC.user.js` would have let Tampermonkey replace
  this script with the PC script. Updates are expected to reach existing
  installations through the installation address,
  `https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_Torn_War_Dibs_WSE_PC.user.js`
  — that Tampermonkey checks the install address when `@updateURL` is absent
  is an assumption, to be confirmed when the next version ships. A header
  update channel is a header change and gets its own version after the war.
- CLAIM and RELEASE in a LIVE own-faction war are not runtime-verified in this
  script. The code is character-identical to 1.0.40, which has been used in
  live wars, but 0.1.0 itself has only been run in PREWAR.
- Inherits PC 1.0.40's handling of zero-prefixed target IDs in the shared
  claims response (multi-client simulation row E2: PC, WSE and Call Guard
  store such a key uncanonicalised and can show that target as free, while
  PDA rejects the response). Not new and not changed here.
- Dead code inherited from 1.0.40 is left in place rather than cleaned up
  (`statusPresentation`, `STATUS_LABELS`, `freshApiStatusForTarget`,
  `viewMemberStatusForTarget`, the `rosterStatusWidthPx` measurement, the
  FF Scouter V2 attributes still listed in the observer filter). Harmless;
  cleanup is a separate version.

**VERIFICATION**

- Source: byte-identical to
  `KS Torn War Dibs/Test Artifacts/KS_Torn_War_Dibs_WSE_PC_v0.1.0_TEST.txt`
  — 222 737 bytes, 5 153 lines, SHA-256 `8E29B0C3…2AC7F8`, no BOM, LF
  throughout, first line `// ==UserScript==`, `node --check` clean. Both the
  stable channel file and the 0.1.0 snapshot carry that digest, pinned in
  `tests/fixtures/userscripts.json`.
- Build: generated from 1.0.40 by an asserted build script in which every edit
  must match exactly once. A per-function identity check found 216 of 253
  top-level functions character-identical, 27 changed — all inside the eight
  listed changes — 10 removed and 9 added. Multi-client simulation with 0.1.0
  as fourth client: the same button decision as PC in all 1 296 combinations,
  the same claim expiry second by second and in 97 ms steps, the same reading
  of 20 000 fuzzed server responses. Network surface: exactly two origins,
  `api.torn.com` and `ffscouter.com`; no `console.*`.
- Runtime: installed in the owner's real Torn PC runtime on 2026-09-11 in the
  owner's own Ranked War during PREWAR, with War Stuff Enhanced 2.1 and
  FF Scouter V2 enabled at the same time. Screenshot-verified: panel, DIBS
  column left of Attack, FF 60 of 60 targets via get-stats, Shared online,
  WSE detected.

## KS Ranked War DIBS — 2026-09-11 — Torn PDA release

### Torn PDA — KS Torn War Dibs 1.5.167

Replaces the 1.5.145 emergency build on the permanent Torn PDA stable update
channel and adds an immutable 1.5.167 snapshot. 1.5.145 is marked FAILED /
DO NOT USE in the project's own status files; anyone installing from the GitHub
raw URL today was walking into the 2026-09-12 ranked war on it.

The published file is the release copy
`KS Torn War Dibs/Releases/KS_Torn_War_Dibs_PDA_v1.5.167.txt`, which differs
from the runtime-verified artifact on exactly three lines — `@name` loses the
` TEST` suffix, `@description` loses its `TEST: ` prefix, and the panel's
version line drops ` TEST`. Verified by diff: six changed lines, no logic
difference.

**FIXED**

- **The lock.** A redraw of Torn's war card no longer resets the confirmed LIVE
  phase (1.5.151, `refreshCurrentWarSurface`). On 1.5.145 the DIBS button
  locked itself once the war started, which is what happened to the owner
  throughout the previous ranked war and is the single heaviest complaint
  against that build.
- **The clock.** The hospital countdown reads Torn time via Torn PDA's own
  `getCurrentTimestamp()` instead of the phone clock (1.5.154). A phone running
  ahead of Torn made the countdown show less time than there was, so the hit
  missed. The `+1` was removed and `hospitalUntilExpired` added, so an expired
  hospital time stops counting as hospital instead of persisting for up to 30
  seconds until the next member fetch.
- **Dropped claims.** CLAIM now goes through `hitApiWriteWithBusyRetry`
  (1.5.155). 1.5.145 gave up on the first refusal, so a `409 busy` — normal
  when several members claim at once, i.e. exactly the hottest moment of a war
  — lost the claim on the phone while PC retried and won. Same button press,
  different outcome per device.
- **Unreadable claims.** The same contract as PC (1.5.156): an unreadable
  entry is skipped and its target flagged `DIBS?` and unclaimable, while a
  shape fault is still rejected whole and takes the panel offline. On 1.5.145
  a single broken entry took the whole client offline.

**ADDED**

- Auto-release, ported from PC 1.0.38 (1.5.158): a claim is released once the
  target is back in hospital well above the claim gate.
- DEMO mode (1.5.162): a preview of the finished war look on a foreign roster.
  Pixels only — impossible on the owner's own war route, and sends nothing
  anywhere.

**CHANGED**

- The DIBS button moved to the Status cell and carries the hospital countdown
  itself (1.5.164). Measured 2026-09-05: Torn PDA's roster has no Attack
  column and its attack cell measures 0×0, so the button was never drawn at
  all on the previous layout.
- Three cell rules, one per version, so KS's own UI never covers Torn's: the
  native Status cell is hidden only while the button covers it (1.5.165), Est
  replaces the Score cell only when there is an estimate to show (1.5.166),
  and the FF pill on the nameplate stays blank and invisible until there is a
  real value (1.5.167) — it used to draw `FF -` across part of the member name
  on every row without an FF value.
- An unreadable hospital time reads `Hosp ?` instead of `Hosp 0:00` (1.5.163).
  Zero means attack now; unknown must never be able to say that.
- The country gate was removed (1.5.157). PC never had one, and two clients
  with different gates cannot say the same thing about the same target.
- `@name` changes from `KS Torn War Dibs` to `KS Torn War Dibs PDA`. Members
  will see the new name in their script manager. This is deliberate and
  harmless: Tampermonkey matches the update on the URL, not the name, and the
  filename `KS_Torn_War_Dibs.user.js` — the path the installed 1.5.145 points
  at in its `@updateURL` — is unchanged.

**KNOWN ISSUES**

- **The file carries no `@updateURL` and no `@downloadURL`.** The installed
  1.5.145 still points at this path, so this update reaches existing
  installations — but 1.5.167 itself declares no update channel, so it will
  not automatically update any further after this installation. Adding the two
  headers is a header change and needs its own version; it is deferred until
  after the war.
- The lock fix is proven against the rig, not against a live war. Measured:
  13 passed / 7 failed against 1.5.150, where the seven failures are exactly
  the lock behaviour, and 20 of 20 against 1.5.151. A real own-faction war is
  the only thing that can close it.
- Auto-release (1.5.158), busy-retry (1.5.155) and the unreadable-claim
  contract (1.5.156) cannot be verified outside an own-faction war, because
  the VIEW transport deliberately denies FFScouter. All three remain
  CANDIDATE.
- The Est overlay limitation recorded against 1.5.145 is superseded: Est is
  drawn from FFScouter's API by the script itself, and was confirmed on screen
  2026-09-05.
- The PDA test rig under `tools/war-dibs-pda/` is absent from disk and was
  never tracked in git, so the project's own test-gate step cannot be run.
  That blocks the next functional change, not this publication, which is a
  rename of an already runtime-verified file.

**VERIFICATION**

- Source: byte-identical to
  `KS Torn War Dibs/Releases/KS_Torn_War_Dibs_PDA_v1.5.167.txt` — 245 918
  bytes, SHA-256 `E0DE464C…5A6C072D`, no BOM, LF throughout, first line
  `// ==UserScript==`, `node --check` clean. Both the stable channel file and
  the 1.5.167 snapshot carry that digest, pinned in
  `tests/fixtures/userscripts.json`.
- Runtime: verified on a real Torn PDA against a foreign ranked war on
  2026-09-05 (two owner screenshots, Just Fer Khaos vs Subversive Alliance).
  Demo off: member names render whole with no `FF -` in front, Torn's own
  scores stand alone and readable, `Abroad` rows keep Torn's own cyan text.
  Demo on: FF pills, Est boxes and DIBS buttons all render in every state
  (`0:42 / DIBS · FF3.5`, `3h 12m / LOCKED`, `DIBS? / UNKNOWN`,
  `TAKEN / Kingshade`, `DIBBED / RELEASE`). No regression.
- Countdown measured against Torn's own timestamp on 2026-09-03: Torn moved
  seven seconds and four tracked targets each moved exactly seven seconds. No
  drift.
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
