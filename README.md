# Kingshade Torn Suite

![Platform](https://img.shields.io/badge/Platform-Torn%20PDA-blue)
![Suite](https://img.shields.io/badge/Kingshade%20Suite-0.8.4%20Beta-orange)
![Status](https://img.shields.io/badge/Status-Faction%20testing-yellow)

A compact collection of read-only Torn PDA userscripts by **Kingshade**. The scripts add information, filtering and visual guidance without performing Torn actions for the player.

## Kingshade Suite 0.8.4 Beta

Scout and War Tools are one coordinated suite. They must always use the **same version number**.

### Kingshade Scout 0.8.4

Faction-member intelligence, shared data core and the Suite Control Center.

- FF Scouter Fair Fight values
- Estimated battle-stat fallback when FF is unavailable
- Full-row FF colour scale
- Manual FF, battle-stat values and notes
- Shared faction status data for War Tools
- Exact Hospital, Jail and Federal end timestamps when Torn exposes them
- Marked travel-time estimates when Torn does not expose an exact arrival timestamp
- Active-page-only network requests
- Reduced rescanning and smoother scrolling on long member lists
- Tabbed Suite Control Center for overview, Scout, War Tools and local-data controls

**Repository file:** `Kingshade_Scout_Torn_PDA_v0.8.4.user.js`

**Raw installation URL:**

`https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/Kingshade_Scout_Torn_PDA_v0.8.4.user.js`

### KS War Tools 0.8.4

Mobile faction filters, sorting and status timers powered by Scout.

- ALL, READY, EASY NOW, SOON and NO DATA filters
- Configurable maximum FF and SOON window
- Sorting by original order, FF, status and ending time
- Exact Hospital, Jail and Federal countdowns
- Travel estimates clearly prefixed with `~`
- `TRAVEL ~?` when no trustworthy ETA can be produced
- Clickable attacker names only when Torn exposes a verifiable profile ID
- Version-mismatch warning when Scout and War Tools do not match
- No independent API requests and no automated Torn actions
- Public settings/status interface used by the Suite Control Center

**Repository file:** `KS_War_Tools_Torn_PDA_v0.8.4.user.js`

**Raw installation URL:**

`https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_War_Tools_Torn_PDA_v0.8.4.user.js`

### Suite Control Center

Open the **KS** button on a faction member list to manage the coordinated Suite from one panel.

- **Overview:** component state, version match, API-key state, status snapshot and local-data counts
- **Scout:** FF Scouter key, unknown-player display, button style, rescan and position reset
- **War Tools:** default filter, sorting, Easy max FF, SOON window and collapsed state
- **Data:** privacy disclosure and cache reset that preserves manual values, notes, key and preferences

The Control Center changes settings only. It performs no Torn actions.

### Timer accuracy

- **Hospital, Jail and Federal:** exact countdowns based on Torn's exposed end timestamp.
- **Traveling:** estimates only. Torn does not expose another player's exact departure or arrival timestamp.
- **Abroad:** no countdown because the player is stationary abroad.

## Kingshade's Bootlegging Clean 4.1.1

Standalone visual guidance for the Bootlegging crime. It keeps its own version number.

- Blue highlight — copy that genre
- Green highlight — sell counterfeit DVDs
- No highlight — wait
- Reads only Bootlegging data already loaded on the open Crimes page
- Does not click, perform crimes or initiate additional Torn requests

**Repository file:** `Kingshades_Bootlegging_Clean_v4.1.1.user.js`

**Raw installation URL:**

`https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/Kingshades_Bootlegging_Clean_v4.1.1.user.js`

## Installation in Torn PDA

1. Open the raw installation URL for each required script.
2. Add the script to Torn PDA's userscript manager.
3. Enable both Scout and War Tools.
4. Confirm that both display version **0.8.4** and that the KS button opens **Suite Control Center**.
5. Disable older Scout and War Tools versions.

## Feedback for faction testing

Include:

- Scout and War Tools version numbers
- Torn PDA and Android versions
- A screenshot of the faction member list and War Tools panel
- The active filter or sort mode
- Whether the problem remains after one page reload

Never include an API key in screenshots, reports or issues.

## Repository workflow

- `main` contains the current released build.
- `dev` is the integration branch for future work.
- `feature/...` branches contain isolated changes.
- `release/...` branches prepare a version for `main`.
- `test-status-timers` is retained as the historical v0.8.4 faction-test branch.
- Scout and War Tools always share the version stored in [`VERSION`](VERSION).
- Temporary diagnostics, test notes, ZIP archives and duplicate script copies do not belong in the repository root.

See [`docs/RELEASE_PROCESS.md`](docs/RELEASE_PROCESS.md).

## Validation

Every push and pull request runs an automated repository check. It verifies:

- Suite version consistency
- Required script filenames
- Userscript metadata versions
- README and CHANGELOG version references
- Absence of temporary diagnostics, test notes and ZIP files

Run locally with:

```bash
bash tools/validate-suite.sh
```

## Licensing

See [`LICENSES.md`](LICENSES.md). The repository contains scripts with different licensing status.

## Disclaimer

Unofficial community project. Not affiliated with Torn City or FF Scouter.
# test
