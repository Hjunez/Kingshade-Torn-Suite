/**
 * KS actionBudget — "en användarinput ger högst en åtgärd".
 *
 * grant() får bara anropas från en äkta, isTrusted event-handler.
 * spend() konsumerar budgeten. Andra spend() utan ny grant() kastar.
 *
 * Budgeten går ur tiden efter `ttlMs` så att ett klick inte kan "spara"
 * en åtgärd till senare — det vore i praktiken schemaläggning.
 */

import { ComplianceError } from './netGuard.js';

const DEFAULT_TTL_MS = 5000;

/**
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function createActionBudget({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  let token = 0;
  let grantedAt = 0;

  return {
    /**
     * @param {{ isTrusted?: boolean }} [event] Om ett event skickas in krävs event.isTrusted.
     */
    grant(event) {
      if (event && event.isTrusted === false) {
        throw new ComplianceError('Syntetiskt event kan inte ge budget.', 'UNTRUSTED_EVENT');
      }
      token = 1;
      grantedAt = now();
    },

    spend() {
      if (token !== 1) {
        throw new ComplianceError('Ingen budget — en input ger högst en åtgärd.', 'NO_BUDGET');
      }
      if (now() - grantedAt > ttlMs) {
        token = 0;
        throw new ComplianceError('Budgeten har gått ut — åtgärden måste följa direkt på inputen.', 'BUDGET_EXPIRED');
      }
      token = 0;
    },

    get available() {
      return token === 1 && now() - grantedAt <= ttlMs;
    },

    reset() {
      token = 0;
      grantedAt = 0;
    },
  };
}

/**
 * Bekvämlighet: kopplar en handler så att budgeten alltid ges av ett äkta klick.
 *
 * @param {EventTarget} element
 * @param {(event: Event) => unknown} handler
 * @param {{ grant: (event?: { isTrusted?: boolean }) => void }} budget
 * @returns {void}
 *
 * @example
 *   onUserAction(button, (e) => api.getBazaar({ userGesture: true }));
 */
export function onUserAction(element, handler, budget) {
  element.addEventListener('click', (/** @type {Event} */ event) => {
    if (!event.isTrusted) return; // syntetiska klick ignoreras helt
    budget.grant(event);
    return handler(event);
  });
}
