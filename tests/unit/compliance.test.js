/** @vitest-environment jsdom */
/** @vitest-environment-options { "url": "https://www.torn.com/factions.php?step=your&type=1" } */

/**
 * KS compliance-tester.
 *
 * Del A testar vakterna i src/compliance själva.
 * Del B är runtime-harnessen: den kör ett publicerat produktionsskript
 * oförändrat mot repots capture-fixtur och mäter beteendet — inga syntetiska
 * klick, inga anrop mot Torns spelsidor, inga iframes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComplianceError,
  assertCompliantRequest,
  createGuardedRequest,
  redact,
} from '../../src/compliance/netGuard.js';
import { createActionBudget } from '../../src/compliance/actionBudget.js';
import {
  declaredConnectHosts,
  installSourceUnderObservation,
  installUserscriptUnderObservation,
  parseUserscriptMetadata,
  requestsAgainstGamePages,
  requestsOutsideAllowlist,
} from '../../test-support/compliance.js';
import { readRepositoryFile } from '../../test-support/repository.js';

// ---------------------------------------------------------------- Del A

describe('netGuard', () => {
  const visibleDoc = { visibilityState: 'visible', hasFocus: () => true };

  it('släpper igenom api.torn.com vid användarinteraktion', () => {
    const url = assertCompliantRequest('https://api.torn.com/v2/user?selections=bars', {
      userGesture: true,
      doc: visibleDoc,
    });
    expect(url).toContain('api.torn.com');
  });

  it.each([
    'https://www.torn.com/bazaar.php',
    'https://torn.com/factions.php',
    'https://api.torn.com.evil.example/v2/user',
    'http://api.torn.com/v2/user',
  ])('blockerar %s', (bad) => {
    expect(() => assertCompliantRequest(bad, { userGesture: true, doc: visibleDoc })).toThrow(
      ComplianceError,
    );
  });

  it('blockerar anrop utan användarinteraktion', () => {
    expect(() =>
      assertCompliantRequest('https://api.torn.com/v2/user', { doc: visibleDoc }),
    ).toThrow(/utan användarinteraktion/);
  });

  it('blockerar anrop när sidan är dold', () => {
    const hidden = { visibilityState: 'hidden', hasFocus: () => false };
    expect(() =>
      assertCompliantRequest('https://api.torn.com/v2/user', { userGesture: true, doc: hidden }),
    ).toThrow(/inte synlig/);
  });

  it('maskerar nyckeln i loggbar text', () => {
    expect(redact('https://api.torn.com/v2/user?key=abcdefghij123456&selections=bars')).toBe(
      'https://api.torn.com/v2/user?key=***&selections=bars',
    );
  });

  it('guardad request konsumerar budgeten', async () => {
    const budget = createActionBudget();
    const transport = vi.fn().mockResolvedValue({ ok: true });
    const request = createGuardedRequest(transport, { budget, doc: visibleDoc });

    budget.grant();
    await request('https://api.torn.com/v2/user', { userGesture: true });
    expect(transport).toHaveBeenCalledTimes(1);

    await expect(request('https://api.torn.com/v2/user', { userGesture: true })).rejects.toThrow(
      /Ingen budget/,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('actionBudget', () => {
  it('ett klick ger exakt en åtgärd', () => {
    const budget = createActionBudget();
    budget.grant();
    budget.spend();
    expect(() => budget.spend()).toThrow(/Ingen budget/);
  });

  it('syntetiskt event ger ingen budget', () => {
    const budget = createActionBudget();
    expect(() => budget.grant({ isTrusted: false })).toThrow(/Syntetiskt event/);
  });

  it('budgeten går ut och kan inte sparas till senare', () => {
    let t = 0;
    const budget = createActionBudget({ ttlMs: 1000, now: () => t });
    budget.grant();
    t = 5000;
    expect(() => budget.spend()).toThrow(/gått ut/);
  });
});

// ---------------------------------------------------------------- Del B

/**
 * Produktionsskriptet som mäts. Byt USERSCRIPT för att mäta ett annat skript —
 * harnessen är inte bunden till just det här.
 *
 * Vad testerna nedan faktiskt bevisar: War Dibs laddat på en riktig Ranked
 * War-sida, med fiendrader på plats, rör varken nätverket eller sidan förrän
 * spelaren själv interagerat. Skriptet grindar sitt runtime på
 * `windowFocused && hasRecentTrustedInteraction()`, och jsdom kan inte skapa
 * trusted event — så det här mäter exakt den grinden.
 *
 * De negativa kontrollerna längre ned bevisar att harnessen har tänder. Utan
 * dem skulle ett grönt utfall lika gärna kunna betyda att ingenting mättes.
 */
const USERSCRIPT = 'KS_Torn_War_Dibs.user.js';
const FIXTURE = 'tests/fixtures/war-dibs-page.html';
const INSTANCE_KEY = '__ksTornWarDibsV1517';
/** @type {import('../../test-support/compliance.js').WarRow[]} */
const ROWS = [
  { id: '100101', name: 'Compliance Row One', untilOffsetSeconds: 119 },
  { id: '100102', name: 'Compliance Row Two', untilOffsetSeconds: 45 },
];

