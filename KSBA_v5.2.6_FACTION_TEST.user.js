// ==UserScript==
// @name         Kingshade's Bootlegging Advisor
// @namespace    DieselBladeScripts.ARS.Kingshade
// @version      5.2.6
// @description  Premium Bootlegging guidance for Torn PDA with queue balancing, stable rendering and privacy-safe diagnostics.
// @license      GPL-3.0-or-later
// @author       DieselBlade [1701621], Hemicopter [2780600], rebuilt for Kingshade
// @match        https://www.torn.com/page.php?sid=crimes*
// @match        https://torn.com/page.php?sid=crimes*
// @match        https://www.torn.com/loader.php?sid=crimes*
// @match        https://torn.com/loader.php?sid=crimes*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
    'use strict';

    /*
     * Kingshade's Bootlegging Advisor v5.2.6 STATUS & DETAILS UI CLEANUP
     *
     * v5.2.6 status and details UI cleanup:
     * - keeps LIVE only in the main header and removes duplicate technical status labels;
     * - replaces DATA CONFIDENCE / DOM LIVE with the user-facing DATA STATUS / READY state;
     * - changes SELL READY to LOWEST COVERAGE and removes repeated Sell summary text;
     * - makes PRIORITY ORDER a plain information label instead of a button-like control;
     * - moves the diagnostic action into Data Status and leaves DONE as the only footer button;
     * - keeps calculations, recommendations, placement, highlighting, native Sell row and scrolling behavior unchanged.
     *
     * Safety contract:
     * - visual/read-only guidance only;
     * - never clicks a Torn control;
     * - never starts, repeats, intercepts or changes a Torn request;
     * - reads only the eight visible Bootlegging genre tiles and Torn controls;
     * - waits for a complete, stable DOM snapshot before changing advice;
     * - diagnostics contain no full HTML, player identity or unrestricted text.
     *
     * v5.2.5 native hard stop:
     * - removes every scroll-position clamp introduced by v5.2.3/v5.2.4;
     * - removes excessive trailing layout space at its source instead of pushing the page back;
     * - adds one small native bottom-access spacer after the complete Torn crime card;
     * - lets the page stop naturally with no bounce, shake or repeated scroll correction;
     * - restores every changed layout style when leaving Bootlegging or replacing the script;
     * - keeps all calculations, Details, COPY/WAIT/SELL logic and native Torn controls unchanged;
     *
     * v5.2.1 priority-only details:
     * - removes the unnecessary alternate ordering and always displays genres by real priority;
     * - keeps P1–P8 aligned with the visible list order;
     * - simplifies the Details toolbar to a fixed PRIORITY ORDER label plus Refresh;
     * - keeps all calculations, COPY/WAIT/SELL logic, placement and native Sell row unchanged;
     *
     * v5.2.0 release baseline:
     * - keeps the approved DOM-only data path, stability guard and layout unchanged;
     * - never adds classes, layers, badges, borders, tint, glow or text changes to the Sell row;
     * - leaves Torn's native Sell Counterfeit DVDs row and 5-nerve control completely untouched;
     * - clears styling remnants left by older Kingshade Bootlegging versions during startup;
     * - keeps SELL guidance only inside the Advisor card;
     * - fails closed instead of guessing while Torn is rebuilding the crime card.
     */

    const CONFIG = Object.freeze({
        targets: Object.freeze({
            Action: 100,
            Comedy: 70,
            Drama: 55,
            Fantasy: 70,
            Horror: 30,
            Romance: 30,
            Thriller: 40,
            'Sci-Fi': 20
        }),
        refillFraction: 0.25,
        renderDebounceMs: 90,
        domStabilityMs: 140,
        healthCheckMs: 8_000,
        oversupplyWarningAt: 1.25,
        debug: false
    });

    const SCRIPT = Object.freeze({
        name: "Kingshade's Bootlegging Advisor",
        version: '5.2.6',
        globalKey: '__ksBootleggingAssistantClean',
        mainHostId: 'ksba-v526-main-host',
        portalHostId: 'ksba-v526-portal-host',
        styleId: 'ksba-v526-global-styles',
        storagePrefix: 'ksBootAdvisorV5.'
    });

    const GENRE_ORDER = Object.freeze([
        'Action', 'Comedy', 'Drama', 'Fantasy',
        'Horror', 'Romance', 'Thriller', 'Sci-Fi'
    ]);

    const win = window;

    const previous = win[SCRIPT.globalKey];
    if (previous?.destroy instanceof Function) {
        try {
            previous.destroy();
        } catch {
            // Best-effort cleanup of a previously injected version.
        }
    }

    const state = {
        destroyed: false,
        rendering: false,
        observer: null,
        renderTimer: null,
        healthTimer: null,
        toastTimer: null,
        routeHandler: null,
        clickHandler: null,
        visibilityHandler: null,
        keyHandler: null,
        pendingDomSignature: '',
        pendingDomSince: 0,
        domGapSince: 0,
        lastSnapshot: null,
        lastError: '',
        diagnosticsCopiedAt: 0,
        detailsOpen: false,
        lastFocused: null,
        suppressObserverUntil: 0,
        renderSignatures: {
            main: '',
            details: '',
            highlight: ''
        },
        preferences: {
            highlightTiles: true
        },
        pageEnd: {
            active: false,
            frame: 0,
            resizeHandler: null,
            spacer: null,
            anchor: null,
            sizingNode: null,
            originalSizingStyle: null,
            collapsedNodes: [],
            safeGapPx: 0,
            removedExcessPx: 0
        },
        ui: {
            mainHost: null,
            mainRoot: null,
            portalHost: null,
            portalRoot: null
        }
    };

    function log(...values) {
        if (CONFIG.debug) {
            console.log(`[${SCRIPT.name} v${SCRIPT.version}]`, ...values);
        }
    }

    function rememberError(error) {
        const message = normalizeText(error?.message || error);
        state.lastError = message.slice(0, 240);
        log(message);
    }

    function normalizeText(value) {
        return String(value ?? '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeCount(value) {
        if (typeof value === 'number') {
            return Number.isSafeInteger(value) && value >= 0 ? value : null;
        }

        const text = normalizeText(value);
        if (!text) {
            return null;
        }

        const compact = text.replace(/[\s,.']/g, '');
        if (!/^\d+$/.test(compact)) {
            return null;
        }

        const number = Number(compact);
        return Number.isSafeInteger(number) && number >= 0 ? number : null;
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function genrePattern(genre) {
        return new RegExp(`(?:^|[^a-z])${escapeRegExp(genre)}(?:$|[^a-z])`, 'i');
    }

    function findGenreInText(value) {
        const text = normalizeText(value);
        return GENRE_ORDER.find(genre => genrePattern(genre).test(text)) || '';
    }

    function safeStorageGet(key, fallback) {
        try {
            const value = localStorage.getItem(SCRIPT.storagePrefix + key);
            return value === null ? fallback : value;
        } catch {
            return fallback;
        }
    }

    function safeStorageSet(key, value) {
        try {
            localStorage.setItem(SCRIPT.storagePrefix + key, String(value));
        } catch {
            // Storage can be unavailable in hardened WebViews.
        }
    }

    function loadPreferences() {
        state.preferences.highlightTiles = safeStorageGet('highlightTiles', 'true') !== 'false';
    }

    function setPreference(key, value) {
        state.preferences[key] = value;
        safeStorageSet(key, value);
    }

    function routeFingerprint() {
        return `${location.pathname || ''}${location.search || ''}${location.hash || ''}`;
    }

    function hasCrimesUrl() {
        const url = `${location.pathname || ''}${location.search || ''}`.toLowerCase();
        return url.includes('sid=crimes');
    }

    function pageMentionsBootlegging() {
        const headingCandidates = document.querySelectorAll(
            'h1, h2, h3, [class*="titleBar"], [class*="currentCrime"], [aria-label]'
        );
        for (const element of headingCandidates) {
            const text = normalizeText(
                element.getAttribute?.('aria-label') || element.textContent
            );
            if (/\bbootlegging\b/i.test(text)) {
                return true;
            }
        }
        return false;
    }

    function isBootleggingRoute(tiles = null) {
        if (!hasCrimesUrl()) {
            return false;
        }

        const hash = String(location.hash || '').toLowerCase();
        if (hash.includes('bootlegging')) {
            return true;
        }

        if (hash && /#\/(?:search|shoplifting|pickpocketing|hustling|burglary|graffiti|scamming|forgery|cracking|disposal|arson)/i.test(hash)) {
            return false;
        }

        const discovered = tiles || collectGenreTiles();
        return discovered.length === GENRE_ORDER.length || pageMentionsBootlegging();
    }

    function installStyles() {
        document.querySelectorAll(
            'style[id^="ks-boot-clean-v"], style[id^="ks-boot-advisor-v"], style[id^="ksba-v"]'
        ).forEach(style => {
            if (style.id !== SCRIPT.styleId) style.remove();
        });

        document.getElementById(SCRIPT.styleId)?.remove();
        const style = document.createElement('style');
        style.id = SCRIPT.styleId;
        style.textContent = `
            .ks-boot-copy-target,
            .ksba-copy-target {
                position: relative !important;
            }

            .ksba-copy-target {
                outline: 2px solid #3d9cff !important;
                outline-offset: -2px !important;
                box-shadow:
                    inset 0 0 0 1px rgba(255,255,255,.18),
                    0 0 0 1px rgba(61,156,255,.22),
                    0 0 16px rgba(61,156,255,.38) !important;
            }


            .ksba-copy-target::after {
                content: attr(data-ksba-label) !important;
                position: absolute !important;
                top: 4px !important;
                right: 4px !important;
                z-index: 6 !important;
                min-width: 34px !important;
                box-sizing: border-box !important;
                padding: 2px 6px !important;
                border: 1px solid rgba(255,255,255,.24) !important;
                border-radius: 999px !important;
                background: rgba(26,105,187,.96) !important;
                font: 900 9px/13px Arial, sans-serif !important;
                letter-spacing: .45px !important;
                text-align: center !important;
                color: #fff !important;
                text-shadow: 0 1px 1px rgba(0,0,0,.65) !important;
                pointer-events: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function readGenre(element) {
        if (!(element instanceof Element)) {
            return '';
        }

        const sources = [
            element.getAttribute('data-genre'),
            element.getAttribute('aria-label'),
            element.querySelector?.('[class*="genreName"], [data-genre-name]')?.textContent,
            element.textContent
        ];

        for (const source of sources) {
            const genre = findGenreInText(source);
            if (genre) {
                return genre;
            }
        }
        return '';
    }

    function countGenresInElement(element) {
        const text = normalizeText(element?.textContent);
        return GENRE_ORDER.reduce(
            (count, genre) => count + (genrePattern(genre).test(text) ? 1 : 0),
            0
        );
    }

    function elementScore(element, genre) {
        if (!(element instanceof Element)) {
            return -Infinity;
        }

        const text = normalizeText(element.textContent);
        if (!genrePattern(genre).test(text)) {
            return -Infinity;
        }

        const genreCount = countGenresInElement(element);
        if (genreCount > 2) {
            return -Infinity;
        }

        let score = 0;
        const tag = element.tagName.toLowerCase();
        const classes = String(element.className || '').toLowerCase();
        const role = element.getAttribute('role');

        if (tag === 'button') score += 18;
        if (role === 'button') score += 12;
        if (/genre|stock|copy|tile|card|option/.test(classes)) score += 10;
        if (element.querySelector('[class*="currentStock"], [data-stock], [aria-label*="stock" i]')) score += 12;
        if (element.querySelector('[class*="statusText"], [data-queue], [aria-label*="queued" i], [aria-label*="copying" i]')) score += 9;
        if (element.querySelector('[class*="genreName"], [data-genre-name]')) score += 7;
        if (/\d/.test(text)) score += 5;
        if (text.length <= 100) score += 4;
        if (text.length > 260) score -= 12;
        if (genreCount === 1) score += 10;

        const rect = element.getBoundingClientRect?.();
        if (rect && rect.width >= 60 && rect.height >= 50 && rect.height <= 350) {
            score += 4;
        }

        return score;
    }

    function likelyRoots() {
        const selectors = [
            '[class*="bootlegging"]',
            '[class*="crime-root"]',
            '[class*="currentCrime"]',
            '[class*="crimeRoot"]',
            'main',
            '#mainContainer',
            'body'
        ];
        const roots = [];
        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(root => {
                if (!roots.includes(root)) {
                    roots.push(root);
                }
            });
        }
        return roots.length ? roots : [document.body].filter(Boolean);
    }

    function directCandidates(root) {
        return Array.from(root.querySelectorAll([
            '[class*="genreStock"]',
            '[data-genre]',
            'button[aria-label]',
            '[role="button"][aria-label]',
            'button',
            '[role="button"]'
        ].join(',')));
    }

    function exactGenreLabels(root, genre) {
        const selector = '[class*="genreName"], [data-genre-name], h3, h4, span, div, p, strong';
        const labels = [];
        for (const element of root.querySelectorAll(selector)) {
            const text = normalizeText(element.textContent);
            if (text.toLowerCase() === genre.toLowerCase()) {
                labels.push(element);
            }
        }
        return labels;
    }

    function collectGenreTiles() {
        if (!document.body) {
            return [];
        }

        const best = new Map();

        function consider(element, genre) {
            const score = elementScore(element, genre);
            if (!Number.isFinite(score)) {
                return;
            }
            const current = best.get(genre);
            if (!current || score > current.score) {
                best.set(genre, { genre, element, score });
            }
        }

        for (const root of likelyRoots()) {
            for (const element of directCandidates(root)) {
                const genre = readGenre(element);
                if (genre) {
                    consider(element, genre);
                }
            }

            for (const genre of GENRE_ORDER) {
                for (const label of exactGenreLabels(root, genre)) {
                    let candidate = label;
                    for (let depth = 0; depth < 7 && candidate; depth += 1) {
                        consider(candidate, genre);
                        candidate = candidate.parentElement;
                    }
                }
            }

            if (best.size === GENRE_ORDER.length) {
                break;
            }
        }

        const used = new Set();
        const result = [];
        for (const genre of GENRE_ORDER) {
            const entry = best.get(genre);
            if (!entry || used.has(entry.element)) {
                return [];
            }
            used.add(entry.element);
            result.push({ genre, button: entry.element, score: entry.score });
        }
        return result;
    }

    function parseQueued(text, element) {
        const sources = [
            element?.getAttribute?.('data-queue'),
            element?.querySelector?.('[data-queue]')?.getAttribute?.('data-queue'),
            element?.querySelector?.('[class*="statusText"]')?.textContent,
            element?.getAttribute?.('aria-label'),
            text
        ];

        for (const source of sources) {
            const normalized = normalizeText(source);
            if (!normalized) {
                continue;
            }

            const matches = Array.from(
                normalized.matchAll(/(\d[\d\s,.']*)\s*(?:queued|copying|in\s+queue|being\s+copied)\b/gi)
            );
            if (matches.length) {
                const values = matches
                    .map(match => normalizeCount(match[1]))
                    .filter(value => value !== null);
                if (values.length) {
                    return values.reduce((sum, value) => sum + value, 0);
                }
            }

            const direct = normalizeCount(normalized);
            if (direct !== null && source !== text) {
                return direct;
            }
        }

        return null;
    }

    function parseOwned(text, element, queued) {
        const directSources = [
            element?.getAttribute?.('data-stock'),
            element?.querySelector?.('[data-stock]')?.getAttribute?.('data-stock'),
            element?.querySelector?.('[class*="currentStock"]')?.textContent,
            element?.querySelector?.('[aria-label*="stock" i]')?.getAttribute?.('aria-label')
        ];

        for (const source of directSources) {
            const normalized = normalizeText(source);
            if (!normalized) {
                continue;
            }
            const labelled = normalized.match(/(?:stock|owned)\D*(\d[\d\s,.']*)/i);
            const value = normalizeCount(labelled ? labelled[1] : normalized);
            if (value !== null) {
                return value;
            }
        }

        const withoutStatuses = normalizeText(text)
            .replace(/\d[\d\s,.']*\s*(?:queued|copying|in\s+queue|being\s+copied)\b/gi, ' ')
            .replace(/\b(?:queued|copying|stock|owned)\b/gi, ' ');

        const labelled = withoutStatuses.match(/(?:stock|owned)\D*(\d[\d\s,.']*)/i);
        if (labelled) {
            const value = normalizeCount(labelled[1]);
            if (value !== null) {
                return value;
            }
        }

        const tokens = Array.from(
            withoutStatuses.matchAll(/(?:^|[^\d])(\d[\d,.']*)(?=$|[^\d])/g)
        ).map(match => normalizeCount(match[1])).filter(value => value !== null);

        if (!tokens.length) {
            return null;
        }

        // Torn's visible stock is the final standalone number in the genre tile.
        // If a custom DOM places the queued value last, avoid returning the exact
        // known queue count when another numeric token is available.
        for (let index = tokens.length - 1; index >= 0; index -= 1) {
            if (tokens.length === 1 || tokens[index] !== queued) {
                return tokens[index];
            }
        }
        return tokens[tokens.length - 1];
    }

    function createRow(genre, button, owned, queued) {
        const target = CONFIG.targets[genre];
        const projected = owned + queued;
        const refillAt = Math.max(1, Math.ceil(target * CONFIG.refillFraction));
        return {
            genre,
            button,
            owned,
            queued,
            projected,
            target,
            refillAt,
            completion: projected / target,
            deficit: Math.max(0, target - projected)
        };
    }

    function parseVisibleGenreRow(genre, button) {
        if (!(button instanceof Element)) {
            return null;
        }

        const text = normalizeText(button.innerText || button.textContent);
        if (!text) {
            return null;
        }

        const queued = parseQueued(text, button);
        const owned = parseOwned(text, button, queued);
        if (owned === null || queued === null) {
            return null;
        }
        return createRow(genre, button, owned, queued);
    }

    function validateDomRows(tiles, domRows) {
        if (!Array.isArray(tiles) || tiles.length !== GENRE_ORDER.length) {
            return { rows: null, source: 'none', confidence: 'none', warnings: [] };
        }
        if (!Array.isArray(domRows) || domRows.length !== GENRE_ORDER.length) {
            return { rows: null, source: 'none', confidence: 'none', warnings: [] };
        }

        const seen = new Set();
        for (const row of domRows) {
            if (!GENRE_ORDER.includes(row.genre) || seen.has(row.genre)) {
                return { rows: null, source: 'none', confidence: 'none', warnings: [] };
            }
            if (!Number.isSafeInteger(row.owned) || row.owned < 0 ||
                !Number.isSafeInteger(row.queued) || row.queued < 0) {
                return { rows: null, source: 'none', confidence: 'none', warnings: [] };
            }
            seen.add(row.genre);
        }

        return { rows: domRows, source: 'dom', confidence: 'dom', warnings: [] };
    }

    function domRowsSignature(rows) {
        return Array.isArray(rows)
            ? rows.map(row => `${row.genre}:${row.owned}:${row.queued}`).join('|')
            : 'none';
    }

    function domSnapshotIsStable(rows) {
        const signature = domRowsSignature(rows);
        const now = performance.now();
        if (signature !== state.pendingDomSignature) {
            state.pendingDomSignature = signature;
            state.pendingDomSince = now;
            return false;
        }
        return now - state.pendingDomSince >= CONFIG.domStabilityMs;
    }

    function priorityRows(rows) {
        if (!Array.isArray(rows)) return [];
        return [...rows].sort((a, b) => {
            const completionDifference = a.completion - b.completion;
            if (Math.abs(completionDifference) > 1e-12) return completionDifference;
            if (a.deficit !== b.deficit) return b.deficit - a.deficit;
            if (a.projected !== b.projected) return a.projected - b.projected;
            return GENRE_ORDER.indexOf(a.genre) - GENRE_ORDER.indexOf(b.genre);
        });
    }

    function determineInstruction(rows) {
        if (!Array.isArray(rows) || rows.length !== GENRE_ORDER.length) {
            return {
                mode: 'none',
                command: 'DATA CHECK',
                headline: 'Recommendation paused',
                summary: 'Waiting for eight reliable genre values.'
            };
        }

        const ordered = priorityRows(rows);
        const bottleneck = ordered[0];
        const refillMode = rows.some(row => row.owned <= row.refillAt);
        const candidates = ordered.filter(row => row.projected < row.target);
        const coverage = Math.max(0, Math.min(1, bottleneck?.completion ?? 0));

        if (!refillMode) {
            return {
                mode: 'sell',
                command: 'SELL COUNTERFEIT DVDS',
                headline: 'Ready to sell',
                summary: `Lowest projected balance: ${bottleneck.genre} ${Math.round(bottleneck.completion * 100)}%.`,
                genre: null,
                coverage,
                bottleneck: bottleneck.genre,
                priority: ordered.slice(0, 3).map(row => row.genre)
            };
        }

        if (!candidates.length) {
            return {
                mode: 'wait',
                command: 'WAIT FOR QUEUE',
                headline: 'Queue covers every target',
                summary: `${bottleneck.genre} is currently the lowest projected genre.`,
                genre: null,
                coverage,
                bottleneck: bottleneck.genre,
                priority: ordered.slice(0, 3).map(row => row.genre)
            };
        }

        const selected = candidates[0];
        return {
            mode: 'copy',
            genre: selected.genre,
            command: `COPY ${selected.genre.toUpperCase()}`,
            headline: 'Next move',
            summary: `${selected.owned} stock + ${selected.queued} queued = ${selected.projected} / ${selected.target}`,
            coverage,
            bottleneck: selected.genre,
            priority: candidates.slice(0, 3).map(row => row.genre),
            reason: {
                owned: selected.owned,
                queued: selected.queued,
                projected: selected.projected,
                target: selected.target,
                completion: selected.completion,
                deficit: selected.deficit
            }
        };
    }

    function clearHighlights() {
        state.suppressObserverUntil = performance.now() + 100;
        document.querySelectorAll(
            '.ks-boot-copy-target, .ks-boot-sell-target, .ksba-copy-target, .ksba-sell-target'
        ).forEach(element => {
            element.classList.remove(
                'ks-boot-copy-target', 'ks-boot-sell-target',
                'ksba-copy-target', 'ksba-sell-target'
            );
            element.removeAttribute('data-ks-boot-label');
            element.removeAttribute('data-ks-boot-reason');
            element.removeAttribute('data-ksba-label');
            element.removeAttribute('data-ksba-reason');
        });
        document.querySelectorAll('.ksba-sell-label').forEach(element => {
            element.classList.remove('ksba-sell-label');
            if (!normalizeText(element.getAttribute('class'))) element.removeAttribute('class');
        });
        document.querySelectorAll('.ksba-sell-cost-target').forEach(element => {
            element.classList.remove('ksba-sell-cost-target');
            if (!normalizeText(element.getAttribute('class'))) element.removeAttribute('class');
        });
        document.querySelectorAll('.ksba-sell-visual-layer').forEach(element => element.remove());
        document.querySelectorAll('.ks-boot-copy-star, .ks-boot-sell-star').forEach(element => element.remove());
        state.renderSignatures.highlight = '';
    }

        function addHighlight(target, mode, reason) {
        if (!(target instanceof Element) ||
            mode !== 'copy' ||
            state.preferences.highlightTiles === false) {
            return;
        }

        state.suppressObserverUntil = performance.now() + 100;
        target.classList.add('ksba-copy-target');
        target.setAttribute('data-ksba-label', 'COPY');
        target.setAttribute('data-ksba-reason', reason || '');
    }

        function syncHighlight(rows, decision) {
        if (state.preferences.highlightTiles === false || !decision) {
            if (state.renderSignatures.highlight) clearHighlights();
            return;
        }

        // SELL guidance belongs only in the Advisor card.
        // Torn's native Sell Counterfeit DVDs row must remain completely untouched.
        if (decision.mode !== 'copy' || !Array.isArray(rows)) {
            if (state.renderSignatures.highlight) clearHighlights();
            return;
        }

        const selected = rows.find(row => row.genre === decision.genre);
        const target = selected?.button || null;
        const reason = selected
            ? `${selected.genre}: ${selected.owned} + ${selected.queued} = ${selected.projected}/${selected.target}`
            : '';
        const identity = selected ? `copy:${selected.genre}` : '';

        if (!(target instanceof Element)) {
            if (state.renderSignatures.highlight) clearHighlights();
            return;
        }

        const active = document.querySelector('.ksba-copy-target');
        if (active === target &&
            target.classList.contains('ksba-copy-target') &&
            state.renderSignatures.highlight === identity) {
            if (target.getAttribute('data-ksba-reason') !== reason) {
                target.setAttribute('data-ksba-reason', reason);
            }
            return;
        }

        clearHighlights();
        addHighlight(target, 'copy', reason);
        state.renderSignatures.highlight = identity;
    }

    function sellRowCandidateScore(candidate, label, depth) {
        if (!(candidate instanceof Element) || !(label instanceof Element) || !candidate.contains(label)) {
            return -Infinity;
        }

        const text = normalizeText(candidate.textContent);
        const rect = candidate.getBoundingClientRect?.();
        const labelRect = label.getBoundingClientRect?.();
        const viewportWidth = Math.max(document.documentElement.clientWidth || 0, innerWidth || 0, 320);

        if (!text || !/sell\s+counterfeit\s+dvds/i.test(text)) return -Infinity;
        if (/set\s+up\s+online\s+store/i.test(text)) return -Infinity;
        if (countGenresInElement(candidate) > 0) return -Infinity;
        if (!rect || rect.width < 180 || rect.width > viewportWidth + 32 || rect.height < 32 || rect.height > 145) {
            return -Infinity;
        }
        if (labelRect && (labelRect.top < rect.top - 2 || labelRect.bottom > rect.bottom + 2)) {
            return -Infinity;
        }

        let score = 0;
        const widthRatio = Math.min(1, rect.width / viewportWidth);
        score += widthRatio * 36;
        score += Math.max(0, 14 - Math.abs(rect.height - 68) / 4);
        score += Math.min(depth, 5) * 2;

        if (candidate !== label) score += 10;
        if (candidate.children.length >= 2) score += 9;
        if (candidate.querySelector('button, [role="button"], input, [class*="commit"], [class*="cost"]')) score += 13;
        if (candidate.matches('span, p, strong, h3, h4')) score -= 24;
        if (/^sell\s+counterfeit\s+dvds$/i.test(text)) score -= 12;
        if (rect.width >= viewportWidth * 0.72) score += 12;

        return score;
    }

    function findSellControl() {
        const labels = Array.from(document.querySelectorAll('span, div, p, strong, h3, h4, button, [role="button"]'))
            .filter(element => /^sell\s+counterfeit\s+dvds$/i.test(normalizeText(
                element.textContent || element.getAttribute?.('aria-label')
            )));

        const candidates = [];
        for (const label of labels) {
            let candidate = label;
            for (let depth = 0; depth < 9 && candidate; depth += 1) {
                const score = sellRowCandidateScore(candidate, label, depth);
                if (Number.isFinite(score)) candidates.push({ element: candidate, score });
                candidate = candidate.parentElement;
            }
        }

        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const bWidth = b.element.getBoundingClientRect?.().width || 0;
            const aWidth = a.element.getBoundingClientRect?.().width || 0;
            return bWidth - aWidth;
        });

        return candidates[0]?.element || null;
    }

    function commonAncestor(elements) {
        if (!elements.length) return null;
        let candidate = elements[0];
        while (candidate && !elements.every(element => candidate.contains(element))) {
            candidate = candidate.parentElement;
        }
        return candidate;
    }

    function appearsBefore(candidate, reference) {
        if (!(candidate instanceof Element) || !(reference instanceof Element) || candidate === reference) {
            return false;
        }
        return Boolean(candidate.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    function actionRowEvidence(element) {
        if (!(element instanceof Element)) return 0;
        const text = normalizeText(element.textContent);
        if (!text || text.length > 260 || !/copy/i.test(text)) return 0;
        if (/sell\s+counterfeit\s+dvds/i.test(text)) return 0;
        if (countGenresInElement(element) > 1) return 0;

        let evidence = 1;
        if (/(?:idle|copying|queued)/i.test(text)) evidence += 3;
        if (/\b\d+\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/i.test(text)) evidence += 3;
        if (/(?:computer|disc|dvd|nerve)/i.test(text)) evidence += 2;
        if ((text.match(/\d+/g) || []).length >= 2) evidence += 2;
        if (element.querySelectorAll('button, [role="button"], img, svg').length >= 2) evidence += 2;
        return evidence;
    }

    function copyRowScore(element, firstTile, gridRect) {
        if (!(element instanceof Element) || element.contains(firstTile) || !appearsBefore(element, firstTile)) {
            return -Infinity;
        }

        const evidence = actionRowEvidence(element);
        if (evidence < 4) return -Infinity;

        const rect = element.getBoundingClientRect?.();
        if (!rect || rect.width < 220 || rect.height < 35 || rect.height > 170) {
            return -Infinity;
        }
        if (gridRect?.width && rect.width < gridRect.width * 0.62) {
            return -Infinity;
        }
        if (gridRect?.top && rect.bottom > gridRect.top + 24) {
            return -Infinity;
        }

        const text = normalizeText(element.textContent);
        let score = evidence * 10;
        const widthRatio = gridRect?.width ? rect.width / gridRect.width : 1;
        score += Math.max(0, 22 - Math.abs(1 - widthRatio) * 35);
        score += Math.max(0, 20 - Math.max(0, (gridRect?.top || rect.bottom) - rect.bottom) / 8);
        if (rect.height >= 50 && rect.height <= 125) score += 12;
        if (/^(div|li|section|article)$/i.test(element.tagName)) score += 4;
        if (element.children.length >= 3) score += 8;
        if (text.length <= 150) score += 5;
        return score;
    }

    function searchRootForActionRow(root, firstTile, gridRect) {
        if (!(root instanceof Element)) return [];
        const candidates = [];
        const all = [root, ...Array.from(root.querySelectorAll('*'))];

        for (const element of all) {
            const score = copyRowScore(element, firstTile, gridRect);
            if (Number.isFinite(score)) {
                candidates.push({ element, score });
            }
        }
        return candidates;
    }

    function findCopyActionRowNear(container, firstTile) {
        if (!(container instanceof Element) || !(firstTile instanceof Element)) {
            return null;
        }

        const gridRect = container.getBoundingClientRect?.();
        const roots = [];
        let cursor = container;
        for (let depth = 0; depth < 5 && cursor instanceof Element; depth += 1) {
            if (!roots.includes(cursor)) roots.push(cursor);
            cursor = cursor.parentElement;
            if (cursor === document.body || cursor === document.documentElement) {
                if (cursor && !roots.includes(cursor)) roots.push(cursor);
                break;
            }
        }

        const candidates = [];
        for (const root of roots) {
            candidates.push(...searchRootForActionRow(root, firstTile, gridRect));
            if (candidates.length) break;
        }

        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0]?.element || null;
        if (!best) return null;

        let row = best;
        let parent = row.parentElement;
        while (
            parent &&
            parent !== document.body &&
            parent !== document.documentElement &&
            !parent.contains(firstTile)
        ) {
            const parentScore = copyRowScore(parent, firstTile, gridRect);
            const rowRect = row.getBoundingClientRect?.();
            const parentRect = parent.getBoundingClientRect?.();
            const sameVisualRow = rowRect && parentRect &&
                Math.abs(parentRect.width - rowRect.width) <= 18 &&
                Math.abs(parentRect.height - rowRect.height) <= 18;

            if (!Number.isFinite(parentScore) || !sameVisualRow) break;
            row = parent;
            parent = parent.parentElement;
        }

        return row;
    }

    function firstVisualTile(elements) {
        return [...elements].sort((a, b) => {
            if (a === b) return 0;
            const ar = a.getBoundingClientRect?.();
            const br = b.getBoundingClientRect?.();
            if (ar && br && Math.abs(ar.top - br.top) > 2) return ar.top - br.top;
            if (ar && br && Math.abs(ar.left - br.left) > 2) return ar.left - br.left;
            return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        })[0] || null;
    }

    function horizontalOverlap(a, b) {
        if (!a || !b) return 0;
        const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        return overlap / Math.max(1, Math.min(a.width, b.width));
    }

    function findBootleggingCardHeading(firstTile) {
        if (!(firstTile instanceof Element)) return null;
        const tileRect = firstTile.getBoundingClientRect?.();
        if (!tileRect) return null;

        const candidates = [];
        const labels = document.querySelectorAll('h1, h2, h3, h4, strong, span, div, [aria-label]');
        for (const element of labels) {
            const text = normalizeText(element.getAttribute?.('aria-label') || element.textContent);
            if (!/^bootlegging$/i.test(text)) continue;
            const rect = element.getBoundingClientRect?.();
            if (!rect || rect.width < 45 || rect.height < 10) continue;
            if (rect.bottom > tileRect.top + 8) continue;
            const overlap = horizontalOverlap(rect, tileRect);
            if (overlap < 0.2) continue;
            const distance = Math.max(0, tileRect.top - rect.bottom);
            if (distance > 900) continue;

            let score = 1_000 - distance;
            if (/title|header|crime/i.test(String(element.className || ''))) score += 80;
            if (/^(h1|h2|h3|h4|strong)$/i.test(element.tagName)) score += 35;
            score += overlap * 100;
            candidates.push({ element, score });
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.element || null;
    }

    function isUsableDockRoot(element, tileElements) {
        if (!(element instanceof Element)) return false;
        if (element === document.body || element === document.documentElement) return false;
        if (!tileElements.every(tile => element.contains(tile))) return false;

        const rect = element.getBoundingClientRect?.();
        const tileRects = tileElements.map(tile => tile.getBoundingClientRect?.()).filter(Boolean);
        if (!rect || rect.width < 260 || rect.height < 260 || !tileRects.length) return false;

        const minLeft = Math.min(...tileRects.map(r => r.left));
        const maxRight = Math.max(...tileRects.map(r => r.right));
        const tileWidth = Math.max(1, maxRight - minLeft);
        if (rect.width < tileWidth * 0.9 || rect.width > Math.max(tileWidth * 1.45, 820)) return false;
        return true;
    }

    function detachedDockAnchor(tiles) {
        const tileElements = tiles.map(tile => tile.button).filter(Boolean);
        if (tileElements.length !== GENRE_ORDER.length) return null;

        const firstTile = firstVisualTile(tileElements);
        const heading = findBootleggingCardHeading(firstTile);
        const sell = findSellControl();
        const common = commonAncestor(tileElements);
        const copy = findCopyActionRowNear(common || firstTile?.parentElement, firstTile);

        // The smallest ancestor containing the whole Torn crime card is the only
        // safe mount target. The advisor is inserted before this element, never
        // between Torn's internal grid/flex children.
        const required = [heading, copy, sell, ...tileElements].filter(Boolean);
        let root = commonAncestor(required) || common;

        if (!isUsableDockRoot(root, tileElements)) {
            let cursor = common;
            let fallback = null;
            for (let depth = 0; depth < 9 && cursor instanceof Element; depth += 1) {
                if (isUsableDockRoot(cursor, tileElements)) {
                    const hasHeading = !heading || cursor.contains(heading);
                    const hasSell = !sell || cursor.contains(sell);
                    const hasCopy = !copy || cursor.contains(copy);
                    if (hasHeading && hasSell && hasCopy) {
                        fallback = cursor;
                        break;
                    }
                }
                cursor = cursor.parentElement;
            }
            root = fallback;
        }

        if (!(root instanceof Element) || !root.parentElement) return null;
        if (root.parentElement === document.documentElement) return null;
        return root;
    }

    function dockPlacementIsSafe(host, anchor) {
        if (!(host instanceof Element) || !(anchor instanceof Element)) return false;
        const hostRect = host.getBoundingClientRect?.();
        const anchorRect = anchor.getBoundingClientRect?.();
        if (!hostRect || !anchorRect || hostRect.height < 40) return false;

        const overlapsVertically = hostRect.bottom > anchorRect.top + 3 &&
            anchorRect.bottom > hostRect.top + 3;
        const overlapsHorizontally = horizontalOverlap(hostRect, anchorRect) > 0.12;
        return !(overlapsVertically && overlapsHorizontally);
    }

    function placeDetachedDock(host, initialAnchor) {
        if (!(host instanceof Element) || !(initialAnchor instanceof Element)) return null;

        let anchor = initialAnchor;
        for (let depth = 0; depth < 7 && anchor instanceof Element; depth += 1) {
            const parent = anchor.parentElement;
            if (!parent || anchor === document.body || anchor === document.documentElement) break;
            if (parent === document.documentElement) break;

            state.suppressObserverUntil = performance.now() + 180;
            parent.insertBefore(host, anchor);
            host.dataset.ksbaMount = depth === 0 ? 'detached-safe-dock' : `detached-safe-dock-level-${depth}`;

            // Force one synchronous layout read. If Torn's parent uses absolute,
            // named-grid or fixed-height placement, move the dock one complete
            // container outward and test again instead of covering game controls.
            if (dockPlacementIsSafe(host, anchor)) return anchor;
            anchor = parent;
        }

        host.remove();
        return null;
    }

    function shadowRootFor(host) {
        if (!host) return null;
        return host.shadowRoot || host.attachShadow?.({ mode: 'open' }) || host;
    }

    function mainCss() {
        return `
            :host {
                all: initial;
                display: block;
                width: 100%;
                box-sizing: border-box;
                font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
                color-scheme: dark;
                --ks-bg: #0e1319;
                --ks-surface: #151c24;
                --ks-surface-2: #1d2732;
                --ks-border: #334252;
                --ks-text: #f4f7fb;
                --ks-muted: #98a7b7;
                --ks-silver: #c8d1dc;
                --ks-blue: #3d9cff;
                --ks-blue-2: #80c6ff;
                --ks-green: #38d179;
                --ks-amber: #f0b54a;
                --ks-red: #ff6575;
                --ks-accent: var(--ks-blue);
            }
            *, *::before, *::after { box-sizing: border-box; }
            button { font: inherit; }
            .card {
                position: relative;
                width: 100%;
                margin: 0;
                overflow: hidden;
                border: 1px solid rgba(145,166,188,.28);
                border-radius: 13px;
                background:
                    radial-gradient(120% 130% at 100% 0%, color-mix(in srgb, var(--ks-accent) 13%, transparent), transparent 58%),
                    linear-gradient(150deg, #17202a 0%, #111820 52%, #0d1218 100%);
                box-shadow: 0 10px 26px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.05);
                color: var(--ks-text);
            }
            .card::before {
                content: "";
                position: absolute;
                inset: 0 auto 0 0;
                width: 3px;
                background: var(--ks-accent);
                box-shadow: 0 0 18px color-mix(in srgb, var(--ks-accent) 65%, transparent);
            }
            .card[data-mode="sell"] { --ks-accent: var(--ks-green); }
            .card[data-mode="wait"] { --ks-accent: var(--ks-amber); }
            .card[data-mode="none"] { --ks-accent: var(--ks-red); }
            .top {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 7px 10px 5px 11px;
                border-bottom: 1px solid rgba(255,255,255,.055);
            }
            .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
            .mark {
                display: grid;
                place-items: center;
                width: 26px;
                height: 26px;
                flex: 0 0 auto;
                border: 1px solid color-mix(in srgb, var(--ks-accent) 58%, #fff 10%);
                border-radius: 8px;
                background: linear-gradient(145deg, color-mix(in srgb, var(--ks-accent) 24%, #17212b), #111820);
                color: #fff;
                font-size: 10px;
                font-weight: 950;
                letter-spacing: .5px;
                box-shadow: inset 0 1px 0 rgba(255,255,255,.12);
            }
            .title { min-width: 0; }
            .title strong {
                display: block;
                overflow: hidden;
                color: var(--ks-text);
                font-size: 11px;
                font-weight: 900;
                line-height: 1.15;
                letter-spacing: .7px;
                white-space: nowrap;
                text-overflow: ellipsis;
            }
            .title span {
                display: block;
                margin-top: 2px;
                color: var(--ks-muted);
                font-size: 8px;
                font-weight: 650;
                letter-spacing: .35px;
            }
            .live {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                flex: 0 0 auto;
                padding: 4px 6px;
                border: 1px solid color-mix(in srgb, var(--ks-accent) 38%, transparent);
                border-radius: 999px;
                background: color-mix(in srgb, var(--ks-accent) 10%, transparent);
                color: color-mix(in srgb, var(--ks-accent) 78%, #fff);
                font-size: 8px;
                font-weight: 900;
                letter-spacing: .6px;
            }
            .live i { width: 6px; height: 5px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
            .hero {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 8px;
                align-items: center;
                padding: 7px 10px 6px 11px;
            }
            .eyebrow { color: var(--ks-muted); font-size: 8px; font-weight: 850; letter-spacing: .7px; text-transform: uppercase; }
            .command {
                margin-top: 1px;
                overflow: hidden;
                color: color-mix(in srgb, var(--ks-accent) 78%, #fff);
                font-size: clamp(15px, 4.3vw, 19px);
                font-weight: 950;
                line-height: 1.08;
                letter-spacing: -.2px;
                white-space: nowrap;
                text-overflow: ellipsis;
            }
            .summary { margin-top: 4px; color: var(--ks-silver); font-size: 10px; font-weight: 650; line-height: 1.25; }
            .details {
                min-width: 68px;
                min-height: 36px;
                padding: 0 10px;
                border: 1px solid rgba(151,177,202,.32);
                border-radius: 10px;
                background: rgba(255,255,255,.045);
                color: #eef4fb;
                font-size: 9px;
                font-weight: 900;
                letter-spacing: .45px;
                cursor: pointer;
                -webkit-tap-highlight-color: transparent;
            }
            .details:active { transform: translateY(1px); background: rgba(255,255,255,.075); }
            .meter-wrap { padding: 0 11px 7px 13px; }
            .meter-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
            .meter-label { color: var(--ks-muted); font-size: 8px; font-weight: 800; letter-spacing: .55px; }
            .meter-value { color: var(--ks-text); font-size: 10px; font-weight: 900; }
            .meter { height: 6px; overflow: hidden; border: 1px solid rgba(255,255,255,.06); border-radius: 999px; background: #090d12; }
            .meter i { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, color-mix(in srgb, var(--ks-accent) 72%, #27435e), var(--ks-accent)); box-shadow: 0 0 10px color-mix(in srgb, var(--ks-accent) 45%, transparent); transition: width .22s ease; }
            .bottom {
                display: flex;
                align-items: center;
                justify-content: flex-start;
                gap: 10px;
                min-height: 26px;
                padding: 5px 11px 6px 13px;
                border-top: 1px solid rgba(255,255,255,.045);
                background: rgba(0,0,0,.12);
            }
            .preview {
                min-width: 0;
                overflow: hidden;
                color: var(--ks-silver);
                font-size: 9px;
                font-weight: 650;
                white-space: nowrap;
                text-overflow: ellipsis;
            }
            @media (max-width: 350px) {
                .top { padding-right: 9px; }
                .hero { padding-right: 9px; gap: 7px; }
                .details { min-width: 58px; padding: 0 7px; }
                .title span { display: none; }
            }
            @media (prefers-reduced-motion: reduce) {
                *, *::before, *::after { transition: none !important; animation: none !important; }
            }
        `;
    }

    function portalCss() {
        return `
            :host {
                all: initial;
                position: fixed;
                inset: 0;
                z-index: 2147483000;
                pointer-events: none;
                font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
                color-scheme: dark;
                --ks-bg: #0e1319;
                --ks-surface: #151c24;
                --ks-surface-2: #1d2732;
                --ks-border: #334252;
                --ks-text: #f4f7fb;
                --ks-muted: #98a7b7;
                --ks-silver: #c8d1dc;
                --ks-blue: #3d9cff;
                --ks-green: #38d179;
                --ks-amber: #f0b54a;
                --ks-red: #ff6575;
                --ks-accent: var(--ks-blue);
            }
            *, *::before, *::after { box-sizing: border-box; }
            button { font: inherit; }
            .backdrop {
                position: fixed;
                inset: 0;
                display: flex;
                align-items: flex-end;
                justify-content: center;
                padding: 8px 6px max(8px, env(safe-area-inset-bottom));
                background: rgba(1,4,8,.88);
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
                transition: none;
            }
            .backdrop[data-open="true"] { opacity: 1; visibility: visible; pointer-events: auto; }
            .sheet {
                width: min(100%, 620px);
                max-height: min(92dvh, 820px);
                overflow: hidden;
                display: flex;
                flex-direction: column;
                border: 1px solid rgba(151,177,202,.30);
                border-radius: 16px 16px 13px 13px;
                background: linear-gradient(160deg, #17212b, #10171f 56%, #0c1117);
                color: var(--ks-text);
                box-shadow: 0 20px 60px rgba(0,0,0,.62), inset 0 1px 0 rgba(255,255,255,.06);
                transform: none;
                transition: none;
                contain: layout paint style;
                backface-visibility: hidden;
            }
            .backdrop[data-open="true"] .sheet { transform: none; }
            .grab { width: 42px; height: 4px; flex: 0 0 auto; margin: 6px auto 0; border-radius: 999px; background: #506070; opacity: .65; }
            .sheet-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 7px 10px 8px;
                border-bottom: 1px solid rgba(255,255,255,.065);
            }
            .sheet-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
            .sheet-mark { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid rgba(61,156,255,.45); border-radius: 9px; background: linear-gradient(145deg, rgba(61,156,255,.20), #111820); font-size: 11px; font-weight: 950; letter-spacing: .5px; }
            .sheet-title strong { display:block; font-size: 12px; font-weight: 900; letter-spacing: .55px; }
            .sheet-title span { display:block; margin-top:2px; color:var(--ks-muted); font-size:9px; font-weight:650; }
            .icon-btn { display:grid; place-items:center; width:36px; height:36px; flex:0 0 auto; border:1px solid rgba(151,177,202,.28); border-radius:10px; background:rgba(255,255,255,.045); color:#f5f8fb; font-size:19px; line-height:1; cursor:pointer; }
            .status-card { margin: 8px 8px 0; padding: 8px 9px; border: 1px solid rgba(151,177,202,.21); border-left: 3px solid var(--ks-accent); border-radius: 12px; background: rgba(255,255,255,.035); }
            .status-card[data-mode="sell"] { --ks-accent: var(--ks-green); }
            .status-card[data-mode="wait"] { --ks-accent: var(--ks-amber); }
            .status-card[data-mode="none"] { --ks-accent: var(--ks-red); }
            .status-top { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
            .status-label { color:var(--ks-muted); font-size:8px; font-weight:850; letter-spacing:.65px; text-transform:uppercase; }
            .status-command { margin-top:2px; color:color-mix(in srgb, var(--ks-accent) 78%, #fff); font-size:17px; font-weight:950; line-height:1.12; }
            .status-summary { margin-top:4px; color:var(--ks-silver); font-size:10px; font-weight:600; line-height:1.35; }
            .readiness { flex:0 0 auto; min-width:62px; text-align:right; }
            .readiness strong { display:block; font-size:19px; font-weight:950; }
            .readiness span { display:block; color:var(--ks-muted); font-size:8px; font-weight:800; letter-spacing:.35px; }
            .toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 8px 6px; }
            .priority-order { display:flex; align-items:center; min-height:34px; padding:0 4px; color:#8fc9ff; font-size:8px; font-weight:900; letter-spacing:.55px; }
            .priority-order::before { content:'↓'; margin-right:6px; color:var(--ks-blue); font-size:11px; }
            .tool-actions { display:flex; flex:0 0 auto; gap:6px; }
            .small-btn { min-height:34px; padding:0 9px; border:1px solid rgba(151,177,202,.25); border-radius:10px; background:rgba(255,255,255,.04); color:#eef4fb; font-size:9px; font-weight:850; cursor:pointer; }
            .content { overflow:auto; overscroll-behavior:contain; touch-action:pan-y; padding:0 8px 8px; scrollbar-width:thin; contain:layout paint; }
            .list { display:grid; gap:6px; }
            .genre-card { position:relative; overflow:hidden; padding:8px 9px 7px; border:1px solid rgba(151,177,202,.18); border-radius:12px; background:rgba(255,255,255,.028); }
            .genre-card[data-selected="true"] { border-color:rgba(61,156,255,.52); background:linear-gradient(110deg, rgba(61,156,255,.12), rgba(255,255,255,.025)); box-shadow:inset 3px 0 0 var(--ks-blue); }
            .genre-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .genre-name { display:flex; align-items:center; gap:7px; min-width:0; }
            .rank { color:#647487; font-size:9px; font-weight:900; font-variant-numeric:tabular-nums; }
            .genre-name strong { color:var(--ks-text); font-size:12px; font-weight:900; }
            .chip { flex:0 0 auto; padding:3px 6px; border:1px solid rgba(151,177,202,.22); border-radius:999px; background:rgba(255,255,255,.035); color:var(--ks-muted); font-size:8px; font-weight:900; letter-spacing:.35px; }
            .chip[data-kind="now"] { border-color:rgba(61,156,255,.42); background:rgba(61,156,255,.10); color:#86c9ff; }
            .chip[data-kind="over"] { border-color:rgba(240,181,74,.38); background:rgba(240,181,74,.08); color:#f4c765; }
            .genre-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:4px; margin-top:6px; }
            .metric { min-width:0; }
            .metric span { display:block; color:var(--ks-muted); font-size:6.5px; font-weight:800; letter-spacing:.35px; text-transform:uppercase; }
            .metric strong { display:block; margin-top:1px; overflow:hidden; color:var(--ks-silver); font-size:10px; font-weight:850; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric:tabular-nums; }
            .genre-bar-head { display:flex; justify-content:space-between; gap:8px; margin-top:6px; color:var(--ks-muted); font-size:8px; font-weight:750; }
            .genre-bar { height:5px; overflow:hidden; margin-top:3px; border-radius:999px; background:#080c11; }
            .genre-bar i { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,#2a6fab,var(--ks-blue)); }
            .advisories { display:grid; gap:6px; margin-top:7px; }
            .advisory { padding:8px 9px; border:1px solid rgba(240,181,74,.22); border-radius:10px; background:rgba(240,181,74,.055); color:#e7c879; font-size:9px; font-weight:650; line-height:1.35; }
            .data-card { margin-top:7px; padding:8px 9px; border:1px solid rgba(151,177,202,.18); border-radius:11px; background:rgba(255,255,255,.025); }
            .data-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .data-head strong { font-size:9px; font-weight:900; letter-spacing:.45px; }
            .data-state { display:flex; align-items:center; gap:5px; color:var(--ks-muted); font-size:8px; font-weight:850; }
            .data-state i { width:6px; height:6px; border-radius:50%; background:var(--ks-green); box-shadow:0 0 7px rgba(56,209,121,.48); }
            .data-copy { margin-top:5px; color:var(--ks-muted); font-size:9px; line-height:1.35; }
            .setting { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,.055); color:var(--ks-silver); font-size:9px; font-weight:700; }
            .diagnostic-row { display:flex; justify-content:flex-start; margin-top:7px; }
            .diagnostic { min-height:30px; padding:0; border:0; background:transparent; color:#86c9ff; font-size:8px; font-weight:850; letter-spacing:.25px; cursor:pointer; text-decoration:underline; text-decoration-color:rgba(134,201,255,.35); text-underline-offset:3px; }
            .switch { position:relative; width:40px; height:23px; flex:0 0 auto; padding:0; border:1px solid rgba(151,177,202,.28); border-radius:999px; background:#202a35; cursor:pointer; }
            .switch i { position:absolute; top:3px; left:3px; width:15px; height:15px; border-radius:50%; background:#798898; transition:none; }
            .switch[data-on="true"] { border-color:rgba(61,156,255,.48); background:rgba(61,156,255,.16); }
            .switch[data-on="true"] i { transform:translateX(17px); background:var(--ks-blue); box-shadow:0 0 8px rgba(61,156,255,.5); }
            .footer { display:flex; justify-content:flex-end; padding:8px 8px 9px; border-top:1px solid rgba(255,255,255,.065); background:rgba(0,0,0,.12); }
            .footer button { min-height:40px; border-radius:11px; font-size:9px; font-weight:900; cursor:pointer; }
            .done { flex:1 1 auto; border:1px solid rgba(61,156,255,.38); background:rgba(61,156,255,.14); color:#a9d8ff; }
            .toast { position:fixed; left:50%; bottom:max(18px,env(safe-area-inset-bottom)); max-width:min(calc(100vw - 24px),420px); padding:9px 12px; border:1px solid rgba(151,177,202,.28); border-radius:10px; background:#151d26; color:#f3f7fb; box-shadow:0 10px 28px rgba(0,0,0,.46); font-size:10px; font-weight:750; line-height:1.3; opacity:0; visibility:hidden; transform:translate(-50%,0); transition:none; pointer-events:none; }
            .toast[data-show="true"] { opacity:1; visibility:visible; transform:translate(-50%,0); }
            @media (max-width:350px) {
                .sheet-title span { display:none; }
                .toolbar { gap:6px; }
                .priority-order { padding:0 8px; font-size:8px; }
                .small-btn { padding:0 7px; font-size:8px; }
                .genre-card { padding-left:8px; padding-right:8px; }
                .metric span { font-size:6px; }
            }
            @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition:none !important; animation:none !important; } }
        `;
    }

    function buildMainInterface(root) {
        state.renderSignatures.main = '';
        root.innerHTML = `
            <style>${mainCss()}</style>
            <section class="card" data-mode="none" aria-label="Kingshade Bootlegging Advisor">
                <div class="top">
                    <div class="brand"><span class="mark">KS</span><div class="title"><strong>BOOTLEGGING ADVISOR</strong><span>Kingshade Suite</span></div></div>
                    <div class="live"><i></i><span>LIVE</span></div>
                </div>
                <div class="hero">
                    <div><div class="eyebrow">STATUS</div><div class="command">LOADING</div><div class="summary">Reading Bootlegging data.</div></div>
                    <button type="button" class="details" aria-label="Open Bootlegging details">DETAILS</button>
                </div>
                <div class="meter-wrap"><div class="meter-head"><span class="meter-label">BALANCE COVERAGE</span><span class="meter-value">—</span></div><div class="meter"><i></i></div></div>
                <div class="bottom"><div class="preview">Waiting for all eight genres.</div></div>
            </section>
        `;
        root.querySelector('.details')?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openDetails();
        });
    }

    function buildPortalInterface(root) {
        state.renderSignatures.details = '';
        root.innerHTML = `
            <style>${portalCss()}</style>
            <div class="backdrop" data-open="false" aria-hidden="true">
                <section class="sheet" role="dialog" aria-modal="true" aria-label="Bootlegging Advisor details">
                    <div class="grab"></div>
                    <header class="sheet-head"><div class="sheet-brand"><span class="sheet-mark">KS</span><div class="sheet-title"><strong>BOOTLEGGING ADVISOR</strong><span>Kingshade Suite · Priority & queue</span></div></div><button type="button" class="icon-btn close" aria-label="Close details">×</button></header>
                    <div class="status-card" data-mode="none"><div class="status-top"><div><div class="status-label">STATUS</div><div class="status-command">LOADING</div><div class="status-summary">Reading Bootlegging data.</div></div><div class="readiness"><strong>—</strong><span>COVERAGE</span></div></div></div>
                    <div class="toolbar"><div class="priority-order" aria-label="Genres are always sorted by priority">PRIORITY ORDER</div><div class="tool-actions"><button type="button" class="small-btn refresh">REFRESH</button></div></div>
                    <div class="content"><div class="list"></div><div class="advisories"></div><div class="data-card"><div class="data-head"><strong>DATA STATUS</strong><span class="data-state"><i></i><span>WAITING</span></span></div><div class="data-copy">Waiting for all eight genres to load and stabilize.</div><div class="setting"><span>Highlight recommended Torn tile</span><button type="button" class="switch highlight" data-on="true" role="switch" aria-checked="true"><i></i></button></div><div class="diagnostic-row"><button type="button" class="diagnostic">COPY SAFE DIAGNOSTIC</button></div></div></div>
                    <footer class="footer"><button type="button" class="done">DONE</button></footer>
                </section>
            </div>
            <div class="toast" role="status" aria-live="polite"></div>
        `;

        const backdrop = root.querySelector('.backdrop');
        const close = () => closeDetails();
        root.querySelector('.close')?.addEventListener('click', close);
        root.querySelector('.done')?.addEventListener('click', close);
        backdrop?.addEventListener('click', event => { if (event.target === backdrop) close(); });
        root.querySelector('.refresh')?.addEventListener('click', () => {
            scheduleRender(0);
            showToast('Bootlegging data refreshed.');
        });
        root.querySelector('.highlight')?.addEventListener('click', event => {
            const button = event.currentTarget;
            const next = button.dataset.on !== 'true';
            setPreference('highlightTiles', next);
            button.dataset.on = String(next);
            button.setAttribute('aria-checked', String(next));
            scheduleRender(0);
            showToast(next ? 'Tile highlight enabled.' : 'Tile highlight disabled.');
        });
        root.querySelector('.diagnostic')?.addEventListener('click', copyDiagnostic);
    }

    function ensureInterface(tiles) {
        const anchor = detachedDockAnchor(tiles);
        if (!anchor?.parentElement) {
            document.getElementById(SCRIPT.mainHostId)?.remove();
            state.ui.mainHost = null;
            state.ui.mainRoot = null;
            return null;
        }

        let mainHost = document.getElementById(SCRIPT.mainHostId);
        if (!mainHost) {
            mainHost = document.createElement('div');
            mainHost.id = SCRIPT.mainHostId;
            mainHost.style.cssText = 'display:block;width:100%;box-sizing:border-box;position:relative;z-index:1;clear:both;isolation:isolate;contain:layout style;margin:0 0 10px 0;';
            const root = shadowRootFor(mainHost);
            buildMainInterface(root);
            state.ui.mainHost = mainHost;
            state.ui.mainRoot = root;
        } else {
            state.ui.mainHost = mainHost;
            state.ui.mainRoot = shadowRootFor(mainHost);
        }

        if (!placeDetachedDock(mainHost, anchor)) {
            mainHost.remove();
            state.ui.mainHost = null;
            state.ui.mainRoot = null;
            return null;
        }

        let portalHost = document.getElementById(SCRIPT.portalHostId);
        if (!portalHost) {
            portalHost = document.createElement('div');
            portalHost.id = SCRIPT.portalHostId;
            portalHost.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
            const root = shadowRootFor(portalHost);
            buildPortalInterface(root);
            document.body?.appendChild(portalHost);
            state.ui.portalHost = portalHost;
            state.ui.portalRoot = root;
        } else {
            state.ui.portalHost = portalHost;
            state.ui.portalRoot = shadowRootFor(portalHost);
        }

        const highlightOn = state.preferences.highlightTiles;
        const highlight = state.ui.portalRoot?.querySelector('.highlight');
        if (highlight) {
            highlight.dataset.on = String(highlightOn);
            highlight.setAttribute('aria-checked', String(highlightOn));
        }
        return state.ui;
    }

    function dataStatusView(confidence) {
        if (confidence === 'dom') {
            return {
                label: 'READY',
                copy: 'All eight genres are loaded and stable.',
                kind: 'good'
            };
        }
        return {
            label: 'WAITING',
            copy: 'Waiting for all eight genres to load and stabilize.',
            kind: 'bad'
        };
    }

    function decisionCoverage(decision) {
        return Math.max(0, Math.min(100, Math.round((decision?.coverage || 0) * 100)));
    }

    function previewText(rows, decision) {
        if (!rows?.length) return 'Waiting for all eight genres.';
        const ordered = priorityRows(rows);
        if (decision.mode === 'copy') {
            const next = ordered.filter(row => row.projected < row.target).slice(1, 3);
            return next.length ? `Next: ${next.map(row => `${row.genre} ${Math.round(row.completion * 100)}%`).join(' · Then: ')}` : 'Current queue will cover the remaining targets.';
        }
        if (decision.mode === 'sell') return 'All genres are above the refill threshold.';
        if (decision.mode === 'wait') return `Queue bottleneck: ${ordered[0].genre} ${Math.round(ordered[0].completion * 100)}%`;
        return 'Recommendation paused until data stabilizes.';
    }

    function modeMeterLabel(mode) {
        if (mode === 'copy') return 'REFILL PROGRESS';
        if (mode === 'sell') return 'LOWEST COVERAGE';
        if (mode === 'wait') return 'QUEUE COVERAGE';
        return 'DATA STATUS';
    }

    function compactRowsSignature(rows) {
        return Array.isArray(rows)
            ? rows.map(row => [row.genre, row.owned, row.queued, row.projected, row.target, Math.round(row.completion * 1000)].join(':')).join('|')
            : 'none';
    }

    function renderMain(root, rows, decision, confidence, source) {
        if (!root) return;
        const signature = [
            decision?.mode, decision?.headline, decision?.command, decision?.summary, decisionCoverage(decision),
            previewText(rows, decision), confidence, source
        ].join('¦');
        if (state.renderSignatures.main === signature) return;
        state.renderSignatures.main = signature;

        const card = root.querySelector('.card');
        const coverage = decisionCoverage(decision);
        card.dataset.mode = decision.mode;
        root.querySelector('.eyebrow').textContent = decision.headline || 'STATUS';
        root.querySelector('.command').textContent = decision.command || 'DATA CHECK';
        root.querySelector('.summary').textContent = decision.summary || 'Waiting for reliable Bootlegging data.';
        root.querySelector('.meter-label').textContent = modeMeterLabel(decision.mode);
        root.querySelector('.meter-value').textContent = decision.mode === 'none' ? '—' : `${coverage}%`;
        root.querySelector('.meter i').style.width = decision.mode === 'none' ? '0%' : `${coverage}%`;
        root.querySelector('.preview').textContent = previewText(rows, decision);
        const live = root.querySelector('.live span');
        if (live) live.textContent = confidence === 'mismatch' ? 'CHECK' : confidence === 'none' ? 'WAIT' : 'LIVE';
    }

    function priorityRankMap(rows) {
        return new Map(priorityRows(rows).map((row, index) => [row.genre, index + 1]));
    }

    function rowChip(row, decision, priorityRank) {
        if (decision.mode === 'copy' && row.genre === decision.genre) return { label: 'NOW', kind: 'now' };
        if (row.completion >= CONFIG.oversupplyWarningAt) return { label: 'OVER TARGET', kind: 'over' };
        if (priorityRank === 2 && decision.mode === 'copy') return { label: 'NEXT', kind: 'next' };
        if (row.projected >= row.target) return { label: 'COVERED', kind: 'covered' };
        return { label: `${Math.round(row.completion * 100)}%`, kind: 'normal' };
    }

    function renderDetails(root, rows, decision, confidence, source, warnings) {
        if (!root) return;
        const signature = [
            compactRowsSignature(rows), decision?.mode, decision?.genre, decision?.headline, decision?.command,
            decision?.summary, decisionCoverage(decision), confidence, source,
            state.preferences.highlightTiles, ...(warnings || [])
        ].join('¦');
        if (state.renderSignatures.details === signature) return;
        state.renderSignatures.details = signature;

        const content = root.querySelector('.content');
        const previousScrollTop = content?.scrollTop || 0;
        const status = root.querySelector('.status-card');
        status.dataset.mode = decision.mode;
        root.querySelector('.status-label').textContent = decision.headline || 'STATUS';
        root.querySelector('.status-command').textContent = decision.command || 'DATA CHECK';
        root.querySelector('.status-summary').textContent = decision.summary || 'Waiting for reliable Bootlegging data.';
        root.querySelector('.readiness strong').textContent = decision.mode === 'none' ? '—' : `${decisionCoverage(decision)}%`;

        const ordered = rows?.length ? priorityRows(rows) : [];
        const ranks = priorityRankMap(rows || []);
        const list = root.querySelector('.list');
        list.innerHTML = ordered.map(row => {
            const priorityRank = ranks.get(row.genre) || 0;
            const chip = rowChip(row, decision, priorityRank);
            const fill = Math.max(0, Math.min(100, Math.round(row.completion * 100)));
            const missing = Math.max(0, row.target - row.projected);
            return `
                <article class="genre-card" data-selected="${String(decision.genre === row.genre)}">
                    <div class="genre-top"><div class="genre-name"><span class="rank">P${priorityRank}</span><strong>${row.genre}</strong></div><span class="chip" data-kind="${chip.kind}">${chip.label}</span></div>
                    <div class="genre-metrics"><div class="metric"><span>Stock</span><strong>${row.owned}</strong></div><div class="metric"><span>Queued</span><strong>${row.queued}</strong></div><div class="metric"><span>Projected</span><strong>${row.projected}</strong></div><div class="metric"><span>Target</span><strong>${row.target}</strong></div></div>
                    <div class="genre-bar-head"><span>${missing ? `${missing} missing` : 'Target covered'}</span><span>${Math.round(row.completion * 100)}%</span></div><div class="genre-bar"><i style="width:${fill}%"></i></div>
                </article>`;
        }).join('');

        const advisories = [];
        if (warnings?.length) advisories.push(warnings.join('; '));
        for (const row of ordered.filter(row => row.completion >= CONFIG.oversupplyWarningAt)) {
            advisories.push(`${row.genre} is ${Math.round((row.completion - 1) * 100)}% above target. Avoid adding more unless you deliberately changed the balance.`);
        }
        root.querySelector('.advisories').innerHTML = advisories.map(text => `<div class="advisory">${text}</div>`).join('');

        const view = dataStatusView(confidence);
        root.querySelector('.data-state span').textContent = view.label;
        root.querySelector('.data-copy').textContent = view.copy;
        const dot = root.querySelector('.data-state i');
        dot.style.background = view.kind === 'good' ? 'var(--ks-green)' : view.kind === 'warn' ? 'var(--ks-amber)' : 'var(--ks-red)';
        if (content) content.scrollTop = Math.min(previousScrollTop, Math.max(0, content.scrollHeight - content.clientHeight));
    }

    function renderInterface(rows, decision, source, confidence, warnings) {
        renderMain(state.ui.mainRoot, rows, decision, confidence, source);
        renderDetails(state.ui.portalRoot, rows, decision, confidence, source, warnings);
    }

    function renderLastInterface() {
        const snapshot = state.lastSnapshot;
        if (!snapshot) return;
        renderInterface(snapshot.rows, snapshot.decision, snapshot.source, snapshot.confidence, snapshot.warnings);
    }

    function finalActionRowScore(candidate, label, depth) {
        if (!(candidate instanceof Element) || !(label instanceof Element) || !candidate.contains(label)) return -Infinity;
        const text = normalizeText(candidate.textContent);
        const rect = candidate.getBoundingClientRect?.();
        const labelRect = label.getBoundingClientRect?.();
        const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0, 320);
        if (!/set\s+up\s+online\s+store/i.test(text) || /sell\s+counterfeit\s+dvds/i.test(text)) return -Infinity;
        if (countGenresInElement(candidate) > 0) return -Infinity;
        if (!rect || rect.width < 180 || rect.width > viewportWidth + 32 || rect.height < 32 || rect.height > 150) return -Infinity;
        if (labelRect && (labelRect.top < rect.top - 2 || labelRect.bottom > rect.bottom + 2)) return -Infinity;

        let score = Math.min(42, rect.width / Math.max(1, viewportWidth) * 42);
        score += Math.max(0, 18 - Math.abs(rect.height - 64) / 3);
        score += Math.min(depth, 5) * 2;
        if (candidate !== label) score += 10;
        if (candidate.children.length >= 2) score += 10;
        if (candidate.querySelector('button, [role="button"], input, [class*="commit"], [class*="cost"]')) score += 12;
        if (candidate.matches('span, p, strong, h3, h4')) score -= 24;
        if (/^set\s+up\s+online\s+store$/i.test(text)) score -= 12;
        if (rect.width >= viewportWidth * 0.72) score += 12;
        return score;
    }

    function findFinalActionRow() {
        const labels = Array.from(document.querySelectorAll('span, div, p, strong, h3, h4, button, [role="button"]'))
            .filter(element => /^set\s+up\s+online\s+store$/i.test(normalizeText(
                element.textContent || element.getAttribute?.('aria-label')
            )));
        const candidates = [];
        for (const label of labels) {
            let candidate = label;
            for (let depth = 0; depth < 9 && candidate; depth += 1) {
                const score = finalActionRowScore(candidate, label, depth);
                if (Number.isFinite(score)) candidates.push({ element: candidate, score });
                candidate = candidate.parentElement;
            }
        }
        candidates.sort((a, b) => b.score - a.score ||
            (b.element.getBoundingClientRect?.().width || 0) - (a.element.getBoundingClientRect?.().width || 0));
        return candidates[0]?.element || null;
    }

    function fixedBottomNavigationHeight() {
        const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
        const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
        if (!viewportHeight || !viewportWidth) return 0;

        let height = 0;
        const candidates = document.querySelectorAll(
            'nav, footer, [role="navigation"], [class*="bottom"], [class*="footer"], [class*="menu"], [class*="navbar"], [class*="navigation"]'
        );
        for (const element of Array.from(candidates).slice(0, 450)) {
            if (!(element instanceof Element) || element.closest?.(`#${SCRIPT.mainHostId}, #${SCRIPT.portalHostId}`)) continue;
            const style = getComputedStyle(element);
            if (!/^(fixed|sticky)$/.test(style.position) || style.visibility === 'hidden' || style.display === 'none') continue;
            const rect = element.getBoundingClientRect?.();
            if (!rect || rect.width < viewportWidth * 0.48 || rect.height < 28 || rect.height > 210) continue;
            if (rect.bottom < viewportHeight - 4 || rect.top >= viewportHeight) continue;
            height = Math.max(height, viewportHeight - Math.max(0, rect.top));
        }
        return Math.min(190, Math.max(0, Math.round(height)));
    }

    function pageEndSafeGap() {
        const navigation = fixedBottomNavigationHeight();
        const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
        const fallback = Math.round(viewportHeight * 0.105);
        return Math.max(92, Math.min(168, navigation ? navigation + 14 : fallback));
    }

    function isMeaningfulTrailingNode(node) {
        if (!(node instanceof Element)) return false;
        if (node.id === SCRIPT.mainHostId || node.id === SCRIPT.portalHostId) return true;
        if (normalizeText(node.textContent)) return true;
        if (node.querySelector('button, a, input, select, textarea, img, video, canvas, iframe, svg, [role="button"], [contenteditable="true"]')) return true;
        return false;
    }

    function rememberCollapsedNode(node) {
        if (!(node instanceof Element)) return;
        if (state.pageEnd.collapsedNodes.some(entry => entry.node === node)) return;
        state.pageEnd.collapsedNodes.push({ node, style: node.getAttribute('style') });
    }

    function collapseEmptyTrailingSiblings(branch) {
        let current = branch;
        let parent = current?.parentElement || null;
        while (current instanceof Element && parent instanceof Element) {
            let sibling = current.nextElementSibling;
            while (sibling) {
                const next = sibling.nextElementSibling;
                if (!isMeaningfulTrailingNode(sibling)) {
                    const rect = sibling.getBoundingClientRect?.();
                    const style = getComputedStyle(sibling);
                    const safeLayoutNode = !/^(fixed|sticky|absolute)$/.test(style.position);
                    if (safeLayoutNode && (rect?.height || sibling.scrollHeight || 0) > 18) {
                        rememberCollapsedNode(sibling);
                        sibling.style.setProperty('display', 'none', 'important');
                    }
                }
                sibling = next;
            }
            if (parent === document.body || parent === document.documentElement) break;
            current = parent;
            parent = current.parentElement;
        }
    }

    function restoreCollapsedNodes() {
        for (const entry of state.pageEnd.collapsedNodes) {
            if (!(entry.node instanceof Element)) continue;
            if (entry.style === null) entry.node.removeAttribute('style');
            else entry.node.setAttribute('style', entry.style);
        }
        state.pageEnd.collapsedNodes = [];
    }

    function branchHasMeaningfulFollowers(branch, ancestor) {
        let current = branch;
        while (current instanceof Element && current !== ancestor) {
            let sibling = current.nextElementSibling;
            while (sibling) {
                if (isMeaningfulTrailingNode(sibling)) return true;
                sibling = sibling.nextElementSibling;
            }
            current = current.parentElement;
        }
        return false;
    }

    function findPageEndSizingNode(anchor, finalRow, safeGap) {
        if (!(anchor instanceof Element) || !(finalRow instanceof Element)) return null;
        const finalRect = finalRow.getBoundingClientRect?.();
        if (!finalRect) return null;

        let branch = anchor;
        let candidate = anchor.parentElement;
        const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0, 320);
        while (candidate instanceof Element && candidate !== document.body && candidate !== document.documentElement) {
            const style = getComputedStyle(candidate);
            const rect = candidate.getBoundingClientRect?.();
            const scrollable = /^(auto|scroll|overlay)$/.test(style.overflowY);
            const excess = rect ? rect.bottom - finalRect.bottom : 0;
            const wideEnough = rect && rect.width >= Math.min(280, viewportWidth * 0.72);
            const safePosition = !/^(fixed|sticky)$/.test(style.position);
            const noFollowers = !branchHasMeaningfulFollowers(branch, candidate);

            if (!scrollable && wideEnough && safePosition && noFollowers && excess > safeGap + 72) {
                return { node: candidate, excess };
            }
            branch = candidate;
            candidate = candidate.parentElement;
        }
        return null;
    }

    function restoreSizingNode() {
        const node = state.pageEnd.sizingNode;
        if (node instanceof Element) {
            if (state.pageEnd.originalSizingStyle === null) node.removeAttribute('style');
            else node.setAttribute('style', state.pageEnd.originalSizingStyle);
        }
        state.pageEnd.sizingNode = null;
        state.pageEnd.originalSizingStyle = null;
        state.pageEnd.removedExcessPx = 0;
    }

    function ensurePageEndSpacer(anchor, safeGap) {
        let spacer = state.pageEnd.spacer;
        if (!(spacer instanceof Element) || !spacer.isConnected) {
            spacer = document.createElement('div');
            spacer.id = `${SCRIPT.mainHostId}-bottom-access`;
            spacer.setAttribute('aria-hidden', 'true');
            spacer.dataset.ksbaOwn = 'true';
            state.pageEnd.spacer = spacer;
        }
        spacer.style.cssText = `display:block;width:100%;height:${safeGap}px;min-height:${safeGap}px;max-height:${safeGap}px;pointer-events:none;visibility:hidden;clear:both;contain:strict;`;
        if (spacer.parentElement !== anchor.parentElement || spacer.previousElementSibling !== anchor) {
            anchor.insertAdjacentElement('afterend', spacer);
        }
        return spacer;
    }

    function applyNativePageEnd() {
        state.pageEnd.frame = 0;
        if (state.destroyed || !isBootleggingRoute() || !state.ui.mainHost?.isConnected) {
            deactivateNativePageEnd();
            return;
        }

        const tiles = collectGenreTiles();
        const anchor = detachedDockAnchor(tiles);
        const finalRow = findFinalActionRow();
        if (!(anchor instanceof Element) || !(finalRow instanceof Element)) return;

        state.pageEnd.active = true;
        state.pageEnd.anchor = anchor;
        const safeGap = pageEndSafeGap();
        state.pageEnd.safeGapPx = safeGap;

        collapseEmptyTrailingSiblings(anchor);
        ensurePageEndSpacer(anchor, safeGap);

        const currentSizingIsValid = state.pageEnd.sizingNode instanceof Element &&
            state.pageEnd.sizingNode.isConnected &&
            state.pageEnd.sizingNode.contains(anchor) &&
            state.pageEnd.sizingNode.contains(finalRow);
        const sizing = currentSizingIsValid
            ? { node: state.pageEnd.sizingNode }
            : findPageEndSizingNode(anchor, finalRow, safeGap);
        if (sizing?.node !== state.pageEnd.sizingNode) {
            restoreSizingNode();
            if (sizing?.node instanceof Element) {
                state.pageEnd.sizingNode = sizing.node;
                state.pageEnd.originalSizingStyle = sizing.node.getAttribute('style');
            }
        }

        if (state.pageEnd.sizingNode instanceof Element) {
            const node = state.pageEnd.sizingNode;
            const nodeRect = node.getBoundingClientRect?.();
            const finalRect = finalRow.getBoundingClientRect?.();
            if (nodeRect && finalRect) {
                const desiredHeight = Math.max(1, Math.ceil(finalRect.bottom - nodeRect.top + safeGap));
                state.pageEnd.removedExcessPx = Math.max(0, Math.round(nodeRect.height - desiredHeight));
                node.style.setProperty('height', `${desiredHeight}px`, 'important');
                node.style.setProperty('min-height', `${desiredHeight}px`, 'important');
                node.style.setProperty('max-height', `${desiredHeight}px`, 'important');
                node.style.setProperty('padding-bottom', '0px', 'important');
                node.style.setProperty('box-sizing', 'border-box', 'important');
                node.style.setProperty('overflow', 'visible', 'important');
            }
        }
    }

    function scheduleNativePageEnd() {
        if (state.destroyed || state.pageEnd.frame) return;
        state.pageEnd.frame = requestAnimationFrame(applyNativePageEnd);
    }

    function activateNativePageEnd() {
        if (!state.pageEnd.resizeHandler) {
            state.pageEnd.resizeHandler = () => scheduleNativePageEnd();
            window.addEventListener('resize', state.pageEnd.resizeHandler, { passive: true });
        }
        scheduleNativePageEnd();
    }

    function deactivateNativePageEnd() {
        if (state.pageEnd.frame) cancelAnimationFrame(state.pageEnd.frame);
        state.pageEnd.frame = 0;
        if (state.pageEnd.resizeHandler) {
            window.removeEventListener('resize', state.pageEnd.resizeHandler);
            state.pageEnd.resizeHandler = null;
        }
        state.pageEnd.spacer?.remove();
        state.pageEnd.spacer = null;
        restoreSizingNode();
        restoreCollapsedNodes();
        Object.assign(state.pageEnd, {
            active: false,
            anchor: null,
            safeGapPx: 0,
            removedExcessPx: 0
        });
    }

    function openDetails() {
        const root = state.ui.portalRoot;
        const backdrop = root?.querySelector('.backdrop');
        if (!backdrop) return;
        state.lastFocused = document.activeElement;
        state.detailsOpen = true;
        backdrop.dataset.open = 'true';
        backdrop.setAttribute('aria-hidden', 'false');
        state.ui.portalHost.style.pointerEvents = 'auto';
        setTimeout(() => root.querySelector('.close')?.focus(), 0);
    }

    function closeDetails() {
        const root = state.ui.portalRoot;
        const backdrop = root?.querySelector('.backdrop');
        if (!backdrop) return;
        state.detailsOpen = false;
        backdrop.dataset.open = 'false';
        backdrop.setAttribute('aria-hidden', 'true');
        state.ui.portalHost.style.pointerEvents = 'none';
        try { state.lastFocused?.focus?.(); } catch {}
        state.lastFocused = null;
    }

    function showToast(message) {
        const toast = state.ui.portalRoot?.querySelector('.toast');
        if (!toast) return;
        clearTimeout(state.toastTimer);
        toast.textContent = message;
        toast.dataset.show = 'true';
        state.toastTimer = setTimeout(() => {
            if (toast.isConnected) toast.dataset.show = 'false';
        }, 1800);
    }

    async function copyText(value) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.cssText = 'position:fixed;left:-9999px;opacity:0;';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand?.('copy');
        textarea.remove();
        if (!copied) throw new Error('Clipboard unavailable');
    }

    async function copyDiagnostic() {
        try {
            await copyText(JSON.stringify(buildDiagnosticReport(), null, 2));
            state.diagnosticsCopiedAt = Date.now();
            showToast('Safe diagnostic copied — no identity or raw HTML included.');
        } catch (error) {
            rememberError(error);
            showToast('Could not copy diagnostic.');
        }
    }

    function removeInterface() {
        deactivateNativePageEnd();
        closeDetails();
        document.getElementById(SCRIPT.mainHostId)?.remove();
        document.getElementById(SCRIPT.portalHostId)?.remove();
        state.ui.mainHost = null;
        state.ui.mainRoot = null;
        state.ui.portalHost = null;
        state.ui.portalRoot = null;
        state.renderSignatures.main = '';
        state.renderSignatures.details = '';
    }

    function render() {
        clearTimeout(state.renderTimer);
        if (state.destroyed || state.rendering) return;

        state.rendering = true;
        try {
            const tiles = collectGenreTiles();
            if (!isBootleggingRoute(tiles)) {
                clearHighlights();
                removeInterface();
                state.lastSnapshot = null;
                return;
            }

            if (tiles.length !== GENRE_ORDER.length) {
                clearHighlights();
                removeInterface();
                state.lastSnapshot = {
                    version: SCRIPT.version,
                    source: 'none',
                    confidence: 'none',
                    updatedAt: Date.now(),
                    route: routeFingerprint(),
                    tileCount: tiles.length,
                    rows: [],
                    decision: {
                        mode: 'none',
                        command: 'WAITING FOR GENRES',
                        headline: 'Loading Bootlegging',
                        summary: `Found ${tiles.length} of 8 genre tiles.`
                    },
                    warnings: []
                };
                return;
            }

            const domRows = tiles
                .map(({ genre, button }) => parseVisibleGenreRow(genre, button))
                .filter(Boolean);
            const validated = validateDomRows(tiles, domRows);
            const rows = validated.rows;

            if (!rows) {
                const now = performance.now();
                if (!state.domGapSince) state.domGapSince = now;
                if (!state.lastSnapshot?.rows?.length || now - state.domGapSince >= 600) {
                    clearHighlights();
                    removeInterface();
                    state.lastSnapshot = null;
                }
                scheduleRender(180);
                return;
            }
            state.domGapSince = 0;

            if (!domSnapshotIsStable(rows)) {
                scheduleRender(CONFIG.domStabilityMs + 20);
                return;
            }

            if (!ensureInterface(tiles)) {
                clearHighlights();
                state.lastSnapshot = null;
                scheduleRender(250);
                return;
            }

            const decision = determineInstruction(rows);
            syncHighlight(rows, decision);
            renderInterface(rows, decision, validated.source, validated.confidence, validated.warnings);
            activateNativePageEnd();

            state.lastSnapshot = {
                version: SCRIPT.version,
                dataMode: 'dom-only',
                source: validated.source,
                confidence: validated.confidence,
                updatedAt: Date.now(),
                route: routeFingerprint(),
                tileCount: tiles.length,
                rows: rows.map(({ button, ...row }) => ({ ...row })),
                decision: { ...decision },
                warnings: [...validated.warnings]
            };
        } catch (error) {
            rememberError(error);
            clearHighlights();
            removeInterface();
            state.lastSnapshot = {
                version: SCRIPT.version,
                source: 'none',
                confidence: 'none',
                updatedAt: Date.now(),
                route: routeFingerprint(),
                tileCount: 0,
                rows: [],
                decision: {
                    mode: 'none',
                    command: 'SCRIPT ERROR',
                    headline: 'Recommendation paused',
                    summary: state.lastError || 'Unexpected rendering error.'
                },
                warnings: [state.lastError]
            };
        } finally {
            state.rendering = false;
        }
    }

    function scheduleRender(delay = CONFIG.renderDebounceMs) {
        clearTimeout(state.renderTimer);
        state.renderTimer = setTimeout(render, Math.max(0, delay));
    }

    function isOwnMutation(mutation) {
        if (performance.now() < state.suppressObserverUntil) return true;
        const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
        if (!target) return false;
        if (target.id === SCRIPT.mainHostId || target.id === SCRIPT.portalHostId || target.id === `${SCRIPT.mainHostId}-bottom-access` || target.closest?.(`#${SCRIPT.mainHostId}, #${SCRIPT.portalHostId}`)) return true;
        if (target.dataset?.ksbaOwn === 'true') return true;
        if (state.pageEnd.sizingNode === target || state.pageEnd.collapsedNodes.some(entry => entry.node === target)) return true;
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            const combined = `${mutation.oldValue || ''} ${target.className || ''}`;
            if (/ks(?:ba|\-boot)-(?:copy|sell)-target/.test(combined)) return true;
        }
        return false;
    }

    function begin() {
        if (state.destroyed || !document.documentElement) return;

        loadPreferences();
        installStyles();
        clearHighlights();
        removeInterface();

        state.observer = new MutationObserver(mutations => {
            if (state.destroyed || state.rendering || mutations.every(isOwnMutation)) return;
            scheduleRender();
        });
        state.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeOldValue: true,
            attributeFilter: ['class', 'aria-label', 'data-stock', 'data-queue']
        });

        state.clickHandler = event => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target || !isBootleggingRoute()) return;
            if (target.closest('[class*="genre"], [class*="stock"], .commit-button, button, [role="button"]')) {
                [70, 250, 700, 1_400].forEach(delay => setTimeout(() => {
                    if (!state.destroyed) scheduleRender(0);
                }, delay));
            }
        };
        document.addEventListener('click', state.clickHandler, true);

        state.routeHandler = () => scheduleRender(50);
        window.addEventListener('hashchange', state.routeHandler);
        window.addEventListener('popstate', state.routeHandler);
        win.navigation?.addEventListener?.('currententrychange', state.routeHandler);

        state.visibilityHandler = () => { if (!document.hidden) scheduleRender(50); };
        document.addEventListener('visibilitychange', state.visibilityHandler);

        state.keyHandler = event => {
            if (event.key === 'Escape' && state.detailsOpen) closeDetails();
        };
        document.addEventListener('keydown', state.keyHandler, true);

        state.healthTimer = setInterval(() => {
            if (state.destroyed || document.hidden || !hasCrimesUrl()) return;
            const mainConnected = Boolean(document.getElementById(SCRIPT.mainHostId)?.isConnected);
            const portalConnected = Boolean(document.getElementById(SCRIPT.portalHostId)?.isConnected);
            if (!mainConnected || !portalConnected || !state.lastSnapshot) scheduleRender(0);
        }, CONFIG.healthCheckMs);

        scheduleRender(0);
    }

    function buildDiagnosticReport() {
        const snapshot = state.lastSnapshot;
        return {
            schemaVersion: 4,
            script: { name: SCRIPT.name, version: SCRIPT.version },
            generatedAt: new Date().toISOString(),
            privacy: {
                rawHtmlCaptured: false,
                unrestrictedTextCaptured: false,
                playerIdentityCaptured: false,
                scriptInitiatedNetworkRequests: false,
                passiveNetworkResponsesObserved: false,
                automatedClicksPerformed: false,
                automatedGameplayActions: false
            },
            context: {
                route: routeFingerprint(),
                documentReadyState: document.readyState,
                hidden: document.hidden,
                detailsOpen: state.detailsOpen,
                nativePageEndActive: state.pageEnd.active
            },
            detection: {
                bootleggingRoute: isBootleggingRoute(),
                genreTileCount: collectGenreTiles().length,
                sellControlFound: Boolean(findSellControl()),
                safePlacementFound: Boolean(detachedDockAnchor(collectGenreTiles())),
                mountMode: document.getElementById(SCRIPT.mainHostId)?.dataset?.ksbaMount || null,
                domInterfaceMounted: Boolean(document.getElementById(SCRIPT.mainHostId)),
                dataMode: 'dom-only',
                networkObserverInstalled: false,
                pageEndMode: 'native-layout',
                pageEndSafeGapPx: state.pageEnd.safeGapPx,
                pageEndRemovedExcessPx: state.pageEnd.removedExcessPx,
                pageEndCollapsedNodes: state.pageEnd.collapsedNodes.length,
                pageEndUsesScrollClamp: false,
                pendingDomStabilityMs: state.pendingDomSignature
                    ? Math.max(0, CONFIG.domStabilityMs - (performance.now() - state.pendingDomSince))
                    : null
            },
            preferences: {
                detailsOrder: 'priority-only',
                highlightTiles: state.preferences.highlightTiles
            },
            snapshot: snapshot ? JSON.parse(JSON.stringify(snapshot)) : null,
            lastError: state.lastError || null
        };
    }

    function runBuiltInSelfTests() {
        const makeRows = values => GENRE_ORDER.map(genre => {
            const value = values[genre];
            return createRow(genre, null, value.owned, value.queued);
        });

        const screenshotRows = makeRows({
            Action: { owned: 12, queued: 28 },
            Comedy: { owned: 14, queued: 12 },
            Drama: { owned: 15, queued: 0 },
            Fantasy: { owned: 22, queued: 0 },
            Horror: { owned: 15, queued: 0 },
            Romance: { owned: 12, queued: 0 },
            Thriller: { owned: 8, queued: 16 },
            'Sci-Fi': { owned: 6, queued: 0 }
        });

        const liveRows = makeRows({
            Action: { owned: 24, queued: 49 },
            Comedy: { owned: 9, queued: 54 },
            Drama: { owned: 12, queued: 41 },
            Fantasy: { owned: 26, queued: 37 },
            Horror: { owned: 13, queued: 15 },
            Romance: { owned: 13, queued: 18 },
            Thriller: { owned: 15, queued: 16 },
            'Sci-Fi': { owned: 10, queued: 17 }
        });

        const cases = [
            { name: 'Full queue is counted in the screenshot state', actual: determineInstruction(screenshotRows).genre, expected: 'Drama' },
            { name: 'Live diagnostic state selects Action', actual: determineInstruction(liveRows).genre, expected: 'Action' },
            { name: 'Priority preview starts Action then Thriller', actual: priorityRows(liveRows).slice(0,2).map(row => row.genre).join(','), expected: 'Action,Thriller' },
            { name: 'Balanced stock recommends selling', actual: determineInstruction(makeRows(Object.fromEntries(GENRE_ORDER.map(genre => [genre, { owned: CONFIG.targets[genre], queued: 0 }])))).mode, expected: 'sell' },
            { name: 'A fully covered refill queue recommends waiting', actual: determineInstruction(makeRows(Object.fromEntries(GENRE_ORDER.map(genre => [genre, { owned: 0, queued: CONFIG.targets[genre] }])))).mode, expected: 'wait' },
            { name: 'Complete DOM rows pass validation', actual: validateDomRows(GENRE_ORDER.map((genre, index) => ({ genre, button: { index } })), liveRows).confidence, expected: 'dom' },
            { name: 'Coverage is capped at 100 percent', actual: decisionCoverage({ coverage: 1.5 }), expected: 100 },
            { name: 'Missing rows fail closed', actual: determineInstruction(liveRows.slice(0,7)).mode, expected: 'none' },
            { name: 'Priority rank map keeps Action first', actual: priorityRankMap(liveRows).get('Action'), expected: 1 },
            { name: 'Details always use priority order', actual: priorityRows(liveRows).map(row => row.genre).slice(0,3).join(','), expected: 'Action,Thriller,Comedy' }
        ];

        return {
            passed: cases.every(test => test.actual === test.expected),
            cases: cases.map(test => ({ ...test, passed: test.actual === test.expected }))
        };
    }

    function destroy() {
        if (state.destroyed) return;
        state.destroyed = true;
        clearTimeout(state.renderTimer);
        clearTimeout(state.toastTimer);
        clearInterval(state.healthTimer);
        state.observer?.disconnect();

        if (state.clickHandler) document.removeEventListener('click', state.clickHandler, true);
        if (state.routeHandler) {
            window.removeEventListener('hashchange', state.routeHandler);
            window.removeEventListener('popstate', state.routeHandler);
            win.navigation?.removeEventListener?.('currententrychange', state.routeHandler);
        }
        if (state.visibilityHandler) document.removeEventListener('visibilitychange', state.visibilityHandler);
        if (state.keyHandler) document.removeEventListener('keydown', state.keyHandler, true);

        deactivateNativePageEnd();
        clearHighlights();
        removeInterface();
        document.getElementById(SCRIPT.styleId)?.remove();

        if (win[SCRIPT.globalKey]?.destroy === destroy) delete win[SCRIPT.globalKey];
    }

    win[SCRIPT.globalKey] = Object.freeze({
        version: SCRIPT.version,
        refresh: () => scheduleRender(0),
        getSnapshot: () => state.lastSnapshot ? JSON.parse(JSON.stringify(state.lastSnapshot)) : null,
        diagnose: buildDiagnosticReport,
        selfTest: runBuiltInSelfTests,
        openDetails,
        closeDetails,
        destroy
    });


    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', begin, { once: true });
    } else {
        begin();
    }

    console.info(
        `[${SCRIPT.name}] v${SCRIPT.version} loaded. ` +
        'DOM-only read-only guidance; no network interception or automated Torn actions.'
    );
})();
