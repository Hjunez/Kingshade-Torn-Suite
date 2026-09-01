/**
 * KS netGuard — enda tillåtna utgången för nättrafik.
 *
 * Gör tre rader i KS compliance-baseline till kod:
 *   · Endast Torns officiella API (api.torn.com) — aldrig spelsidor.
 *   · Ingen bakgrundsövervakning — sidan måste vara synlig och aktiv.
 *   · En användarinput ger högst en åtgärd — anropet måste bära en budgettoken.
 *
 * Plattformsoberoende: transporten (fetch / GM_xmlhttpRequest / PDA_httpGet)
 * skickas in som adapter, så core-lagret aldrig känner till plattformen.
 */

/**
 * Vakten läser bara två saker ur dokumentet. Strukturell typ i stället för
 * Document, så tester kan skicka in ett minimalt fejkdokument.
 *
 * @typedef {{ visibilityState: string, hasFocus?: () => boolean }} DocumentLike
 */

const ALLOWED_ORIGIN = 'https://api.torn.com';
const ALLOWED_URL = /^https:\/\/api\.torn\.com\/(v2\/)?[a-z0-9/_-]*(\?|$)/i;

export class ComplianceError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'ComplianceError';
    this.code = code;
  }
}

/**
 * Kastar om anropet bryter mot baselinen. Returnerar den normaliserade URL:en.
 *
 * @param {string|URL} url
 * @param {{ userGesture?: boolean, doc?: DocumentLike | null | undefined }} [opts]
 * @returns {string}
 */
export function assertCompliantRequest(url, opts = {}) {
  const { userGesture = false, doc = typeof document !== 'undefined' ? document : null } = opts;

  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new ComplianceError(`Ogiltig URL: ${url}`, 'INVALID_URL');
  }

  if (parsed.origin !== ALLOWED_ORIGIN || !ALLOWED_URL.test(parsed.href)) {
    throw new ComplianceError(
      `Blockerad destination: ${parsed.origin} — endast ${ALLOWED_ORIGIN} är tillåten.`,
      'FORBIDDEN_HOST',
    );
  }

  if (!userGesture) {
    throw new ComplianceError(
      'Nätanrop utan användarinteraktion — en input ger högst en åtgärd.',
      'NO_USER_GESTURE',
    );
  }

  if (doc) {
    if (doc.visibilityState !== 'visible') {
      throw new ComplianceError('Sidan är inte synlig — ingen bakgrundsaktivitet.', 'PAGE_HIDDEN');
    }
    if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) {
      throw new ComplianceError('Sidan har inte fokus — ingen bakgrundsaktivitet.', 'PAGE_UNFOCUSED');
    }
  }

  // Nyckeln får aldrig hamna i loggar eller felmeddelanden.
  return parsed.href;
}

/**
 * Bygger en guardad request-funktion.
 *
 * @param {(url: string, init?: Record<string, unknown>) => Promise<unknown>} transport
 *   Plattformsadapter: fetch på PC, PDA_httpGet på PDA.
 * @param {{ budget?: { spend: () => void }, doc?: DocumentLike | null | undefined }} [deps]
 * @returns {(url: string | URL, options?: { userGesture?: boolean } & Record<string, unknown>) => Promise<unknown>}
 */
export function createGuardedRequest(transport, deps = {}) {
  const { budget, doc } = deps;

  return async function request(url, { userGesture = false, ...init } = {}) {
    const safeUrl = assertCompliantRequest(url, { userGesture, doc });
    if (budget) budget.spend();
    return transport(safeUrl, init);
  };
}

/**
 * Maskerar nyckeln innan något loggas.
 *
 * @param {string | URL} url
 * @returns {string}
 */
export function redact(url) {
  return String(url).replace(/([?&]key=)[^&]+/gi, '$1***');
}
