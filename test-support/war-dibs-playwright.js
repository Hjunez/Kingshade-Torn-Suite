import { readJsonFixture, readRepositoryFile, repositoryPath } from './repository.js';

const fixturePageUrl = 'https://www.torn.com/factions.php?step=your&type=1';
const panelSelector = '#ks-twd-v1517-panel';
const rowHostPrefix = 'ks-twd-v1517-row-';
const ownClaimStorageKey = 'ks_torn_war_dibs_bridge_own_claim_v1';

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   untilOffsetSeconds: number,
 *   fairFight: number,
 *   datasetId?: string,
 * }} WarDibsRow
 */

/**
 * @typedef {{
 *   baseNowMs: number,
 *   keys: {ffscouter: string, torn: string},
 *   self: {id: string, name: string},
 *   hospitalGateRows: WarDibsRow[],
 *   fairFightRows: WarDibsRow[],
 *   claimRow: WarDibsRow,
 *   sharedRow: WarDibsRow,
 *   spaRows: WarDibsRow[],
 *   timeSync: {
 *     tornClockOffsetsMs: number[],
 *     hospitalUntilFromLocalNowSeconds: number,
 *   },
 *   claimIds: Record<string, string>,
 * }} WarDibsFixture
 */

/**
 * @typedef {{
 *   route: string,
 *   sequence: number,
 *   method: string,
 *   url: string,
 *   headers: Record<string, string>,
 *   data: string | null,
 *   body: unknown,
 *   timeout: number,
 * }} WarDibsRequest
 */

/**
 * @returns {Promise<WarDibsFixture>}
 */
export function readWarDibsFixture() {
  return readJsonFixture('war-dibs-scenarios.json');
}

/**
 * @param {WarDibsFixture} fixture
 * @param {WarDibsRow} row
 * @returns {{state: string, description: string, details: string, until: number}}
 */
export function hospitalStatus(fixture, row) {
  return {
    state: 'Hospital',
    description: 'Hospital in Torn City',
    details: 'Torn City',
    until: Math.floor(fixture.baseNowMs / 1000) + row.untilOffsetSeconds,
  };
}

/**
 * @param {WarDibsFixture} fixture
 * @param {WarDibsRow[]} rows
 * @returns {Record<string, {fair_fight: number, bs_estimate: number, bs_estimate_human: string}>}
 */
function statsForRows(fixture, rows) {
  return Object.fromEntries(
    rows.map((row, index) => [
      row.id,
      {
        fair_fight: row.fairFight,
        bs_estimate: 1_000_000 + index * 10_000,
        bs_estimate_human: `${1 + index / 100}m`,
      },
    ]),
  );
}

/**
 * Runs in the page before the userscript. It provides the only API transport used
 * by the system under test and exposes deterministic, test-owned server controls.
 *
 * @param {{
 *   baseNowMs: number,
 *   tornClockOffsetMs: number,
 *   self: {id: string, name: string},
 *   claimIds: string[],
 * }} options
 */
