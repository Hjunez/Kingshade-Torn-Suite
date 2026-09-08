/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HUSTLING_INSTANCE_KEY,
  HUSTLING_USERSCRIPT,
  installHustlingUserscript,
  mountHustlingFixture,
  readHustlingFixture,
  removeHustlingTestGlobals,
  setSidebarCash,
  tick,
} from '../../test-support/hustling.js';
import { installUserscriptUnderObservation } from '../../test-support/compliance.js';
import { readRepositoryFile } from '../../test-support/repository.js';

/**
 * DOM and lifecycle behaviour of KS Torn Hustling Advisor PC.
 *
 * The published file is evaluated unchanged, exactly as a userscript manager
 * would. The last describe swaps the plain harness for the compliance harness,
 * which records outgoing requests, programmatic clicks and dispatched events —
 * the negative controls that give that harness teeth live in
 * tests/unit/compliance.test.js.
 */

const FIXTURE = 'active-bet-one-bet.html';

/** The debounce is 120 ms and discovery retries start at 0 ms. */
const SETTLE_MS = 400;

function panelHost() {
  return document.getElementById('ks-hustling-advisor-panel');
}

function panelText() {
  const host = panelHost();
  return host?.shadowRoot?.textContent ?? '';
}

/**
 * jsdom reports document.hasFocus() as false for a document nobody is looking at,
 * which is exactly the state the script refuses to analyse in. A real browser tab
 * the player is using reports true, so the focused case has to be stated here.
 *
 * @type {import('vitest').MockInstance<() => boolean>}
 */
let focus;

