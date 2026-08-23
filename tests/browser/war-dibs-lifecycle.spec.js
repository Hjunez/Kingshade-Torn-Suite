import { expect, test } from '@playwright/test';
import {
  clickPanelRole,
  readWarDibsFixture,
  requestsFor,
  startWarDibsHarness,
  warDibsControl,
  warDibsSelectors,
} from '../../test-support/war-dibs-playwright.js';

test('ignores a held shared response after blur suspension and remounts cleanly', async ({
  page,
}) => {
  const fixture = await readWarDibsFixture();
  const row = fixture.sharedRow;
  const harness = await startWarDibsHarness(page, row);
  const staleClaim = {
    claim_id: fixture.claimIds.stale,
    claimer: { player_id: 800001, name: 'Stale Claimant' },
    created_at: Math.floor(fixture.baseNowMs / 1000),
    expires_at: Math.floor(fixture.baseNowMs / 1000) + 900,
  };

  await harness.controller('clearRequests');
  await harness.controller('queueResponse', 'ff:claims', {
    body: { claims: { faction: { [row.id]: [staleClaim] } } },
  });
  await harness.controller('holdNext', 'ff:claims', 'claims-before-blur');
  await clickPanelRole(page, 'sync');
  await expect.poll(() => harness.controller('getPendingTokens')).toContain('claims-before-blur');

  await harness.controller('suspend');
  await expect(page.locator(warDibsSelectors.panel)).toHaveCount(0);
  await expect(warDibsControl(page, row.id).host).toHaveCount(0);

  await harness.controller('resolve', 'claims-before-blur');
  await expect
    .poll(() => harness.controller('getPendingTokens'))
    .not.toContain('claims-before-blur');
  await harness.controller('resume');

  await expect(page.locator(warDibsSelectors.panel)).toHaveCount(1);
  await expect(warDibsControl(page, row.id).button).toHaveAttribute('data-state', 'ready');
  await expect(warDibsControl(page, row.id).label).toHaveText('DIBS');
  await expect(page.getByText('Stale Claimant', { exact: true })).toHaveCount(0);
  await expectHarnessSafety(harness);
});

test('treats 30-second inactivity as expected polling sleep and wakes on interaction', async ({
  page,
}) => {
  const fixture = await readWarDibsFixture();
  const harness = await startWarDibsHarness(page, fixture.claimRow);

  await harness.controller('clearRequests');
  await harness.controller('setNowMs', fixture.baseNowMs + 30_001);
  await page.waitForTimeout(2_800);

  await expect(page.locator(warDibsSelectors.panel)).toHaveCount(1);
  expect(await harness.controller('getRequests')).toEqual([]);

  await harness.controller('resume');
  await expect
    .poll(() => requestsFor(page, 'ff:claims').then((requests) => requests.length))
    .toBe(1);
  await expect(page.locator(warDibsSelectors.panel)).toHaveCount(1);
  await expectHarnessSafety(harness);
});

test('unmounts across a missing SPA war root and remounts the replacement once', async ({
  page,
}) => {
  const fixture = await readWarDibsFixture();
  const [oldRow, newRow] = fixture.spaRows;
  if (!oldRow || !newRow) throw new Error('SPA lifecycle fixture requires two rows.');
  const harness = await startWarDibsHarness(page, oldRow);

  await page.evaluate(() => document.getElementById('faction_war_list_id')?.remove());
  await expect(page.locator(warDibsSelectors.panel)).toHaveCount(0, { timeout: 2_000 });
  await expect(warDibsControl(page, oldRow.id).host).toHaveCount(0);

  await harness.replaceRows([newRow]);
  await expect(page.locator(warDibsSelectors.panel)).toHaveCount(1, { timeout: 2_000 });
  await expect(warDibsControl(page, newRow.id).host).toHaveCount(1);
  await expect(warDibsControl(page, oldRow.id).host).toHaveCount(0);
  await expectHarnessSafety(harness);
});

test('uses profile XID identity and never decorates a replacement row with old stats', async ({
  page,
}) => {
  const fixture = await readWarDibsFixture();
  const [oldRow, newRow] = fixture.spaRows;
  if (!oldRow || !newRow || !oldRow.datasetId || !newRow.datasetId) {
    throw new Error('SPA identity fixture requires two rows with misleading dataset IDs.');
  }
  const harness = await startWarDibsHarness(page, oldRow);

  await expect(warDibsControl(page, oldRow.id).host).toHaveCount(1);
  await expect(warDibsControl(page, oldRow.datasetId).host).toHaveCount(0);
  await expect(warDibsControl(page, oldRow.id).host).toHaveAttribute(
    'data-ks-twd-player-id',
    oldRow.id,
  );

  await harness.controller('clearRequests');
  await harness.controller('holdNext', 'ff:stats', 'old-row-stats');
  await clickPanelRole(page, 'sync');
  await expect.poll(() => harness.controller('getPendingTokens')).toContain('old-row-stats');

  await harness.replaceRows([newRow]);
  await expect(warDibsControl(page, newRow.id).host).toHaveCount(1);
  await expect(warDibsControl(page, newRow.datasetId).host).toHaveCount(0);
  await harness.controller('resolve', 'old-row-stats');

  const newEnemyRow = page.locator(`li.enemy:has(a[href*="XID=${newRow.id}"])`);
  await expect(newEnemyRow).toHaveAttribute('data-ks-twd-v1567-player-id', newRow.id);
  await expect(newEnemyRow).not.toHaveAttribute('data-ks-twd-v1563-ff-value', /.+/);

  await clickPanelRole(page, 'sync');
  await expect(newEnemyRow).toHaveAttribute('data-ks-twd-v1563-ff-value', /4\.50/);

  await harness.controller('clearRequests');
  await warDibsControl(page, newRow.id).button.click();
  await expect
    .poll(() => requestsFor(page, 'ff:claim').then((requests) => requests.length))
    .toBe(1);
  const [claimRequest] = await requestsFor(page, 'ff:claim');
  expect(claimRequest?.body).toEqual({ target_player_id: Number(newRow.id) });
  await expectHarnessSafety(harness);
});

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
