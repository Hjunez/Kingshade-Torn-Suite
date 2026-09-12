/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepositoryFile } from '../../test-support/repository.js';

/**
 * War Dibs PDA 1.5.168 — the panel control row must answer a tap.
 *
 * The 2026-09-12 runtime reading was "nothing happens on any of those links",
 * on the owner's own Ranked War in PREWAR with both keys already stored and the
 * shared row reading "Shared: syncing…". While the shared key has no current
 * ownership proof every credential control was given the disabled property, and
 * a disabled button dispatches no click at all — so the refusal each action
 * already carries could never be shown, and the row read as dead.
 *
 * What these tests pin:
 *  - a control that is locked, not unavailable, still receives the tap and the
 *    panel answers with the reason;
 *  - the tap path survives a redraw of the element the panel is anchored beside,
 *    which Torn does on its own schedule during a war;
 *  - the delegated handler is installed exactly once per panel, so one tap is
 *    one action.
 *
 * jsdom has no IndexedDB and no crypto.subtle, so apiKeyStorageReady never
 * becomes true and the credential locks are genuinely active here. That is the
 * same predicate the owner met, reached by a different route, and it is what
 * makes the refusal observable without inventing state.
 */

const OWN_WAR_ROUTE = 'https://www.torn.com/factions.php?step=your&type=1#/war/rank';
const VIEW_WAR_ROUTE = 'https://www.torn.com/factions.php?step=profile&ID=222#/war/rank';
const INSTANCE_KEY = '__ksTornWarDibsPdaV15169Test';

/** jsdom does no layout; the script refuses to mount on a surface it measures as invisible. */
function stubLayoutAsRendered() {
  const rect = () => ({
    bottom: 42,
    height: 42,
    left: 0,
    right: 320,
    toJSON() {},
    top: 0,
    width: 320,
    x: 0,
    y: 0,
  });
  Element.prototype.getBoundingClientRect = rect;
  Element.prototype.getClientRects = function getClientRects() {
    return Object.assign([rect()], { item: () => rect() });
  };
}

function warCardHtml() {
  return `
    <main class="faction-war">
      <div class="war-section-header" data-test-torn-header>Ranked War</div>
      <div class="war-card" data-warid="34567">
        <div class="war-head">
          <a href="/factions.php?step=profile&ID=111">Kingshade</a>
          <span class="timer">13:34:28</span>
          <a href="/factions.php?step=profile&ID=222">Enemy</a>
        </div>
        <section class="enemy-faction">
          <div id="faction_war_list_id">
            <ul class="members-list">
              <li class="enemy" data-user-id="2000001">
                <div class="member"><a href="/profiles.php?XID=2000001"><span class="name">Enemy</span></a></div>
                <div class="level">30</div>
                <div class="points">0</div>
                <div class="status"><a href="/loader.php?sid=attack&user2ID=2000001">Okay</a></div>
              </li>
            </ul>
          </div>
        </section>
      </div>
    </main>`;
}

/**
 * Torn folds its own Ranked War section from a handler on the container the war
 * card sits in. The panel is a sibling of that card, so this is the ancestor
 * every tap in the panel used to reach. Modelled, not copied from Torn: what is
 * pinned here is that KS taps stop before it and Torn's own taps still reach it.
 */
function installTornCollapseHandler() {
  const container = document.querySelector('main.faction-war');
  if (!container) throw new Error('war container is missing');
  const collapses = { count: 0 };
  container.addEventListener('click', () => {
    collapses.count += 1;
  });
  return collapses;
}

/** @param {string} route */
async function mountPdaWarDibs(route) {
  window.history.replaceState(null, '', route);
  stubLayoutAsRendered();
  document.body.innerHTML = warCardHtml();
  document.hasFocus = () => true;
  Reflect.set(window, 'GM_xmlhttpRequest', () => ({ abort() {} }));
  window.eval(await readRepositoryFile('KS_Torn_War_Dibs.user.js'));
  window.dispatchEvent(new Event('load'));
  window.dispatchEvent(new Event('focus'));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** @returns {ShadowRoot} */
function panelShadow() {
  const shadow = document.getElementById('ks-twd-pda-panel')?.shadowRoot;
  if (!shadow) throw new Error('panel is not mounted');
  return shadow;
}

/**
 * @param {string} role
 * @returns {Element | null}
 */
function findControl(role) {
  return panelShadow().querySelector(`[data-role='${role}']`);
}

/**
 * @param {string} role
 * @returns {HTMLButtonElement}
 */
function control(role) {
  const element = findControl(role);
  if (!(element instanceof window.HTMLElement)) throw new Error(`missing control: ${role}`);
  return /** @type {HTMLButtonElement} */ (element);
}

/** @param {string} role */
function tap(role) {
  control(role).dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }),
  );
}

