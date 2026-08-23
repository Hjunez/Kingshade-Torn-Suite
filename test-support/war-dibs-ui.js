import { expect } from '@playwright/test';
import { forceWarDibsScan } from './war-dibs-playwright.js';
import { readJsonFixture } from './repository.js';

const rowHostPrefix = 'ks-twd-v1517-row-';
const scoutPalette = Object.freeze([
  '#3057e1',
  '#3274ff',
  '#29a9ff',
  '#27d7f2',
  '#28d8b8',
  '#35d96f',
  '#85dd28',
  '#d9df24',
  '#f3b326',
  '#f57c1f',
  '#ef3340',
]);
const attributes = Object.freeze({
  dibsRow: 'data-ks-twd-v1538-dibs-overlay-row',
  estimate: 'data-ks-twd-v1517-est',
  ffGauge: 'data-ks-twd-v1517-ff-gauge',
  ffPlayer: 'data-ks-twd-v1567-player-id',
  ffValue: 'data-ks-twd-v1563-ff-value',
  hidden: 'data-ks-twd-v1517-hidden',
});

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   title: string,
 *   untilOffsetSeconds: number,
 *   fairFight: number,
 *   battleStatsEstimate: number,
 *   battleStatsEstimateHuman: string,
 *   attackCellClass?: string,
 * }} DesktopWarDibsRow
 */

/**
 * @typedef {{
 *   basePlayerId: number,
 *   rowCount: number,
 *   scrollCycles: number,
 *   churnRounds: number,
 *   longNameIndex: number,
 *   longTitleIndex: number,
 *   longName: string,
 *   longTitle: string,
 *   desktopViewports: Array<{width: number, height: number}>,
 *   responsiveBoundary: {
 *     above: {width: number, height: number},
 *     below: {width: number, height: number},
 *   },
 * }} DesktopUiFixture
 */

/** @returns {Promise<DesktopUiFixture>} */
export function readDesktopUiFixture() {
  return readJsonFixture('war-dibs-desktop-ui.json');
}

/**
 * @param {DesktopUiFixture} fixture
 * @returns {DesktopWarDibsRow[]}
 */
export function buildDesktopRows(fixture) {
  return Array.from({ length: fixture.rowCount }, (_, index) => {
    const ordinal = index + 1;
    return {
      id: String(fixture.basePlayerId + ordinal),
      name:
        index === fixture.longNameIndex
          ? fixture.longName
          : `Desktop Player ${String(ordinal).padStart(2, '0')}`,
      title:
        index === fixture.longTitleIndex
          ? fixture.longTitle
          : `Unique title ${String(ordinal).padStart(2, '0')}`,
      untilOffsetSeconds: 119,
      fairFight: 2 + (index * 3) / Math.max(1, fixture.rowCount - 1),
      battleStatsEstimate: ordinal * 1_000_000,
      battleStatsEstimateHuman: `${ordinal}m`,
    };
  });
}

/**
 * @param {DesktopWarDibsRow} row
 */
export function expectedVisualSignature(row) {
  const estimate = row.battleStatsEstimateHuman.toLowerCase();
  const boundedFairFight = Math.max(1, Math.min(8, row.fairFight));
  const gaugePercent =
    boundedFairFight < 2
      ? (boundedFairFight - 1) * 33
      : boundedFairFight < 4
        ? 33 + ((boundedFairFight - 2) / 2) * 33
        : 66 + ((boundedFairFight - 4) / 4) * 34;
  const clampedPercent = Math.max(33, Math.min(98, gaugePercent));
  const paletteFairFight = Math.max(1, Math.min(5, row.fairFight));
  const paletteIndex = Math.max(0, Math.min(10, Math.floor(((paletteFairFight - 1) / 4) * 10)));
  return {
    estimate,
    ffColor: scoutPalette[paletteIndex],
    ffLeft: `${(6 + (104 * clampedPercent) / 100).toFixed(2)}px`,
    ffValue: `${row.fairFight.toFixed(2)} / ${estimate}`,
    levelTitle: `Est ${estimate} · Fair Fight ${row.fairFight.toFixed(2)}`,
  };
}

/**
 * Lets layout and paint settle without invoking a userscript scan or repair path.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function waitForUiFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {DesktopWarDibsRow[]} rows
 */
