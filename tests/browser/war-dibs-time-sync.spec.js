import { expect, test } from '@playwright/test';
import {
  forceWarDibsScan,
  readWarDibsFixture,
  requestsFor,
  startWarDibsHarness,
  warDibsControl,
  warDibsSelectors,
} from '../../test-support/war-dibs-playwright.js';

const boundarySamples = [
  { elapsedMs: 999, expectedSeconds: 121 },
  { elapsedMs: 1_000, expectedSeconds: 120 },
  { elapsedMs: 1_001, expectedSeconds: 120 },
  { elapsedMs: 1_999, expectedSeconds: 120 },
  { elapsedMs: 2_000, expectedSeconds: 119 },
  { elapsedMs: 2_001, expectedSeconds: 119 },
];

test.describe('KS Torn War Dibs FFScouter-aligned Hospital time', () => {
  for (const clock of [
    { label: '1000ms ahead', fixtureIndex: 0 },
    { label: '1000ms behind', fixtureIndex: 1 },
  ]) {
    test(`matches local wall-clock seconds with Torn time ${clock.label}`, async ({ page }) => {
      const fixture = await readWarDibsFixture();
      const row = timeSyncRow(fixture);
      const tornClockOffsetMs = fixture.timeSync.tornClockOffsetsMs[clock.fixtureIndex];
      if (tornClockOffsetMs === undefined) throw new Error('Time-sync clock fixture is incomplete');
      const harness = await startWarDibsHarness(page, row, { tornClockOffsetMs });
      const untilSeconds = hospitalUntilSeconds(fixture);

      for (const { elapsedMs, expectedSeconds } of boundarySamples) {
        const localNowMs = fixture.baseNowMs + elapsedMs;
        const tornNowMs = localNowMs + tornClockOffsetMs;
        const modeledSeconds = modeledFfscouterSeconds(untilSeconds, localNowMs);

        await harness.controller('setClocks', localNowMs, tornNowMs);
        expect(
          await page.evaluate(() => ({
            localNowMs: Date.now(),
            tornNowMs: /** @type {any} */ (window).getCurrentTimestamp?.(),
          })),
        ).toEqual({ localNowMs, tornNowMs });
        expect(modeledSeconds).toBe(expectedSeconds);
        await forceWarDibsScan(page);
        await expectSynchronizedState(page, row.id, modeledSeconds);
      }

      expect(await harness.controller('getUnexpectedRequests')).toEqual([]);
      expect(harness.blockedNetwork).toEqual([]);
      expect(harness.pageErrors).toEqual([]);
    });
  }

  test('keeps inactivity suspended and catches up from local wall-clock time on interaction', async ({
    page,
  }) => {
    const fixture = await readWarDibsFixture();
    const row = timeSyncRow(fixture);
    const tornClockOffsetMs = fixture.timeSync.tornClockOffsetsMs[0];
    if (tornClockOffsetMs === undefined) throw new Error('Time-sync clock fixture is incomplete');
    const harness = await startWarDibsHarness(page, row, { tornClockOffsetMs });
    const status = hospitalStatusCell(page, row.id);

    await setElapsedClocks(harness, fixture.baseNowMs, tornClockOffsetMs, 2_001);
    await forceWarDibsScan(page);
    const frozenTimer = await status.getAttribute('data-ks-twd-hospital-timer');

    await harness.controller('clearRequests');
    await setElapsedClocks(harness, fixture.baseNowMs, tornClockOffsetMs, 30_001);
    await page.waitForTimeout(2_800);

    await expect(page.locator(warDibsSelectors.panel)).toHaveCount(1);
    await expect(status).toHaveAttribute('data-ks-twd-hospital-timer', frozenTimer || '');
    expect(await harness.controller('getRequests')).toEqual([]);

    await harness.controller('resume');
    const modeledSeconds = modeledFfscouterSeconds(
      hospitalUntilSeconds(fixture),
      fixture.baseNowMs + 30_001,
    );
    await expect(status).toHaveAttribute(
      'data-ks-twd-hospital-timer',
      formatHospitalTimer(modeledSeconds),
    );
    await expect
      .poll(() => requestsFor(page, 'ff:claims').then((requests) => requests.length))
      .toBeGreaterThan(0);
    expect(await harness.controller('getUnexpectedRequests')).toEqual([]);
    expect(harness.blockedNetwork).toEqual([]);
    expect(harness.pageErrors).toEqual([]);
  });
});

/**
 * @param {Awaited<ReturnType<typeof readWarDibsFixture>>} fixture
 */
function timeSyncRow(fixture) {
  const row = fixture.hospitalGateRows[0];
  if (!row) throw new Error('Time-sync Hospital row is missing');
  if (row.untilOffsetSeconds !== fixture.timeSync.hospitalUntilFromLocalNowSeconds) {
    throw new Error('Time-sync Hospital fixture does not match the modeled epoch');
  }
  return row;
}

/**
 * @param {Awaited<ReturnType<typeof readWarDibsFixture>>} fixture
 */
function hospitalUntilSeconds(fixture) {
  return Math.floor(fixture.baseNowMs / 1_000) + fixture.timeSync.hospitalUntilFromLocalNowSeconds;
}

/**
 * Independent model of FFScouter's client-wall-clock Hospital second.
 *
 * @param {number} untilSeconds
 * @param {number} localNowMs
 */
function modeledFfscouterSeconds(untilSeconds, localNowMs) {
  return Math.max(0, Math.ceil(untilSeconds - localNowMs / 1_000) + 1);
}

/**
 * @param {number} seconds
 */
function formatHospitalTimer(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} playerId
 */
function hospitalStatusCell(page, playerId) {
  return warDibsControl(page, playerId).host.locator('xpath=..').locator(':scope > .status');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} playerId
 * @param {number} modeledSeconds
 */
async function expectSynchronizedState(page, playerId, modeledSeconds) {
  const control = warDibsControl(page, playerId);
  const timer = formatHospitalTimer(modeledSeconds);
  const isReady = modeledSeconds <= 120;

  await expect(hospitalStatusCell(page, playerId)).toHaveAttribute(
    'data-ks-twd-hospital-timer',
    timer,
  );
  await expect(control.button).toHaveAttribute('data-state', isReady ? 'ready' : 'locked');
  await expect(control.button).toHaveAttribute('data-ready', isReady ? 'true' : 'false');
  if (isReady) {
    await expect(control.button).toBeEnabled();
    await expect(control.sub).toHaveText(`${Number(timer.slice(0, 2))}:${timer.slice(3)} · FF3.0`);
  } else {
    await expect(control.button).toBeDisabled();
    await expect(control.sub).toHaveText(`${Number(timer.slice(0, 2))}:${timer.slice(3)}`);
  }
}

/**
 * @param {{controller: (method: string, ...args: unknown[]) => Promise<any>}} harness
 * @param {number} localBaseNowMs
 * @param {number} tornClockOffsetMs
 * @param {number} elapsedMs
 */
async function setElapsedClocks(harness, localBaseNowMs, tornClockOffsetMs, elapsedMs) {
  const localNowMs = localBaseNowMs + elapsedMs;
  await harness.controller('setClocks', localNowMs, localNowMs + tornClockOffsetMs);
}
