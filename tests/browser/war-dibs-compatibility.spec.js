import { expect, test } from '@playwright/test';
import {
  applyCompatibilityProfile,
  captureCompatibilityState,
  detectWarStuffEnhanced,
  readCompatibilityFixture,
} from '../../test-support/war-dibs-compatibility.js';
import { startWarDibsHarness } from '../../test-support/war-dibs-playwright.js';
import {
  buildDesktopRows,
  expectWarDibsUiIntegrity,
  readDesktopUiFixture,
  settleWarDibsUi,
  swapRowIdentityAttributes,
} from '../../test-support/war-dibs-ui.js';

test.describe('KS Torn War Dibs desktop compatibility profiles', () => {
  test.describe.configure({ timeout: 90_000 });

  for (const profileId of ['vanilla', 'ffscouter-v2', 'torntools', 'ffscouter-v2-torntools']) {
    test(`keeps ownership and geometry intact with ${profileId}`, async ({ page }) => {
      const compatibility = await readCompatibilityFixture();
      const desktop = await readDesktopUiFixture();
      const rows = buildDesktopRows(desktop).slice(0, compatibility.rowCount);
      const profile = requiredProfile(compatibility, profileId);
      const harness = await startWarDibsHarness(page, rows, {
        beforeUserscript: () => applyCompatibilityProfile(page, compatibility, profile, rows),
      });
      await settleWarDibsUi(page, rows);
      await expectWarDibsUiIntegrity(page, rows);

      const state = await captureCompatibilityState(page);
      expectCompatibilityOwnership(state, profile, rows);
      await expectHarnessSafety(harness);
    });
  }

  for (const profileId of ['ffscouter-v2', 'torntools', 'ffscouter-v2-torntools']) {
    test(`survives ${profileId} mounting after War Dibs`, async ({ page }) => {
      const compatibility = await readCompatibilityFixture();
      const desktop = await readDesktopUiFixture();
      const rows = buildDesktopRows(desktop).slice(0, compatibility.rowCount);
      const profile = requiredProfile(compatibility, profileId);
      const harness = await startWarDibsHarness(page, rows);

      await applyCompatibilityProfile(page, compatibility, profile, rows);
      await settleWarDibsUi(page, rows);
      await expectWarDibsUiIntegrity(page, rows);
      expectCompatibilityOwnership(await captureCompatibilityState(page), profile, rows);
      await expectHarnessSafety(harness);
    });
  }

  for (const profileId of ['war-stuff-enhanced', 'war-stuff-enhanced-ffscouter-v2']) {
    test(`models ${profileId} and reproduces the shared status overlay conflict`, async ({
      page,
    }) => {
      const compatibility = await readCompatibilityFixture();
      const desktop = await readDesktopUiFixture();
      const rows = buildDesktopRows(desktop).slice(0, compatibility.rowCount);
      const profile = requiredProfile(compatibility, profileId);
      const harness = await startWarDibsHarness(page, rows, {
        beforeUserscript: () => applyCompatibilityProfile(page, compatibility, profile, rows),
      });
      await settleWarDibsUi(page, rows);

      const detection = await detectWarStuffEnhanced(page);
      expect(detection).toEqual({
        activeCurrentRoster: true,
        activeRows: rows.length,
        booted: true,
        copyButtons: rows.length,
        overriddenStatuses: rows.length,
      });

      const state = await captureCompatibilityState(page);
      expectCompatibilityOwnership(state, profile, rows);
      expect(
        state.rows.filter((row) => row.statusPseudoContested).map((row) => row.identity),
        'WSE and War Dibs claim the same status-cell pseudo-element',
      ).toHaveLength(rows.length);
      await expectHarnessSafety(harness);
    });
  }

  test('detects WSE at boot, by current-row markers, and after late injection', async ({
    page,
  }) => {
    const compatibility = await readCompatibilityFixture();
    const desktop = await readDesktopUiFixture();
    const rows = buildDesktopRows(desktop).slice(0, 3);
    const vanilla = requiredProfile(compatibility, 'vanilla');
    const wse = requiredProfile(compatibility, 'war-stuff-enhanced');
    const harness = await startWarDibsHarness(page, rows, {
      beforeUserscript: () => applyCompatibilityProfile(page, compatibility, vanilla, rows),
    });

    expect(await detectWarStuffEnhanced(page)).toEqual({
      activeCurrentRoster: false,
      activeRows: 0,
      booted: false,
      copyButtons: 0,
      overriddenStatuses: 0,
    });

    await page.evaluate(() => document.documentElement.setAttribute('data-twse-injected', 'true'));
    expect(await detectWarStuffEnhanced(page)).toEqual({
      activeCurrentRoster: false,
      activeRows: 0,
      booted: true,
      copyButtons: 0,
      overriddenStatuses: 0,
    });

    await applyCompatibilityProfile(page, compatibility, wse, rows);
    await settleWarDibsUi(page, rows);
    const lateDetection = await detectWarStuffEnhanced(page);
    expect(lateDetection.booted).toBe(true);
    expect(lateDetection.activeCurrentRoster).toBe(true);
    expect(lateDetection.activeRows).toBe(rows.length);
    await expectHarnessSafety(harness);
  });

  test('classifies standalone plus TornTools FF as two active providers', async ({ page }) => {
    const compatibility = await readCompatibilityFixture();
    const desktop = await readDesktopUiFixture();
    const rows = buildDesktopRows(desktop).slice(0, compatibility.rowCount);
    const profile = compatibility.duplicateFfProviderScenario;
    const harness = await startWarDibsHarness(page, rows, {
      beforeUserscript: () => applyCompatibilityProfile(page, compatibility, profile, rows),
    });
    await settleWarDibsUi(page, rows);

    const state = await captureCompatibilityState(page);
    expect(state.ffscouter.cells).toBe(rows.length);
    expect(state.tornTools.gauges).toBe(rows.length);
    expect(state.tornTools.arrows).toBe(rows.length);
    expect(
      state.rows.every(
        (row) =>
          row.compatibility.ffscouterCells.length === 1 && row.compatibility.tornToolsFf.length > 0,
      ),
      'both FF providers visibly decorate every row',
    ).toBe(true);
    await expectHarnessSafety(harness);
  });

  test('isolates TornTools built-in FF ownership after attribute-only row recycling', async ({
    page,
  }) => {
    const compatibility = await readCompatibilityFixture();
    const desktop = await readDesktopUiFixture();
    const [first, second] = buildDesktopRows(desktop).slice(0, 2);
    if (!first || !second) throw new Error('TornTools recycling fixtures are missing');
    const rows = [first, second];
    const profile = {
      ...compatibility.duplicateFfProviderScenario,
      id: 'torntools-built-in-ffscouter',
      label: 'TornTools built-in FFScouter only',
      features: compatibility.duplicateFfProviderScenario.features.filter(
        (feature) => feature === 'torntools-ffscouter',
      ),
      tornToolsBuiltInFfscouter: true,
    };
    const harness = await startWarDibsHarness(page, rows, {
      beforeUserscript: () => applyCompatibilityProfile(page, compatibility, profile, rows),
    });
    await settleWarDibsUi(page, rows);

    await swapRowIdentityAttributes(page, first.id, second.id);
    const state = await captureCompatibilityState(page);
    const expectedById = new Map(rows.map((row) => [row.id, row.fairFight.toFixed(2)]));
    const tornToolsLeaks = state.rows
      .filter(
        (row) =>
          Number(row.compatibility.tornToolsFf).toFixed(2) !== expectedById.get(row.identity),
      )
      .map((row) => ({ identity: row.identity, retainedFf: row.compatibility.tornToolsFf }));
    expect(tornToolsLeaks).toHaveLength(rows.length);
    expect(
      state.rows.every(
        (row) =>
          row.warDibs.directHosts === 1 &&
          row.warDibs.ffPlayerId === row.identity &&
          row.warDibs.hostId === `ks-twd-v1517-row-${row.identity}` &&
          row.warDibs.hostPlayerId === row.identity,
      ),
      'War Dibs ownership remains correct while the TornTools-owned gauge is stale',
    ).toBe(true);
    await expectHarnessSafety(harness);
  });
});