export async function settleWarDibsUi(page, rows) {
  await forceWarDibsScan(page);
  await page.waitForFunction(
    ({ expectedIds, hostPrefix, attrs }) => {
      const domRows = [...document.querySelectorAll('#faction_war_list_id li.enemy')];
      const hosts = [...document.querySelectorAll(`[id^="${hostPrefix}"]`)];
      if (domRows.length !== expectedIds.length || hosts.length !== expectedIds.length)
        return false;
      return expectedIds.every((id) => {
        const row = domRows.find((candidate) => {
          const href = candidate.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
          return new URL(href, location.href).searchParams.get('XID') === id;
        });
        const host = document.getElementById(`${hostPrefix}${id}`);
        return (
          row?.getAttribute(attrs.ffPlayer) === id &&
          row?.hasAttribute(attrs.ffGauge) &&
          row?.hasAttribute(attrs.ffValue) &&
          host?.parentElement === row &&
          host.shadowRoot?.querySelectorAll('button').length === 1
        );
      });
    },
    { expectedIds: rows.map((row) => row.id), hostPrefix: rowHostPrefix, attrs: attributes },
  );
  await waitForUiFrames(page);
}

/**
 * Reorders existing row nodes without recreating them.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string[]} orderedIds
 */
export async function reorderWarRows(page, orderedIds) {
  await page.evaluate((ids) => {
    const list = document.querySelector('[data-test-enemy-rows]');
    if (!list) throw new Error('Enemy row list is missing');
    const byId = new Map(
      [...list.querySelectorAll(':scope > li.enemy')].map((row) => {
        const href = row.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
        const id = new URL(href, location.href).searchParams.get('XID') || '';
        return [id, row];
      }),
    );
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) throw new Error(`Cannot reorder missing player ${id}`);
      list.append(row);
    }
  }, orderedIds);
}

/**
 * Reuses the existing li elements for a new deterministic player order.
 *
 * @param {import('@playwright/test').Page} page
 * @param {DesktopWarDibsRow[]} nextRows
 */
export async function recycleWarRowsInPlace(page, nextRows) {
  await page.evaluate((rows) => {
    const items = [...document.querySelectorAll('[data-test-enemy-rows] > li.enemy')];
    if (items.length !== rows.length) throw new Error('Recycled row count changed');
    items.forEach((item, index) => {
      const row = rows[index];
      if (!row) throw new Error(`Missing recycled row ${index}`);
      if (!(item instanceof HTMLElement)) throw new Error(`Invalid recycled row ${index}`);
      item.dataset.playerId = row.id;
      const profile = item.querySelector('[data-test-player-name]');
      const title = item.querySelector('[data-test-player-title]');
      const attack = item.querySelector('a[href*="sid=attack"]');
      if (!(profile instanceof HTMLAnchorElement) || !(title instanceof HTMLElement)) {
        throw new Error('Recycled identity nodes are missing');
      }
      profile.href = `/profiles.php?XID=${row.id}`;
      profile.textContent = row.name;
      title.textContent = row.title;
      if (attack instanceof HTMLAnchorElement) {
        attack.href = `/loader.php?sid=attack&user2ID=${row.id}`;
      }
    });
  }, nextRows);
}

/**
 * Swaps only identity-bearing attributes. This intentionally does not create a
 * child-list or text mutation, matching virtualized-row attribute recycling.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} firstId
 * @param {string} secondId
 */
export async function swapRowIdentityAttributes(page, firstId, secondId) {
  await page.evaluate(
    ({ first, second }) => {
      const find = (/** @type {string} */ id) =>
        [...document.querySelectorAll('[data-test-enemy-rows] > li.enemy')].find((row) => {
          const href = row.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
          return new URL(href, location.href).searchParams.get('XID') === id;
        });
      const firstRow = find(first);
      const secondRow = find(second);
      if (!(firstRow instanceof HTMLElement) || !(secondRow instanceof HTMLElement)) {
        throw new Error('Rows for attribute recycling are missing');
      }
      /** @type {Array<[HTMLElement, string]>} */
      const swaps = [
        [firstRow, second],
        [secondRow, first],
      ];
      for (const [row, id] of swaps) {
        row.dataset.playerId = id;
        const profile = row.querySelector('[data-test-player-name]');
        const attack = row.querySelector('a[href*="sid=attack"]');
        if (profile instanceof HTMLAnchorElement) profile.href = `/profiles.php?XID=${id}`;
        if (attack instanceof HTMLAnchorElement) {
          attack.href = `/loader.php?sid=attack&user2ID=${id}`;
        }
      }
    },
    { first: firstId, second: secondId },
  );
  await waitForUiFrames(page);
}