/** Torn re-renders the war card the panel is anchored beside. Reproduce that. */
async function redrawWarCardUnderPanel() {
  const container = document.querySelector('main.faction-war');
  if (!container) throw new Error('war container is missing');
  const rebuilt = document.createElement('div');
  rebuilt.innerHTML = warCardHtml();
  const card = rebuilt.querySelector('.war-card');
  if (!card) throw new Error('war card is missing');
  container.innerHTML = '';
  container.append(card);
  window.dispatchEvent(new Event('focus'));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('War Dibs PDA panel control row', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    Reflect.deleteProperty(window, INSTANCE_KEY);
    Reflect.deleteProperty(window, 'GM_xmlhttpRequest');
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('mounts the panel above the war card with every control present', async () => {
    await mountPdaWarDibs(OWN_WAR_ROUTE);
    const host = document.getElementById('ks-twd-pda-panel');
    expect(host).not.toBeNull();
    expect(host?.nextElementSibling?.getAttribute('data-warid')).toBe('34567');
    for (const role of [
      'key',
      'torn-key',
      'create-key',
      'sync',
      'demo',
      'war-room',
      'forget-ff',
      'forget-torn',
    ]) {
      expect(findControl(role), role).not.toBeNull();
    }
  });

  it('lets a locked credential control receive the tap and answer with the reason', async () => {
    await mountPdaWarDibs(OWN_WAR_ROUTE);
    const key = control('key');
    expect(key.getAttribute('aria-disabled')).toBe('true');
    // The whole point: locked is not the disabled property, or no click is dispatched.
    expect(key.disabled).toBe(false);

    const before = control('status').textContent;
    tap('key');
    const after = control('status').textContent;
    expect(after).not.toBe(before);
    expect(after).toContain('key change locked');
  });

  it('keeps the tap path after Torn redraws the war card underneath the panel', async () => {
    await mountPdaWarDibs(OWN_WAR_ROUTE);
    await redrawWarCardUnderPanel();

    expect(document.querySelectorAll('#ks-twd-pda-panel')).toHaveLength(1);
    expect(findControl('key')).not.toBeNull();
    tap('key');
    expect(control('status').textContent).toContain('key change locked');
  });

  it('binds the control row again after a full unmount and remount', async () => {
    await mountPdaWarDibs(OWN_WAR_ROUTE);
    expect(findControl('panel')).not.toBeNull();

    window.dispatchEvent(new Event('blur'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(document.querySelectorAll('#ks-twd-pda-panel')).toHaveLength(1);
    // Whether the remount reused the panel node or built a new one, the row answers.
    expect(findControl('panel')).not.toBeNull();
    control('status').textContent = 'Shared: syncing…';
    tap('key');
    expect(control('status').textContent).toContain('key change locked');
  });

  it('routes one tap to exactly one action after repeated redraws', async () => {
    await mountPdaWarDibs(VIEW_WAR_ROUTE);
    const demo = control('demo');
    expect(demo.disabled).toBe(false);
    expect(demo.textContent).toBe('Demo');

    await redrawWarCardUnderPanel();
    await redrawWarCardUnderPanel();

    // A second handler on the same panel would toggle Demo straight back off.
    tap('demo');
    expect(control('demo').textContent).toBe('Demo: ON');
    tap('demo');
    expect(control('demo').textContent).toBe('Demo');
  });

  it('keeps Demo powerless on the owner own war', async () => {
    await mountPdaWarDibs(OWN_WAR_ROUTE);
    const demo = control('demo');
    expect(demo.disabled).toBe(true);
    tap('demo');
    expect(control('demo').textContent).toBe('Demo');
  });

  it('never lets a tap in the panel reach Torn own collapse handler', async () => {
    await mountPdaWarDibs(OWN_WAR_ROUTE);
    const collapses = installTornCollapseHandler();

    tap('key');
    tap('sync');
    tap('war-room');
    tap('forget-ff');

    expect(collapses.count).toBe(0);
    // And the tap still did its own work rather than being swallowed.
    expect(control('status').textContent).toContain('key change locked');
  });

  it('stops the pointer and touch events a collapse handler may listen for', async () => {
    await mountPdaWarDibs(OWN_WAR_ROUTE);
    const container = document.querySelector('main.faction-war');
    if (!container) throw new Error('war container is missing');
    /** @type {string[]} */
    const seen = [];
    for (const name of [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'touchstart',
      'touchend',
    ]) {
      container.addEventListener(name, (event) => seen.push(event.type));
    }

    const button = control('key');
    for (const name of [
      'pointerdown',
      'touchstart',
      'mousedown',
      'mouseup',
      'touchend',
      'pointerup',
    ]) {
      button.dispatchEvent(new window.Event(name, { bubbles: true, composed: true }));
    }

    expect(seen).toEqual([]);
  });

  it('leaves Torn own collapse working outside the panel', async () => {
    await mountPdaWarDibs(OWN_WAR_ROUTE);
    const collapses = installTornCollapseHandler();

    const header = document.querySelector('[data-test-torn-header]');
    expect(header).not.toBeNull();
    header?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(collapses.count).toBe(1);

    const row = document.querySelector('li.enemy');
    row?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(collapses.count).toBe(2);
  });

  it('declares a phone-sized touch target for every control in the row', async () => {
    await mountPdaWarDibs(OWN_WAR_ROUTE);
    const css = panelShadow().querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/\.controls > button,\.controls > a \{[^}]*min-height:44px/);
    expect(css).toMatch(/\.controls > button,\.controls > a \{[^}]*touch-action:manipulation/);
    expect(panelShadow().querySelectorAll('.controls .sep')).toHaveLength(0);
  });
});