describe(`runtime-beteende: ${USERSCRIPT} mot capture-fixtur`, () => {
  /** @type {Awaited<ReturnType<typeof installUserscriptUnderObservation>>} */
  let harness;

  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    harness = await installUserscriptUnderObservation(USERSCRIPT, {
      fixture: FIXTURE,
      instanceKey: INSTANCE_KEY,
      rows: ROWS,
    });
    await settle();
  });

  afterEach(() => {
    harness?.teardown();
  });

  it('bootar mot en bemannad war-lista — annars mäter testet ingenting', () => {
    expect(Reflect.get(window, INSTANCE_KEY)).toBe(true);
    expect(document.getElementById('faction_war_list_id')).not.toBeNull();
    expect(document.querySelectorAll('li.enemy')).toHaveLength(ROWS.length);
  });

  it('gör inga nätanrop innan spelaren interagerat', () => {
    expect(harness.requests).toEqual([]);
  });

  it('klickar aldrig åt spelaren', () => {
    expect(harness.clickCalls).toBe(0);
  });

  it('skickar inga syntetiska input-event', () => {
    const synthetic = harness.dispatchedEvents.filter((event) => event?.isTrusted === false);
    expect(synthetic.map((event) => event.type)).toEqual([]);
  });

  it('skapar inga iframes', () => {
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('navigerar inte bort från sidan', () => {
    expect(window.location.pathname).toBe('/factions.php');
  });

  it('deklarerar inga spelsidor i @connect', () => {
    const gamePages = harness.declaredHosts.filter(
      (host) => (host === 'torn.com' || host.endsWith('.torn.com')) && host !== 'api.torn.com',
    );
    expect(gamePages).toEqual([]);
  });

  it('begränsar @match till torn.com', () => {
    const offSite = (harness.metadata.match ?? []).filter(
      (pattern) => !/^https:\/\/(www\.)?torn\.com\//.test(pattern),
    );
    expect(offSite).toEqual([]);
  });

  it('innehåller ingen inbäddad API-nyckel', async () => {
    const source = await readRepositoryFile(USERSCRIPT);
    expect(source).not.toMatch(/(api[_-]?key|tornkey)\s*[:=]\s*['"][A-Za-z0-9]{16}['"]/i);
    expect(source).not.toMatch(/[?&]key=[A-Za-z0-9]{16}\b/);
  });

  it('inga API-nycklar i capture-fixturen', async () => {
    const html = await readRepositoryFile(FIXTURE);
    expect(html).not.toMatch(/(api[_-]?key|tornkey)\s*[:=]\s*['"]?[A-Za-z0-9]{16}/i);
  });
});

// ------------------------------------------------- Negativa kontroller
//
// Kalibrering av instrumentet: varje test installerar ett avsiktligt
// icke-compliant skript och kräver att harnessen fångar det. Går något av dem
// grönt utan att fånga överträdelsen mäter Del B ingenting.

describe('harnessen fångar överträdelser', () => {
  /** @type {Awaited<ReturnType<typeof installSourceUnderObservation>>} */
  let harness;

  afterEach(() => harness?.teardown());

  it('upptäcker anrop mot en Torn-spelsida', async () => {
    harness = await installSourceUnderObservation(
      `GM_xmlhttpRequest({ method: 'GET', url: 'https://www.torn.com/factions.php?step=profile' });`,
      { fixture: FIXTURE },
    );
    await settle();

    expect(requestsAgainstGamePages(harness.requests)).toHaveLength(1);
  });

  it('upptäcker anrop utanför @connect-allowlistan', async () => {
    harness = await installSourceUnderObservation(
      `fetch('https://telemetry.example.com/collect?u=1');`,
      { fixture: FIXTURE },
    );
    await settle();

    expect(
      requestsOutsideAllowlist(harness.requests, ['api.torn.com', 'ffscouter.com']),
    ).toHaveLength(1);
  });

  it('släpper igenom en deklarerad värd', async () => {
    harness = await installSourceUnderObservation(
      `GM_xmlhttpRequest({ url: 'https://api.torn.com/v2/user?selections=bars' });`,
      { fixture: FIXTURE },
    );
    await settle();

    expect(harness.requests).toHaveLength(1);
    expect(requestsOutsideAllowlist(harness.requests, ['api.torn.com'])).toEqual([]);
    expect(requestsAgainstGamePages(harness.requests)).toEqual([]);
  });

  it('upptäcker ett automatiskt klick', async () => {
    harness = await installSourceUnderObservation(`document.querySelector('li.act')?.click();`, {
      fixture: FIXTURE,
    });
    await settle();

    expect(harness.clickCalls).toBe(1);
  });

  it('upptäcker syntetiska input-event', async () => {
    harness = await installSourceUnderObservation(
      `document.querySelector('li.act')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));`,
      { fixture: FIXTURE },
    );
    await settle();

    const synthetic = harness.dispatchedEvents.filter((event) => event?.isTrusted === false);
    expect(synthetic.map((event) => event.type)).toEqual(['click']);
  });

  it('upptäcker en injicerad iframe', async () => {
    harness = await installSourceUnderObservation(
      `document.body.append(document.createElement('iframe'));`,
      { fixture: FIXTURE },
    );
    await settle();

    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });
});

describe('userscript-metadata', () => {
  it('parsar headern och plockar ut @connect', async () => {
    const metadata = parseUserscriptMetadata(await readRepositoryFile(USERSCRIPT));

    expect(metadata.name?.[0]).toBe('KS Torn War Dibs');
    expect(declaredConnectHosts(metadata)).toEqual(['ffscouter.com', 'api.torn.com']);
  });
});

/** Låter skriptets mount-, timer- och microtask-arbete gå klart. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 600));
}
