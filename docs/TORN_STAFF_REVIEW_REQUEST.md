# Torn Staff Review Request

## Official contact route

Torn's API documentation links uncertain developers to the logged-in staff directory:

- https://www.torn.com/staff.php

There is no publicly documented email address dedicated to userscript approval. Use the in-game staff page and ask the contacted staff member to route the request to the appropriate API/scripting reviewer. Torn may provide guidance rather than a formal certification.

## Message to send to Torn staff

**Subject:** Request for scripting/API compliance review — Kingshade Suite 0.8.5

Hello,

I am requesting a compliance review of an open-source Torn PDA userscript suite before wider faction testing.

Repository:
https://github.com/Hjunez/Kingshade-Torn-Suite

Version / branch to review:
Kingshade Suite 0.8.5 draft compliance pull request:
https://github.com/Hjunez/Kingshade-Torn-Suite/pull/7

Scripts:
- Kingshade Scout for Torn PDA
- KS War Tools for Torn PDA

What the Suite does:
- Reads the faction member list that the user has manually opened and is actively viewing.
- Uses Torn's official API with the `faction/basic` selection for member mapping and status/timer data.
- Uses FFScouter's documented `GET /api/v1/get-stats` endpoint for FF and battle-stat estimates.
- Adds visual labels, row colours, filters, sorting, status timers and a settings panel.

What it does not do:
- No automatic attacks, clicks, travel, purchases, crimes or other Torn actions.
- No non-API Torn page requests.
- No scraping of pages that are not manually open and visible.
- No requests or alerts while Torn is hidden or unfocused; active requests are aborted on visibility loss or window blur.
- No CAPTCHA bypass.
- No developer-operated server.

API disclosure:
- A full Torn API ToS table is displayed directly beside the API-key field.
- Network requests are blocked until the user explicitly accepts the disclosure.
- The key is stored locally in Torn PDA and transmitted over HTTPS only to Torn API and FFScouter.
- Links to Torn's API terms/rules and FFScouter's terms/data policy are provided.

Could you please confirm whether this design complies with Torn's scripting rules and API Terms of Service, or identify any changes required before faction testing?

Thank you.
