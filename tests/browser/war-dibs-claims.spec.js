import { expect, test } from '@playwright/test';

import {
  clickPanelRole,
  panelRole,
  readWarDibsFixture,
  requestsFor,
  startWarDibsHarness,
  warDibsControl,
  warDibsSelectors,
} from '../../test-support/war-dibs-playwright.js';

/**
 * @typedef {{
 *   claim_id: string,
 *   claimer: {player_id: number, name: string},
 *   created_at: number,
 *   expires_at: number,
 * }} ServerClaim
 */

/**
 * @param {{claimId: string, playerId: string, name: string, createdAt: number, expiresAt: number}} values
 * @returns {ServerClaim}
 */
function serverClaim(values) {
  return {
    claim_id: values.claimId,
    claimer: { player_id: Number(values.playerId), name: values.name },
    created_at: values.createdAt,
    expires_at: values.expiresAt,
  };
}

/**
 * @template T
 * @param {T[]} values
 * @param {string} label
 * @returns {T}
 */
function firstItem(values, label) {
  const value = values[0];
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

/**
 * @param {{claimIds: Record<string, string>}} fixture
 * @param {string} name
 * @returns {string}
 */
function requiredClaimId(fixture, name) {
  const value = fixture.claimIds[name];
  if (!value) throw new Error(`Missing deterministic claim ID: ${name}`);
  return value;
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, unknown> | null>}
 */
function readOwnClaim(page) {
  return page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  }, warDibsSelectors.ownClaimStorageKey);
}

/**
 * @param {Awaited<ReturnType<typeof startWarDibsHarness>>} harness
 */
async function expectNoEscapedRequestsOrErrors(harness) {
  expect(await harness.controller('getUnexpectedRequests')).toEqual([]);
  expect(harness.blockedNetwork).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
}

