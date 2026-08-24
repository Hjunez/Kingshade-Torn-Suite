import {
  clickPanelRole,
  forceWarDibsScan,
  readWarDibsFixture,
  startWarDibsHarness,
  warDibsControl,
  warDibsSelectors,
} from './war-dibs-playwright.js';
import {
  buildDesktopRows,
  captureWarDibsUi,
  expectedVisualSignature,
  readDesktopUiFixture,
  recycleWarRowsInPlace,
  reorderWarRows,
  swapRowIdentityAttributes,
  waitForUiFrames,
} from './war-dibs-ui.js';

const arenaRootId = 'ks-war-dibs-test-arena';
const arenaPanelTestId = 'war-dibs-arena-panel';
const arenaCommandBinding = '__ksWarDibsArenaCommand';
const localClockTickMs = 100;

const commandGroups = Object.freeze([
  {
    label: 'Hospital and Fair Fight',
    commands: [
      ['hospital-gates', 'Hospital > / = / < 2:00'],
      ['countdown-live', 'Run live 2:01 → 2:00 → 1:59'],
      ['countdown-pause', 'Pause live clock'],
      ['clock-plus-one', 'Advance local clock +1s'],
      ['fair-fight-gates', 'FF <2 / 2 / normal / 5 / >5'],
    ],
  },
  {
    label: 'Claims and transport ordering',
    commands: [
      ['claim-load', 'Load claim target'],
      ['claim', 'CLAIM (winner / DIBBED)'],
      ['release', 'RELEASE'],
      ['reclaim', 'Reclaim'],
      ['shared-taken', 'Shared TAKEN + claimant'],
      ['race-win', 'Simultaneous claim: winner'],
      ['race-lose', 'Simultaneous claim: loser'],
      ['stale-claims', 'Stale claims response'],
      ['out-of-order-stats', 'Out-of-order FF response'],
      ['api-errors', 'Show Torn + FF API errors'],
      ['api-recover', 'Recover Torn + FF APIs'],
    ],
  },
  {
    label: 'Lifecycle',
    commands: [
      ['inactivity', 'Enter expected inactivity sleep'],
      ['background', 'Simulate background / blur'],
      ['foreground', 'Resume foreground'],
      ['visibility-hide', 'Hide tab'],
      ['visibility-show', 'Show tab'],
      ['background-cycles', 'Repeat background / foreground'],
      ['spa-remove', 'Remove SPA war root'],
      ['spa-remount', 'Remount SPA war root'],
    ],
  },
  {
    label: 'Desktop DOM and layout stress',
    commands: [
      ['long-roster', 'Load long names and titles'],
      ['row-reorder', 'Reverse row order'],
      ['row-replace', 'Complete row replacement'],
      ['row-recycle', 'Recycle existing rows'],
      ['attribute-recycle', 'Attribute-only identity recycle'],
      ['scroll-stress', 'Rapid repeated scrolling'],
      ['resize-1280', 'Viewport 1280px'],
      ['resize-784', 'Viewport 784px'],
      ['resize-783', 'Viewport 783px'],
      ['dom-churn', 'Start repeated DOM churn'],
      ['dom-churn-stop', 'Stop DOM churn'],
    ],
  },
  {
    label: 'Known baseline regressions and utilities',
    commands: [
      ['responsive-width-regression', 'Reproduce responsive DIBS width'],
      ['attack-fallback-regression', 'Reproduce Attack fallback'],
      ['sync', 'Run real War Dibs Sync'],
      ['refresh', 'Refresh diagnostics'],
      ['reset', 'RESET clean arena session'],
    ],
  },
]);

/**
 * @typedef {import('@playwright/test').Browser} Browser
 * @typedef {import('@playwright/test').BrowserContext} BrowserContext
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {Awaited<ReturnType<typeof readWarDibsFixture>>} WarDibsFixture
 * @typedef {WarDibsFixture['hospitalGateRows'][number]} FixtureRow
 * @typedef {Awaited<ReturnType<typeof startWarDibsHarness>>} WarDibsHarness
 * @typedef {{width: number, height: number}} Viewport
 * @typedef {{ok: boolean, message: string}} ArenaCommandResult
 *
 * @typedef {{
 *   context: BrowserContext,
 *   page: Page,
 *   harness: WarDibsHarness,
 *   fixture: WarDibsFixture,
 *   desktopFixture: Awaited<ReturnType<typeof readDesktopUiFixture>>,
 *   rows: FixtureRow[],
 *   scenario: string,
 *   contextBlockedNetwork: string[],
 *   clockTimer: ReturnType<typeof setInterval> | null,
 *   clockRunId: number,
 *   churnRunId: number,
 *   expectedSuspension: boolean,
 * }} ArenaSession
 *
 * @typedef {{
 *   readonly page: Page,
 *   command: (id: string) => Promise<ArenaCommandResult>,
 *   snapshot: () => Promise<any>,
 *   reset: () => Promise<void>,
 *   close: () => Promise<void>,
 *   waitUntilClosed: () => Promise<void>,
 * }} WarDibsArena
 */

/**
 * Opens a permanent, headed-or-headless arena around the actual repository
 * userscript. Every browser context is ephemeral and every transport boundary is
 * deterministic and offline.
 *
 * @param {Browser} browser
 * @param {{smoke?: boolean, viewport?: Viewport | null}} [options]
 * @returns {Promise<WarDibsArena>}
 */
export async function launchWarDibsArena(browser, options = {}) {
  /** @type {ArenaSession | null} */
  let current = null;
  /** @type {Promise<void> | null} */
  let resetPromise = null;
  let closed = false;
  /** @type {(value?: void | PromiseLike<void>) => void} */
  let resolveClosed = () => {};
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const finish = () => {
    if (closed) return;
    closed = true;
    resolveClosed();
  };

  /** @returns {Promise<ArenaSession>} */
  const openSession = async () => {
    const viewport =
      options.viewport === undefined ? { height: 800, width: 1440 } : options.viewport;
    const context = await browser.newContext({
      locale: 'en-US',
      serviceWorkers: 'block',
      timezoneId: 'UTC',
      viewport,
    });
    /** @type {string[]} */
    const contextBlockedNetwork = [];
    await context.route('**/*', async (route) => {
      contextBlockedNetwork.push(route.request().url());
      await route.abort('blockedbyclient');
    });

    const page = await context.newPage();
    const fixture = await readWarDibsFixture();
    const desktopFixture = await readDesktopUiFixture();
    const rows = normalizeRows([
      ...fixture.hospitalGateRows,
      ...fairFightArenaRows(fixture),
      fixture.claimRow,
      fixture.sharedRow,
    ]);
    const harness = await startWarDibsHarness(page, rows);
    /** @type {ArenaSession} */
    const session = {
      context,
      page,
      harness,
      fixture,
      desktopFixture,
      rows,
      scenario: 'Hospital and Fair Fight overview',
      contextBlockedNetwork,
      clockTimer: null,
      clockRunId: 0,
      churnRunId: 0,
      expectedSuspension: false,
    };

    page.on('close', () => {
      if (current === session && !resetPromise) finish();
    });
    page.on('popup', (popup) => void popup.close());
    await installNavigationGuard(page);
    await installIdentityBadges(page);
    await installArenaPanel(page, async (id) => {
      if (id === 'reset') {
        setTimeout(() => {
          void reset().catch((error) => {
            console.error('War Dibs arena reset failed:', error);
          });
        }, 0);
        return { ok: true, message: 'Opening a clean deterministic session…' };
      }
      return dispatch(session, id);
    });
    await context.setOffline(true);
    await refreshPanel(session, 'Arena ready. Network is blocked; API responses are mocked.');
    return session;
  };

  const reset = async () => {
    if (closed) throw new Error('The War Dibs arena is closed');
    if (resetPromise) return resetPromise;
    resetPromise = (async () => {
      const previous = current;
      if (previous) stopSessionRunners(previous);
      const replacement = await openSession();
      current = replacement;
      await replacement.page.bringToFront();
      if (previous) await previous.context.close();
    })();
    try {
      await resetPromise;
    } finally {
      resetPromise = null;
    }
  };

  current = await openSession();
  browser.on('disconnected', finish);

  return {
    get page() {
      if (!current) throw new Error('The War Dibs arena has no active page');
      return current.page;
    },
    async command(id) {
      if (!current) throw new Error('The War Dibs arena has no active session');
      if (id === 'reset') {
        await reset();
        return { ok: true, message: 'Clean deterministic session opened.' };
      }
      return dispatch(current, id);
    },
    async snapshot() {
      if (!current) throw new Error('The War Dibs arena has no active session');
      return collectArenaSnapshot(current);
    },
    reset,
    async close() {
      if (closed) return;
      const session = current;
      current = null;
      if (session) {
        stopSessionRunners(session);
        await session.context.close();
      }
      finish();
    },
    waitUntilClosed: () => closedPromise,
  };
}

