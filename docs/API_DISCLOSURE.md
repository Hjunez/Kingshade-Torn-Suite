# Kingshade Suite API and Data Disclosure

This disclosure is also displayed directly beside the API-key input in Suite Control Center.

| Category | Disclosure |
|---|---|
| Data storage | The API key, acceptance state, settings, manual values, notes and cached FF/EST, available-estimate, Premium/distribution/spy, status and travel data are stored locally in the Torn PDA webview until cleared or removed. |
| Data sharing | Torn API receives the key. FFScouter receives the key and visible target player IDs where required by its documented endpoints. Kingshade Suite has no developer-operated server and the developer receives no keys or user data. |
| Purpose of use | Show FF/EST values, map visible faction members, provide faction status/timers and flight estimates, and support filters and sorting. |
| Key storage and sharing | The Suite stores the key locally and sends it over HTTPS only to Torn API and FFScouter. FFScouter independently handles registered keys and data under its own terms and data policy. |
| Key access level | Direct Kingshade Suite Torn use is custom `faction/basic`. Full access is not required by Kingshade Suite. FFScouter may require its own documented selections for its services. |

## Network behavior

- Requests run only while a manually opened Torn page is visible and focused; active requests are aborted on hide or blur.
- Torn requests use the official faction `basic` selection.
- FFScouter integration uses its documented `/register`, `/check-key`, `/get-stats` and `/player-flights` flows.
- FFScouter registration occurs only after the user explicitly presses **Register this key with FFScouter** after the linked FFScouter terms/data policy are available in the Scout panel.
- No attacks, clicks, travel, purchases, crimes or other Torn actions are automated.
- No background alerts are generated from hidden or unfocused Torn pages.

## KS Torn War Dibs WSE PC 0.1.0

`KS_Torn_War_Dibs_WSE_PC.user.js` shows this disclosure in its panel, beside the key controls. Copied verbatim from the script:

- **Torn API key:** stored only locally, encrypted in this browser; sent only to api.torn.com. Purpose: key-owner identity, own-faction Ranked War state, one opponent-members status batch while the roster is visible, and one final target basic check immediately before DIBS. Required selections: faction → members,wars and user → basic.
- **FFScouter key/integration:** key stored only locally, encrypted in this browser; sent only to FFScouter for shared Hit Calling claims, claim and release, and to FFScouter's get-stats endpoint for Fair Fight and battle-stat estimates of the opponent roster (one batched request, refreshed at most once a minute). FFScouter terms/data policy: https://ffscouter.com/ · Privacy: https://ffscouter.com/privacy.
- **War Stuff Enhanced:** detected read-only. This script never writes to, hides or moves anything War Stuff Enhanced renders.

`@connect` hosts: `ffscouter.com`, `api.torn.com`. Torn endpoints: `/v2/key/info`, `/v2/faction/wars`, `/v2/faction/{id}/members`, `/v2/user/{id}/basic`. FFScouter endpoints: `/api/v1/hit-calling/claims`, `/api/v1/hit-calling/claim`, `/api/v1/hit-calling/unclaim`, `/api/v1/get-stats`. In read-only VIEW mode on another faction's Ranked War page only the members batch and get-stats are sent.

## External policies

- Torn API Terms: https://www.torn.com/api.html
- Torn scripting rules: https://www.torn.com/rules.php
- FFScouter terms and data policy: https://ffscouter.com/
- FFScouter privacy policy: https://ffscouter.com/privacy
- FFScouter API docs: https://ffscouter.com/api-docs
