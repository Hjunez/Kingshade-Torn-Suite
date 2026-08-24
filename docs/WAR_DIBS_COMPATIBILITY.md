# KS Torn War Dibs desktop compatibility regressions

The compatibility suite executes the repository's actual `KS_Torn_War_Dibs.user.js` in bundled
Chromium and installed Google Chrome. Torn and FFScouter requests remain blocked by the existing
offline harness. External tools are represented by deterministic DOM/CSS contract models derived
from their current published source; their application logic and network clients are not copied or
executed.

## Profiles and support policy

| Profile                            | Modeled external behavior                                                                              | Policy                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| Vanilla Torn                       | Native fixture only                                                                                    | Supported                |
| FF Scouter V2                      | War filter mount, initialized/display attributes, FF header and per-row FF cells                       | Supported                |
| TornTools                          | Ranked-War stats estimate row marker and estimate block                                                | Supported where feasible |
| FF Scouter V2 + TornTools          | Standalone FF column plus TornTools stats estimates, with TornTools' own FFScouter connection disabled | Conditional              |
| War Stuff Enhanced                 | WSE boot/current-row markers, status replacement, copy button and complete-row sort                    | Unsupported              |
| War Stuff Enhanced + FF Scouter V2 | Both source-derived models                                                                             | Unsupported              |

The suite also has a negative configuration for standalone FF Scouter V2 plus TornTools' built-in
FFScouter gauge. It proves that two independent FF providers are visible at once. That is a
configuration error, not a supported combined profile.

Run the compatibility spec in bundled Chromium:

```powershell
npx playwright test tests/browser/war-dibs-compatibility.spec.js
```

Run it in both bundled Chromium and installed Google Chrome:

```powershell
npx playwright test tests/browser/war-dibs-compatibility.spec.js --config playwright.desktop.config.js
```

## Source contracts

### FF Scouter V2 3.1

The model uses the current script's documented war contracts:

- `html[__FF_SCOUTER_V2_INJECTED__="1"]` as the document-start singleton;
- `.faction-war[data-ffscouter-initialized][data-ffscouter-col-display]`;
- one `[data-ff-filter-box][data-mode="war"]` mount;
- a `.ffscouter-header` after the native Level header;
- one `.ffscouter-cell` after each native Level cell; and
- FFScouter's narrower native Level, Points and Status widths while its column is active.

Primary reference: [FFScouter source glossary](https://github.com/xentac/FFScouter/blob/main/CONTEXT.md).

### TornTools 9.1.2 / source revision `6beab148`

Current TornTools Ranked-War stats estimates mark a row `.tt-estimated[data-estimate]` and insert a
`.tt-stats-estimate` block after the row's native `.clear`. This extra block can increase row height.
The current source does not reliably add the older `.tt-last-action` sibling to active Ranked-War
rows, so that class is documented as a legacy/interoperability observation rather than a required
profile marker.

TornTools' optional FFScouter connection is a separate honor/name gauge. Its active markers are
`.tt-ff-scouter-indicator` and a child `.tt-ff-scouter-arrow`; `data-ff-scout` alone can remain after
cleanup and is not sufficient detection. TornTools' Ranked War Filter can deliberately hide rows
with `.tt-hidden[data-hide-reason]`, so hidden rows must not be diagnosed as DIBS clipping until the
filter state is checked.

Primary references:

- [Ranked-War stats-estimate integration](https://github.com/Mephiles/torntools_extension/blob/6beab14825caa14d951544c7af11c2b174cd3306/src/common/features/stats-estimate/stats-estimate-faction-ranked-wars.ts)
- [TornTools FFScouter gauge](https://github.com/Mephiles/torntools_extension/blob/6beab14825caa14d951544c7af11c2b174cd3306/src/common/features/ff-scouter/ff-scouter-gauge.ts)
- [FFScouter's TornTools conflict guidance](https://ffscouter.com/guides/ff-scouter-v2-installation#6-fix-torntools-conflicts-if-applicable)

When standalone FF Scouter V2 is installed, disable TornTools Settings > Connections > FFScouter >
Enable FFScouter. The safe combined model keeps TornTools stats estimates but has only one FF
provider.

### Torn War Stuff Enhanced 2.1

The current WSE source:

- stamps `data-twse-injected="true"` on `<html>` when it boots;
- annotates current `.enemy`/`.your` rows with `data-twse-last-action-timestamp` and other sort/state
  data;
- adds `.twse-copy-btn[data-player-id]` to `.member` without reserving text width;
- replaces Status presentation through `[data-twse-overridden]`, `--twse-content` and `::after`; and
- reorders complete row nodes through a `DocumentFragment`.

That Status `::after` is the same rendering slot War Dibs uses for its Hospital countdown. The
compatibility spec deterministically reproduces both owners on one status cell. WSE also forces
Member flex layout and places its copy button over the Member cell, which makes the severity of
name/title overlap dependent on Torn's current widths and the user's other extensions.

Primary references:

- [WSE 2.1 published source](https://greasyfork.org/en/scripts/529238-torn-war-stuff-enhanced/code)
- [WSE war-monitor source](https://github.com/xentac/torn_war_stuff_enhanced/tree/main/src/features/war-monitor)
- [FFScouter's documented WSE presence contract](https://github.com/xentac/FFScouter/blob/main/CONTEXT.md#twse-presence-detection)

## Future WSE guard design

No production guard is implemented by this test work. The smallest fail-closed design is:

1. Before any roster mount, check the persistent root marker
   `document.documentElement.hasAttribute('data-twse-injected')`.
2. Also check the connected current war roster for at least one
   `li.enemy[data-twse-last-action-timestamp]` or `li.your[...]`. A value of `0` still proves WSE
   ownership. Use connected `.twse-copy-btn[data-player-id]` and
   `.status[data-twse-overridden]` as secondary markers.
3. Repeat detection from the existing SPA/roster observation path because WSE can load after War
   Dibs. Do not depend on optional chain bubbles, settings panels, generic `data-until`, or a
   transient custom event.
4. On detection, call the existing War Dibs teardown path so all DIBS hosts, Est/FF decorations,
   Hospital overlays and layout ownership are removed. Render one non-roster warning: "War Stuff
   Enhanced is unsupported. Disable it and reload Torn before using KS War Dibs."
5. Keep the warning idempotent and require a clean reload after WSE is disabled; WSE intentionally
   leaves some markers and DOM changes behind during same-page cleanup.

The guard should not attempt to patch around WSE CSS or selectively leave War Dibs roster elements
mounted. That would preserve the contested ownership state the guard is meant to prevent.

## Limits of automation

The regression profiles prove source-level marker ownership, deterministic DOM mutation behavior,
row identity, and browser geometry in the repository fixture. They do not execute third-party
network code or guarantee the exact severity of a particular live Torn stylesheet/extension build.
The reported WSE + FFScouter + War Dibs whole-page corruption still needs one manual installed-Chrome
pass on a live active Ranked War with the affected user's extension settings and zoom captured.
