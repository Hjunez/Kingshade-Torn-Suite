import { readRepositoryFile } from './repository.js';

/**
 * Test harness for KS Torn Hustling Advisor PC.
 *
 * The published file is evaluated unchanged, exactly as Tampermonkey would do it,
 * so every assertion measures the code that ships. Nothing is bundled, rewritten
 * or transpiled on the way in.
 */

export const HUSTLING_USERSCRIPT = 'KS_Torn_Hustling_Advisor_PC.user.js';
export const HUSTLING_INSTANCE_KEY = '__ksTornHustlingAdvisorV010A1';

/**
 * @typedef {object} HustlingInternals
 * @property {number} ATTENTION_THRESHOLD
 * @property {(classes: Iterable<string>) => string} classifyOutcomeClasses
 * @property {(state: any, options?: { attentionThreshold?: number }) => any} decide
 * @property {() => boolean} isObserving
 * @property {() => boolean} isMounted
 * @property {string} panelId
 * @property {(label: string) => any} parseActionLabel
 * @property {(label: string) => any} parseAudienceMemberLabel
 * @property {(text: string) => any} parseAudienceSummary
 * @property {(text: string) => number | null} parseMoney
 * @property {(doc: Document | null) => { amount: number | null, readable: boolean }} readCash
 * @property {(root: Element | null, doc?: Document) => any} readState
 * @property {number} CASH_WARNING_RATIO
 */

/**
 * @typedef {object} HustlingController
 * @property {string} version
 * @property {string} status
 * @property {string} mode
 * @property {() => void} destroy
 * @property {HustlingInternals} internals
 */

/**
 * @param {string} name file name inside tests/fixtures/hustling
 * @returns {Promise<string>}
 */
export function readHustlingFixture(name) {
  return readRepositoryFile(`tests/fixtures/hustling/${name}`);
}

/**
 * Renders a fixture into the current jsdom document as Torn's crimes page would.
 *
 * @param {string} name
 * @returns {Promise<Element>} the mounted hustling-root
 */
export async function mountHustlingFixture(name) {
  document.body.setAttribute('data-page', 'crimes');
  const app = document.createElement('div');
  app.className = 'crimes-app';
  app.innerHTML = await readHustlingFixture(name);
  document.body.replaceChildren(app);

  const root = app.querySelector('div.crime-root.hustling-root');
  if (!root) throw new Error(`Fixture ${name} has no hustling-root.`);
  return root;
}

/**
 * Installs Torn's sidebar balance block in the current document.
 *
 * The markup is the real captured block (see the fixture's own comment); only the
 * amount is substituted here, because that is the whole point of the test.
 *
 * @param {number | string | null} amount a number sets both data-money and the
 *   rendered text; a string sets only the rendered text, so the fallback path can
 *   be exercised; null removes the sidebar entirely.
 * @returns {Promise<void>}
 */
export async function setSidebarCash(amount) {
  document.getElementById('ks-test-sidebar')?.remove();
  if (amount === null) return;

  const holder = document.createElement('div');
  holder.id = 'ks-test-sidebar';
  holder.innerHTML = await readHustlingFixture('sidebar-cash.html');
  document.body.append(holder);

  const value = holder.querySelector('#user-money');
  if (!value) throw new Error('sidebar-cash.html no longer contains #user-money.');

  if (typeof amount === 'number') {
    value.setAttribute('data-money', String(amount));
    value.textContent = `$${amount.toLocaleString('en-US')}`;
  } else {
    value.removeAttribute('data-money');
    value.textContent = amount;
  }
}

/**
 * Parses a fixture into a detached root, for the pure parser/decision tests.
 *
 * @param {string} name
 * @returns {Promise<Element>}
 */
export async function detachedHustlingRoot(name) {
  const holder = document.createElement('div');
  holder.innerHTML = await readHustlingFixture(name);
  const root = holder.querySelector('div.crime-root.hustling-root');
  if (!root) throw new Error(`Fixture ${name} has no hustling-root.`);
  return root;
}

/**
 * Evaluates the published userscript in the current jsdom page.
 *
 * @returns {Promise<HustlingController>}
 */
export async function installHustlingUserscript() {
  window.eval(await readRepositoryFile(HUSTLING_USERSCRIPT));

  const controller = Reflect.get(window, HUSTLING_INSTANCE_KEY);
  if (!isHustlingController(controller)) {
    throw new Error('Hustling userscript did not expose its lifecycle controller.');
  }
  return controller;
}

export function removeHustlingTestGlobals() {
  const controller = Reflect.get(window, HUSTLING_INSTANCE_KEY);
  if (isHustlingController(controller)) controller.destroy();
  Reflect.deleteProperty(window, HUSTLING_INSTANCE_KEY);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function tick(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {unknown} value
 * @returns {value is HustlingController}
 */
function isHustlingController(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'version') === 'string' &&
    typeof Reflect.get(value, 'destroy') === 'function' &&
    typeof Reflect.get(value, 'internals') === 'object'
  );
}
