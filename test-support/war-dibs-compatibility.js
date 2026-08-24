import { readJsonFixture } from './repository.js';

const compatibilityStyleId = 'ks-war-dibs-compatibility-model-styles';
const rowHostPrefix = 'ks-twd-v1517-row-';

/**
 * @typedef {'supported' | 'conditional' | 'unsupported' | 'misconfigured'} CompatibilitySupport
 */

/**
 * @typedef {'ffscouter-v2' | 'torntools-estimates' | 'torntools-ffscouter' | 'war-stuff-enhanced'} CompatibilityFeature
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   support: CompatibilitySupport,
 *   features: CompatibilityFeature[],
 *   tornToolsBuiltInFfscouter?: boolean,
 * }} CompatibilityProfile
 */

/**
 * @typedef {{
 *   contentWidth: number,
 *   rowCount: number,
 *   sources: Record<string, Record<string, string>>,
 *   profiles: CompatibilityProfile[],
 *   duplicateFfProviderScenario: CompatibilityProfile,
 *   markers: Record<string, string[]>,
 * }} CompatibilityFixture
 */

/**
 * @typedef {{
 *   id: string,
 *   fairFight: number,
 *   battleStatsEstimate: number,
 *   battleStatsEstimateHuman: string,
 * }} CompatibilityRow
 */

/** @returns {Promise<CompatibilityFixture>} */
export function readCompatibilityFixture() {
  return readJsonFixture('war-dibs-compatibility.json');
}

/**
 * @param {CompatibilityFixture} fixture
 * @param {string} id
 * @returns {CompatibilityProfile}
 */
