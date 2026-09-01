import { expect, test } from '@playwright/test';
import {
  clickPanelRole,
  forceWarDibsScan,
  readWarDibsFixture,
  requestsFor,
  startWarDibsHarness,
  warDibsControl,
} from '../../test-support/war-dibs-playwright.js';

test.describe('KS Torn War Dibs deterministic gates', () => {
  test('opens the Hospital gate at 2:00 while locking 2:01', async ({ page }) => {
    const fixture = await readWarDibsFixture();
    const harness = await startWarDibsHarness(page, fixture.hospitalGateRows);
    const [above, exact, below] = fixture.hospitalGateRows;

    if (!above || !exact || !below) throw new Error('Hospital gate fixtures are incomplete');

    await expectHospitalState(page, above.id, '02:01', 'locked', '2:01');
    await expectHospitalState(page, exact.id, '02:00', 'ready', '2:00 · FF3.0');
    await expectHospitalState(page, below.id, '01:59', 'ready', '1:59 · FF3.0');

    await expect(warDibsControl(page, above.id).button).toBeDisabled();
    await expect(warDibsControl(page, exact.id).button).toBeEnabled();
    await expect(warDibsControl(page, below.id).button).toBeEnabled();
    expect(harness.pageErrors).toEqual([]);
  });

  test('treats 2.00 and 5.00 as inclusive Fair Fight boundaries', async ({ page }) => {
    const fixture = await readWarDibsFixture();
    const harness = await startWarDibsHarness(page, fixture.fairFightRows);
    const [belowMinimum, minimum, maximum, aboveMaximum] = fixture.fairFightRows;

    if (!belowMinimum || !minimum || !maximum || !aboveMaximum) {
      throw new Error('Fair Fight boundary fixtures are incomplete');
    }

    await expectFairFightState(page, belowMinimum.id, '1.99', 'locked', 'FF2.0');
    await expectFairFightState(page, minimum.id, '2.00', 'ready', '2:00 · FF2.0');
    await expectFairFightState(page, maximum.id, '5.00', 'ready', '2:00 · FF5.0');
    await expectFairFightState(page, aboveMaximum.id, '5.01', 'locked', 'FF5.0');

    await expect(warDibsControl(page, belowMinimum.id).button).toBeDisabled();
    await expect(warDibsControl(page, minimum.id).button).toBeEnabled();
    await expect(warDibsControl(page, maximum.id).button).toBeEnabled();
    await expect(warDibsControl(page, aboveMaximum.id).button).toBeDisabled();
    expect(harness.pageErrors).toEqual([]);
  });

  test('uses ceil-plus-one Hospital semantics at exact second boundaries', async ({ page }) => {
    const fixture = await readWarDibsFixture();
    const row = fixture.hospitalGateRows[1];
    if (!row) throw new Error('Exact Hospital boundary fixture is missing');

    const harness = await startWarDibsHarness(page, row);

    await expectHospitalState(page, row.id, '02:00', 'ready', '2:00 · FF3.0');

    await harness.controller('setNowMs', fixture.baseNowMs + 999);
    await forceWarDibsScan(page);
    await expectHospitalState(page, row.id, '02:00', 'ready', '2:00 · FF3.0');

    await harness.controller('setNowMs', fixture.baseNowMs + 1_000);
    await forceWarDibsScan(page);
    await expectHospitalState(page, row.id, '01:59', 'ready', '1:59 · FF3.0');
    expect(harness.pageErrors).toEqual([]);
  });

  test('characterizes Hospital gating as local-Date based despite divergent time sources', async ({
    page,
  }) => {
    const fixture = await readWarDibsFixture();
    const row = fixture.hospitalGateRows[1];
    if (!row) throw new Error('Exact Hospital boundary fixture is missing');

    const harness = await startWarDibsHarness(page, row);
    await harness.controller('setTornTimestampSeconds', fixture.baseNowMs / 1_000 + 3_600);
    await harness.controller('setCurrentTimestampMs', fixture.baseNowMs + 7_200_000);
    await harness.controller('clearRequests');
    await clickPanelRole(page, 'sync');

    await expect.poll(async () => (await requestsFor(page, 'torn:faction')).length).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          local: Date.now(),
          tornHelper: /** @type {any} */ (window).getCurrentTimestamp?.(),
        })),
      )
      .toEqual({
        local: fixture.baseNowMs,
        tornHelper: fixture.baseNowMs + 7_200_000,
      });
    await expectHospitalState(page, row.id, '02:00', 'ready', '2:00 · FF3.0');
    expect(harness.pageErrors).toEqual([]);
  });

  test('requests sorted FFScouter targets through the mocked allowlisted transport only', async ({
    page,
  }) => {
    const fixture = await readWarDibsFixture();
    const reversedRows = [...fixture.fairFightRows].reverse();
    const harness = await startWarDibsHarness(page, reversedRows);
    const statsRequests = await requestsFor(page, 'ff:stats');
    const expectedTargets = fixture.fairFightRows
      .map((row) => row.id)
      .sort((left, right) => Number(left) - Number(right))
      .join(',');

    expect(statsRequests.length).toBeGreaterThanOrEqual(1);
    for (const request of statsRequests) {
      const url = new URL(request.url);
      expect(request.method).toBe('GET');
      expect(url.origin).toBe('https://ffscouter.com');
      expect(url.pathname).toBe('/api/v1/get-stats');
      expect(url.searchParams.get('key')).toBe(fixture.keys.ffscouter);
      expect(url.searchParams.get('targets')).toBe(expectedTargets);
      expect(request.headers).toEqual({ Accept: 'application/json' });
      expect(request.data).toBeNull();
      expect([6_000, 15_000]).toContain(request.timeout);
    }
    expect(statsRequests[0]?.timeout).toBe(6_000);
    expect(await harness.controller('getUnexpectedRequests')).toEqual([]);
    expect(harness.blockedNetwork).toEqual([]);
    expect(harness.pageErrors).toEqual([]);
  });
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} playerId
 * @param {string} timer
 * @param {string} state
 * @param {string} sublabel
 */
async function expectHospitalState(page, playerId, timer, state, sublabel) {
  const control = warDibsControl(page, playerId);
  const status = control.host.locator('xpath=..').locator(':scope > .status');

  await expect(status).toHaveAttribute('data-ks-twd-hospital-timer', timer);
  await expect(status).toHaveAttribute('title', `Hospital · ${timer}`);
  await expect(control.button).toHaveAttribute('data-state', state);
  await expect(control.sub).toHaveText(sublabel);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} playerId
 * @param {string} fairFight
 * @param {string} state
 * @param {string} sublabel
 */
async function expectFairFightState(page, playerId, fairFight, state, sublabel) {
  const control = warDibsControl(page, playerId);
  const row = control.host.locator('xpath=..');

  await expect(row).toHaveAttribute('data-ks-twd-v1567-player-id', playerId);
  await expect(row).toHaveAttribute('data-ks-twd-v1563-ff-value', new RegExp(`^${fairFight} / `));
  await expect(control.button).toHaveAttribute('data-state', state);
  await expect(control.sub).toHaveText(sublabel);
}
