import { readRepositoryFile } from './repository.js';

/**
 * Runtime-harness för KS compliance-testerna.
 *
 * Kör ett publicerat userscript oförändrat i jsdom mot en capture-fixtur och
 * spelar in vad det faktiskt gör: vilka nätanrop som lämnar skriptet, om det
 * klickar åt spelaren, om det skickar syntetiska event och om det injicerar
 * iframes.
 *
 * Skriptkällan transformeras aldrig — den evalueras precis som Tampermonkey
 * eller Torn PDA skulle göra det, så testet mäter den kod som publiceras.
 */

/**
 * @typedef {{ method: string, url: string, via: 'GM_xmlhttpRequest' | 'fetch' | 'XMLHttpRequest' }} RecordedRequest
 */

/**
 * @typedef {{ id: string, name: string, title?: string, untilOffsetSeconds: number }} WarRow
 */

/**
 * Renderar fiendrader i capturen med samma markup som Torns war-lista.
 * Samma radform som test-support/war-dibs-playwright.js använder, så jsdom- och
 * browser-testerna mäter mot identisk DOM.
 *
 * @param {WarRow[]} rows
 * @param {number} baseNowMs
 */
export function renderWarRows(rows, baseNowMs) {
  const root = document.getElementById('faction_war_list_id');
  if (!root) throw new Error('Capturen saknar #faction_war_list_id — fel fixtur?');

  let list = root.querySelector('[data-test-enemy-rows]');
  if (!list) {
    list = document.createElement('ul');
    list.className = 'members-list';
    list.setAttribute('data-test-enemy-rows', '');
    root.append(list);
  }
  list.replaceChildren();

  for (const row of rows) {
    const item = document.createElement('li');
    item.className = 'enemy';
    item.dataset.playerId = row.id;
    item.dataset.until = String(Math.floor(baseNowMs / 1000) + row.untilOffsetSeconds);
    item.innerHTML = `
      <div class="member">
        <a class="user name" data-test-player-name href="/profiles.php?XID=${row.id}">${row.name}</a>
        <span class="player-title" data-test-player-title>${row.title ?? ''}</span>
      </div>
      <div class="level">50</div>
      <div class="points">0</div>
      <div class="status hospital">Hospital in Torn City</div>
      <div class="attack"><a href="/loader.php?sid=attack&user2ID=${row.id}">Attack</a></div>
    `;
    list.append(item);
  }
}

/**
 * @typedef {object} ComplianceHarness
 * @property {RecordedRequest[]} requests Alla utgående anrop, i ordning.
 * @property {Event[]} dispatchedEvents Event som skriptet skickat via dispatchEvent.
 * @property {number} clickCalls Antal programmatiska .click()-anrop.
 * @property {Record<string, string[]>} metadata Userscript-headerns fält.
 * @property {string[]} declaredHosts Värdar skriptet deklarerat i sin connect-metadata.
 * @property {() => void} teardown
 */

const GM_GLOBAL = 'GM_xmlhttpRequest';

/**
 * @param {string} source
 * @returns {boolean}
 */
export function hasMetadataBlock(source) {
  return /\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/.test(source);
}

/**
 * Läser userscript-headern utan att köra skriptet.
 *
 * @param {string} source
 * @returns {Record<string, string[]>}
 */
export function parseUserscriptMetadata(source) {
  const block = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
  if (!block) throw new Error('Hittade inget ==UserScript==-block.');

  /** @type {Record<string, string[]>} */
  const metadata = {};
  for (const line of (block[1] ?? '').split('\n')) {
    const match = line.match(/^\/\/\s*@(\S+)\s+(.+?)\s*$/);
    const key = match?.[1];
    const value = match?.[2];
    if (!key || value === undefined) continue;
    (metadata[key] ??= []).push(value);
  }
  return metadata;
}

/**
 * Värdar skriptet självt säger att det behöver nå (connect-metadatan).
 *
 * @param {Record<string, string[]>} metadata
 * @returns {string[]}
 */
export function declaredConnectHosts(metadata) {
  return (metadata.connect ?? []).map((host) => host.toLowerCase());
}

/**
 * Installerar ett publicerat userscript i den aktuella jsdom-sidan.
 *
 * @param {string} userscriptFile Filnamn i repo-roten, t.ex. 'KS_Torn_War_Dibs.user.js'.
 * @param {{ fixture?: string, instanceKey?: string, rows?: WarRow[], baseNowMs?: number }} [options]
 *   fixture: sökväg till en HTML-capture som laddas in i body innan skriptet körs.
 *   instanceKey: global som skriptet sätter för att undvika dubbelkörning.
 *   rows: fiendrader som renderas in i capturen innan skriptet körs.
 * @returns {Promise<ComplianceHarness>}
 */
export async function installUserscriptUnderObservation(userscriptFile, options = {}) {
  const source = await readRepositoryFile(userscriptFile);
  return installSourceUnderObservation(source, options);
}

/**
 * Som installUserscriptUnderObservation, men mot källkod i minnet.
 *
 * Används för negativa kontroller: ett avsiktligt icke-compliant skript ska
 * fångas av harnessen. Utan de testerna bevisar ett grönt utfall bara att
 * ingenting mättes.
 *
 * @param {string} source
 * @param {{ fixture?: string, instanceKey?: string, rows?: WarRow[], baseNowMs?: number }} [options]
 * @returns {Promise<ComplianceHarness>}
 */
