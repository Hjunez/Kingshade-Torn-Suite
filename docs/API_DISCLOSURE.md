# Kingshade Suite API and Data Disclosure

This disclosure is also displayed directly beside the API-key input in Suite Control Center.

| Category | Disclosure |
|---|---|
| Data storage | The API key, acceptance state, settings, manual values, notes and cached FF/profile/status/travel data are stored locally in the Torn PDA webview until cleared or removed. |
| Data sharing | Torn API receives the key. FFScouter receives the key and visible target player IDs. Kingshade Suite has no developer-operated server and the developer receives no keys or user data. |
| Purpose of use | Show FF/EST values, map visible faction members, and provide faction status/timers, filters and sorting. |
| Key storage and sharing | The Suite stores the key locally and sends it over HTTPS only to Torn API and FFScouter. FFScouter independently handles registered keys and data under its own terms and data policy. |
| Key access level | Direct Kingshade Suite use is custom `faction/basic`. FFScouter's separate custom selections are listed in its policy. Full access is not required by Kingshade Suite. |

## Network behavior

- Requests run only while a manually opened Torn page is visible.
- FFScouter requests use the documented `GET /api/v1/get-stats` endpoint.
- Torn requests use the official faction `basic` selection.
- No attacks, clicks, travel, purchases, crimes or other Torn actions are automated.
- No background alerts are generated from hidden or unfocused Torn pages.

## External policies

- Torn API Terms: https://www.torn.com/api.html
- Torn scripting rules: https://www.torn.com/rules.php
- FFScouter terms and data policy: https://ffscouter.com/
- FFScouter privacy policy: https://ffscouter.com/privacy
- FFScouter API docs: https://ffscouter.com/api-docs