/** @param {ArenaSession} session */
function stopSessionRunners(session) {
  session.clockRunId += 1;
  session.churnRunId += 1;
  if (session.clockTimer) clearInterval(session.clockTimer);
  session.clockTimer = null;
}

/**
 * @param {FixtureRow[]} rows
 * @returns {FixtureRow[]}
 */
function normalizeRows(rows) {
  return rows.map((row, index) => ({
    ...row,
    title: row.title ?? `Deterministic arena identity ${row.id}`,
    battleStatsEstimate: row.battleStatsEstimate ?? 1_000_000 + index * 10_000,
    battleStatsEstimateHuman: row.battleStatsEstimateHuman ?? `${1 + index / 100}m`,
  }));
}

/** @param {WarDibsFixture} fixture */
function fairFightArenaRows(fixture) {
  const [below, exactMinimum, exactMaximum, above] = fixture.fairFightRows;
  if (!below || !exactMinimum || !exactMaximum || !above) {
    throw new Error('Fair Fight arena fixture is incomplete');
  }
  return [
    below,
    exactMinimum,
    {
      ...exactMinimum,
      id: '100205',
      name: 'Normal FF 3.00',
      fairFight: 3,
    },
    {
      ...exactMinimum,
      id: '100206',
      name: 'Normal FF 4.50',
      fairFight: 4.5,
    },
    exactMaximum,
    above,
  ];
}

/**
 * Prevents fixture profile/attack links and popup attempts from navigating away
 * from the offline arena. Network routing is still the final deny-by-default
 * boundary.
 *
 * @param {Page} page
 */
async function installNavigationGuard(page) {
  await page.evaluate(() => {
    /** @type {any} */ (window).open = () => null;
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        const anchor = target instanceof Element ? target.closest('a[href]') : null;
        if (!anchor) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        document.documentElement.dataset.ksArenaNavigationBlocked =
          anchor.getAttribute('href') || '';
      },
      true,
    );
  });
}

/**
 * Adds an arena-only ID gutter. Attribute-only recycling updates the badge with
 * another ignored attribute mutation, so it cannot create a child/text mutation
 * that would mask the production ownership bug under test.
 *
 * @param {Page} page
 */
async function installIdentityBadges(page) {
  await page.evaluate(() => {
    if (!document.getElementById('ks-war-dibs-arena-row-label-style')) {
      const style = document.createElement('style');
      style.id = 'ks-war-dibs-arena-row-label-style';
      style.textContent = `
        [data-test-war-scope] {
          margin-left: 94px;
          width: calc(100% - 94px);
        }
        #faction_war_list_id li.enemy > .member > .ks-arena-player-id {
          align-items: center;
          background: #082f49;
          border: 1px solid #38bdf8;
          border-radius: 4px;
          color: #e0f2fe;
          display: flex;
          font: 700 10px/1 Arial, sans-serif;
          height: 24px;
          justify-content: center;
          left: -90px;
          letter-spacing: .2px;
          pointer-events: none;
          position: absolute;
          top: 9px;
          width: 84px;
          z-index: 20;
        }
        #faction_war_list_id li.enemy > .member > .ks-arena-player-id::before {
          content: "ID " attr(data-arena-player-id);
        }
      `;
      document.head.append(style);
    }

    for (const row of document.querySelectorAll('#faction_war_list_id li.enemy')) {
      const href = row.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
      const playerId = new URL(href, location.href).searchParams.get('XID') || 'UNKNOWN';
      const member = row.querySelector(':scope > .member');
      if (!(member instanceof HTMLElement)) continue;
      let badge = member.querySelector(':scope > .ks-arena-player-id');
      if (!(badge instanceof HTMLElement)) {
        badge = document.createElement('span');
        badge.className = 'ks-arena-player-id';
        badge.setAttribute('aria-hidden', 'true');
        member.append(badge);
      }
      badge.setAttribute('data-arena-player-id', playerId);
    }
  });
}

/**
 * Updates existing badge attributes without adding/removing nodes or changing
 * text, preserving the purity of attribute-only row recycling scenarios.
 *
 * @param {Page} page
 */
async function syncIdentityBadgeAttributes(page) {
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('#faction_war_list_id li.enemy')) {
      const href = row.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
      const playerId = new URL(href, location.href).searchParams.get('XID') || 'UNKNOWN';
      const badge = row.querySelector(':scope > .member > .ks-arena-player-id');
      if (badge instanceof HTMLElement) badge.dataset.arenaPlayerId = playerId;
    }
  });
}

/**
 * @param {Page} page
 * @param {(id: string) => Promise<ArenaCommandResult>} onCommand
 */