test.describe('KS Torn War Dibs claim lifecycle', () => {
  test('sends the exact CLAIM contract and preserves server claimant identity', async ({
    page,
  }) => {
    const initialFixture = await readWarDibsFixture();
    const harness = await startWarDibsHarness(page, initialFixture.claimRow);
    const { fixture } = harness;
    const row = fixture.claimRow;
    const firstClaimId = requiredClaimId(fixture, 'first');
    const control = warDibsControl(page, row.id);

    await expect(control.button).toHaveAttribute('data-state', 'ready');
    await harness.controller('clearRequests');
    await control.button.click();

    await expect(control.button).toHaveAttribute('data-state', 'claimed');
    await expect(control.label).toHaveText('DIBBED');
    await expect(control.sub).toHaveText('RELEASE');

    const claimRequests = await requestsFor(page, 'ff:claim');
    expect(claimRequests).toHaveLength(1);
    const request = firstItem(claimRequests, 'CLAIM request');
    const url = new URL(request.url);
    expect(request.method).toBe('POST');
    expect(url.origin).toBe('https://ffscouter.com');
    expect(url.pathname).toBe('/api/v1/hit-calling/claim');
    expect([...url.searchParams.entries()]).toEqual([['key', fixture.keys.ffscouter]]);
    expect(request.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(request.body).toEqual({ target_player_id: Number(row.id) });
    expect(request.data).toBe(JSON.stringify({ target_player_id: Number(row.id) }));
    expect(request.timeout).toBe(15_000);

    expect(await readOwnClaim(page)).toEqual({
      claimId: firstClaimId,
      targetId: row.id,
      claimerPlayerId: fixture.self.id,
      claimerName: fixture.self.name,
      expiresAt: fixture.baseNowMs / 1000 + 900,
      cleanupRequired: false,
      createdLocalAt: fixture.baseNowMs,
    });
    await expectNoEscapedRequestsOrErrors(harness);
  });

  test('renders shared TAKEN state with the first claimant identity and queue size', async ({
    page,
  }) => {
    const fixture = await readWarDibsFixture();
    const harness = await startWarDibsHarness(page, fixture.sharedRow);
    const nowSeconds = fixture.baseNowMs / 1000;
    const first = serverClaim({
      claimId: requiredClaimId(fixture, 'remote'),
      playerId: '700001',
      name: 'Alice First',
      createdAt: nowSeconds - 20,
      expiresAt: nowSeconds + 800,
    });
    const second = serverClaim({
      claimId: requiredClaimId(fixture, 'winner'),
      playerId: '700002',
      name: 'Bob Second',
      createdAt: nowSeconds - 10,
      expiresAt: nowSeconds + 810,
    });
    const control = warDibsControl(page, fixture.sharedRow.id);

    await harness.controller('setClaims', { [fixture.sharedRow.id]: [second, first] });
    await harness.controller('clearRequests');
    await clickPanelRole(page, 'sync');

    await expect(control.button).toHaveAttribute('data-state', 'shared');
    await expect(control.button).toBeDisabled();
    await expect(control.label).toHaveText('TAKEN');
    await expect(control.sub).toHaveText('Alice First +1');
    expect(await readOwnClaim(page)).toBeNull();

    const requests = await requestsFor(page, 'ff:claims');
    expect(requests.length).toBeGreaterThanOrEqual(1);
    const request = firstItem(requests, 'claims-list request');
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    expect(url.origin).toBe('https://ffscouter.com');
    expect(url.pathname).toBe('/api/v1/hit-calling/claims');
    expect([...url.searchParams.entries()]).toEqual([['key', fixture.keys.ffscouter]]);
    expect(request.headers).toEqual({ Accept: 'application/json' });
    expect(request.data).toBeNull();
    expect(await requestsFor(page, 'ff:claim')).toEqual([]);
    await expectNoEscapedRequestsOrErrors(harness);
  });

  test('RELEASE clears the exact claim and permits a deterministic reclaim', async ({ page }) => {
    const fixture = await readWarDibsFixture();
    const harness = await startWarDibsHarness(page, fixture.claimRow);
    const firstClaimId = requiredClaimId(fixture, 'first');
    const secondClaimId = requiredClaimId(fixture, 'second');
    const control = warDibsControl(page, fixture.claimRow.id);

    await expect(control.button).toHaveAttribute('data-state', 'ready');
    await harness.controller('clearRequests');
    await control.button.click();
    await expect(control.button).toHaveAttribute('data-state', 'claimed');

    await control.button.click();
    await expect(control.button).toHaveAttribute('data-state', 'ready');
    expect(await readOwnClaim(page)).toBeNull();

    const releaseRequests = await requestsFor(page, 'ff:unclaim');
    expect(releaseRequests).toHaveLength(1);
    expect(releaseRequests[0]?.method).toBe('POST');
    expect(new URL(releaseRequests[0]?.url || '').pathname).toBe('/api/v1/hit-calling/unclaim');
    expect(releaseRequests[0]?.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(releaseRequests[0]?.body).toEqual({ claim_id: firstClaimId });
    expect(releaseRequests[0]?.data).toBe(JSON.stringify({ claim_id: firstClaimId }));

    await control.button.click();
    await expect(control.button).toHaveAttribute('data-state', 'claimed');
    await expect(control.label).toHaveText('DIBBED');
    await expect(control.sub).toHaveText('RELEASE');

    const claimRequests = await requestsFor(page, 'ff:claim');
    expect(claimRequests).toHaveLength(2);
    expect(claimRequests.map((request) => request.body)).toEqual([
      { target_player_id: Number(fixture.claimRow.id) },
      { target_player_id: Number(fixture.claimRow.id) },
    ]);
    expect(await readOwnClaim(page)).toMatchObject({
      claimId: secondClaimId,
      targetId: fixture.claimRow.id,
      claimerPlayerId: fixture.self.id,
      claimerName: fixture.self.name,
      cleanupRequired: false,
    });
    await expectNoEscapedRequestsOrErrors(harness);
  });

  test('cleans up a deterministic position-two racing claim and shows the winner', async ({
    page,
  }) => {
    const fixture = await readWarDibsFixture();
    const harness = await startWarDibsHarness(page, fixture.claimRow);
    const nowSeconds = fixture.baseNowMs / 1000;
    const winnerClaimId = requiredClaimId(fixture, 'winner');
    const loserClaimId = requiredClaimId(fixture, 'loser');
    const winner = serverClaim({
      claimId: winnerClaimId,
      playerId: '700003',
      name: 'Race Winner',
      createdAt: nowSeconds - 1,
      expiresAt: nowSeconds + 899,
    });
    const loser = serverClaim({
      claimId: loserClaimId,
      playerId: fixture.self.id,
      name: fixture.self.name,
      createdAt: nowSeconds,
      expiresAt: nowSeconds + 900,
    });
    const control = warDibsControl(page, fixture.claimRow.id);

    await harness.controller('queueResponse', 'ff:claim', {
      status: 200,
      serverClaims: { [fixture.claimRow.id]: [winner, loser] },
      body: {
        claim: loser,
        position: 2,
        other_claims_for_target: [{ ...winner, position: 1 }],
      },
    });
    await harness.controller('clearRequests');
    await control.button.click();

    await expect(control.button).toHaveAttribute('data-state', 'shared');
    await expect(control.label).toHaveText('TAKEN');
    await expect(control.sub).toHaveText('Race Winner');
    expect(await readOwnClaim(page)).toBeNull();

    const claimRequests = await requestsFor(page, 'ff:claim');
    const cleanupRequests = await requestsFor(page, 'ff:unclaim');
    expect(claimRequests).toHaveLength(1);
    expect(claimRequests[0]?.body).toEqual({
      target_player_id: Number(fixture.claimRow.id),
    });
    expect(cleanupRequests).toHaveLength(1);
    expect(cleanupRequests[0]?.body).toEqual({ claim_id: loserClaimId });
    expect(cleanupRequests[0]?.body).not.toEqual({ claim_id: winnerClaimId });
    await expectNoEscapedRequestsOrErrors(harness);
  });

  test('does not erase a successful CLAIM when an older empty claims GET resolves later', async ({
    page,
  }) => {
    const fixture = await readWarDibsFixture();
    const harness = await startWarDibsHarness(page, fixture.claimRow);
    const firstClaimId = requiredClaimId(fixture, 'first');
    const control = warDibsControl(page, fixture.claimRow.id);

    await harness.controller('clearRequests');
    await harness.controller('holdNext', 'ff:claims', 'old-empty-claims');
    await clickPanelRole(page, 'sync');
    await expect.poll(() => harness.controller('getPendingTokens')).toContain('old-empty-claims');

    await control.button.click();
    await expect(control.button).toHaveAttribute('data-state', 'claimed');
    const createdClaim = await readOwnClaim(page);
    expect(createdClaim).toMatchObject({
      claimId: firstClaimId,
      targetId: fixture.claimRow.id,
      claimerPlayerId: fixture.self.id,
      claimerName: fixture.self.name,
    });

    await harness.controller('resolve', 'old-empty-claims');
    await expect(panelRole(page, 'status')).toContainText('0 targets');
    await expect(control.button).toHaveAttribute('data-state', 'claimed');
    await expect(control.label).toHaveText('DIBBED');
    expect(await readOwnClaim(page)).toEqual(createdClaim);

    await clickPanelRole(page, 'sync');
    await expect(panelRole(page, 'status')).toContainText('1 targets');
    await expect(control.button).toHaveAttribute('data-state', 'claimed');
    expect(await readOwnClaim(page)).toEqual(createdClaim);

    const claimsReads = await requestsFor(page, 'ff:claims');
    expect(claimsReads).toHaveLength(2);
    expect(claimsReads[0]?.sequence).toBeLessThan(claimsReads[1]?.sequence || 0);
    expect(await requestsFor(page, 'ff:claim')).toHaveLength(1);
    expect(await harness.controller('getPendingTokens')).toEqual([]);
    await expectNoEscapedRequestsOrErrors(harness);
  });
});
