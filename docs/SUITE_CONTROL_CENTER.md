# Suite Control Center

## Scope

Suite Control Center is hosted by Scout and coordinates the existing Scout and War Tools components. It is available from the KS button on faction member-list pages.

## Ownership

- **Scout** owns the panel, FF/Torn API access, shared status snapshot, cache and manual data.
- **War Tools** owns faction filtering, sorting and timer rendering.
- **Control Center** calls component interfaces; it does not duplicate War Tools rendering or move network ownership away from Scout.

## Tabs

- **Overview:** component/version health, API-key state, status age/member count and local-data counts.
- **Scout:** existing Scout preferences and maintenance actions.
- **War Tools:** persistent filter/sort/threshold/collapse settings.
- **Data:** privacy disclosure and targeted cache clearing.

## War Tools interface

`window.__ksWarToolsActive` exposes:

- `getSettings()`
- `updateSettings(partial)`
- `resetSettings()`
- `getStatus()`
- `refresh()`
- `destroy()`

Settings are validated before storage. The component also listens for `kingshade-war-tools:settings-command` and emits `kingshade-war-tools:settings-update`.

## Compatibility

Scout and War Tools retain separate localStorage keys. Existing 0.8.3 preferences migrate automatically because the key names are unchanged.

## Safety

The Control Center changes local presentation and data settings only. It does not click, attack, travel, purchase or perform other Torn actions.
