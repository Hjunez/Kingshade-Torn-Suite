# KS Ranked War DIBS

Two coordinated userscripts provide shared Ranked War target claims across Torn PDA and FFScouter War Room.

## Current releases

| Platform | Script | Version | Stable install URL |
|---|---|---:|---|
| Torn PDA | KS Torn War Dibs | 1.5.91 | `https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_Torn_War_Dibs.user.js` |
| PC / Tampermonkey | KS FFScouter Call Guard | 1.1.2 | `https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_FFScouter_Call_Guard.user.js` |

The unversioned URLs are the stable update channels. Versioned snapshots are retained for rollback and auditability.

## What the system does

- Reads the currently displayed Ranked War roster and binds targets by Torn player ID.
- Shows FFScouter Fair Fight and battle-stat estimate information on Torn PDA.
- Uses real Hospital status/countdown in release mode.
- DIBS is eligible only when Hospital time is **2:00 or less** and Fair Fight is **2.00–5.00 inclusive**.
- The first successful FFScouter Hit Calling claim wins.
- Other users see **TAKEN + claimant name**.
- The claimant can **RELEASE** the target.
- One user can hold only one active DIBS at a time.
- No attack, travel, crime, purchase or other Torn action is automated.

## Torn PDA installation

1. Open the stable raw URL for `KS_Torn_War_Dibs.user.js` in Torn PDA.
2. Add or replace the userscript and enable it.
3. Open the Torn faction Ranked War page and interact with the page so the script enters its active-view state.
4. In the **KS Torn War Dibs** panel, configure the Torn API key and FFScouter key if they are not already stored.
5. Use **Create custom API key** for the least-privilege Torn key flow exposed by the script.
6. Confirm the panel reports Torn and Shared/FFScouter connectivity before the war.

### PDA key/data behavior

- Torn API key: encrypted locally in the browser and sent only to `api.torn.com`.
- Torn API purpose: faction member Hospital/status data and key-owner identity for Ranked War DIBS.
- FFScouter key: encrypted locally and sent only to FFScouter.
- FFScouter receives visible target IDs for documented FF/estimate and Hit Calling operations.
- Shared claim/release state is provided through FFScouter Hit Calling.
- Network/DOM work is gated to the visible, focused and recently interacted-with page.

## PC / Tampermonkey installation

1. Open Tampermonkey and choose **Create a new script**.
2. Delete the template content.
3. Install the contents of the stable `KS_FFScouter_Call_Guard.user.js` URL and save it.
4. Make sure the script is enabled.
5. Open FFScouter War Room.
6. Use your own FFScouter-compatible 16-character API key in FFScouter as normal.
7. In the **KS Call Guard** panel, choose **Set key** and enter the same FFScouter-compatible key.

The Call Guard key is encrypted locally. KS Call Guard makes no direct Torn API requests.

## Live DIBS rules

- Hospital **> 2:00**: locked.
- Hospital **<= 2:00** + FF **2.00–5.00**: claimable.
- FF **< 2.00**: locked.
- FF **> 5.00**: locked.
- Unknown/unverifiable FF: locked.
- First successful claim wins.
- Other faction members see TAKEN and the claimant name after shared state synchronizes.
- The claimant uses RELEASE to relinquish the target.

Do not spam DIBS. One click is sufficient; repeated rapid clicks create overlapping requests and make first-claim behavior harder to diagnose.

## Compliance design

The release builds are intentionally conservative:

- No programmatic Torn clicks or automated attacks.
- No Torn-page fetch/XHR/WebSocket scraping.
- Torn requests use the official Torn API.
- FFScouter requests use its documented integration endpoints.
- Shared claim polling is 2.5 seconds (24/minute), below the documented 60/minute Hit Calling claims limit.
- API/data disclosure is shown in the script UI.
- Keys are encrypted locally where supported.
- Release test/simulation Worker code is absent.

References:

- Torn API Terms of Service: https://www.torn.com/api.html
- Torn rules: https://www.torn.com/rules.php
- FFScouter terms/data policy: https://ffscouter.com/
- FFScouter privacy: https://ffscouter.com/privacy
- FFScouter API documentation: https://ffscouter.com/api-docs

## Pre-war smoke test

Before a Ranked War:

1. Verify both scripts report their current release versions.
2. Verify keys load without errors.
3. Confirm FF/Est appears on PDA.
4. Confirm a real Hospital target above 2:00 remains locked.
5. Confirm a real target at <=2:00 is claimable only with FF 2.00–5.00.
6. Claim once from one client, verify TAKEN + claimant name on another, then RELEASE.

## Troubleshooting

- **Shared offline / too many requests:** wait for the backoff period; do not repeatedly press Sync.
- **No FF/Est:** verify FFScouter key and that the target/player IDs are visible on the current roster.
- **No Hospital timer on PDA:** verify Torn API status is online and the target is genuinely in Hospital.
- **War Room button locked:** check Hospital time and FF range; unknown FF is intentionally non-claimable.
- **Old behavior after update:** confirm the installed userscript version and stable raw URL, then reload the relevant page once.

## Reporting problems

Include script version, platform/browser, a screenshot or short recording, the target status/FF, and whether the issue persists after one page reload. Never include API keys in screenshots or reports.