export function compatibilityProfile(fixture, id) {
  const profile = fixture.profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown compatibility profile: ${id}`);
  return profile;
}

/**
 * Applies source-derived external-script DOM and CSS contracts. The actual War
 * Dibs userscript remains the system under test; no War Dibs behavior is copied
 * into this model.
 *
 * @param {import('@playwright/test').Page} page
 * @param {CompatibilityFixture} fixture
 * @param {CompatibilityProfile} profile
 * @param {CompatibilityRow[]} rows
 */
export async function applyCompatibilityProfile(page, fixture, profile, rows) {
  await page.evaluate(
    ({ contentWidth, model, rowModels, styleId }) => {
      const features = new Set(model.features);
      const rowData = new Map(rowModels.map((row) => [String(row.id), row]));
      const warBox = document.querySelector('.faction-war');
      if (!(warBox instanceof HTMLElement)) throw new Error('Compatibility war box is missing');

      warBox.style.width = `${contentWidth}px`;
      warBox.style.maxWidth = '100%';
      warBox.setAttribute('data-test-compatibility-profile', model.id);

      let style = document.getElementById(styleId);
      if (!(style instanceof HTMLStyleElement)) {
        style = document.createElement('style');
        style.id = styleId;
        (document.head || document.documentElement).append(style);
      }
      style.textContent = `
        .faction-war[data-ffscouter-initialized="true"] .ffscouter-header {
          box-sizing: border-box;
          float: left !important;
          width: 38px !important;
          height: 42px;
          line-height: 42px;
          text-align: center;
        }
        .faction-war[data-ffscouter-initialized="true"] .ffscouter-cell {
          box-sizing: border-box;
          float: left !important;
          width: 32px !important;
          height: 20px !important;
          margin: 7px 4px !important;
          border-radius: 3px;
          color: #fff;
          font: 700 11px/20px Arial, sans-serif;
          text-align: center;
        }
        .faction-war[data-ffscouter-col-display] .level:not(.ffscouter-cell):not(.ffscouter-header) {
          width: 29px !important;
        }
        .faction-war[data-ffscouter-col-display] .points {
          width: 38px !important;
        }
        .faction-war[data-ffscouter-col-display] .status {
          width: 50px !important;
        }
        .tt-stats-estimate {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 11px;
          padding: 5px;
          text-align: center;
        }
        .faction-war .tt-stats-estimate {
          border-bottom: unset;
        }
        .faction-war[data-test-torntools-estimates="true"] li.enemy {
          flex-wrap: wrap;
          height: auto;
        }
        .faction-war[data-test-torntools-estimates="true"] li.enemy > .clear {
          clear: both;
          flex-basis: 100%;
          width: 100%;
          height: 0;
        }
        .faction-war[data-test-torntools-estimates="true"] li.enemy > .tt-stats-estimate {
          flex: 1 0 100%;
        }
        .tt-ff-scouter-indicator {
          position: relative;
        }
        .tt-ff-scouter-arrow {
          position: absolute;
          top: 0;
          left: calc(
            var(--arrow-width) / 2 + var(--band-percent) *
              (100% - var(--arrow-width)) / 100
          );
          width: var(--arrow-width);
          transform: translate(-50%, -50%);
          pointer-events: none;
        }
        .members-list li .member {
          position: relative;
        }
        html[data-twse-injected="true"] .members-list li .member {
          display: flex !important;
          align-items: center;
        }
        .twse-copy-btn {
          position: absolute;
          top: 50%;
          right: 8px;
          z-index: 10;
          box-sizing: content-box;
          width: 12px;
          height: 12px;
          padding: 4px;
          border: 0;
          transform: translateY(-50%);
        }
        .members-list div.status[data-twse-overridden="true"] {
          position: relative !important;
          color: transparent !important;
        }
        .members-list div.status[data-twse-overridden="true"]::after {
          content: var(--twse-content);
          position: absolute;
          top: 0;
          left: 0;
          right: 10px;
          display: flex;
          width: calc(100% - 10px);
          height: 100%;
          align-items: center;
          justify-content: flex-end;
          white-space: nowrap !important;
        }
        .twse-sort-toggle-container {
          position: absolute;
          top: 4px;
          left: 10px;
        }
      `;

      const identityFor = (/** @type {Element} */ row) => {
        const href = row.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
        return new URL(href, location.href).searchParams.get('XID') || '';
      };
      const playerRows = [...warBox.querySelectorAll('ul.members-list > li.enemy')];

      if (features.has('ffscouter-v2')) {
        document.documentElement.setAttribute('__FF_SCOUTER_V2_INJECTED__', '1');
        warBox.setAttribute('data-ffscouter-initialized', 'true');
        warBox.setAttribute('data-ffscouter-col-display', 'fair_fight');

        const filterBox = document.createElement('div');
        filterBox.setAttribute('data-ff-filter-box', 'true');
        filterBox.setAttribute('data-mode', 'war');
        filterBox.textContent = 'FFScouter filters';
        warBox.prepend(filterBox);

        for (const warList of warBox.querySelectorAll('.enemy-faction, .your-faction')) {
          warList.setAttribute('data-ffscouter-header-click', 'true');
          const nativeHeader = warList.querySelector('.white-grad > .level');
          if (nativeHeader && !warList.querySelector('.white-grad > .ffscouter-header')) {
            const header = document.createElement('div');
            header.className = 'left level ffscouter-header';
            header.textContent = 'FF';
            nativeHeader.insertAdjacentElement('afterend', header);
          }
        }

        for (const playerRow of playerRows) {
          const id = identityFor(playerRow);
          const data = rowData.get(id);
          const nativeLevel = playerRow.querySelector(':scope > .level');
          if (!data || !nativeLevel || playerRow.querySelector(':scope > .ffscouter-cell'))
            continue;
          playerRow.setAttribute('data-ff-value', String(data.fairFight));
          playerRow.setAttribute('data-est-value', String(data.battleStatsEstimate));
          const cell = document.createElement('div');
          cell.className = 'left level ffscouter-cell';
          cell.textContent = Number(data.fairFight).toFixed(2);
          cell.style.backgroundColor = ffColor(data.fairFight);
          nativeLevel.insertAdjacentElement('afterend', cell);
        }
      }

      if (features.has('torntools-estimates')) {
        warBox.setAttribute('data-test-torntools-estimates', 'true');
        for (const playerRow of playerRows) {
          const id = identityFor(playerRow);
          const data = rowData.get(id);
          if (!data) continue;
          playerRow.classList.add('tt-estimated');
          playerRow.setAttribute('data-estimate', String(data.battleStatsEstimate));
          let clear = playerRow.querySelector(':scope > .clear');
          if (!clear) {
            clear = document.createElement('div');
            clear.className = 'clear';
            playerRow.append(clear);
          }
          const estimate = document.createElement('div');
          estimate.className = 'tt-stats-estimate';
          estimate.textContent = `Stats Estimate: ${data.battleStatsEstimateHuman}`;
          clear.insertAdjacentElement('afterend', estimate);
        }
      }

      if (features.has('torntools-ffscouter')) {
        for (const playerRow of playerRows) {
          const id = identityFor(playerRow);
          const data = rowData.get(id);
          const host = playerRow.querySelector('.member a[href*="XID="]');
          if (!(host instanceof HTMLElement) || !data) continue;
          host.classList.add('tt-ff-scouter-indicator', 'indicator-lines');
          host.setAttribute('data-ff-scout', String(data.fairFight));
          host.style.setProperty('--arrow-width', '20px');
          host.style.setProperty('--band-percent', String(ffPercent(data.fairFight)));
          const arrow = document.createElement('img');
          arrow.className = 'tt-ff-scouter-arrow';
          arrow.alt = '';
          arrow.src =
            'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 12"%3E%3Cpath fill="%2335d96f" d="M10 12 0 0h20z"/%3E%3C/svg%3E';
          host.append(arrow);
        }
      }

      if (features.has('war-stuff-enhanced')) {
        document.documentElement.setAttribute('data-twse-injected', 'true');
        const toggle = document.createElement('div');
        toggle.className = 'twse-sort-toggle-container';
        toggle.innerHTML =
          '<label><input id="twse-war-sort-checkbox" type="checkbox" checked> TWSE sort</label>';
        warBox.append(toggle);

        for (const [index, playerRow] of playerRows.entries()) {
          const id = identityFor(playerRow);
          const data = rowData.get(id);
          if (!data) continue;
          playerRow.setAttribute('data-player_id', id);
          playerRow.setAttribute('data-sortA', String(index));
          playerRow.setAttribute('data-location', 'Torn');
          playerRow.setAttribute('data-okay-since', '0');
          playerRow.setAttribute('data-unexpected-at', '0');
          playerRow.setAttribute('data-twse-last-action-timestamp', String(1_800_000_000 - index));

          const status = playerRow.querySelector(':scope > .status');
          if (status instanceof HTMLElement) {
            status.setAttribute('data-twse-overridden', 'true');
            status.setAttribute('data-twse-highlight', index % 2 === 0 ? 'hospital' : 'traveling');
            status.style.setProperty('--twse-content', JSON.stringify('Hospital'));
          }

          const member = playerRow.querySelector(':scope > .member');
          if (member instanceof HTMLElement) {
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'twse-copy-btn';
            copy.dataset.playerId = id;
            copy.title = `Copy ${id}`;
            copy.innerHTML =
              '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="1" y="1" width="7" height="7"></rect><rect x="4" y="4" width="7" height="7"></rect></svg>';
            member.append(copy);
          }
        }

        for (const list of warBox.querySelectorAll('ul.members-list')) {
          const ordered = [...list.querySelectorAll(':scope > li.enemy, :scope > li.your')].sort(
            (left, right) =>
              Number(right.getAttribute('data-sortA')) - Number(left.getAttribute('data-sortA')),
          );
          const fragment = document.createDocumentFragment();
          for (const row of ordered) fragment.append(row);
          list.append(fragment);
        }
      }

      /** @param {number} value */
      function ffPercent(value) {
        const bounded = Math.max(1, Math.min(5, Number(value)));
        return ((bounded - 1) / 4) * 100;
      }

      /** @param {number} value */
      function ffColor(value) {
        const bounded = Math.max(1, Math.min(5, Number(value)));
        if (bounded < 2) return '#3057e1';
        if (bounded < 4) return '#35d96f';
        return '#ef3340';
      }
    },
    {
      contentWidth: fixture.contentWidth,
      model: profile,
      rowModels: rows,
      styleId: compatibilityStyleId,
    },
  );
}

/**
 * Uses only source-backed persistent markers. The root marker proves that WSE
 * booted; current-roster markers distinguish an actively decorated war list.
 *
 * @param {import('@playwright/test').Page} page
 */
export function detectWarStuffEnhanced(page) {
  return page.evaluate(() => {
    const root = document.getElementById('faction_war_list_id');
    const activeRows = root
      ? root.querySelectorAll(
          'ul.members-list > li.enemy[data-twse-last-action-timestamp], ul.members-list > li.your[data-twse-last-action-timestamp]',
        ).length
      : 0;
    const copyButtons = root?.querySelectorAll('.twse-copy-btn[data-player-id]').length || 0;
    const overriddenStatuses = root?.querySelectorAll('.status[data-twse-overridden]').length || 0;
    return {
      activeCurrentRoster: activeRows > 0 || copyButtons > 0 || overriddenStatuses > 0,
      activeRows,
      booted: document.documentElement.hasAttribute('data-twse-injected'),
      copyButtons,
      overriddenStatuses,
    };
  });
}

/**
 * @param {import('@playwright/test').Page} page
 */
export function captureCompatibilityState(page) {
  return page.evaluate(
    ({ hostPrefix }) => {
      const overlap = (/** @type {DOMRect} */ left, /** @type {DOMRect} */ right) =>
        Math.max(left.left, right.left) < Math.min(left.right, right.right) &&
        Math.max(left.top, right.top) < Math.min(left.bottom, right.bottom);
      const identityFor = (/** @type {Element} */ row) => {
        const href = row.querySelector('a[href*="XID="]')?.getAttribute('href') || '';
        return new URL(href, location.href).searchParams.get('XID') || '';
      };
      const textRect = (/** @type {Element | null} */ element) => {
        if (!element?.firstChild) return null;
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect();
      };

      const rows = [...document.querySelectorAll('#faction_war_list_id li.enemy')].map((row) => {
        const identity = identityFor(row);
        const host = row.querySelector(`:scope > [id^="${hostPrefix}"]`);
        const copy = row.querySelector('.twse-copy-btn[data-player-id]');
        const name = row.querySelector('[data-test-player-name]');
        const title = row.querySelector('[data-test-player-title]');
        const copyRect = copy?.getBoundingClientRect() || null;
        const nameRect = textRect(name);
        const titleRect = textRect(title);
        const status = row.querySelector(':scope > .status');
        return {
          compatibility: {
            ffscouterCells: [...row.querySelectorAll(':scope > .ffscouter-cell')].map((cell) =>
              String(cell.textContent || '').trim(),
            ),
            tornToolsEstimate: row.querySelector(':scope > .tt-stats-estimate')?.textContent || '',
            tornToolsFf:
              row.querySelector('.tt-ff-scouter-indicator')?.getAttribute('data-ff-scout') || '',
            twseCopyPlayerId: copy?.getAttribute('data-player-id') || '',
          },
          identity,
          memberCopyOverlap: Boolean(
            copyRect &&
            ((nameRect && overlap(copyRect, nameRect)) ||
              (titleRect && overlap(copyRect, titleRect))),
          ),
          statusPseudoContested: Boolean(
            status?.hasAttribute('data-twse-overridden') &&
            status.hasAttribute('data-ks-twd-hospital-timer'),
          ),
          warDibs: {
            directHosts: row.querySelectorAll(`:scope > [id^="${hostPrefix}"]`).length,
            ffPlayerId: row.getAttribute('data-ks-twd-v1567-player-id') || '',
            hostId: host?.id || '',
            hostPlayerId: host instanceof HTMLElement ? host.dataset.ksTwdPlayerId || '' : '',
          },
        };
      });

      return {
        ffscouter: {
          cells: document.querySelectorAll('.ffscouter-cell').length,
          filterBoxes: document.querySelectorAll('[data-ff-filter-box][data-mode="war"]').length,
          headers: document.querySelectorAll('.ffscouter-header').length,
          initialized: document.querySelectorAll('[data-ffscouter-initialized]').length,
        },
        rows,
        tornTools: {
          arrows: document.querySelectorAll('.tt-ff-scouter-arrow').length,
          estimates: document.querySelectorAll('.tt-stats-estimate').length,
          gauges: document.querySelectorAll('.tt-ff-scouter-indicator').length,
        },
        warStuffEnhanced: {
          copyButtons: document.querySelectorAll('.twse-copy-btn[data-player-id]').length,
          rowMarkers: document.querySelectorAll('li.enemy[data-twse-last-action-timestamp]').length,
          statusOverrides: document.querySelectorAll('.status[data-twse-overridden]').length,
        },
      };
    },
    { hostPrefix: rowHostPrefix },
  );
}
