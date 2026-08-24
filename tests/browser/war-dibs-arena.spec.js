import { expect, test } from '@playwright/test';

import { launchWarDibsArena } from '../../test-support/war-dibs-arena.js';

const commandIds = ['hospital-gates', 'fair-fight-gates', 'attribute-recycle', 'refresh'];

test('runs the offline War Dibs arena scenarios and resets into a clean page', async ({
  browser,
}) => {
  test.setTimeout(30_000);
  const arena = await launchWarDibsArena(browser, {
    viewport: { height: 720, width: 1280 },
  });

  try {
    await expectArenaReady(arena);

    await runCommand(arena, 'hospital-gates');
    await expectHospitalGate(arena.page, '02:01', 'locked');
    await expectHospitalGate(arena.page, '02:00', 'ready');
    await expectHospitalGate(arena.page, '01:59', 'ready');
    await expectSafeSnapshot(arena, /Hospital gates/i);

    await runCommand(arena, 'countdown-live');
    await expect
      .poll(() => arena.page.locator('[data-ks-twd-hospital-timer="01:59"]').count(), {
        timeout: 4_000,
      })
      .toBe(1);
    await runCommand(arena, 'countdown-pause');

    await runCommand(arena, 'fair-fight-gates');
    await expectFairFightGate(arena.page, '1.99', 'locked');
    await expectFairFightGate(arena.page, '2.00', 'ready');
    await expectFairFightGate(arena.page, '5.00', 'ready');
    await expectFairFightGate(arena.page, '5.01', 'locked');
    await expectSafeSnapshot(arena, /Fair Fight gates/i);

    await runCommand(arena, 'attribute-recycle');
    expect(await attributeOwnershipLeaks(arena.page)).toEqual([]);
    await expectSafeSnapshot(arena, /attribute-only/i);

    const originalPage = arena.page;
    await originalPage.locator(commandSelector('reset')).click();
    await expect.poll(() => arena.page !== originalPage).toBe(true);
    expect(arena.page).not.toBe(originalPage);
    await expectArenaReady(arena);
    await runCommand(arena, 'refresh');
    await expectSafeSnapshot(arena);
  } finally {
    await arena.close();
  }
});

test('drives claim, response-order, API-error, and lifecycle controls through the real UI', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const arena = await launchWarDibsArena(browser, {
    viewport: { height: 720, width: 1280 },
  });

  try {
    for (const id of ['claim-load', 'claim', 'release', 'reclaim', 'release', 'shared-taken']) {
      await runCommand(arena, id);
    }
    await expectSafeSnapshot(arena, /TAKEN/i);

    await arena.reset();
    for (const id of ['race-win', 'release', 'race-lose']) await runCommand(arena, id);
    await expectSafeSnapshot(arena, /loser/i);

    await arena.reset();
    await runCommand(arena, 'stale-claims');
    await expectSafeSnapshot(arena, /Stale claims/i);

    await arena.reset();
    await runCommand(arena, 'out-of-order-stats');
    await expectSafeSnapshot(arena, /Out-of-order FF/i);

    await arena.reset();
    await runCommand(arena, 'api-errors');
    await runCommand(arena, 'api-recover');
    await expectSafeSnapshot(arena, /recovery/i);

    await runCommand(arena, 'inactivity');
    await runCommand(arena, 'foreground');
    await runCommand(arena, 'background');
    await expectExpectedSuspension(arena, /blur/i);
    await runCommand(arena, 'foreground');
    await runCommand(arena, 'visibility-hide');
    await expectExpectedSuspension(arena, /Hidden-tab/i);
    await runCommand(arena, 'visibility-show');
    await runCommand(arena, 'background-cycles');
    await runCommand(arena, 'spa-remove');
    await expectExpectedSuspension(arena, /SPA war-root removal/i);
    await runCommand(arena, 'spa-remount');
    await expectSafeSnapshot(arena, /remount/i);
  } finally {
    await arena.close();
  }
});

test('drives desktop churn and leaves both documented baseline regressions reproducible', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const arena = await launchWarDibsArena(browser, {
    viewport: { height: 720, width: 1280 },
  });

  try {
    for (const id of [
      'long-roster',
      'row-reorder',
      'row-replace',
      'row-recycle',
      'attribute-recycle',
      'scroll-stress',
      'resize-1280',
      'resize-784',
    ]) {
      await runCommand(arena, id);
    }
    await expectSafeSnapshot(arena);

    await runCommand(arena, 'dom-churn');
    await arena.page.waitForTimeout(750);
    await runCommand(arena, 'dom-churn-stop');
    await arena.page.waitForTimeout(250);
    await runCommand(arena, 'refresh');
    await expectSafeSnapshot(arena);

    await runCommand(arena, 'responsive-width-regression');
    let snapshot = await arena.snapshot();
    expect(await minimizedArenaClearsWarRows(arena.page)).toBe(true);
    expect(
      snapshot.issues.some((/** @type {string} */ issue) => /DIBS .* vs Attack/.test(issue)),
    ).toBe(true);
    expectSafeTransport(snapshot);

    await runCommand(arena, 'attack-fallback-regression');
    snapshot = await arena.snapshot();
    expect(
      snapshot.issues.some((/** @type {string} */ issue) =>
        /name hidden or clipped|title hidden or clipped/.test(issue),
      ),
    ).toBe(true);
    expectSafeTransport(snapshot);
  } finally {
    await arena.close();
  }
});