async function installArenaPanel(page, onCommand) {
  await page.exposeFunction(arenaCommandBinding, onCommand);
  await page.evaluate(
    ({ bindingName, groups, panelTestId, rootId }) => {
      document.getElementById(rootId)?.remove();
      const host = document.createElement('aside');
      host.id = rootId;
      host.dataset.testid = panelTestId;
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .shell {
            background: rgba(7, 12, 20, .97);
            border: 1px solid #38bdf8;
            border-radius: 8px 0 0 8px;
            box-shadow: 0 10px 35px rgba(0, 0, 0, .55);
            color: #dbeafe;
            display: flex;
            flex-direction: column;
            font: 12px/1.35 Arial, sans-serif;
            max-height: calc(100vh - 16px);
            overflow: hidden;
            position: fixed;
            right: 0;
            top: 8px;
            width: min(390px, calc(100vw - 12px));
            z-index: 2147483647;
          }
          .top {
            align-items: center;
            background: #0c4a6e;
            display: flex;
            gap: 8px;
            justify-content: space-between;
            padding: 8px 10px;
          }
          h1 { font-size: 13px; margin: 0; }
          .offline { color: #86efac; font-size: 10px; font-weight: 700; }
          .toggle {
            background: #e0f2fe;
            border: 0;
            border-radius: 4px;
            color: #082f49;
            cursor: pointer;
            font-weight: 700;
            padding: 3px 7px;
          }
          .body { overflow: auto; padding: 8px; }
          .shell.collapsed .body { display: none; }
          .shell.collapsed {
            left: 4px;
            max-height: 34px;
            right: auto;
            top: 4px;
            width: 86px;
          }
          .shell.collapsed .top { padding: 4px; }
          .shell.collapsed .top > div { display: none; }
          .shell.collapsed .toggle { width: 78px; }
          fieldset {
            border: 1px solid #334155;
            border-radius: 5px;
            display: grid;
            gap: 5px;
            grid-template-columns: 1fr 1fr;
            margin: 0 0 8px;
            padding: 7px;
          }
          legend { color: #7dd3fc; font-weight: 700; padding: 0 4px; }
          button.command {
            background: #1e293b;
            border: 1px solid #475569;
            border-radius: 4px;
            color: #f8fafc;
            cursor: pointer;
            min-height: 32px;
            padding: 5px 7px;
            text-align: left;
          }
          button.command:hover { background: #334155; border-color: #7dd3fc; }
          button.command[aria-busy="true"] { color: #facc15; cursor: wait; }
          button.command[data-command="reset"] { background: #7f1d1d; border-color: #f87171; }
          .status {
            background: #111827;
            border-left: 3px solid #38bdf8;
            margin-bottom: 8px;
            min-height: 32px;
            padding: 7px;
          }
          .status.error { border-left-color: #f87171; color: #fecaca; }
          details { border-top: 1px solid #334155; padding-top: 6px; }
          summary { color: #a5f3fc; cursor: pointer; font-weight: 700; }
          pre {
            background: #020617;
            color: #bae6fd;
            font: 10px/1.35 Consolas, monospace;
            margin: 6px 0 0;
            max-height: 260px;
            overflow: auto;
            padding: 7px;
            white-space: pre-wrap;
          }
        </style>
        <section class="shell">
          <header class="top">
            <div><h1>KS War Dibs — Desktop Test Arena</h1><div class="offline">OFFLINE · MOCKED TORN + FFSCOUTER</div></div>
            <button class="toggle" type="button" aria-expanded="true">Minimize</button>
          </header>
          <div class="body">
            <div class="status" data-role="arena-status">Starting deterministic arena…</div>
            <div data-role="command-groups"></div>
            <details open>
              <summary>Live diagnostics</summary>
              <pre data-role="arena-diagnostics">Collecting…</pre>
            </details>
          </div>
        </section>
      `;
      document.body.append(host);

      const shell = shadow.querySelector('.shell');
      const toggle = shadow.querySelector('.toggle');
      const commandRoot = shadow.querySelector('[data-role="command-groups"]');
      if (
        !(shell instanceof HTMLElement) ||
        !(toggle instanceof HTMLButtonElement) ||
        !commandRoot
      ) {
        throw new Error('Arena panel shell did not initialize');
      }
      toggle.addEventListener('click', () => {
        const collapsed = shell.classList.toggle('collapsed');
        toggle.textContent = collapsed ? 'Show arena' : 'Minimize';
        toggle.setAttribute('aria-expanded', String(!collapsed));
      });

      for (const group of groups) {
        const fieldset = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = group.label;
        fieldset.append(legend);
        for (const [id, label] of group.commands) {
          if (!id || !label) continue;
          const button = document.createElement('button');
          button.className = 'command';
          button.dataset.command = id;
          button.type = 'button';
          button.textContent = label;
          button.addEventListener('click', async () => {
            button.setAttribute('aria-busy', 'true');
            const status = shadow.querySelector('[data-role="arena-status"]');
            if (status) {
              status.classList.remove('error');
              status.textContent = `Running: ${label}…`;
            }
            try {
              const invoke = /** @type {any} */ (window)[bindingName];
              const result = await invoke(id);
              if (status) {
                status.classList.toggle('error', !result.ok);
                status.textContent = result.message;
              }
            } catch (error) {
              if (status) {
                status.classList.add('error');
                status.textContent = error instanceof Error ? error.message : String(error);
              }
            } finally {
              button.removeAttribute('aria-busy');
            }
          });
          fieldset.append(button);
        }
        commandRoot.append(fieldset);
      }
    },
    {
      bindingName: arenaCommandBinding,
      groups: commandGroups,
      panelTestId: arenaPanelTestId,
      rootId: arenaRootId,
    },
  );
}

/**
 * Moves the minimized controller entirely into the arena's 94px ID gutter so
 * it cannot cover names, FF/Est decorations, or the Attack/DIBS column.
 *
 * @param {Page} page
 * @param {boolean} collapsed
 */
async function setArenaPanelCollapsed(page, collapsed) {
  await page.evaluate(
    ({ shouldCollapse, rootId }) => {
      const shadow = document.getElementById(rootId)?.shadowRoot;
      const shell = shadow?.querySelector('.shell');
      const toggle = shadow?.querySelector('.toggle');
      if (!(shell instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement)) return;
      shell.classList.toggle('collapsed', shouldCollapse);
      toggle.textContent = shouldCollapse ? 'Show arena' : 'Minimize';
      toggle.setAttribute('aria-expanded', String(!shouldCollapse));
    },
    { rootId: arenaRootId, shouldCollapse: collapsed },
  );
}

/**
 * @param {ArenaSession} session
 * @param {string} id
 * @returns {Promise<ArenaCommandResult>}
 */
async function dispatch(session, id) {
  try {
    const message = await runCommand(session, id);
    await refreshPanel(session, message);
    return { ok: true, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await refreshPanel(session, `ERROR: ${message}`, true);
    return { ok: false, message };
  }
}

/**
 * @param {ArenaSession} session
 * @param {string} id
 * @returns {Promise<string>}
 */
async function runCommand(session, id) {
  const { fixture, page } = session;
  switch (id) {
    case 'hospital-gates': {
      await loadRows(session, fixture.hospitalGateRows, 'Hospital gates: 2:01 / 2:00 / 1:59');
      return 'Hospital fixtures loaded: 2:01 locked; 2:00 and 1:59 claim-ready.';
    }
    case 'countdown-live': {
      const row = fixture.hospitalGateRows[0];
      if (!row) throw new Error('Live Hospital countdown fixture is missing');
      await loadRows(session, [row], 'Live Hospital countdown');
      await setClocks(session, fixture.baseNowMs, fixture.baseNowMs + 1_000);
      await forceWarDibsScan(page);
      startLiveClock(session);
      return 'Live mocked client clock started at 2:01 with Torn time +1s; watch 2:00 unlock and 1:59.';
    }
    case 'countdown-pause':
      stopLiveClock(session);
      return 'Live mocked client clock paused.';
    case 'clock-plus-one':
      await advanceClocks(session, 1_000);
      await forceWarDibsScan(page);
      return 'Advanced local and Torn clocks by exactly one second.';
    case 'fair-fight-gates':
      await loadRows(
        session,
        fairFightArenaRows(fixture),
        'Fair Fight gates: 1.99 / 2.00 / 3.00 / 4.50 / 5.00 / 5.01',
      );
      return 'Fair Fight fixtures loaded, including both inclusive boundaries and normal values.';
    case 'claim-load':
      await loadRows(session, [fixture.claimRow], 'Claim lifecycle target');
      return 'Ready claim target loaded. Use CLAIM, RELEASE, and Reclaim controls.';
    case 'claim':
      await ensureClaimTarget(session);
      await clickAndWaitForState(session, fixture.claimRow.id, 'claimed');
      return 'Actual DIBS control sent CLAIM and now shows DIBBED / RELEASE.';
    case 'release':
      await ensureCurrentRow(session, fixture.claimRow);
      await clickAndWaitForState(session, fixture.claimRow.id, 'ready');
      return 'Actual DIBBED control sent RELEASE and returned to DIBS.';
    case 'reclaim':
      await ensureCurrentRow(session, fixture.claimRow);
      await clickAndWaitForState(session, fixture.claimRow.id, 'claimed');
      return 'Actual DIBS control reclaimed the released target.';
    case 'shared-taken':
      return showSharedTaken(session);
    case 'race-win':
      return showRaceWinner(session);
    case 'race-lose':
      return showRaceLoser(session);
    case 'stale-claims':
      return runStaleClaimsScenario(session);
    case 'out-of-order-stats':
      return runOutOfOrderStatsScenario(session);
    case 'api-errors':
      await session.harness.controller('queueResponse', 'ff:claims', {
        status: 503,
        body: { error: 'Deterministic FFScouter outage' },
      });
      await session.harness.controller('queueResponse', 'torn:faction', {
        status: 503,
        body: { error: { code: 0, error: 'Deterministic Torn outage' } },
      });
      await session.harness.controller('clearRequests');
      await clickPanelRole(page, 'sync');
      await waitForRequestRoutes(session, ['ff:claims', 'torn:faction']);
      session.scenario = 'Deterministic Torn and FFScouter API errors';
      return 'Injected Torn and FFScouter 503 responses. Inspect the real panel, then use Recover APIs.';
    case 'api-recover':
      await advanceClocks(session, 300_000);
      await session.harness.controller('clearRequests');
      await clickPanelRole(page, 'sync');
      await waitForRequestRoutes(session, ['ff:claims', 'torn:faction']);
      session.scenario = 'API recovery after deterministic errors';
      return 'Advanced beyond backoff and recovered both mocked APIs with normal responses.';
    case 'inactivity':
      await session.harness.controller('clearRequests');
      await advanceClocks(session, 30_001);
      await page.waitForTimeout(2_800);
      session.scenario = 'Expected foreground inactivity suspension';
      return 'Advanced past 30s inactivity and waited through a poll tick; expected silence is not an error.';
    case 'background':
      session.expectedSuspension = true;
      await session.harness.controller('suspend');
      session.scenario = 'Background / blur suspension';
      return 'Simulated blur. War Dibs unmounted as expected; the arena remains available.';
    case 'foreground':
      session.expectedSuspension = false;
      await session.harness.controller('resume');
      await waitForProductionPanel(page);
      await installIdentityBadges(page);
      session.scenario = 'Foreground resume';
      return 'Resumed focus and interaction; War Dibs remounted.';
    case 'visibility-hide':
      session.expectedSuspension = true;
      await session.harness.controller('hide');
      session.scenario = 'Hidden-tab suspension';
      return 'Simulated a hidden tab. Production UI suspension is expected.';
    case 'visibility-show':
      session.expectedSuspension = false;
      await session.harness.controller('show');
      await waitForProductionPanel(page);
      await installIdentityBadges(page);
      session.scenario = 'Visible-tab resume';
      return 'Restored visible/foreground state and remounted War Dibs.';
    case 'background-cycles':
      session.expectedSuspension = false;
      for (let cycle = 0; cycle < 4; cycle += 1) {
        await session.harness.controller('hide');
        await page.waitForTimeout(80);
        await session.harness.controller('show');
        await waitForProductionPanel(page);
      }
      await installIdentityBadges(page);
      session.scenario = 'Repeated background / foreground transitions';
      return 'Completed four deterministic hide/show cycles with a single remounted panel.';
    case 'spa-remove':
      session.expectedSuspension = true;
      await page.evaluate(() => document.getElementById('faction_war_list_id')?.remove());
      await page.locator(warDibsSelectors.panel).waitFor({ state: 'detached', timeout: 3_000 });
      session.scenario = 'SPA war-root removal';
      return 'Removed the Ranked War root; production UI unmounted as expected.';
    case 'spa-remount':
      session.expectedSuspension = false;
      await session.harness.replaceRows(session.rows);
      await waitForProductionPanel(page);
      await installIdentityBadges(page);
      await waitForDecorations(session);
      session.scenario = 'SPA war-root remount';
      return 'Recreated the SPA root and remounted exactly one production panel/control set.';
    case 'long-roster': {
      const rows = buildDesktopRows(session.desktopFixture);
      await loadRows(session, rows, 'Long-name and long-title desktop roster');
      return `Loaded ${rows.length} deterministic desktop rows with unique IDs, FF/Est values, and long text.`;
    }
    case 'row-reorder':
      await ensureDesktopRoster(session);
      session.rows = [...session.rows].reverse();
      await reorderWarRows(
        page,
        session.rows.map((row) => row.id),
      );
      await waitForUiFrames(page);
      session.scenario = 'Existing row nodes reordered';
      return 'Reversed existing row nodes without recreating them.';
    case 'row-replace':
      await ensureDesktopRoster(session);
      if (!session.rows[0]) throw new Error('Desktop replacement roster is empty');
      session.rows = [...session.rows.slice(1), session.rows[0]];
      await session.harness.replaceRows(session.rows);
      await installIdentityBadges(page);
      await waitForDecorations(session);
      session.scenario = 'Complete deterministic row replacement';
      return 'Replaced every row DOM node and verified the production decorations remounted.';
    case 'row-recycle':
      await ensureDesktopRoster(session);
      session.rows = [...session.rows.slice(2), ...session.rows.slice(0, 2)];
      await recycleWarRowsInPlace(page, /** @type {any} */ (session.rows));
      await syncIdentityBadgeAttributes(page);
      await page.waitForTimeout(20);
      session.scenario = 'Existing row nodes fully recycled';
      return 'Reused existing row nodes for a rotated player roster.';
    case 'attribute-recycle':
      return runAttributeOnlyRecycle(session);
    case 'scroll-stress':
      await ensureDesktopRoster(session);
      await runScrollStress(session);
      await setArenaPanelCollapsed(page, true);
      session.scenario = 'Rapid repeated scroll stress';
      return `Completed ${session.desktopFixture.scrollCycles} fast top/bottom scroll cycles.`;
    case 'resize-1280':
      await page.setViewportSize({ height: 720, width: 1_280 });
      await waitForUiFrames(page);
      return 'Set the content viewport to 1280 × 720.';
    case 'resize-784':
      await page.setViewportSize(session.desktopFixture.responsiveBoundary.above);
      await waitForUiFrames(page);
      return 'Set the content viewport to the 784px side of the responsive boundary.';
    case 'resize-783':
      await page.setViewportSize(session.desktopFixture.responsiveBoundary.below);
      await waitForUiFrames(page);
      await setArenaPanelCollapsed(page, true);
      return 'Set the content viewport to the 783px side of the responsive boundary.';
    case 'dom-churn':
      await ensureDesktopRoster(session);
      startDomChurn(session);
      return 'Started bounded repeated reorder/recycle/replacement/SPA churn; use Stop DOM churn anytime.';
    case 'dom-churn-stop':
      session.churnRunId += 1;
      return 'Stopped the active DOM churn loop.';
    case 'responsive-width-regression':
      await ensureDesktopRoster(session);
      await page.setViewportSize(session.desktopFixture.responsiveBoundary.above);
      await waitForUiFrames(page);
      await page.setViewportSize(session.desktopFixture.responsiveBoundary.below);
      await waitForUiFrames(page);
      await setArenaPanelCollapsed(page, true);
      session.scenario = 'KNOWN: responsive DIBS width regression';
      return 'Known regression reproduced: compare DIBS host and Attack-cell widths at 783px in diagnostics.';
    case 'attack-fallback-regression':
      await loadAttackFallbackRows(session);
      await setArenaPanelCollapsed(page, true);
      return 'Known regression fixture loaded: native name/title “Attack” may be hidden by fallback placement.';
    case 'sync':
      await clickPanelRole(page, 'sync');
      await page.waitForTimeout(100);
      return 'Clicked the actual production Sync control against deterministic mocked APIs.';
    case 'refresh':
      return 'Diagnostics refreshed without forcing a production scan.';
    default:
      throw new Error(`Unknown arena command: ${id}`);
  }
}

/**
 * @param {ArenaSession} session
 * @param {FixtureRow[]} requestedRows
 * @param {string} scenario
 */
async function loadRows(session, requestedRows, scenario) {
  stopLiveClock(session);
  session.churnRunId += 1;
  session.expectedSuspension = false;
  session.rows = normalizeRows(requestedRows);
  await setClocks(session, session.fixture.baseNowMs, session.fixture.baseNowMs + 1_000);
  await session.harness.replaceRows(session.rows);
  await installIdentityBadges(session.page);
  await clickPanelRole(session.page, 'sync');
  await waitForDecorations(session);
  session.scenario = scenario;
}

/** @param {ArenaSession} session */
async function waitForDecorations(session) {
  await session.page.waitForFunction(
    ({ expectedIds, hostPrefix }) =>
      expectedIds.every((id) => {
        const host = document.getElementById(`${hostPrefix}${id}`);
        const row = host?.closest('li.enemy');
        return (
          host?.shadowRoot?.querySelectorAll('button').length === 1 &&
          row?.getAttribute('data-ks-twd-v1567-player-id') === id &&
          row.hasAttribute('data-ks-twd-v1563-ff-value')
        );
      }),
    {
      expectedIds: session.rows.map((row) => row.id),
      hostPrefix: warDibsSelectors.rowHostPrefix,
    },
    { timeout: 6_000 },
  );
  await waitForUiFrames(session.page);
}

/** @param {Page} page */
async function waitForProductionPanel(page) {
  await page.locator(warDibsSelectors.panel).waitFor({ state: 'attached', timeout: 3_000 });
}

/**
 * @param {ArenaSession} session
 * @param {number} localNowMs
 * @param {number} tornNowMs
 */
async function setClocks(session, localNowMs, tornNowMs) {
  await session.harness.controller('setClocks', localNowMs, tornNowMs);
}

/**
 * @param {ArenaSession} session
 * @param {number} deltaMs
 */
async function advanceClocks(session, deltaMs) {
  const clocks = await session.page.evaluate(() => ({
    local: Date.now(),
    torn: Number(/** @type {any} */ (window).getCurrentTimestamp?.() ?? Date.now()),
  }));
  await setClocks(session, clocks.local + deltaMs, clocks.torn + deltaMs);
}

/** @param {ArenaSession} session */
function startLiveClock(session) {
  stopLiveClock(session);
  const runId = ++session.clockRunId;
  const realStartedAt = Date.now();
  const fakeStartedAt = session.fixture.baseNowMs;
  let busy = false;
  session.clockTimer = setInterval(() => {
    if (busy || runId !== session.clockRunId || session.page.isClosed()) return;
    busy = true;
    const elapsed = Date.now() - realStartedAt;
    void (async () => {
      await setClocks(session, fakeStartedAt + elapsed, fakeStartedAt + elapsed + 1_000);
      await forceWarDibsScan(session.page);
      if (elapsed >= 4_200) {
        stopLiveClock(session);
        await refreshPanel(
          session,
          'Live sequence completed through 2:01 → 2:00 → 1:59; clock paused.',
        );
      } else if (elapsed % 500 < localClockTickMs) {
        await refreshPanel(session, 'Live client-clock countdown is running…');
      }
    })()
      .catch((error) => {
        stopLiveClock(session);
        console.error('War Dibs arena clock failed:', error);
      })
      .finally(() => {
        busy = false;
      });
  }, localClockTickMs);
}

/** @param {ArenaSession} session */
function stopLiveClock(session) {
  session.clockRunId += 1;
  if (session.clockTimer) clearInterval(session.clockTimer);
  session.clockTimer = null;
}

/**
 * @param {ArenaSession} session
 * @param {FixtureRow} row
 */
async function ensureCurrentRow(session, row) {
  if (session.rows.some((candidate) => candidate.id === row.id)) return;
  await loadRows(session, [row], `Player ${row.id}`);
}

/** @param {ArenaSession} session */
async function ensureClaimTarget(session) {
  await ensureCurrentRow(session, session.fixture.claimRow);
  const state = await buttonState(session.page, session.fixture.claimRow.id);
  if (state !== 'ready') {
    throw new Error(
      `Claim target is ${state || 'missing'}; press RESET for a clean claim lifecycle`,
    );
  }
}

/** @param {ArenaSession} session */
async function prepareUnclaimedTarget(session) {
  await ensureCurrentRow(session, session.fixture.claimRow);
  const control = warDibsControl(session.page, session.fixture.claimRow.id);
  const state = await buttonState(session.page, session.fixture.claimRow.id);
  if (state === 'claimed') {
    await control.button.evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error('DIBS button is missing');
      button.click();
    });
    await waitForButtonState(session.page, session.fixture.claimRow.id, 'ready');
  } else if (state !== 'ready') {
    await loadRows(session, [session.fixture.claimRow], 'Clean race target');
  }
  await session.harness.controller('setClaims', {});
  await clickPanelRole(session.page, 'sync');
  await waitForButtonState(session.page, session.fixture.claimRow.id, 'ready');
}

/**
 * @param {ArenaSession} session
 * @param {string} playerId
 * @param {string} expectedState
 */
async function clickAndWaitForState(session, playerId, expectedState) {
  await warDibsControl(session.page, playerId).button.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error('DIBS button is missing');
    button.click();
  });
  await waitForButtonState(session.page, playerId, expectedState);
}

/**
 * @param {Page} page
 * @param {string} playerId
 */
function buttonState(page, playerId) {
  return warDibsControl(page, playerId).button.getAttribute('data-state');
}

/**
 * @param {Page} page
 * @param {string} playerId
 * @param {string} expectedState
 */
async function waitForButtonState(page, playerId, expectedState) {
  await page.waitForFunction(
    ({ hostId, state }) =>
      document.getElementById(hostId)?.shadowRoot?.querySelector('button')?.dataset.state === state,
    { hostId: `${warDibsSelectors.rowHostPrefix}${playerId}`, state: expectedState },
    { timeout: 4_000 },
  );
}

/** @param {ArenaSession} session */
async function showSharedTaken(session) {
  const nowSeconds = session.fixture.baseNowMs / 1_000;
  const first = serverClaim(
    session.fixture.claimIds.remote,
    '700001',
    'Alice Arena Claimant',
    nowSeconds - 20,
    nowSeconds + 800,
  );
  const second = serverClaim(
    session.fixture.claimIds.winner,
    '700002',
    'Bob Queue Position Two',
    nowSeconds - 10,
    nowSeconds + 810,
  );
  await loadRows(session, [session.fixture.sharedRow], 'Shared TAKEN claimant identity');
  await session.harness.controller('setClaims', {
    [session.fixture.sharedRow.id]: [second, first],
  });
  await clickPanelRole(session.page, 'sync');
  await waitForButtonState(session.page, session.fixture.sharedRow.id, 'shared');
  return 'Shared state loaded: TAKEN by Alice Arena Claimant with one queued claimant.';
}

/** @param {ArenaSession} session */
async function showRaceWinner(session) {
  await prepareUnclaimedTarget(session);
  const nowSeconds = session.fixture.baseNowMs / 1_000;
  const winner = serverClaim(
    session.fixture.claimIds.first,
    session.fixture.self.id,
    session.fixture.self.name,
    nowSeconds - 1,
    nowSeconds + 899,
  );
  const loser = serverClaim(
    session.fixture.claimIds.loser,
    '700004',
    'Race Loser',
    nowSeconds,
    nowSeconds + 900,
  );
  await session.harness.controller('queueResponse', 'ff:claim', {
    status: 200,
    serverClaims: { [session.fixture.claimRow.id]: [winner] },
    body: {
      claim: winner,
      position: 1,
      other_claims_for_target: [{ ...loser, position: 2 }],
    },
  });
  await session.harness.controller('clearRequests');
  await clickAndWaitForState(session, session.fixture.claimRow.id, 'claimed');
  await waitForRequestRoutes(session, ['ff:claim']);
  session.scenario = 'Simultaneous claim winner with a deterministic loser';
  return 'Simulated competing claims: this client won position one and holds DIBBED.';
}

/** @param {ArenaSession} session */
async function showRaceLoser(session) {
  await prepareUnclaimedTarget(session);
  const nowSeconds = session.fixture.baseNowMs / 1_000;
  const winner = serverClaim(
    session.fixture.claimIds.winner,
    '700003',
    'Race Winner',
    nowSeconds - 1,
    nowSeconds + 899,
  );
  const loser = serverClaim(
    session.fixture.claimIds.loser,
    session.fixture.self.id,
    session.fixture.self.name,
    nowSeconds,
    nowSeconds + 900,
  );
  await session.harness.controller('queueResponse', 'ff:claim', {
    status: 200,
    serverClaims: { [session.fixture.claimRow.id]: [winner, loser] },
    body: {
      claim: loser,
      position: 2,
      other_claims_for_target: [{ ...winner, position: 1 }],
    },
  });
  await session.harness.controller('clearRequests');
  await clickAndWaitForState(session, session.fixture.claimRow.id, 'shared');
  await session.page.waitForFunction(
    ({ expectedClaimId, storageKey }) => {
      const api = /** @type {any} */ (globalThis).__ksWarDibsHarness;
      const requests = api?.getRequests?.() || [];
      return (
        requests.some(
          (/** @type {{route: string, body: {claim_id?: string}}} */ request) =>
            request.route === 'ff:unclaim' && request.body?.claim_id === expectedClaimId,
        ) && localStorage.getItem(storageKey) === null
      );
    },
    {
      expectedClaimId: session.fixture.claimIds.loser,
      storageKey: warDibsSelectors.ownClaimStorageKey,
    },
    { timeout: 4_000 },
  );
  session.scenario = 'Simultaneous claim loser and cleanup';
  return 'Simulated position-two loser; production cleaned its claim and displays TAKEN by Race Winner.';
}

/**
 * @param {string | undefined} claimId
 * @param {string} playerId
 * @param {string} name
 * @param {number} createdAt
 * @param {number} expiresAt
 */
function serverClaim(claimId, playerId, name, createdAt, expiresAt) {
  if (!claimId) throw new Error('A deterministic claim ID is missing');
  return {
    claim_id: claimId,
    claimer: { player_id: Number(playerId), name },
    created_at: createdAt,
    expires_at: expiresAt,
  };
}

/** @param {ArenaSession} session */
async function runStaleClaimsScenario(session) {
  await prepareUnclaimedTarget(session);
  await session.harness.controller('clearRequests');
  await session.harness.controller('holdNext', 'ff:claims', 'arena-old-empty-claims');
  await clickPanelRole(session.page, 'sync');
  await waitForPendingToken(session, 'arena-old-empty-claims');
  await clickAndWaitForState(session, session.fixture.claimRow.id, 'claimed');
  await session.harness.controller('resolve', 'arena-old-empty-claims');
  await waitForButtonState(session.page, session.fixture.claimRow.id, 'claimed');
  session.scenario = 'Stale claims response after a successful CLAIM';
  return 'Resolved an older empty claims GET after CLAIM; the newer DIBBED state remained intact.';
}

/** @param {ArenaSession} session */
async function runOutOfOrderStatsScenario(session) {
  const [oldRow, newRow] = session.fixture.spaRows;
  if (!oldRow || !newRow) throw new Error('Out-of-order FF fixtures are incomplete');
  await loadRows(session, [oldRow], 'Held FF response for outgoing player');
  await session.harness.controller('clearRequests');
  await session.harness.controller('holdNext', 'ff:stats', 'arena-old-player-stats');
  await clickPanelRole(session.page, 'sync');
  await waitForPendingToken(session, 'arena-old-player-stats');
  session.rows = normalizeRows([newRow]);
  await session.harness.replaceRows(session.rows);
  await installIdentityBadges(session.page);
  await session.harness.controller('resolve', 'arena-old-player-stats');
  await clickPanelRole(session.page, 'sync');
  await waitForDecorations(session);
  session.scenario = 'Out-of-order FF response after row replacement';
  return 'Resolved old-player FF data after replacement; the new player kept its own FF/Est identity.';
}

/**
 * @param {ArenaSession} session
 * @param {string} token
 */
async function waitForPendingToken(session, token) {
  await session.page.waitForFunction(
    async (expected) => {
      const api = /** @type {any} */ (globalThis).__ksWarDibsHarness;
      return api?.getPendingTokens?.().includes(expected);
    },
    token,
    { timeout: 4_000 },
  );
}

/**
 * @param {ArenaSession} session
 * @param {string[]} routes
 */
async function waitForRequestRoutes(session, routes) {
  await session.page.waitForFunction(
    (expectedRoutes) => {
      const api = /** @type {any} */ (globalThis).__ksWarDibsHarness;
      const requests = api?.getRequests?.() || [];
      return expectedRoutes.every((route) =>
        requests.some((/** @type {{route: string}} */ request) => request.route === route),
      );
    },
    routes,
    { timeout: 4_000 },
  );
}

/** @param {ArenaSession} session */
async function ensureDesktopRoster(session) {
  if (session.rows.length >= 12 && session.rows.every((row) => Number(row.id) >= 200_000)) return;
  await loadRows(
    session,
    buildDesktopRows(session.desktopFixture),
    'Desktop geometry and ownership roster',
  );
}

/** @param {ArenaSession} session */
async function runAttributeOnlyRecycle(session) {
  const [firstSource, secondSource] = buildDesktopRows(session.desktopFixture);
  if (!firstSource || !secondSource) throw new Error('Attribute-only recycle rows are missing');
  const first = {
    ...firstSource,
    name: 'Attribute-Recycled Player',
    title: 'Constant text; identity comes only from attributes',
  };
  const second = {
    ...secondSource,
    name: 'Attribute-Recycled Player',
    title: 'Constant text; identity comes only from attributes',
  };
  await loadRows(session, [first, second], 'Attribute-only row identity recycling');
  const immediate = await swapRowIdentityAttributes(session.page, first.id, second.id);
  session.rows = normalizeRows([second, first]);
  await syncIdentityBadgeAttributes(session.page);
  const expectedById = new Map(session.rows.map((row) => [row.id, row]));
  const leaks = immediate.rows.filter((row) => {
    const expected = expectedById.get(row.identity);
    if (!expected) return true;
    const signature = expectedVisualSignature(/** @type {any} */ (expected));
    return (
      row.buttonReady !== 'true' ||
      row.buttonState !== 'ready' ||
      row.hostId !== `${warDibsSelectors.rowHostPrefix}${row.identity}` ||
      row.hostDatasetId !== row.identity ||
      row.ffPlayerId !== row.identity ||
      row.ffGauge !== 'true' ||
      row.ffValue !== signature.ffValue ||
      row.ffLeftVariable !== signature.ffLeft ||
      row.ffColorVariable !== signature.ffColor ||
      row.levelEstimate !== signature.estimate ||
      row.levelTitle !== signature.levelTitle ||
      row.directHostCount !== 1
    );
  });
  const expectedHostIds = session.rows
    .map((row) => `${warDibsSelectors.rowHostPrefix}${row.id}`)
    .sort();
  if (immediate.hostIds.slice().sort().join(',') !== expectedHostIds.join(',')) {
    throw new Error('Immediate attribute-only recycling duplicated or lost a global DIBS host');
  }
  if (leaks.length) {
    throw new Error(
      `Immediate attribute-only ownership leaks: ${leaks.map((row) => row.identity).join(', ')}`,
    );
  }
  await session.harness.controller('clearRequests');
  await clickAndWaitForState(session, second.id, 'claimed');
  const claimRequests = /** @type {Array<{route: string, body: {target_player_id?: number}}>} */ (
    await session.harness.controller('getRequests')
  ).filter((request) => request.route === 'ff:claim');
  if (claimRequests.at(-1)?.body?.target_player_id !== Number(second.id)) {
    throw new Error('Attribute-recycled DIBS click targeted the previous player identity');
  }
  await clickAndWaitForState(session, second.id, 'ready');
  return 'Attribute-only swap passed the same-task DIBS/FF/Est signature checks and claimed the new player ID.';
}

/** @param {ArenaSession} session */
async function runScrollStress(session) {
  const cycles = session.desktopFixture.scrollCycles;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await session.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await waitForUiFrames(session.page);
    await session.page.waitForTimeout(25);
    await session.page.evaluate(() => window.scrollTo(0, 0));
    await waitForUiFrames(session.page);
    await session.page.waitForTimeout(25);
  }
}

/** @param {ArenaSession} session */
function startDomChurn(session) {
  const runId = ++session.churnRunId;
  void (async () => {
    let rows = [...session.rows];
    for (let round = 0; round < 40 && session.churnRunId === runId; round += 1) {
      const first = rows.shift();
      if (first) rows.push(first);
      if (round % 4 === 0) {
        await session.harness.replaceRows(rows);
        await installIdentityBadges(session.page);
      } else if (round % 4 === 1) {
        await reorderWarRows(
          session.page,
          rows.map((row) => row.id),
        );
      } else if (round % 4 === 2) {
        await recycleWarRowsInPlace(session.page, /** @type {any} */ (rows));
        await syncIdentityBadgeAttributes(session.page);
      } else {
        await session.page.evaluate(() => document.getElementById('faction_war_list_id')?.remove());
        await session.harness.replaceRows(rows);
        await installIdentityBadges(session.page);
      }
      session.rows = [...rows];
      await session.page.waitForTimeout(180);
      if (round % 5 === 0) {
        await refreshPanel(session, `DOM churn running: round ${round + 1} / 40…`);
      }
    }
    if (session.churnRunId === runId) {
      await refreshPanel(session, 'Repeated DOM churn completed 40 bounded rounds.');
    }
  })().catch((error) => {
    if (!session.page.isClosed()) {
      void refreshPanel(
        session,
        `DOM churn stopped with error: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  });
}

/** @param {ArenaSession} session */
async function loadAttackFallbackRows(session) {
  const [first, second] = buildDesktopRows(session.desktopFixture);
  if (!first || !second) throw new Error('Attack fallback fixtures are missing');
  await loadRows(
    session,
    [
      {
        ...first,
        name: 'Attack',
        title: 'Long native title beside an unrecognized attack cell',
        attackCellClass: 'action-cell',
      },
      {
        ...second,
        name: 'Long native player name remains completely visible',
        title: 'Attack',
        attackCellClass: 'action-cell',
      },
    ],
    'KNOWN: Attack text fallback regression',
  );
}

/**
 * @param {ArenaSession} session
 * @param {string} message
 * @param {boolean} [error]
 */
async function refreshPanel(session, message, error = false) {
  if (session.page.isClosed()) return;
  const snapshot = await collectArenaSnapshot(session);
  const diagnosticText = formatDiagnostics(snapshot);
  await session.page.evaluate(
    ({ diagnosticText: text, errorState, messageText, rootId }) => {
      const shadow = document.getElementById(rootId)?.shadowRoot;
      const status = shadow?.querySelector('[data-role="arena-status"]');
      const diagnostics = shadow?.querySelector('[data-role="arena-diagnostics"]');
      if (status) {
        status.classList.toggle('error', errorState);
        status.textContent = messageText;
      }
      if (diagnostics) diagnostics.textContent = text;
    },
    { diagnosticText, errorState: error, messageText: message, rootId: arenaRootId },
  );
}

/**
 * @param {ArenaSession} session
 * @returns {Promise<any>}
 */
async function collectArenaSnapshot(session) {
  const [ui, rows, requests, unexpectedRequests, pendingTokens, clocks] = await Promise.all([
    captureWarDibsUi(session.page),
    collectRowSummary(session.page),
    session.harness.controller('getRequests'),
    session.harness.controller('getUnexpectedRequests'),
    session.harness.controller('getPendingTokens'),
    session.page.evaluate(() => ({
      focused: document.hasFocus(),
      hidden: document.hidden,
      localNowMs: Date.now(),
      tornNowMs: Number(/** @type {any} */ (window).getCurrentTimestamp?.() ?? Date.now()),
      viewport: { height: innerHeight, width: innerWidth },
    })),
  ]);
  const productionFullyUnmounted = ui.panelCount === 0 && ui.hostIds.length === 0;
  const expectedSuspensionActive = session.expectedSuspension && productionFullyUnmounted;
  const issues = expectedSuspensionActive
    ? []
    : [
        ...(session.expectedSuspension
          ? ['Expected suspension, but production UI is still partially mounted']
          : []),
        ...analyzeIntegrity(ui, session.rows),
      ];
  return {
    scenario: session.scenario,
    expectedSuspension: expectedSuspensionActive,
    clocks,
    rows,
    issues,
    requests,
    pendingTokens,
    safety: {
      unexpectedRequests,
      blockedNetwork: [...session.harness.blockedNetwork],
      blockedContextNetwork: [...session.contextBlockedNetwork],
      pageErrors: session.harness.pageErrors.map((item) => item.message),
    },
    production: await session.page.evaluate((panelSelector) => {
      const panel = document.querySelector(panelSelector);
      return {
        panelCount: document.querySelectorAll(panelSelector).length,
        version: panel?.shadowRoot?.querySelector('.version')?.textContent?.trim() || 'unmounted',
      };
    }, warDibsSelectors.panel),
  };
}

/** @param {Page} page */
function collectRowSummary(page) {
  return page.evaluate(
    (hostPrefix) =>
      [...document.querySelectorAll('#faction_war_list_id li.enemy')].map((row) => {
        const href = row.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
        const id = new URL(href, location.href).searchParams.get('XID') || 'UNKNOWN';
        const host = document.getElementById(`${hostPrefix}${id}`);
        const button = host?.shadowRoot?.querySelector('button');
        const status = row.querySelector(':scope > .status');
        const level = row.querySelector(':scope > .level');
        return {
          id,
          badgeId:
            row
              .querySelector(':scope > .member > .ks-arena-player-id')
              ?.getAttribute('data-arena-player-id') || '',
          name: row.querySelector('[data-test-player-name]')?.textContent?.trim() || '',
          title: row.querySelector('[data-test-player-title]')?.textContent?.trim() || '',
          hospital: status?.getAttribute('data-ks-twd-hospital-timer') || '',
          fairFightEstimate: row.getAttribute('data-ks-twd-v1563-ff-value') || '',
          estimate: level?.getAttribute('data-ks-twd-v1517-est') || '',
          dibsState: button?.getAttribute('data-state') || 'none',
          dibsLabel: button?.querySelector('.label')?.textContent?.trim() || '',
          dibsSub: button?.querySelector('.sub')?.textContent?.trim() || '',
        };
      }),
    warDibsSelectors.rowHostPrefix,
  );
}

/**
 * @param {Awaited<ReturnType<typeof captureWarDibsUi>>} ui
 * @param {FixtureRow[]} expectedRows
 */
function analyzeIntegrity(ui, expectedRows) {
  const issues = [];
  const expectedById = new Map(expectedRows.map((row) => [row.id, row]));
  const hostSet = new Set(ui.hostIds);
  if (hostSet.size !== ui.hostIds.length) issues.push('Duplicate global DIBS host IDs');
  if (ui.hostIds.length !== expectedRows.length) {
    issues.push(`DIBS host count ${ui.hostIds.length}; expected ${expectedRows.length}`);
  }
  if (ui.panelCount > 1) issues.push(`Production panel duplicated ${ui.panelCount} times`);
  const actualOrder = ui.rows.map((row) => row.identity);
  const expectedOrder = expectedRows.map((row) => row.id);
  if (actualOrder.join(',') !== expectedOrder.join(',')) {
    issues.push(`DOM player order ${actualOrder.join(',')} expected ${expectedOrder.join(',')}`);
  }

  for (const row of ui.rows) {
    const expected = expectedById.get(row.identity);
    if (!expected) {
      issues.push(`Unknown row identity ${row.identity || '(empty)'}`);
      continue;
    }
    if (row.directHostCount !== 1) {
      issues.push(`Player ${row.identity}: ${row.directHostCount} direct DIBS hosts`);
    }
    if (row.hostId !== `${warDibsSelectors.rowHostPrefix}${row.identity}`) {
      issues.push(`Player ${row.identity}: DIBS host ID belongs to ${row.hostId || 'nobody'}`);
    }
    if (row.hostDatasetId !== row.identity) {
      issues.push(`Player ${row.identity}: DIBS dataset owner ${row.hostDatasetId || 'missing'}`);
    }
    if (row.ffPlayerId !== row.identity) {
      issues.push(`Player ${row.identity}: FF/Est owner ${row.ffPlayerId || 'missing'}`);
    }
    if (row.ffGauge !== 'true') issues.push(`Player ${row.identity}: FF arrow missing`);
    const expectedSignature = expectedVisualSignature(/** @type {any} */ (expected));
    if (row.ffValue !== expectedSignature.ffValue) {
      issues.push(
        `Player ${row.identity}: FF/Est “${row.ffValue || 'missing'}” expected “${expectedSignature.ffValue}”`,
      );
    }
    if (
      expected.name &&
      (!row.name?.visible ||
        !row.name.withinClippingAncestors ||
        !row.name.withinMember ||
        !row.name.withinRow ||
        !positiveRect(row.name.elementRect) ||
        !positiveRect(row.name.rangeRect))
    ) {
      issues.push(`Player ${row.identity}: name hidden or clipped`);
    }
    if (
      expected.title &&
      (!row.title?.visible ||
        !row.title.withinClippingAncestors ||
        !row.title.withinMember ||
        !row.title.withinRow ||
        !positiveRect(row.title.elementRect) ||
        !positiveRect(row.title.rangeRect))
    ) {
      issues.push(`Player ${row.identity}: title hidden or clipped`);
    }
    if (row.memberHiddenCount !== 0) {
      issues.push(`Player ${row.identity}: production attributes hide native member content`);
    }
    if (!positiveRect(row.rowRect)) issues.push(`Player ${row.identity}: row has zero geometry`);
    if (!positiveRect(row.hostRect))
      issues.push(`Player ${row.identity}: DIBS host has zero geometry`);
    if (!positiveRect(row.buttonRect))
      issues.push(`Player ${row.identity}: DIBS button has zero geometry`);
    if (!containsRect(row.rowRect, row.hostRect)) {
      issues.push(`Player ${row.identity}: DIBS host extends outside its row`);
    }
    if (!containsRect(row.hostRect, row.buttonRect)) {
      issues.push(`Player ${row.identity}: DIBS button extends outside its host`);
    }
    if (row.levelEstimate !== expectedSignature.estimate) {
      issues.push(`Player ${row.identity}: Est value belongs to another player`);
    }
    if (row.levelTitle !== expectedSignature.levelTitle) {
      issues.push(`Player ${row.identity}: Est title belongs to another player`);
    }
    if (
      row.ffLeftVariable !== expectedSignature.ffLeft ||
      row.ffColorVariable !== expectedSignature.ffColor
    ) {
      issues.push(`Player ${row.identity}: FF arrow geometry/color belongs to another player`);
    }
    if (
      Math.abs((row.levelPseudo?.top ?? Number.NaN) - 7) >= 0.5 ||
      !containsRect(row.rowRect, row.levelPseudo?.visualRect || null)
    ) {
      issues.push(`Player ${row.identity}: Est decoration shifted vertically or outside row`);
    }
    if (
      Math.abs((row.ffAfter?.top ?? Number.NaN) - 7) >= 0.5 ||
      !containsRect(row.rowRect, row.ffAfter?.visualRect || null)
    ) {
      issues.push(`Player ${row.identity}: FF value shifted vertically or outside row`);
    }
    if (
      Math.abs((row.ffBefore?.top ?? Number.NaN) - 1) >= 0.5 ||
      !containsRect(row.rowRect, row.ffBefore?.visualRect || null)
    ) {
      issues.push(`Player ${row.identity}: FF arrow shifted vertically or outside row`);
    }
    if (
      row.attackRect &&
      row.hostRect &&
      (Math.abs(row.attackRect.left - row.hostRect.left) >= 0.5 ||
        Math.abs(row.attackRect.width - row.hostRect.width) >= 0.5)
    ) {
      issues.push(
        `Player ${row.identity}: DIBS ${row.hostRect.width.toFixed(1)}px vs Attack ${row.attackRect.width.toFixed(1)}px`,
      );
    }
  }

  const ordered = [...ui.rows]
    .filter((row) => row.rowRect)
    .sort((left, right) => (left.rowRect?.top || 0) - (right.rowRect?.top || 0));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (
      previous?.rowRect &&
      current?.rowRect &&
      current.rowRect.top < previous.rowRect.bottom - 0.5
    ) {
      issues.push(`Rows ${previous.identity} and ${current.identity} overlap vertically`);
    }
  }
  return issues;
}

/** @param {{width: number, height: number} | null} rect */
function positiveRect(rect) {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

/**
 * @param {{left: number, right: number, top: number, bottom: number} | null} outer
 * @param {{left: number, right: number, top: number, bottom: number} | null} inner
 */
function containsRect(outer, inner) {
  return Boolean(
    outer &&
    inner &&
    inner.left >= outer.left - 1 &&
    inner.right <= outer.right + 1 &&
    inner.top >= outer.top - 1 &&
    inner.bottom <= outer.bottom + 1,
  );
}

/** @param {any} snapshot */
function formatDiagnostics(snapshot) {
  const requestList = snapshot.requests
    .slice(-6)
    .map(
      (/** @type {{sequence: number, route: string, method: string}} */ request) =>
        `${request.sequence}: ${request.route} ${request.method}`,
    )
    .join('\n');
  const rowList = snapshot.rows
    .map(
      (/** @type {any} */ row) =>
        `ID ${row.id} [badge ${row.badgeId}] | ${row.dibsLabel || row.dibsState} ${row.dibsSub}` +
        ` | Hosp ${row.hospital || '—'} | ${row.fairFightEstimate || 'FF/Est —'} | ${row.name}`,
    )
    .join('\n');
  const safetyCount =
    snapshot.safety.unexpectedRequests.length +
    snapshot.safety.blockedNetwork.length +
    snapshot.safety.blockedContextNetwork.length +
    snapshot.safety.pageErrors.length;
  return [
    `Scenario: ${snapshot.scenario}`,
    `Production: ${snapshot.production.version} | panels ${snapshot.production.panelCount}`,
    `Viewport: ${snapshot.clocks.viewport.width}×${snapshot.clocks.viewport.height}`,
    `Local: ${snapshot.clocks.localNowMs} | Torn helper: ${snapshot.clocks.tornNowMs}`,
    `Focus: ${snapshot.clocks.focused} | Hidden: ${snapshot.clocks.hidden}`,
    `Lifecycle: ${snapshot.expectedSuspension ? 'EXPECTED SUSPENSION (not an error)' : 'active'}`,
    `Safety events: ${safetyCount} | Pending: ${snapshot.pendingTokens.join(', ') || 'none'}`,
    '',
    `INTEGRITY (${snapshot.issues.length}):`,
    snapshot.issues.join('\n') || 'No geometry/ownership issues detected.',
    '',
    'ROWS:',
    rowList || '(production rows currently unmounted)',
    '',
    'RECENT MOCK REQUESTS:',
    requestList || '(none)',
  ].join('\n');
}

export const warDibsArenaSelectors = Object.freeze({
  command: (/** @type {string} */ id) => `#${arenaRootId} >> [data-command="${id}"]`,
  panelHost: `#${arenaRootId}`,
  panelTestId: arenaPanelTestId,
});
