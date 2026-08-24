# War Dibs offline Chrome arena

The arena opens the repository's current `KS_Torn_War_Dibs.user.js` in an isolated, deterministic
desktop Google Chrome session. It is intended for visual inspection and repeatable UI stress work;
it never loads the live Torn or FFScouter sites and never performs an attack.

## Requirements

- The repository's normal development dependencies installed with `npm ci`
- A locally installed stable Google Chrome
- Node.js 22.15 or newer

The launcher uses Playwright's `chrome` channel to find the installed browser. It creates a fresh
temporary browser profile and does not open or alter the user's normal Chrome profile.

## One-click launch from VS Code

Open **Run and Debug**, select **War Dibs: Offline Chrome arena**, and press the green Run button.
The equivalent command is also available through **Terminal > Run Task** as **War Dibs: Open
offline Chrome arena**.

From Codex, ask it to “open the War Dibs offline Chrome arena.” Codex can run the same launcher; the
app may ask for approval because opening a visible desktop program crosses the managed sandbox. No
terminal typing is required in either workflow.

Close the arena's Chrome window or stop its dedicated VS Code terminal to shut down both the arena
and its temporary browser process. VS Code limits the task to one running instance.

## Command-line and Codex launch

On Windows:

```powershell
npm.cmd run arena:war-dibs
```

On macOS or Linux, use `npm`, although the machine must provide a Playwright-supported stable Chrome
channel. A managed Codex session may ask for approval before it launches a visible desktop program.

For a bounded headless startup check that closes itself:

```powershell
npm.cmd run arena:war-dibs:smoke
```

The smoke command verifies that the panel and deterministic player rows mount. It is a launcher
self-check, not a replacement for the browser regression suite.

## Offline and security model

The arena reuses the deterministic Playwright War Dibs harness:

- The Torn-shaped HTTPS page is fulfilled from the repository fixture without a local web server.
- Torn and FFScouter `GM_xmlhttpRequest` calls receive deterministic in-memory responses.
- Native `fetch` and `XMLHttpRequest` are blocked.
- Browser-context routing blocks unexpected page requests, popups, and service workers.
- The context is placed offline after its fixture has mounted.
- Fixture API keys exist only inside the temporary browser context.

Using an intercepted Torn-shaped URL preserves URL, origin, storage, and SPA behavior that an
`about:blank` `setContent()` page would lose. It also avoids localhost ports, Windows Firewall
prompts, and orphaned local-server processes.

Playwright blocks the arena page's traffic. Installed Chrome can still have browser-process update,
policy, or telemetry services outside the page context; the launcher disables the common background
features, but only operating-system network isolation can prove that the Chrome executable emitted
no packets at all.

## What to inspect

The fixed **Desktop Test Arena** panel remains available even while the production UI is expected to
unmount. Its controls exercise the actual repository userscript and existing test harness:

| Control group           | Deterministic scenarios                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hospital and Fair Fight | Static 2:01/2:00/1:59 gates, a live production-timer transition through 2:01 → 2:00 → 1:59 with Torn time deliberately +1 second, and FF 1.99/2.00/3.00/4.50/5.00/5.01                     |
| Claims                  | CLAIM/DIBBED, RELEASE, reclaim, shared TAKEN with named queue members, simultaneous winner and position-two loser cleanup                                                                  |
| Ordering and errors     | Held stale claims response, old FF response resolved after player replacement, mocked Torn and FFScouter 503 states, and recovery after deterministic backoff advancement                  |
| Lifecycle               | Expected inactivity sleep, blur/resume, hidden/visible transitions, repeated background/foreground cycles, SPA root removal, and remount                                                   |
| Desktop stress          | Long text, existing-node reorder, complete replacement, full row recycling, attribute-only identity recycling, fast scroll loops, 1280/784/783px viewports, and bounded repeated DOM churn |
| Known regressions       | Responsive DIBS width at 784→783px and the unrecognized-cell Attack text fallback remain deliberately reproducible                                                                         |

Every row has a bright `ID nnnnnn` gutter badge. Live diagnostics independently list that profile
ID beside Hospital, FF/Est, and DIBS state, then report duplicate ownership, hidden/clipped text,
zero geometry, row overlap, controls outside their rows, and DIBS/Attack width divergence. Use
**RESET clean arena session** to create a fresh temporary context without restarting Chrome; this
clears claims, held responses, queues, clocks, storage, backoff, and production timers.

Press **Minimize** before direct visual inspection. The controller then becomes an 86px
**Show arena** tab contained entirely inside the test-only player-ID gutter, so it cannot cover the
names, decorations, or DIBS/Attack column. Visual stress and known-regression controls minimize it
automatically. Exact and sub-second clock assertions remain in the deterministic automated timing
suite; the arena's live countdown is for real-Chrome visual inspection.

Inspect that:

- Player names and titles remain visible and unclipped.
- FF/Est values and arrows stay on the correct player row.
- Decorations do not move vertically or overlap neighboring rows.
- Exactly one DIBS control remains inside each eligible player's action area.
- CLAIM, TAKEN, RELEASE, and error states remain attached to the intended player.

The arena intentionally uses the same regression model as the automated tests. It does not redefine
or suppress documented known regressions. The responsive-width and Attack-fallback diagnostics are
expected to report an issue until separately authorized production versions address them.

## Limits and live verification

The arena uses fixture HTML/CSS, deterministic API responses, and direct userscript injection. It
does not reproduce Tampermonkey/PDA isolation, live Torn React virtualization or CSS, real
FFScouter atomic races, operating-system background throttling, BFCache, or every font, DPI, zoom,
GPU, and compositor combination. Those behaviors still require deliberate manual verification in
the real supported environment. Live Torn/FFScouter authentication and schema drift, true
multi-client claim atomicity, real Ranked War row recycling, and Torn's deployed responsive layout
therefore still need a real Ranked War. Never automate a live Torn attack from this arena.