function installWarDibsEnvironment(options) {
  /**
   * @template T
   * @param {T} value
   * @returns {T}
   */
  const copy = (value) =>
    /** @type {T} */ (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  /**
   * @type {{
   *   nowMs: number,
   *   tornTimestampSeconds: number,
   *   currentTimestampMs: number,
   *   self: {id: string, name: string},
   *   members: Record<string, any>,
   *   basics: Record<string, any>,
   *   stats: Record<string, any>,
   *   claims: Record<string, any[]>,
   *   claimIds: string[],
   *   claimIndex: number,
   *   requests: any[],
   *   unexpected: any[],
   *   holds: Record<string, string[]>,
   *   pending: Record<string, {xhrOptions: any, response: any}>,
   *   queuedResponses: Record<string, any[]>,
   *   sequence: number,
   *   visible: boolean,
   *   focused: boolean,
   * }}
   */
  const state = {
    nowMs: options.baseNowMs,
    tornTimestampSeconds: Math.floor((options.baseNowMs + options.tornClockOffsetMs) / 1000),
    currentTimestampMs: options.baseNowMs + options.tornClockOffsetMs,
    self: copy(options.self),
    members: {},
    basics: {
      [options.self.id]: {
        state: 'Okay',
        description: 'In Torn City',
        details: 'Torn City',
        until: 0,
      },
    },
    stats: {},
    claims: {},
    claimIds: [...options.claimIds],
    claimIndex: 0,
    requests: [],
    unexpected: [],
    holds: {},
    pending: {},
    queuedResponses: {},
    sequence: 0,
    visible: true,
    focused: true,
  };

  Date.now = () => state.nowMs;
  /** @type {any} */ (window).getCurrentTimestamp = () => state.currentTimestampMs;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => !state.visible,
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (state.visible ? 'visible' : 'hidden'),
  });
  document.hasFocus = () => state.focused;

  /**
   * @param {string} method
   * @param {string} url
   * @returns {string}
   */
  const routeName = (method, url) => {
    const parsed = new URL(url);
    if (parsed.origin === 'https://ffscouter.com') {
      if (method === 'GET' && parsed.pathname === '/api/v1/hit-calling/claims') return 'ff:claims';
      if (method === 'POST' && parsed.pathname === '/api/v1/hit-calling/claim') return 'ff:claim';
      if (method === 'POST' && parsed.pathname === '/api/v1/hit-calling/unclaim')
        return 'ff:unclaim';
      if (method === 'GET' && parsed.pathname === '/api/v1/get-stats') return 'ff:stats';
    }
    if (parsed.origin === 'https://api.torn.com') {
      if (method === 'GET' && parsed.pathname === '/v2/faction/50271') return 'torn:faction';
      if (method === 'GET' && parsed.pathname === '/v2/key/info') return 'torn:key-info';
      if (method === 'GET' && /^\/v2\/user\/\d+\/basic$/.test(parsed.pathname)) return 'torn:basic';
    }
    return 'unexpected';
  };

  /** @param {string} claimId */
  const removeClaim = (claimId) => {
    for (const targetId of Object.keys(state.claims)) {
      const remaining = (state.claims[targetId] || []).filter(
        (claim) => claim.claim_id !== claimId,
      );
      if (remaining.length) state.claims[targetId] = remaining;
      else delete state.claims[targetId];
    }
  };

  const nextClaimId = () => {
    const id = state.claimIds[state.claimIndex];
    state.claimIndex += 1;
    if (id) return id;
    const suffix = String(state.claimIndex).padStart(12, '0');
    return `20000000-0000-4000-8000-${suffix}`;
  };

  /**
   * @param {any} request
   * @returns {any}
   */
  const defaultResponse = (request) => {
    const parsed = new URL(request.url);
    if (request.route === 'ff:claims') {
      return { status: 200, body: { claims: { faction: copy(state.claims) } } };
    }
    if (request.route === 'ff:stats') {
      const targetIds = (parsed.searchParams.get('targets') || '')
        .split(',')
        .filter(Boolean)
        .reverse();
      const stats = targetIds
        .map((playerId) => {
          const entry = state.stats[playerId];
          return entry ? { player_id: Number(playerId), ...copy(entry) } : null;
        })
        .filter(Boolean);
      return { status: 200, body: { stats } };
    }
    if (request.route === 'ff:claim') {
      const targetId = String(request.body?.target_player_id ?? '');
      const claim = {
        claim_id: nextClaimId(),
        claimer: { player_id: Number(state.self.id), name: state.self.name },
        created_at: Math.floor(state.nowMs / 1000),
        expires_at: Math.floor(state.nowMs / 1000) + 900,
      };
      state.claims[targetId] = [...(state.claims[targetId] || []), copy(claim)];
      return { status: 200, body: { claim, position: 1 } };
    }
    if (request.route === 'ff:unclaim') {
      removeClaim(String(request.body?.claim_id || ''));
      return { status: 200, body: { released: true } };
    }
    if (request.route === 'torn:faction') {
      const members = Object.entries(state.members).map(([id, status]) => ({
        id: Number(id),
        status: copy(status),
      }));
      return {
        status: 200,
        body: { timestamp: state.tornTimestampSeconds, members },
      };
    }
    if (request.route === 'torn:key-info') {
      return { status: 200, body: { info: { user: { id: Number(state.self.id) } } } };
    }
    if (request.route === 'torn:basic') {
      const playerId = parsed.pathname.match(/^\/v2\/user\/(\d+)\/basic$/)?.[1] || '';
      const status = state.basics[playerId] || state.members[playerId];
      return status
        ? { status: 200, body: { profile: { status: copy(status) } } }
        : {
            status: 404,
            body: { error: { code: 6, error: 'Not found in deterministic fixture' } },
          };
    }
    state.unexpected.push(copy(request));
    return { status: 599, body: { error: 'Unexpected deterministic fixture route' } };
  };

  /**
   * @param {any} xhrOptions
   * @param {any} response
   */
  const deliver = (xhrOptions, response) => {
    queueMicrotask(() => {
      xhrOptions.onload({
        status: response.status,
        responseText: JSON.stringify(response.body),
        responseHeaders: response.headers || '',
      });
    });
  };

  /** @type {any} */ (window).GM_xmlhttpRequest = (/** @type {any} */ xhrOptions) => {
    const method = String(xhrOptions.method || 'GET').toUpperCase();
    const route = routeName(method, xhrOptions.url);
    let body;
    try {
      body = xhrOptions.data === undefined ? null : JSON.parse(xhrOptions.data);
    } catch {
      body = xhrOptions.data;
    }
    const request = {
      route,
      sequence: ++state.sequence,
      method,
      url: String(xhrOptions.url),
      headers: copy(xhrOptions.headers || {}),
      data: xhrOptions.data === undefined ? null : String(xhrOptions.data),
      body,
      timeout: Number(xhrOptions.timeout),
    };
    state.requests.push(copy(request));

    const queued = state.queuedResponses[route]?.shift();
    if (queued?.serverClaims) state.claims = copy(queued.serverClaims);
    const response = queued
      ? { status: queued.status ?? 200, body: copy(queued.body) }
      : defaultResponse(request);
    const token = state.holds[route]?.shift();
    if (token) {
      state.pending[token] = { xhrOptions, response: copy(response) };
      return;
    }
    deliver(xhrOptions, response);
  };

  const api = /** @type {any} */ ({
    setNowMs(/** @type {number} */ value) {
      state.nowMs = Number(value);
    },
    setCurrentTimestampMs(/** @type {number} */ value) {
      state.currentTimestampMs = Number(value);
    },
    setClocks(/** @type {number} */ localNowMs, /** @type {number} */ tornNowMs) {
      state.nowMs = Number(localNowMs);
      state.currentTimestampMs = Number(tornNowMs);
      state.tornTimestampSeconds = Math.floor(Number(tornNowMs) / 1000);
    },
    setTornTimestampSeconds(/** @type {number} */ value) {
      state.tornTimestampSeconds = Number(value);
    },
    setMembers(/** @type {Record<string, any>} */ value) {
      state.members = copy(value);
    },
    setBasics(/** @type {Record<string, any>} */ value) {
      state.basics = { ...state.basics, ...copy(value) };
    },
    setStats(/** @type {Record<string, any>} */ value) {
      state.stats = copy(value);
    },
    setClaims(/** @type {Record<string, any[]>} */ value) {
      state.claims = copy(value);
    },
    clearRequests() {
      state.requests = [];
      state.unexpected = [];
    },
    getRequests() {
      return copy(state.requests);
    },
    getUnexpectedRequests() {
      return copy(state.unexpected);
    },
    holdNext(/** @type {string} */ route, /** @type {string} */ token) {
      state.holds[route] = [...(state.holds[route] || []), token];
    },
    resolve(/** @type {string} */ token, /** @type {any} */ override) {
      const pending = state.pending[token];
      if (!pending) throw new Error(`No held request named ${token}`);
      delete state.pending[token];
      deliver(
        pending.xhrOptions,
        override ? { status: override.status ?? 200, body: copy(override.body) } : pending.response,
      );
    },
    getPendingTokens() {
      return Object.keys(state.pending);
    },
    queueResponse(/** @type {string} */ route, /** @type {any} */ response) {
      state.queuedResponses[route] = [...(state.queuedResponses[route] || []), copy(response)];
    },
    suspend() {
      state.focused = false;
      window.dispatchEvent(new Event('blur'));
    },
    resume() {
      state.focused = true;
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      window.dispatchEvent(new Event('focus'));
    },
    hide() {
      state.visible = false;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    show() {
      state.visible = true;
      state.focused = true;
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    },
  });

  /** @type {any} */ (globalThis).__ksWarDibsHarness = api;
  window.fetch = () => Promise.reject(new Error('Live fetch is disabled by the War Dibs harness'));
  XMLHttpRequest.prototype.open = function blockedXmlHttpRequest() {
    throw new Error('Live XMLHttpRequest is disabled by the War Dibs harness');
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} method
 * @param {unknown[]} [args]
 * @returns {Promise<any>}
 */
function callController(page, method, args = []) {
  return page.evaluate(
    ({ methodName, values }) => {
      const controller = /** @type {any} */ (globalThis).__ksWarDibsHarness;
      if (!controller || typeof controller[methodName] !== 'function') {
        throw new Error(`Missing War Dibs harness method: ${methodName}`);
      }
      return controller[methodName](...values);
    },
    { methodName: method, values: args },
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {WarDibsFixture} fixture
 * @param {WarDibsRow[]} rows
 */
async function configureRows(page, fixture, rows) {
  const members = Object.fromEntries(rows.map((row) => [row.id, hospitalStatus(fixture, row)]));
  const basics = Object.fromEntries(rows.map((row) => [row.id, hospitalStatus(fixture, row)]));
  await callController(page, 'setMembers', [members]);
  await callController(page, 'setBasics', [basics]);
  await callController(page, 'setStats', [statsForRows(fixture, rows)]);
  await renderWarRows(page, fixture, rows);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {WarDibsFixture} fixture
 * @param {WarDibsRow[]} rows
 */
export async function renderWarRows(page, fixture, rows) {
  await page.evaluate(
    ({ baseNowMs, nextRows }) => {
      const scope = document.querySelector('[data-test-war-scope]');
      if (!scope) throw new Error('War fixture scope is missing');
      let root = document.getElementById('faction_war_list_id');
      if (!root) {
        root = document.createElement('div');
        root.id = 'faction_war_list_id';
        root.innerHTML =
          '<li class="act" role="button">Ranked War</li><ul class="members-list" data-test-enemy-rows></ul>';
        scope.append(root);
      }
      let list = root.querySelector('[data-test-enemy-rows]');
      if (!list) {
        list = document.createElement('ul');
        list.className = 'members-list';
        list.setAttribute('data-test-enemy-rows', '');
        root.append(list);
      }
      list.replaceChildren();
      for (const row of nextRows) {
        const item = document.createElement('li');
        item.className = 'enemy';
        item.dataset.playerId = row.datasetId || row.id;
        item.dataset.until = String(Math.floor(baseNowMs / 1000) + row.untilOffsetSeconds);
        item.innerHTML = `
          <div class="member"><a class="user name" href="/profiles.php?XID=${row.id}">${row.name}</a></div>
          <div class="level">50</div>
          <div class="points">0</div>
          <div class="status hospital">Hospital in Torn City</div>
          <div class="attack"><a href="/loader.php?sid=attack&user2ID=${row.id}">Attack</a></div>
        `;
        list.append(item);
      }
    },
    { baseNowMs: fixture.baseNowMs, nextRows: rows },
  );
}

/**
 * @param {import('@playwright/test').Page} page
 */
export async function forceWarDibsScan(page) {
  await page.evaluate(() => {
    const status = document.querySelector('#faction_war_list_id li.enemy .status');
    if (!status) return;
    const marker = document.createTextNode('');
    status.append(marker);
    marker.remove();
  });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} role
 */
export function panelRole(page, role) {
  return page.locator(`${panelSelector} [data-role="${role}"]`);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} playerId
 */
export function warDibsControl(page, playerId) {
  const host = page.locator(`#${rowHostPrefix}${playerId}`);
  return {
    host,
    button: host.locator('button'),
    label: host.locator('.label'),
    sub: host.locator('.sub'),
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} role
 */
export async function clickPanelRole(page, role) {
  await panelRole(page, role).click();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} route
 * @returns {Promise<WarDibsRequest[]>}
 */
export async function requestsFor(page, route) {
  const requests = /** @type {WarDibsRequest[]} */ (await callController(page, 'getRequests'));
  return requests.filter((request) => request.route === route);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {WarDibsRow[] | WarDibsRow} requestedRows
 * @param {{tornClockOffsetMs?: number}} [options]
 * @returns {Promise<{
 *   fixture: WarDibsFixture,
 *   pageErrors: Error[],
 *   blockedNetwork: string[],
 *   controller: (method: string, ...args: unknown[]) => Promise<any>,
 *   replaceRows: (rows: WarDibsRow[]) => Promise<void>,
 * }>}
 */
export async function startWarDibsHarness(page, requestedRows, options = {}) {
  const fixture = await readWarDibsFixture();
  const rows = Array.isArray(requestedRows) ? requestedRows : [requestedRows];
  const tornClockOffsetMs = Number(options.tornClockOffsetMs ?? 0);
  if (!Number.isFinite(tornClockOffsetMs)) {
    throw new TypeError('tornClockOffsetMs must be finite');
  }
  const pageHtml = await readRepositoryFile('tests/fixtures/war-dibs-page.html');
  /** @type {Error[]} */
  const pageErrors = [];
  /** @type {string[]} */
  const blockedNetwork = [];

  page.on('pageerror', (error) => pageErrors.push(error));
  await page.addInitScript(installWarDibsEnvironment, {
    baseNowMs: fixture.baseNowMs,
    tornClockOffsetMs,
    self: fixture.self,
    claimIds: Object.values(fixture.claimIds),
  });
  await page.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl === fixturePageUrl) {
      await route.fulfill({ body: pageHtml, contentType: 'text/html', status: 200 });
      return;
    }
    blockedNetwork.push(requestUrl);
    await route.abort('blockedbyclient');
  });
  await page.goto(fixturePageUrl);
  await configureRows(page, fixture, rows);
  await page.addScriptTag({ path: repositoryPath('KS_Torn_War_Dibs.user.js') });
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await page.locator(panelSelector).waitFor();

  await panelRole(page, 'key').click();
  await panelRole(page, 'key-input').fill(fixture.keys.ffscouter);
  await panelRole(page, 'key-save').click();
  await panelRole(page, 'torn-key').click();
  await panelRole(page, 'torn-key-input').fill(fixture.keys.torn);
  await panelRole(page, 'torn-key-save').click();

  await page.waitForFunction(
    (expectedIds) =>
      expectedIds.every((id) => {
        const row = document.querySelector(`#ks-twd-v1517-row-${id}`)?.closest('li.enemy');
        return row?.hasAttribute('data-ks-twd-v1563-ff-value');
      }),
    rows.map((row) => row.id),
  );
  await page.waitForFunction(() => {
    const panel = document.getElementById('ks-twd-v1517-panel');
    const country =
      panel?.shadowRoot?.querySelector('[data-role="country-status"]')?.textContent || '';
    const torn = panel?.shadowRoot?.querySelector('[data-role="torn-status"]')?.textContent || '';
    return country.includes('Country: Torn') && torn.includes('Torn: API live');
  });
  // Let the one-shot mount-prime requests finish so tests can deterministically
  // nominate the next request for deferral without racing initial startup work.
  await page.waitForTimeout(300);

  return {
    fixture,
    pageErrors,
    blockedNetwork,
    controller: (method, ...args) => callController(page, method, args),
    replaceRows: async (nextRows) => {
      await configureRows(page, fixture, nextRows);
      await forceWarDibsScan(page);
    },
  };
}

export const warDibsSelectors = Object.freeze({
  ownClaimStorageKey,
  panel: panelSelector,
  rowHostPrefix,
});