export async function installSourceUnderObservation(source, options = {}) {
  const { fixture, instanceKey, rows, baseNowMs = Date.now() } = options;

  const metadata = hasMetadataBlock(source) ? parseUserscriptMetadata(source) : {};

  if (fixture) {
    const html = await readRepositoryFile(fixture);
    // Bara body-innehållet — capturen är ett helt dokument.
    document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  }

  if (rows?.length) renderWarRows(rows, baseNowMs);

  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {Event[]} */
  const dispatchedEvents = [];
  let clickCalls = 0;

  const originalClick = HTMLElement.prototype.click;
  const originalDispatch = EventTarget.prototype.dispatchEvent;
  const originalFetch = Reflect.get(window, 'fetch');
  const originalXhr = Reflect.get(window, 'XMLHttpRequest');

  HTMLElement.prototype.click = function observedClick(...args) {
    clickCalls += 1;
    return originalClick.apply(this, args);
  };

  // Harnessens egna livscykel-event får inte räknas som skriptets beteende.
  const harnessEvents = new WeakSet();

  EventTarget.prototype.dispatchEvent = function observedDispatch(event) {
    if (!harnessEvents.has(event)) dispatchedEvents.push(event);
    return originalDispatch.call(this, event);
  };

  // Transporten svarar alltid tomt. Testet mäter destinationer, inte svar.
  /** @param {{ method?: string, url?: string, onerror?: (response: unknown) => void }} config */
  const gmStub = (config = {}) => {
    requests.push({
      method: String(config.method ?? 'GET').toUpperCase(),
      url: String(config.url ?? ''),
      via: GM_GLOBAL,
    });
    queueMicrotask(() => config.onerror?.({ status: 0, responseText: '' }));
    return { abort() {} };
  };

  /**
   * @param {string | URL | Request} input
   * @param {{ method?: string }} [init]
   */
  const fetchStub = (input, init = {}) => {
    requests.push({
      method: String(init.method ?? 'GET').toUpperCase(),
      url: String(input),
      via: 'fetch',
    });
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  class ObservedXhr {
    /**
     * @param {string} method
     * @param {string | URL} url
     */
    open(method, url) {
      requests.push({
        method: String(method).toUpperCase(),
        url: String(url),
        via: 'XMLHttpRequest',
      });
    }
    setRequestHeader() {}
    send() {}
    abort() {}
    addEventListener() {}
  }

  defineGlobal(GM_GLOBAL, gmStub);
  defineGlobal('unsafeWindow', window);
  defineGlobal('fetch', fetchStub);
  defineGlobal('XMLHttpRequest', ObservedXhr);

  /**
   * @param {EventTarget} target
   * @param {Event} event
   */
  function dispatchHarnessEvent(target, event) {
    harnessEvents.add(event);
    target.dispatchEvent(event);
  }

  window.eval(source);

  // @run-at document-idle — driv livscykeln som en riktig userscript-manager.
  if (document.readyState === 'loading') {
    dispatchHarnessEvent(document, new Event('DOMContentLoaded'));
  }
  dispatchHarnessEvent(window, new Event('load'));

  return {
    requests,
    dispatchedEvents,
    get clickCalls() {
      return clickCalls;
    },
    metadata,
    declaredHosts: declaredConnectHosts(metadata),
    teardown() {
      HTMLElement.prototype.click = originalClick;
      EventTarget.prototype.dispatchEvent = originalDispatch;
      restoreGlobal('fetch', originalFetch);
      restoreGlobal('XMLHttpRequest', originalXhr);
      Reflect.deleteProperty(window, GM_GLOBAL);
      Reflect.deleteProperty(window, 'unsafeWindow');
      if (instanceKey) Reflect.deleteProperty(window, instanceKey);
      document.head.innerHTML = '';
      document.body.innerHTML = '';
    },
  };
}

/**
 * Anrop som lämnat skriptet mot något annat än de deklarerade värdarna.
 *
 * @param {RecordedRequest[]} requests
 * @param {string[]} allowedHosts
 * @returns {RecordedRequest[]}
 */
export function requestsOutsideAllowlist(requests, allowedHosts) {
  return requests.filter((request) => {
    const host = safeHost(request.url);
    if (!host) return true;
    return !allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  });
}

/**
 * Anrop mot Torns spelsidor — allt på torn.com som inte är det officiella API:t.
 *
 * @param {RecordedRequest[]} requests
 * @returns {RecordedRequest[]}
 */
export function requestsAgainstGamePages(requests) {
  return requests.filter((request) => {
    const host = safeHost(request.url);
    if (!host) return false;
    const isTorn = host === 'torn.com' || host.endsWith('.torn.com');
    return isTorn && host !== 'api.torn.com';
  });
}

/**
 * @param {string} url
 * @returns {string}
 */
function safeHost(url) {
  try {
    return new URL(url, window.location.href).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * @param {string} name
 * @param {unknown} value
 */
function defineGlobal(name, value) {
  Object.defineProperty(window, name, { configurable: true, writable: true, value });
}

/**
 * @param {string} name
 * @param {unknown} original
 */
function restoreGlobal(name, original) {
  if (original === undefined) {
    Reflect.deleteProperty(window, name);
    return;
  }
  Object.defineProperty(window, name, { configurable: true, writable: true, value: original });
}
