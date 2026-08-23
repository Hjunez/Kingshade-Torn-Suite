import { readRepositoryFile } from './repository.js';

const controllerKey = '__ksBootleggingAssistantClean';

/** @typedef {{ version: string, destroy: () => void }} BootleggingController */

/**
 * Evaluate the published userscript without transforming its source.
 *
 * @returns {Promise<BootleggingController>}
 */
export async function installBootleggingUserscript() {
  Object.defineProperty(window, 'unsafeWindow', {
    configurable: true,
    value: window,
    writable: true,
  });

  window.eval(await readRepositoryFile('Kingshades_Bootlegging_Clean_v4.1.1.user.js'));

  if (document.readyState === 'loading') {
    document.dispatchEvent(new Event('DOMContentLoaded'));
  }

  const controller = Reflect.get(window, controllerKey);
  if (!isBootleggingController(controller)) {
    throw new Error('Bootlegging userscript did not expose its lifecycle controller.');
  }

  return controller;
}

export function removeBootleggingTestGlobals() {
  const controller = Reflect.get(window, controllerKey);
  if (isBootleggingController(controller)) controller.destroy();
  Reflect.deleteProperty(window, controllerKey);
  Reflect.deleteProperty(window, 'unsafeWindow');
}

/**
 * @param {unknown} value
 * @returns {value is BootleggingController}
 */
function isBootleggingController(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'version') === 'string' &&
    typeof Reflect.get(value, 'destroy') === 'function'
  );
}