beforeEach(() => {
  focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

describe('mounting', () => {
  afterEach(() => {
    removeHustlingTestGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.body.removeAttribute('data-page');
  });

  it('mounts nothing at all when there is no hustling-root', async () => {
    document.body.innerHTML = '<div class="crimes-app"><div class="crime-root"></div></div>';

    await installHustlingUserscript();
    await tick(SETTLE_MS);

    expect(panelHost()).toBeNull();
    expect(document.querySelectorAll('[id^="ks-hustling"]')).toHaveLength(0);
  });

  it('mounts exactly one panel beside the view, never inside it', async () => {
    const root = await mountHustlingFixture(FIXTURE);

    await installHustlingUserscript();
    await tick(SETTLE_MS);

    const host = panelHost();
    expect(host).not.toBeNull();
    expect(document.querySelectorAll('#ks-hustling-advisor-panel')).toHaveLength(1);
    // Outside the observed subtree: the panel can never feed its own observer.
    expect(root.contains(host)).toBe(false);
    expect(host?.parentElement).toBe(root.parentElement);
    expect(host?.nextElementSibling).toBe(root);
  });

  it('renders the single recommendation, its nerve cost and the status/mode banner', async () => {
    await mountHustlingFixture(FIXTURE);

    await installHustlingUserscript();
    await tick(SETTLE_MS);

    const text = panelText();
    expect(text).toContain('KS HUSTLING ADVISOR');
    expect(text).toContain('CANDIDATE');
    expect(text).toContain('MAX CE + CS');
    expect(text).toContain('LOSE');
    expect(text).toContain('Snail Racing');
    expect(text).toContain('2 nerve');
  });

  it('writes the shipped threshold of 60 into both the reason and the footer', async () => {
    await mountHustlingFixture(FIXTURE);

    await installHustlingUserscript();
    await tick(SETTLE_MS);

    const text = panelText();
    // The one bettor in this capture sits at attention 6.
    expect(text).toContain('below the 60 community threshold');
    expect(text).toContain('Attention threshold 60 is a community heuristic');
    expect(text).not.toMatch(/threshold 50|threshold of 50/);
  });

  it('puts a blocked bet on screen instead of quietly dropping it', async () => {
    // Real capture: $4,328 standing on Snail Racing with every button reading
    // "You don't have enough nerve". 0.1.1 rendered no mention of the bet at all.
    await mountHustlingFixture('failure-outcome-no-nerve.html');

    await installHustlingUserscript();
    await tick(SETTLE_MS);

    const text = panelText();
    expect(text).toContain('Snail Racing has an active $4,328 bet you cannot act on');
    expect(text).toContain(`"You don't have enough nerve"`);
  });

  it('warns about the stake before the money runs out, in the panel', async () => {
    // $177 live on Snail Racing against a $500 balance is 35%.
    await mountHustlingFixture(FIXTURE);
    await setSidebarCash(500);

    await installHustlingUserscript();
    await tick(SETTLE_MS);

    const text = panelText();
    expect(text).toContain(
      "Snail Racing's $177 bet is 35% of your $500 cash. One more loss would empty you.",
    );
  });

  it('says so in the panel when the balance cannot be read', async () => {
    await mountHustlingFixture(FIXTURE);
    await setSidebarCash(null);

    await installHustlingUserscript();
    await tick(SETTLE_MS);

    const text = panelText();
    expect(text).toContain('The cash check is UNKNOWN');
    // The advice itself is unaffected.
    expect(text).toContain('LOSE');
  });

  it('leaves Torn’s own markup byte-for-byte untouched', async () => {
    const root = await mountHustlingFixture(FIXTURE);
    const before = root.innerHTML;

    await installHustlingUserscript();
    await tick(SETTLE_MS);

    expect(root.innerHTML).toBe(before);
  });
});

describe('visibility and focus gating', () => {
  afterEach(() => {
    removeHustlingTestGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('stops observing and analysing while the page is not focused', async () => {
    await mountHustlingFixture(FIXTURE);
    const controller = await installHustlingUserscript();
    await tick(SETTLE_MS);
    expect(controller.internals.isObserving()).toBe(true);

    focus.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    await tick(SETTLE_MS);

    expect(controller.internals.isObserving()).toBe(false);
    expect(panelText()).toContain('PAUSED');
    expect(panelText()).not.toContain('Snail Racing');
  });

  it('resumes on focus and re-reads the view rather than reusing the old advice', async () => {
    const root = await mountHustlingFixture(FIXTURE);
    const controller = await installHustlingUserscript();
    await tick(SETTLE_MS);

    focus.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    await tick(SETTLE_MS);
    expect(panelText()).toContain('PAUSED');

    // The view changed while we were away: the audience is gone.
    root.innerHTML = await innerHtmlOfFixture('no-audience.html');

    focus.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await tick(SETTLE_MS);

    expect(controller.internals.isObserving()).toBe(true);
    expect(panelText()).toContain('GATHER');
    expect(panelText()).not.toContain('LOSE');
  });
});

describe('SPA rerenders', () => {
  afterEach(() => {
    removeHustlingTestGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('does not duplicate the panel when Torn re-renders inside the root', async () => {
    const root = await mountHustlingFixture(FIXTURE);
    await installHustlingUserscript();
    await tick(SETTLE_MS);

    const rendered = root.innerHTML;
    root.innerHTML = rendered;
    await tick(SETTLE_MS);

    expect(document.querySelectorAll('#ks-hustling-advisor-panel')).toHaveLength(1);
  });

  it('remounts exactly once when Torn swaps the whole root element out', async () => {
    const root = await mountHustlingFixture(FIXTURE);
    const app = root.parentElement;
    await installHustlingUserscript();
    await tick(SETTLE_MS);

    const replacement = root.cloneNode(true);
    root.remove();
    app?.append(replacement);
    await tick(SETTLE_MS);

    expect(document.querySelectorAll('#ks-hustling-advisor-panel')).toHaveLength(1);
    expect(panelText()).toContain('LOSE');
  });

  it('tears the panel down when the Hustling view goes away', async () => {
    const root = await mountHustlingFixture(FIXTURE);
    await installHustlingUserscript();
    await tick(SETTLE_MS);
    expect(panelHost()).not.toBeNull();

    root.remove();
    await tick(SETTLE_MS);

    expect(panelHost()).toBeNull();
  });

  it('keeps the panel’s own state across a Torn-side update, so it is not looping on itself', async () => {
    const root = await mountHustlingFixture(FIXTURE);
    await installHustlingUserscript();
    await tick(SETTLE_MS);

    const host = panelHost();
    const toggle = host?.shadowRoot?.querySelector('button.toggle');
    expect(toggle).not.toBeNull();
    /** @type {HTMLElement} */ (toggle).click();
    expect(host?.shadowRoot?.querySelector('.wrap')?.classList.contains('collapsed')).toBe(true);

    // A genuine Torn-side mutation still refreshes the advice…
    root.querySelector('[class*="betAmount"]')?.setAttribute('data-nudge', '1');
    await tick(SETTLE_MS);

    // …and the panel's own collapsed state survived, because the panel never
    // re-entered the observer it feeds.
    expect(document.querySelectorAll('#ks-hustling-advisor-panel')).toHaveLength(1);
    expect(host?.shadowRoot?.querySelector('.wrap')?.classList.contains('collapsed')).toBe(true);
  });

  it('removes everything it added on destroy', async () => {
    await mountHustlingFixture(FIXTURE);
    const controller = await installHustlingUserscript();
    await tick(SETTLE_MS);
    expect(panelHost()).not.toBeNull();

    controller.destroy();

    expect(panelHost()).toBeNull();
    expect(controller.internals.isObserving()).toBe(false);
    expect(Reflect.get(window, HUSTLING_INSTANCE_KEY)).toBeUndefined();
  });

  it('refuses to install twice over the same page', async () => {
    await mountHustlingFixture(FIXTURE);
    const first = await installHustlingUserscript();
    await tick(SETTLE_MS);

    await installHustlingUserscript();
    await tick(SETTLE_MS);

    expect(Reflect.get(window, HUSTLING_INSTANCE_KEY)).toBe(first);
    expect(document.querySelectorAll('#ks-hustling-advisor-panel')).toHaveLength(1);
  });
});

describe('compliance under observation', () => {
  /** @type {Awaited<ReturnType<typeof installUserscriptUnderObservation>>} */
  let harness;

  beforeEach(async () => {
    harness = await installUserscriptUnderObservation(HUSTLING_USERSCRIPT, {
      fixture: `tests/fixtures/hustling/${FIXTURE}`,
      instanceKey: HUSTLING_INSTANCE_KEY,
    });
    await tick(SETTLE_MS);
  });

  afterEach(() => {
    removeHustlingTestGlobals();
    harness?.teardown();
  });

  it('boots against a real Hustling capture — otherwise the test measures nothing', () => {
    expect(document.querySelector('div.crime-root.hustling-root')).not.toBeNull();
    expect(document.querySelectorAll('button.commit-button').length).toBeGreaterThan(0);
    expect(Reflect.get(window, HUSTLING_INSTANCE_KEY)).toBeTruthy();
  });

  it('makes no network requests of any kind', () => {
    expect(harness.requests).toEqual([]);
  });

  it('declares no @connect host, because it has nothing to connect to', () => {
    expect(harness.metadata.connect ?? []).toEqual([]);
  });

  it('never clicks for the player', () => {
    expect(harness.clickCalls).toBe(0);
  });

  it('dispatches no synthetic events', () => {
    const synthetic = harness.dispatchedEvents.filter((event) => event?.isTrusted === false);
    expect(synthetic.map((event) => event.type)).toEqual([]);
  });

  it('submits no form and injects no iframe', () => {
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(document.querySelectorAll('form')).toHaveLength(0);
  });

  it('does not navigate', () => {
    expect(window.location.pathname).toBe('/page.php');
    expect(window.location.search).toBe('?sid=crimes');
  });

  it('keeps @match on torn.com only', () => {
    const offSite = (harness.metadata.match ?? []).filter(
      (pattern) => !/^https:\/\/(www\.)?torn\.com\//.test(pattern),
    );
    expect(offSite).toEqual([]);
  });

  it('carries no API key and contains no transport call at all', async () => {
    const source = await readRepositoryFile(HUSTLING_USERSCRIPT);
    expect(source).not.toMatch(/(api[_-]?key|tornkey)\s*[:=]\s*['"][A-Za-z0-9]{16}['"]/i);
    expect(source).not.toMatch(/[?&]key=[A-Za-z0-9]{16}\b/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/new\s+(XMLHttpRequest|WebSocket|EventSource)\b/);
    expect(source).not.toMatch(/\bGM[_.]xmlH?ttpRequest\s*\(/i);
    expect(source).not.toMatch(/\.(click|submit)\s*\(\s*\)/);
    expect(source).not.toMatch(/\bsetInterval\s*\(/);
  });

  it('ships no player data inside the capture fixture', async () => {
    const html = await readHustlingFixture(FIXTURE);
    expect(html).not.toMatch(/(api[_-]?key|tornkey)\s*[:=]\s*['"]?[A-Za-z0-9]{16}/i);
    expect(html).not.toMatch(/profiles\.php|XID=/);
  });
});

/**
 * The inner markup of a fixture's hustling-root, for simulating a Torn rerender.
 *
 * @param {string} name
 * @returns {Promise<string>}
 */
async function innerHtmlOfFixture(name) {
  const holder = document.createElement('div');
  holder.innerHTML = await readHustlingFixture(name);
  const root = holder.querySelector('div.crime-root.hustling-root');
  if (!root) throw new Error(`Fixture ${name} has no hustling-root.`);
  return root.innerHTML;
}