/**
 * @param {import('@playwright/test').Page} page
 */
export function captureWarDibsUi(page) {
  return page.evaluate(
    ({ hostPrefix, attrs }) => {
      const rect = (/** @type {Element | Range | null | undefined} */ element) => {
        if (!element || typeof element.getBoundingClientRect !== 'function') return null;
        const value = element.getBoundingClientRect();
        return {
          bottom: value.bottom,
          height: value.height,
          left: value.left,
          right: value.right,
          top: value.top,
          width: value.width,
        };
      };
      const contains = (
        /** @type {ReturnType<typeof rect>} */ outer,
        /** @type {ReturnType<typeof rect>} */ inner,
        tolerance = 1,
      ) =>
        Boolean(
          outer &&
          inner &&
          inner.left >= outer.left - tolerance &&
          inner.right <= outer.right + tolerance &&
          inner.top >= outer.top - tolerance &&
          inner.bottom <= outer.bottom + tolerance,
        );
      const transparent = (/** @type {string} */ color) =>
        color === 'transparent' || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(color);
      const composedParent = (/** @type {Element} */ element) => {
        if (element.parentElement) return element.parentElement;
        const root = element.getRootNode();
        return root instanceof ShadowRoot ? root.host : null;
      };
      const withinClippingAncestors = (
        /** @type {Element} */ element,
        /** @type {ReturnType<typeof rect>} */ targetRect,
      ) => {
        if (!targetRect) return false;
        let parent = composedParent(element);
        while (parent) {
          const style = getComputedStyle(parent);
          const clipsX = /^(auto|clip|hidden|scroll)$/.test(style.overflowX);
          const clipsY = /^(auto|clip|hidden|scroll)$/.test(style.overflowY);
          const parentRect = rect(parent);
          if (
            parentRect &&
            ((clipsX &&
              (targetRect.left < parentRect.left - 1 || targetRect.right > parentRect.right + 1)) ||
              (clipsY &&
                (targetRect.top < parentRect.top - 1 || targetRect.bottom > parentRect.bottom + 1)))
          ) {
            return false;
          }
          parent = composedParent(parent);
        }
        return true;
      };
      const elementState = (/** @type {Element | null | undefined} */ element) => {
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        const elementRect = rect(element);
        const opacity = Number(style.opacity);
        return {
          display: style.display,
          opacity,
          visibility: style.visibility,
          visible:
            (typeof element.checkVisibility !== 'function' ||
              element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) &&
            style.display !== 'none' &&
            style.visibility === 'visible' &&
            Number.isFinite(opacity) &&
            opacity > 0,
          withinClippingAncestors: withinClippingAncestors(element, elementRect),
        };
      };
      const textState = (
        /** @type {Element | null} */ element,
        /** @type {Element | null} */ member,
        /** @type {Element} */ row,
      ) => {
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        const range = document.createRange();
        range.selectNodeContents(element);
        const rangeRect = rect(range);
        const elementRect = rect(element);
        const memberRect = rect(member);
        const rowRect = rect(row);
        const opacity = Number(style.opacity);
        return {
          color: style.color,
          display: style.display,
          elementRect,
          inViewport: Boolean(
            rangeRect &&
            rangeRect.right > 0 &&
            rangeRect.left < innerWidth &&
            rangeRect.bottom > 0 &&
            rangeRect.top < innerHeight,
          ),
          opacity,
          rangeRect,
          text: element.textContent || '',
          visible:
            (typeof element.checkVisibility !== 'function' ||
              element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) &&
            style.display !== 'none' &&
            style.visibility === 'visible' &&
            Number.isFinite(opacity) &&
            opacity > 0 &&
            !transparent(style.color),
          withinClippingAncestors: withinClippingAncestors(element, rangeRect),
          withinMember: contains(memberRect, rangeRect),
          withinRow: contains(rowRect, rangeRect),
        };
      };
      const pseudo = (/** @type {Element | null} */ element, /** @type {string} */ selector) => {
        if (!(element instanceof Element)) return null;
        const style = getComputedStyle(element, selector);
        const origin = rect(element);
        const top = Number.parseFloat(style.top);
        const left = Number.parseFloat(style.left);
        const width = Number.parseFloat(style.width);
        const height = Number.parseFloat(style.height);
        const borderLeft = Number.parseFloat(style.borderLeftWidth);
        const borderRight = Number.parseFloat(style.borderRightWidth);
        const borderTop = Number.parseFloat(style.borderTopWidth);
        const paddingLeft = Number.parseFloat(style.paddingLeft);
        const paddingRight = Number.parseFloat(style.paddingRight);
        const paddingTop = Number.parseFloat(style.paddingTop);
        const paddingBottom = Number.parseFloat(style.paddingBottom);
        const visualWidth =
          (Number.isFinite(width) ? width : 0) +
          (Number.isFinite(borderLeft) ? borderLeft : 0) +
          (Number.isFinite(borderRight) ? borderRight : 0) +
          (Number.isFinite(paddingLeft) ? paddingLeft : 0) +
          (Number.isFinite(paddingRight) ? paddingRight : 0);
        const visualHeight = Math.max(
          (Number.isFinite(height) ? height : 0) +
            (Number.isFinite(paddingTop) ? paddingTop : 0) +
            (Number.isFinite(paddingBottom) ? paddingBottom : 0),
          Number.isFinite(borderTop) ? borderTop : 0,
        );
        const translatedLeft = style.transform !== 'none' ? visualWidth / 2 : 0;
        const visualRect =
          origin && Number.isFinite(top) && Number.isFinite(left)
            ? {
                bottom: origin.top + top + visualHeight,
                height: visualHeight,
                left: origin.left + left - translatedLeft,
                right: origin.left + left - translatedLeft + visualWidth,
                top: origin.top + top,
                width: visualWidth,
              }
            : null;
        return {
          backgroundColor: style.backgroundColor,
          backgroundVisible: !transparent(style.backgroundColor),
          borderTopColor: style.borderTopColor,
          borderTopVisible: !transparent(style.borderTopColor),
          borderTopWidth: borderTop,
          color: style.color,
          colorVisible: !transparent(style.color),
          content: style.content,
          display: style.display,
          height,
          left,
          opacity: Number(style.opacity),
          top,
          visibility: style.visibility,
          visualRect,
          width,
        };
      };
      const identityFor = (/** @type {Element} */ row) => {
        const href = row.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
        return new URL(href, location.href).searchParams.get('XID') || '';
      };
      const rows = [...document.querySelectorAll('#faction_war_list_id li.enemy')].map((row) => {
        const identity = identityFor(row);
        const member = row.querySelector(':scope > .member');
        const name = member?.querySelector('[data-test-player-name]') || null;
        const title = member?.querySelector('[data-test-player-title]') || null;
        const level = row.querySelector(':scope > .level');
        const attack = row.querySelector(':scope > .attack, :scope > .action-cell');
        const hosts = [...row.querySelectorAll(`:scope > [id^="${hostPrefix}"]`)];
        const host = hosts[0] || null;
        const button = host?.shadowRoot?.querySelector('button') || null;
        const hostStyle = host instanceof HTMLElement ? getComputedStyle(host) : null;
        return {
          attackRect: rect(attack),
          buttonRect: rect(button),
          dibsMarked: row.hasAttribute(attrs.dibsRow),
          directHostCount: hosts.length,
          ffAfter: pseudo(row, '::after'),
          ffBefore: pseudo(row, '::before'),
          ffColorVariable:
            row instanceof HTMLElement ? row.style.getPropertyValue('--ks-twd-ff-color') : '',
          ffGauge: row.getAttribute(attrs.ffGauge),
          ffLeftVariable:
            row instanceof HTMLElement ? row.style.getPropertyValue('--ks-twd-ff-left-px') : '',
          ffPlayerId: row.getAttribute(attrs.ffPlayer),
          ffValue: row.getAttribute(attrs.ffValue),
          hostDatasetId: host instanceof HTMLElement ? host.dataset.ksTwdPlayerId || '' : '',
          hostDisplay: hostStyle?.display || '',
          hostId: host?.id || '',
          hostRect: rect(host),
          hostState: elementState(host),
          identity,
          levelCount: row.querySelectorAll(':scope > .level').length,
          levelEstimate: level?.getAttribute(attrs.estimate) || '',
          levelPseudo: pseudo(level, '::after'),
          levelRect: rect(level),
          levelTitle: level?.getAttribute('title') || '',
          memberHiddenCount:
            member?.querySelectorAll(
              `[${attrs.hidden}], [${attrs.estimate}], [${attrs.ffGauge}], [${attrs.ffPlayer}], [${attrs.ffValue}]`,
            ).length || 0,
          memberRect: rect(member),
          name: textState(name, member, row),
          nativeAttackHidden: Boolean(attack?.querySelector(`[${attrs.hidden}]`)),
          rowRect: rect(row),
          buttonState: elementState(button),
          title: textState(title, member, row),
        };
      });
      const hostIds = [...document.querySelectorAll(`[id^="${hostPrefix}"]`)].map(
        (host) => host.id,
      );
      return {
        hostIds,
        layoutStyleCount: document.querySelectorAll('#ks-twd-v1517-layout-style').length,
        panelCount: document.querySelectorAll('#ks-twd-v1517-panel').length,
        rows,
      };
    },
    { hostPrefix: rowHostPrefix, attrs: attributes },
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {DesktopWarDibsRow[]} expectedRows
 * @param {{checkAttackAlignment?: boolean, viewportTextIds?: string[]}} [options]
 */
export async function expectWarDibsUiIntegrity(page, expectedRows, options = {}) {
  const snapshot = await captureWarDibsUi(page);
  const expectedById = new Map(expectedRows.map((row) => [row.id, row]));
  const uniqueHosts = new Set(snapshot.hostIds);

  expect(snapshot.panelCount).toBe(1);
  expect(snapshot.layoutStyleCount).toBe(1);
  expect(snapshot.rows).toHaveLength(expectedRows.length);
  expect(
    snapshot.rows.map((row) => row.identity),
    'DOM player order',
  ).toEqual(expectedRows.map((row) => row.id));
  expect(snapshot.hostIds).toHaveLength(expectedRows.length);
  expect(uniqueHosts.size).toBe(expectedRows.length);

  for (const row of snapshot.rows) {
    const expected = expectedById.get(row.identity);
    expect(expected, `unexpected row identity ${row.identity}`).toBeDefined();
    if (!expected) continue;
    const signature = expectedVisualSignature(expected);
    expect(row.ffPlayerId, `FF owner for ${row.identity}`).toBe(row.identity);
    expect(row.ffGauge, `FF arrow for ${row.identity}`).toBe('true');
    expect(row.ffValue, `FF value for ${row.identity}`).toBe(signature.ffValue);
    expect(row.ffLeftVariable, `FF arrow position for ${row.identity}`).toBe(signature.ffLeft);
    expect(row.ffColorVariable, `FF arrow color for ${row.identity}`).toBe(signature.ffColor);
    expect(row.levelEstimate, `Est value for ${row.identity}`).toBe(signature.estimate);
    expect(row.levelTitle, `Est title for ${row.identity}`).toBe(signature.levelTitle);
    expect(row.levelCount, `level cells for ${row.identity}`).toBe(1);
    expect(row.directHostCount, `DIBS controls for ${row.identity}`).toBe(1);
    expect(row.hostId, `DIBS host id for ${row.identity}`).toBe(`${rowHostPrefix}${row.identity}`);
    expect(row.hostDatasetId, `DIBS dataset for ${row.identity}`).toBe(row.identity);
    expect(row.dibsMarked, `DIBS row marker for ${row.identity}`).toBe(true);
    expect(row.memberHiddenCount, `script attributes leaked into member ${row.identity}`).toBe(0);
    expect(row.hostDisplay, `DIBS display for ${row.identity}`).not.toBe('none');
    expect(row.hostState?.visible, `DIBS host visibility ${row.identity}`).toBe(true);
    expect(
      row.hostState?.withinClippingAncestors,
      `DIBS host ancestor clipping ${row.identity}`,
    ).toBe(true);
    expect(row.buttonState?.visible, `DIBS button visibility ${row.identity}`).toBe(true);
    expect(
      row.buttonState?.withinClippingAncestors,
      `DIBS button ancestor clipping ${row.identity}`,
    ).toBe(true);

    expectPositiveRect(row.rowRect, `row ${row.identity}`);
    expectPositiveRect(row.memberRect, `member ${row.identity}`);
    expectPositiveRect(row.levelRect, `level ${row.identity}`);
    expectPositiveRect(row.hostRect, `DIBS host ${row.identity}`);
    expectPositiveRect(row.buttonRect, `DIBS button ${row.identity}`);
    expectTextState(row.name, expected.name, `name ${row.identity}`);
    expectTextState(row.title, expected.title, `title ${row.identity}`);
    if (options.viewportTextIds?.includes(row.identity)) {
      expect(row.name?.inViewport, `name viewport visibility ${row.identity}`).toBe(true);
      expect(row.title?.inViewport, `title viewport visibility ${row.identity}`).toBe(true);
    }

    expect(row.levelPseudo?.display, `Est display ${row.identity}`).not.toBe('none');
    expect(row.levelPseudo?.visibility, `Est visibility ${row.identity}`).toBe('visible');
    expect(row.levelPseudo?.content, `Est content ${row.identity}`).toContain(signature.estimate);
    expect(row.levelPseudo?.top, `Est vertical offset ${row.identity}`).toBeCloseTo(7, 1);
    expect(row.levelPseudo?.height, `Est height ${row.identity}`).toBeGreaterThan(0);
    expect(row.levelPseudo?.opacity, `Est opacity ${row.identity}`).toBeGreaterThan(0);
    expect(row.levelPseudo?.colorVisible, `Est paint ${row.identity}`).toBe(true);
    expect(row.levelPseudo?.backgroundVisible, `Est background ${row.identity}`).toBe(true);
    expect(row.levelPseudo?.visualRect?.top, `Est rendered top ${row.identity}`).toBeCloseTo(
      (row.rowRect?.top || 0) + 7,
      0,
    );
    expectContained(row.levelPseudo?.visualRect || null, row.rowRect, `Est in row ${row.identity}`);
    expect(row.ffAfter?.display, `FF display ${row.identity}`).not.toBe('none');
    expect(row.ffAfter?.visibility, `FF visibility ${row.identity}`).toBe('visible');
    expect(row.ffAfter?.content, `FF content ${row.identity}`).toContain(signature.ffValue);
    expect(row.ffAfter?.top, `FF vertical offset ${row.identity}`).toBeCloseTo(7, 1);
    expect(row.ffAfter?.width, `FF width ${row.identity}`).toBeGreaterThan(0);
    expect(row.ffAfter?.opacity, `FF opacity ${row.identity}`).toBeGreaterThan(0);
    expect(row.ffAfter?.colorVisible, `FF paint ${row.identity}`).toBe(true);
    expect(row.ffAfter?.backgroundVisible, `FF background ${row.identity}`).toBe(true);
    expect(row.ffAfter?.left, `FF rendered left ${row.identity}`).toBeCloseTo(
      Number.parseFloat(signature.ffLeft),
      1,
    );
    expect(row.ffAfter?.visualRect?.top, `FF rendered top ${row.identity}`).toBeCloseTo(
      (row.rowRect?.top || 0) + 7,
      0,
    );
    expectContained(
      row.ffAfter?.visualRect || null,
      row.rowRect,
      `FF value in row ${row.identity}`,
    );
    expect(row.ffBefore?.top, `FF arrow vertical offset ${row.identity}`).toBeCloseTo(1, 1);
    expect(row.ffBefore?.borderTopWidth, `FF arrow size ${row.identity}`).toBeGreaterThan(0);
    expect(row.ffBefore?.opacity, `FF arrow opacity ${row.identity}`).toBeGreaterThan(0);
    expect(row.ffBefore?.borderTopVisible, `FF arrow paint ${row.identity}`).toBe(true);
    expect(row.ffBefore?.left, `FF arrow rendered left ${row.identity}`).toBeCloseTo(
      Number.parseFloat(signature.ffLeft),
      1,
    );
    expect(row.ffBefore?.visualRect?.top, `FF arrow rendered top ${row.identity}`).toBeCloseTo(
      (row.rowRect?.top || 0) + 1,
      0,
    );
    expectContained(
      row.ffBefore?.visualRect || null,
      row.rowRect,
      `FF arrow in row ${row.identity}`,
    );

    expectContained(row.hostRect, row.rowRect, `DIBS host in row ${row.identity}`);
    expectContained(row.buttonRect, row.hostRect, `DIBS button in host ${row.identity}`);
    expectContained(row.buttonRect, row.rowRect, `DIBS button in row ${row.identity}`);
    if (options.checkAttackAlignment !== false) {
      expectPositiveRect(row.attackRect, `attack cell ${row.identity}`);
      expect(row.hostRect?.right, `DIBS right edge ${row.identity}`).toBeCloseTo(
        row.attackRect?.right || 0,
        0,
      );
      expect(row.hostRect?.left, `DIBS left edge ${row.identity}`).toBeCloseTo(
        row.attackRect?.left || 0,
        0,
      );
      expect(row.hostRect?.width, `DIBS width ${row.identity}`).toBeCloseTo(
        row.attackRect?.width || 0,
        0,
      );
    }
  }

  for (let index = 1; index < snapshot.rows.length; index += 1) {
    const previous = snapshot.rows[index - 1]?.rowRect;
    const current = snapshot.rows[index]?.rowRect;
    expect(previous?.bottom, `row overlap before index ${index}`).toBeLessThanOrEqual(
      (current?.top || 0) + 0.5,
    );
  }
  return snapshot;
}

/**
 * @param {{width: number, height: number, top: number, bottom: number, left: number, right: number} | null} value
 * @param {string} label
 */
function expectPositiveRect(value, label) {
  expect(value, `${label} rectangle`).not.toBeNull();
  expect(value?.width || 0, `${label} width`).toBeGreaterThan(0);
  expect(value?.height || 0, `${label} height`).toBeGreaterThan(0);
}

/**
 * @param {{width: number, height: number, top: number, bottom: number, left: number, right: number} | null} inner
 * @param {{width: number, height: number, top: number, bottom: number, left: number, right: number} | null} outer
 * @param {string} label
 */
function expectContained(inner, outer, label) {
  expect(inner, `${label} inner rectangle`).not.toBeNull();
  expect(outer, `${label} outer rectangle`).not.toBeNull();
  expect(inner?.left || 0, `${label} left`).toBeGreaterThanOrEqual((outer?.left || 0) - 1);
  expect(inner?.right || 0, `${label} right`).toBeLessThanOrEqual((outer?.right || 0) + 1);
  expect(inner?.top || 0, `${label} top`).toBeGreaterThanOrEqual((outer?.top || 0) - 1);
  expect(inner?.bottom || 0, `${label} bottom`).toBeLessThanOrEqual((outer?.bottom || 0) + 1);
}

/**
 * @param {{
 *   text: string,
 *   visible: boolean,
 *   withinClippingAncestors: boolean,
 *   withinMember: boolean,
 *   withinRow: boolean,
 *   elementRect: {width: number, height: number} | null,
 *   rangeRect: {width: number, height: number} | null,
 * } | null} state
 * @param {string} expectedText
 * @param {string} label
 */
function expectTextState(state, expectedText, label) {
  expect(state, `${label} state`).not.toBeNull();
  expect(state?.text, `${label} text`).toBe(expectedText);
  expect(state?.visible, `${label} visibility`).toBe(true);
  expect(state?.withinClippingAncestors, `${label} ancestor clipping`).toBe(true);
  expect(state?.withinMember, `${label} member clipping`).toBe(true);
  expect(state?.withinRow, `${label} row clipping`).toBe(true);
  expect(state?.elementRect?.width || 0, `${label} element width`).toBeGreaterThan(0);
  expect(state?.elementRect?.height || 0, `${label} element height`).toBeGreaterThan(0);
  expect(state?.rangeRect?.width || 0, `${label} text width`).toBeGreaterThan(0);
  expect(state?.rangeRect?.height || 0, `${label} text height`).toBeGreaterThan(0);
}

export const warDibsUiAttributes = attributes;
