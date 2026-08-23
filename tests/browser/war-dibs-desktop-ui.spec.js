import { expect, test } from '@playwright/test';
import { startWarDibsHarness, warDibsSelectors } from '../../test-support/war-dibs-playwright.js';
import {
  buildDesktopRows,
  captureWarDibsUi,
  expectWarDibsUiIntegrity,
  readDesktopUiFixture,
  recycleWarRowsInPlace,
  reorderWarRows,
  settleWarDibsUi,
  swapRowIdentityAttributes,
  waitForUiFrames,
} from '../../test-support/war-dibs-ui.js';

test.describe('KS Torn War Dibs desktop UI stress', () => {
  test.describe.configure({ timeout: 90_000 });

  test('keeps names, titles, FF/Est and DIBS geometry intact through fast scrolling', async ({
    page,
  }) => {
    const fixture = await readDesktopUiFixture();
    const rows = buildDesktopRows(fixture);
    const longNameRow = rows[fixture.longNameIndex];
    const longTitleRow = rows[fixture.longTitleIndex];
    if (!longNameRow || !longTitleRow) throw new Error('Long-text scroll fixtures are missing');
    const harness = await startWarDibsHarness(page, rows);
    await settleWarDibsUi(page, rows);
    await page
      .locator(`[data-test-player-name][href*="XID=${longNameRow.id}"]`)
      .scrollIntoViewIfNeeded();
    await waitForUiFrames(page);
    await expectWarDibsUiIntegrity(page, rows, { viewportTextIds: [longNameRow.id] });

    await page.mouse.move(400, 400);
    for (let cycle = 0; cycle < fixture.scrollCycles; cycle += 1) {
      await page.mouse.wheel(0, 2_400);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page
        .locator(`[data-test-player-name][href*="XID=${longTitleRow.id}"]`)
        .scrollIntoViewIfNeeded();
      await waitForUiFrames(page);
      if (cycle === 0 || cycle === Math.floor(fixture.scrollCycles / 2)) {
        await expectWarDibsUiIntegrity(page, rows, { viewportTextIds: [longTitleRow.id] });
      }

      await page.mouse.wheel(0, -2_400);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page
        .locator(`[data-test-player-name][href*="XID=${longNameRow.id}"]`)
        .scrollIntoViewIfNeeded();
      await waitForUiFrames(page);
      if (cycle === 0 || cycle === fixture.scrollCycles - 1) {
        await expectWarDibsUiIntegrity(page, rows, { viewportTextIds: [longNameRow.id] });
      }
    }

    await expectWarDibsUiIntegrity(page, rows, { viewportTextIds: [longNameRow.id] });
    await expectHarnessSafety(harness);
  });

  test('keeps player ownership exact through reorder, replacement and in-place recycling', async ({
    page,
  }) => {
    const fixture = await readDesktopUiFixture();
    const rows = buildDesktopRows(fixture).slice(0, 12);
    const harness = await startWarDibsHarness(page, rows);
    await settleWarDibsUi(page, rows);

    let order = [...rows].reverse();
    await reorderWarRows(
      page,
      order.map((row) => row.id),
    );
    await settleWarDibsUi(page, order);
    await expectWarDibsUiIntegrity(page, order);

    for (let round = 0; round < fixture.churnRounds; round += 1) {
      const [first, ...remaining] = order;
      if (!first) throw new Error('Desktop churn roster became empty');
      order = [...remaining, first];
      await recycleWarRowsInPlace(page, order);
      await settleWarDibsUi(page, order);
      await expectWarDibsUiIntegrity(page, order);

      const replacement = round % 2 === 0 ? [...order].reverse() : [...order];
      await harness.replaceRows(replacement);
      order = replacement;
      await settleWarDibsUi(page, order);
      await expectWarDibsUiIntegrity(page, order);
    }
    await expectHarnessSafety(harness);
  });

  test('remounts exactly once through repeated SPA and background/foreground churn', async ({
    page,
  }) => {
    const fixture = await readDesktopUiFixture();
    const rows = buildDesktopRows(fixture).slice(0, 10);
    const harness = await startWarDibsHarness(page, rows);
    let order = [...rows];

    for (let round = 0; round < fixture.churnRounds; round += 1) {
      await harness.controller('hide');
      await expect(page.locator(warDibsSelectors.panel)).toHaveCount(0);
      await expect(page.locator(`[id^="${warDibsSelectors.rowHostPrefix}"]`)).toHaveCount(0);

      order = [...order.slice(2), ...order.slice(0, 2)];
      if (round % 2 === 0) {
        await page.evaluate(() => document.getElementById('faction_war_list_id')?.remove());
      }
      await harness.replaceRows(order);
      await harness.controller('show');
      await settleWarDibsUi(page, order);
      await expectWarDibsUiIntegrity(page, order);
    }
    await expectHarnessSafety(harness);
  });

  test('keeps DIBS aligned with its responsive desktop attack column', async ({ page }) => {
    const fixture = await readDesktopUiFixture();
    const rows = buildDesktopRows(fixture).slice(0, 8);
    const harness = await startWarDibsHarness(page, rows);

    for (const viewport of fixture.desktopViewports) {
      await page.setViewportSize(viewport);
      await settleWarDibsUi(page, rows);
      await expectWarDibsUiIntegrity(page, rows);
    }

    await page.setViewportSize(fixture.responsiveBoundary.above);
    await settleWarDibsUi(page, rows);
    await expectDibsAttackAlignment(page);

    await page.setViewportSize(fixture.responsiveBoundary.below);
    await settleWarDibsUi(page, rows);
    await expectDibsAttackAlignment(page, true);

    await page.setViewportSize(fixture.responsiveBoundary.above);
    await settleWarDibsUi(page, rows);
    await expectDibsAttackAlignment(page);
    await expectHarnessSafety(harness);
  });

  test('never hides a native player name or title that reads Attack', async ({ page }) => {
    const fixture = await readDesktopUiFixture();
    const [first, second] = buildDesktopRows(fixture);
    if (!first || !second) throw new Error('Attack text regression fixtures are missing');
    const rows = [
      {
        ...first,
        name: 'Attack',
        title: 'Long native title remains visible beside an unrecognized attack cell',
        attackCellClass: 'action-cell',
      },
      {
        ...second,
        name: 'Long native player name remains completely visible',
        title: 'Attack',
        attackCellClass: 'action-cell',
      },
    ];
    const harness = await startWarDibsHarness(page, rows);
    await settleWarDibsUi(page, rows);
    const snapshot = await captureWarDibsUi(page);
    const hiddenNativeText = snapshot.rows
      .filter((row) => row.memberHiddenCount !== 0 || !row.name?.visible || !row.title?.visible)
      .map((row) => ({
        hiddenMemberNodes: row.memberHiddenCount,
        id: row.identity,
        nameVisible: row.name?.visible,
        titleVisible: row.title?.visible,
      }));
    expect.soft(hiddenNativeText, 'native player text hidden by DIBS placement').toEqual([]);
    await expectHarnessSafety(harness);
  });

  test('does not leak FF/Est or DIBS ownership during attribute-only row recycling', async ({
    page,
  }) => {
    const fixture = await readDesktopUiFixture();
    const [first, second] = buildDesktopRows(fixture).map((row) => ({
      ...row,
      name: 'Recycled Player',
      title: 'Recycled native title',
    }));
    if (!first || !second) throw new Error('Attribute recycling fixtures are missing');
    const rows = [first, second];
    const harness = await startWarDibsHarness(page, rows);
    await settleWarDibsUi(page, rows);

    await swapRowIdentityAttributes(page, first.id, second.id);
    const immediate = await captureWarDibsUi(page);
    const immediateLeaks = immediate.rows
      .filter(
        (row) =>
          row.ffPlayerId !== row.identity ||
          row.hostDatasetId !== row.identity ||
          row.hostId !== `${warDibsSelectors.rowHostPrefix}${row.identity}`,
      )
      .map((row) => ({
        dibsDatasetId: row.hostDatasetId,
        dibsHostId: row.hostId,
        ffPlayerId: row.ffPlayerId,
        rowIdentity: row.identity,
      }));
    expect.soft(immediateLeaks, 'cross-player leaks before the periodic repair scan').toEqual([]);

    await expect
      .poll(
        async () => {
          const snapshot = await captureWarDibsUi(page);
          return snapshot.rows.every(
            (row) => row.ffPlayerId === row.identity && row.hostDatasetId === row.identity,
          );
        },
        { timeout: 2_000 },
      )
      .toBe(true);
    await expectWarDibsUiIntegrity(page, [second, first]);
    await expectHarnessSafety(harness);
  });
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {boolean} [soft]
 */
async function expectDibsAttackAlignment(page, soft = false) {
  const snapshot = await captureWarDibsUi(page);
  const mismatches = snapshot.rows
    .filter((row) => {
      if (!row.hostRect || !row.attackRect) return true;
      return (
        Math.abs(row.hostRect.left - row.attackRect.left) >= 0.5 ||
        Math.abs(row.hostRect.right - row.attackRect.right) >= 0.5 ||
        Math.abs(row.hostRect.width - row.attackRect.width) >= 0.5
      );
    })
    .map((row) => ({ attack: row.attackRect, dibs: row.hostRect, id: row.identity }));
  if (soft) {
    expect.soft(mismatches, 'DIBS and native attack-column geometry diverged').toEqual([]);
  } else {
    expect(mismatches, 'DIBS and native attack-column geometry diverged').toEqual([]);
  }
}

/**
 * @param {{
 *   controller: (method: string, ...args: unknown[]) => Promise<any>,
 *   pageErrors: Error[],
 *   blockedNetwork: string[],
 * }} harness
 */
async function expectHarnessSafety(harness) {
  expect(await harness.controller('getUnexpectedRequests')).toEqual([]);
  expect(harness.blockedNetwork).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
}