/**
 * @param {Awaited<ReturnType<typeof launchWarDibsArena>>} arena
 */
async function expectArenaReady(arena) {
  await expect(arena.page.getByTestId('war-dibs-arena-panel')).toBeAttached();
  await expect(arena.page.locator('#ks-twd-v1517-panel')).toBeVisible();
  await expect
    .poll(() => arena.page.locator('#faction_war_list_id li.enemy').count())
    .toBeGreaterThan(0);

  for (const id of commandIds) {
    await expect(
      arena.page.locator(commandSelector(id)).first(),
      `arena command ${id}`,
    ).toBeVisible();
  }
}

/**
 * @param {Awaited<ReturnType<typeof launchWarDibsArena>>} arena
 * @param {string} id
 */
async function runCommand(arena, id) {
  const result = await arena.command(id);
  expect(result.ok, result.message).toBe(true);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} timer
 * @param {string} state
 */
async function expectHospitalGate(page, timer, state) {
  const row = page.locator(
    `#faction_war_list_id li.enemy:has(> .status[data-ks-twd-hospital-timer="${timer}"])`,
  );
  await expect(row).toHaveCount(1);
  await expect(row.locator(':scope > [id^="ks-twd-v1517-row-"] button')).toHaveAttribute(
    'data-state',
    state,
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} fairFight
 * @param {string} state
 */
async function expectFairFightGate(page, fairFight, state) {
  const row = page.locator(
    `#faction_war_list_id li.enemy[data-ks-twd-v1563-ff-value^="${fairFight} /"]`,
  );
  await expect(row).toHaveCount(1);
  await expect(row.locator(':scope > [id^="ks-twd-v1517-row-"] button')).toHaveAttribute(
    'data-state',
    state,
  );
}

/**
 * @param {import('@playwright/test').Page} page
 */
function attributeOwnershipLeaks(page) {
  return page.locator('#faction_war_list_id li.enemy').evaluateAll((rows) =>
    rows.flatMap((row) => {
      const href = row.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
      const playerId = new URL(href, location.href).searchParams.get('XID') || '';
      const host = row.querySelector(':scope > [id^="ks-twd-v1517-row-"]');
      const hostPlayerId = host instanceof HTMLElement ? host.dataset.ksTwdPlayerId || '' : '';
      const ffPlayerId = row.getAttribute('data-ks-twd-v1567-player-id') || '';
      const expectedHostId = `ks-twd-v1517-row-${playerId}`;
      return playerId &&
        host?.id === expectedHostId &&
        hostPlayerId === playerId &&
        ffPlayerId === playerId
        ? []
        : [{ expectedHostId, ffPlayerId, hostId: host?.id || '', hostPlayerId, playerId }];
    }),
  );
}

/**
 * @param {Awaited<ReturnType<typeof launchWarDibsArena>>} arena
 * @param {RegExp} [scenario]
 */
async function expectSafeSnapshot(arena, scenario) {
  const snapshot = await arena.snapshot();
  if (scenario) expect(snapshot.scenario).toMatch(scenario);
  expect(snapshot.rows.length).toBeGreaterThan(0);
  expect(snapshot.issues).toEqual([]);
  expectSafeTransport(snapshot);
}

/**
 * @param {Awaited<ReturnType<typeof launchWarDibsArena>>} arena
 * @param {RegExp} scenario
 */
async function expectExpectedSuspension(arena, scenario) {
  const snapshot = await arena.snapshot();
  expect(snapshot.scenario).toMatch(scenario);
  expect(snapshot.expectedSuspension).toBe(true);
  expect(snapshot.issues).toEqual([]);
  expectSafeTransport(snapshot);
}

/** @param {Awaited<ReturnType<Awaited<ReturnType<typeof launchWarDibsArena>>['snapshot']>>} snapshot */
function expectSafeTransport(snapshot) {
  expect(snapshot.safety).toEqual({
    blockedContextNetwork: [],
    blockedNetwork: [],
    pageErrors: [],
    unexpectedRequests: [],
  });
}

/**
 * @param {string} id
 */
function commandSelector(id) {
  return [
    `[data-arena-command="${id}"]`,
    `[data-command="${id}"]`,
    `button[value="${id}"]`,
    `button#${id}`,
  ].join(', ');
}

/** @param {import('@playwright/test').Page} page */
function minimizedArenaClearsWarRows(page) {
  return page.evaluate(() => {
    const shell = document
      .getElementById('ks-war-dibs-test-arena')
      ?.shadowRoot?.querySelector('.shell');
    const scope = document.querySelector('[data-test-war-scope]');
    if (!(shell instanceof HTMLElement) || !(scope instanceof HTMLElement)) return false;
    const shellRect = shell.getBoundingClientRect();
    const scopeRect = scope.getBoundingClientRect();
    return shell.classList.contains('collapsed') && shellRect.right <= scopeRect.left;
  });
}