/**
 * @param {Awaited<ReturnType<typeof captureCompatibilityState>>} state
 * @param {Awaited<ReturnType<typeof readCompatibilityFixture>>['profiles'][number]} profile
 * @param {ReturnType<typeof buildDesktopRows>} rows
 */
function expectCompatibilityOwnership(state, profile, rows) {
  const expectedById = new Map(rows.map((row) => [row.id, row]));
  const features = new Set(profile.features);
  expect(state.rows).toHaveLength(rows.length);

  for (const row of state.rows) {
    const expected = expectedById.get(row.identity);
    expect(expected, `fixture row ${row.identity}`).toBeDefined();
    if (!expected) continue;

    expect(row.warDibs).toEqual({
      directHosts: 1,
      ffPlayerId: row.identity,
      hostId: `ks-twd-v1517-row-${row.identity}`,
      hostPlayerId: row.identity,
    });

    if (features.has('ffscouter-v2')) {
      expect(row.compatibility.ffscouterCells).toEqual([expected.fairFight.toFixed(2)]);
    } else {
      expect(row.compatibility.ffscouterCells).toEqual([]);
    }

    if (features.has('torntools-estimates')) {
      expect(row.compatibility.tornToolsEstimate).toBe(
        `Stats Estimate: ${expected.battleStatsEstimateHuman}`,
      );
    } else {
      expect(row.compatibility.tornToolsEstimate).toBe('');
    }

    if (features.has('war-stuff-enhanced')) {
      expect(row.compatibility.twseCopyPlayerId).toBe(row.identity);
    } else {
      expect(row.compatibility.twseCopyPlayerId).toBe('');
      expect(row.statusPseudoContested).toBe(false);
    }
  }

  expect(state.ffscouter).toEqual({
    cells: features.has('ffscouter-v2') ? rows.length : 0,
    filterBoxes: features.has('ffscouter-v2') ? 1 : 0,
    headers: features.has('ffscouter-v2') ? 1 : 0,
    initialized: features.has('ffscouter-v2') ? 1 : 0,
  });
  expect(state.tornTools.estimates).toBe(features.has('torntools-estimates') ? rows.length : 0);
  expect(state.warStuffEnhanced).toEqual({
    copyButtons: features.has('war-stuff-enhanced') ? rows.length : 0,
    rowMarkers: features.has('war-stuff-enhanced') ? rows.length : 0,
    statusOverrides: features.has('war-stuff-enhanced') ? rows.length : 0,
  });
}

/**
 * @param {Awaited<ReturnType<typeof readCompatibilityFixture>>} fixture
 * @param {string} id
 */
function requiredProfile(fixture, id) {
  const profile = fixture.profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Missing compatibility profile ${id}`);
  return profile;
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
