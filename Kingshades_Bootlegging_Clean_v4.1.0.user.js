// ==UserScript==
// @name         Kingshade's Bootlegging Clean
// @namespace    DieselBladeScripts.ARS.Kingshade
// @version      4.1.0
// @description  Step-by-step Bootlegging guidance for Torn PDA
// @license      GPL-3.0-or-later
// @author       DieselBlade [1701621], Hemicopter [2780600], modified for personal use
// @match        https://www.torn.com/page.php?sid=crimes*
// @match        https://torn.com/page.php?sid=crimes*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(() => {
    'use strict';

    /*
     * Kingshade's Bootlegging v4.1.0
     *
     * Visual guidance only:
     * - does not click;
     * - does not perform crimes;
     * - does not initiate or repeat Torn requests;
     * - only observes data Torn already loaded on the open Crimes page.
     */

    const CONFIG = Object.freeze({
        /*
         * Refill targets follow the commonly used relative genre balance:
         * Action 10, Comedy 7, Fantasy 7, Drama 5.5,
         * Thriller 4, Horror 3, Romance 3, Sci-Fi 2.
         */
        targets: Object.freeze({
            Action: 100,
            Comedy: 70,
            Fantasy: 70,
            Drama: 55,
            Thriller: 40,
            Horror: 30,
            Romance: 30,
            'Sci-Fi': 20
        }),

        /*
         * Stop selling and refill when a genre reaches 25% of its target.
         * Rounded upward so the safety threshold never becomes zero.
         */
        refillFraction: 0.25,

        debug: false
    });

    const SCRIPT = Object.freeze({
        name: "Kingshade's Bootlegging Clean",
        version: '4.1.0',
        styleId: 'ks-boot-clean-v410-styles',
        globalKey: '__ksBootleggingAssistantClean'
    });

    const GENRE_IDS = Object.freeze({
        Action: '1',
        Comedy: '2',
        Drama: '3',
        Fantasy: '4',
        Horror: '5',
        Romance: '6',
        Thriller: '7',
        'Sci-Fi': '8'
    });

    const win =
        typeof unsafeWindow !== 'undefined'
            ? unsafeWindow
            : window;

    const previous = win[SCRIPT.globalKey];

    if (previous?.destroy instanceof Function) {
        try {
            previous.destroy();
        } catch {
            // Best-effort cleanup of an older injected version.
        }
    }

    const state = {
        destroyed: false,
        active: false,
        data: null,
        observer: null,
        renderTimer: null,
        healTimer: null,
        originalFetch: null,
        wrappedFetch: null,
        requestSerial: 0,
        latestAppliedSerial: 0
    };

    function log(...values) {
        if (CONFIG.debug) {
            console.log(`[${SCRIPT.name} v${SCRIPT.version}]`, ...values);
        }
    }

    function installStyles() {
        document.getElementById(SCRIPT.styleId)?.remove();

        const style = document.createElement('style');
        style.id = SCRIPT.styleId;
        style.textContent = `
            .ks-boot-copy-target {
                position: relative !important;
                outline: 3px solid #4aa3ff !important;
                outline-offset: -3px !important;
                box-shadow:
                    inset 0 0 0 1px rgba(255,255,255,.35),
                    0 0 8px rgba(74,163,255,.75) !important;
            }

            .ks-boot-copy-star,
            .ks-boot-sell-star {
                position: absolute !important;
                top: 2px !important;
                right: 4px !important;
                z-index: 50 !important;
                font-size: 14px !important;
                font-weight: 900 !important;
                line-height: 15px !important;
                pointer-events: none !important;
            }

            .ks-boot-copy-star {
                color: #72b8ff !important;
                text-shadow:
                    0 1px 1px #fff,
                    0 0 3px rgba(74,163,255,.9) !important;
            }

            .ks-boot-sell-target {
                position: relative !important;
                outline: 3px solid #45c96f !important;
                outline-offset: -3px !important;
                box-shadow:
                    inset 0 0 0 1px rgba(255,255,255,.35),
                    0 0 8px rgba(69,201,111,.75) !important;
            }

            .ks-boot-sell-star {
                color: #69df8e !important;
                text-shadow:
                    0 1px 1px #fff,
                    0 0 3px rgba(69,201,111,.9) !important;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    function patchFetch() {
        if (typeof win.fetch !== 'function') {
            return;
        }

        state.originalFetch = win.fetch;
        const original = win.fetch.bind(win);

        const wrapped = async (...args) => {
            const requestSerial = ++state.requestSerial;
            const response = await original(...args);

            if (state.destroyed) {
                return response;
            }

            try {
                const request = args[0];
                const url =
                    typeof request === 'string'
                        ? request
                        : request instanceof URL
                            ? request.href
                            : request?.url || '';

                if (String(url).includes('crimesData')) {
                    inspectResponse(
                        response.clone(),
                        requestSerial
                    ).catch(error => {
                        console.error(
                            `[${SCRIPT.name}] Could not inspect crimesData.`,
                            error
                        );
                    });
                }
            } catch (error) {
                console.error(
                    `[${SCRIPT.name}] Fetch observation failed.`,
                    error
                );
            }

            return response;
        };

        state.wrappedFetch = wrapped;
        win.fetch = wrapped;
    }

    async function inspectResponse(response, requestSerial) {
        if (!response?.ok || state.destroyed) {
            return;
        }

        const payload = await response.json();
        const db = payload?.DB;

        if (!db || typeof db !== 'object') {
            return;
        }

        const parsed = parseBootleggingData(db);

        if (!parsed) {
            return;
        }

        if (requestSerial < state.latestAppliedSerial) {
            return;
        }

        state.latestAppliedSerial = requestSerial;
        state.data = parsed;
        state.active = true;
        scheduleRender(70);
    }

    function parseBootleggingData(db) {
        const rawOwned = db?.generalInfo?.CDs;

        if (
            !rawOwned ||
            typeof rawOwned !== 'object' ||
            Array.isArray(rawOwned)
        ) {
            return null;
        }

        const owned = {};
        const queued = {};

        for (const [genre, id] of Object.entries(GENRE_IDS)) {
            const value = parseRequiredNumber(
                rawOwned[id] ?? rawOwned[Number(id)]
            );

            if (value === null) {
                log(`Missing owned stock for ${genre}.`);
                return null;
            }

            owned[genre] = value;
            queued[genre] = 0;
        }

        const queue = findBootleggingQueue(db);

        if (queue === null) {
            return null;
        }

        const genreById = Object.fromEntries(
            Object.entries(GENRE_IDS).map(([genre, id]) => [id, genre])
        );

        for (const rawId of queue) {
            const genre = genreById[String(rawId)];

            if (!genre) {
                return null;
            }

            queued[genre] += 1;
        }

        return { owned, queued };
    }

    function findBootleggingQueue(db) {
        const crimesByType = db?.crimesByType;

        if (!crimesByType || typeof crimesByType !== 'object') {
            return null;
        }

        const direct =
            crimesByType?.['0']?.additionalInfo?.currentQueue;

        if (Array.isArray(direct)) {
            return direct;
        }

        const validIds = new Set(Object.values(GENRE_IDS));

        const validQueues = Object.values(crimesByType)
            .map(entry => entry?.additionalInfo?.currentQueue)
            .filter(queue =>
                Array.isArray(queue) &&
                queue.every(rawId =>
                    validIds.has(String(rawId))
                )
            );

        return validQueues.length === 1
            ? validQueues[0]
            : null;
    }

    function removeLegacyInterface() {
        document
            .querySelectorAll(
                '[id^="ks-boot-v"][id$="-panel"], ' +
                '.ks-boot-panel, ' +
                '.ks-boot-fallback-host'
            )
            .forEach(element => element.remove());

        document
            .querySelectorAll('.ks-boot-hidden-original')
            .forEach(element => {
                element.classList.remove('ks-boot-hidden-original');
            });

        /*
         * Remove obsolete styles from earlier versions while preserving
         * the current version's stylesheet.
         */
        document
            .querySelectorAll('style[id^="ks-boot-v"]')
            .forEach(style => {
                if (style.id !== SCRIPT.styleId) {
                    style.remove();
                }
            });
    }

    function begin() {
        if (state.destroyed) {
            return;
        }

        removeLegacyInterface();
        installStyles();

        state.observer = new MutationObserver(mutations => {
            if (state.destroyed) {
                return;
            }

            const relevant = mutations.some(mutation => {
                const nodes = [
                    ...mutation.addedNodes,
                    ...mutation.removedNodes
                ];

                return !(
                    nodes.length > 0 &&
                    nodes.every(isOwnNode)
                );
            });

            if (relevant) {
                scheduleRender(90);
            }
        });

        state.observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        document.addEventListener(
            'click',
            event => {
                if (
                    !state.active ||
                    !state.data ||
                    state.destroyed
                ) {
                    return;
                }

                const target =
                    event.target instanceof Element
                        ? event.target
                        : null;

                if (
                    target?.closest(
                        'button[class*="genreStock"], ' +
                        'button[aria-label^="Copying "]'
                    ) ||
                    normalizeElementText(target) ===
                        'Sell Counterfeit DVDs'
                ) {
                    [120, 350, 800].forEach(delay => {
                        setTimeout(() => {
                            if (!state.destroyed) {
                                scheduleRender(0);
                            }
                        }, delay);
                    });
                }
            },
            true
        );

        state.healTimer = setInterval(() => {
            removeLegacyInterface();
            if (state.destroyed) {
                return;
            }

            scheduleRender(0);
        }, 500);
    }

    function isOwnNode(node) {
        if (!(node instanceof Element)) {
            return false;
        }

        return (
            node.matches(
                '.ks-boot-highlight, .ks-boot-sell-highlight'
            ) ||
            Boolean(
                node.closest(
                    '.ks-boot-highlight, .ks-boot-sell-highlight'
                )
            )
        );
    }

    function scheduleRender(delay = 30) {
        clearTimeout(state.renderTimer);

        state.renderTimer = setTimeout(() => {
            if (!state.destroyed) {
                render();
            }
        }, delay);
    }

    function getGenreButtons() {
        const candidates = Array.from(
            document.querySelectorAll(
                [
                    'button[class*="genreStock"]',
                    'button[aria-label^="Copying "]'
                ].join(',')
            )
        );

        const unique = new Map();

        for (const button of candidates) {
            const genre = readGenre(button);

            if (
                genre &&
                Object.prototype.hasOwnProperty.call(GENRE_IDS, genre) &&
                !unique.has(genre)
            ) {
                unique.set(genre, button);
            }
        }

        return Array.from(unique.entries()).map(([genre, button]) => ({
            genre,
            button
        }));
    }

    function readGenre(button) {
        const aria = button.getAttribute('aria-label') || '';

        const fromAria = aria
            .split(' - ')[0]
            .replace(/^Copying\s+/i, '')
            .trim();

        if (Object.prototype.hasOwnProperty.call(GENRE_IDS, fromAria)) {
            return fromAria;
        }

        const text = button.textContent || '';

        return Object.keys(GENRE_IDS).find(genre =>
            text.includes(genre)
        ) || '';
    }

    function render() {
        removeLegacyInterface();

        if (state.destroyed) {
            return;
        }

        const buttons = getGenreButtons();

        if (buttons.length !== 8) {
            clearCurrentMarkers();
            return;
        }

        /*
         * Torn PDA may already have rendered Bootlegging before this script
         * starts, so no fresh crimesData response is guaranteed. Read the
         * visible stock and queue directly from Torn's own genre tiles.
         */
        const domRows = buttons
            .map(({ genre, button }) =>
                parseVisibleGenreRow(genre, button)
            )
            .filter(Boolean);

        let rows;

        if (domRows.length === 8) {
            rows = domRows;
        } else if (state.data) {
            rows = buttons.map(({ genre, button }) => {
                const owned = state.data.owned[genre];
                const queued = state.data.queued[genre];
                const target = CONFIG.targets[genre];

                return {
                    genre,
                    button,
                    owned,
                    queued,
                    projected: owned + queued,
                    target,
                    refillAt: Math.max(
                        1,
                        Math.ceil(target * CONFIG.refillFraction)
                    ),
                    completion: (owned + queued) / target
                };
            });
        } else {
            clearCurrentMarkers();
            return;
        }

        const instruction = determineInstruction(rows);

        renderHighlight(rows, instruction);
        renderSellHighlight(instruction);
    }

    function parseVisibleGenreRow(genre, button) {
        const text = String(button.innerText || button.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!text) {
            return null;
        }

        const target = CONFIG.targets[genre];

        const queueMatch = text.match(
            /(\d[\d,]*)\s+(?:queued|copying)/i
        );

        const queued = queueMatch
            ? Number(queueMatch[1].replace(/,/g, ''))
            : 0;

        /*
         * The final standalone number on each Torn tile is current owned
         * stock. Queue/copying count appears earlier in the same tile.
         */
        const numbers = Array.from(
            text.matchAll(/(?:^|\s)(\d[\d,]*)(?=\s|$)/g)
        ).map(match =>
            Number(match[1].replace(/,/g, ''))
        );

        if (numbers.length === 0) {
            return null;
        }

        const owned = numbers[numbers.length - 1];

        if (
            !Number.isFinite(owned) ||
            !Number.isFinite(queued)
        ) {
            return null;
        }

        const projected = owned + queued;

        return {
            genre,
            button,
            owned,
            queued,
            projected,
            target,
            refillAt: Math.max(
                1,
                Math.ceil(target * CONFIG.refillFraction)
            ),
            completion: projected / target
        };
    }

    function determineInstruction(rows) {
        const needsRefill = rows.filter(
            row => row.owned <= row.refillAt
        );

        if (needsRefill.length === 0) {
            return {
                mode: 'sell',
                command: 'SELL NOW'
            };
        }

        const notCoveredByQueue = needsRefill.filter(
            row => row.projected < row.target
        );

        if (notCoveredByQueue.length === 0) {
            return {
                mode: 'wait',
                command: 'WAIT'
            };
        }

        const selected = notCoveredByQueue.reduce((best, current) => {
            if (!best) {
                return current;
            }

            if (current.completion !== best.completion) {
                return current.completion < best.completion
                    ? current
                    : best;
            }

            return current.projected < best.projected
                ? current
                : best;
        }, null);

        return {
            mode: 'copy',
            genre: selected.genre,
            command: `COPY ${selected.genre.toUpperCase()}`
        };
    }

    function findCommonContainer(elements) {
        if (elements.length === 0) {
            return null;
        }

        let candidate = elements[0].parentElement;

        while (
            candidate &&
            !elements.every(element => candidate.contains(element))
        ) {
            candidate = candidate.parentElement;
        }

        return candidate;
    }

    function renderHighlight(rows, instruction) {
        document
            .querySelectorAll('.ks-boot-copy-target')
            .forEach(element => {
                element.classList.remove('ks-boot-copy-target');
                element
                    .querySelectorAll(':scope > .ks-boot-copy-star')
                    .forEach(star => star.remove());
            });

        if (instruction.mode !== 'copy') {
            return;
        }

        const selected = rows.find(
            row => row.genre === instruction.genre
        );

        if (!selected) {
            return;
        }

        selected.button.classList.add('ks-boot-copy-target');

        if (
            !selected.button.querySelector(
                ':scope > .ks-boot-copy-star'
            )
        ) {
            const star = document.createElement('span');
            star.className = 'ks-boot-copy-star';
            star.textContent = '★';
            selected.button.appendChild(star);
        }
    }

    function renderSellHighlight(instruction) {
        document
            .querySelectorAll('.ks-boot-sell-target')
            .forEach(element => {
                element.classList.remove('ks-boot-sell-target');
                element
                    .querySelectorAll(':scope > .ks-boot-sell-star')
                    .forEach(star => star.remove());
            });

        if (instruction.mode !== 'sell') {
            return;
        }

        const sellControl = findSellControl();

        if (!sellControl) {
            return;
        }

        sellControl.classList.add('ks-boot-sell-target');

        if (
            !sellControl.querySelector(
                ':scope > .ks-boot-sell-star'
            )
        ) {
            const star = document.createElement('span');
            star.className = 'ks-boot-sell-star';
            star.textContent = '★';
            sellControl.appendChild(star);
        }
    }

    function findSellControl() {
        const normalize = value =>
            String(value || '')
                .replace(/\s+/g, ' ')
                .trim();

        const labels = Array.from(
            document.querySelectorAll('span, div, p, strong')
        ).filter(element =>
            normalize(element.textContent) ===
            'Sell Counterfeit DVDs'
        );

        for (const label of labels) {
            let candidate = label;

            for (let depth = 0; depth < 4 && candidate; depth += 1) {
                const rect = candidate.getBoundingClientRect();
                const containsGenres =
                    candidate.querySelectorAll(
                        'button[class*="genreStock"], ' +
                        'button[aria-label^="Copying "]'
                    ).length > 0;

                if (
                    !containsGenres &&
                    rect.width >= 180 &&
                    rect.height >= 35 &&
                    rect.height <= 130
                ) {
                    return candidate;
                }

                candidate = candidate.parentElement;
            }
        }

        return null;
    }

    function clearCurrentMarkers() {
        document
            .querySelectorAll(
                '.ks-boot-copy-target, .ks-boot-sell-target'
            )
            .forEach(element => {
                element.classList.remove(
                    'ks-boot-copy-target',
                    'ks-boot-sell-target'
                );
            });

        document
            .querySelectorAll(
                '.ks-boot-copy-star, .ks-boot-sell-star'
            )
            .forEach(element => element.remove());
    }

    function cleanupInterface() {
        removeLegacyInterface();
        clearCurrentMarkers();

        document
            .querySelectorAll(
                '.ks-boot-highlight, .ks-boot-sell-highlight'
            )
            .forEach(element => element.remove());

        document
            .querySelectorAll(
                '.ks-boot-highlight-host, .ks-boot-sell-host'
            )
            .forEach(element => {
                element.classList.remove(
                    'ks-boot-highlight-host',
                    'ks-boot-sell-host'
                );
            });
    }

    function normalizeElementText(element) {
        if (!(element instanceof Element)) {
            return '';
        }

        return (element.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function parseRequiredNumber(value) {
        if (
            value === null ||
            value === undefined ||
            value === ''
        ) {
            return null;
        }

        const number = Number(value);

        return Number.isFinite(number) && number >= 0
            ? number
            : null;
    }

    function destroy() {
        if (state.destroyed) {
            return;
        }

        state.destroyed = true;
        clearTimeout(state.renderTimer);
        clearInterval(state.healTimer);
        state.observer?.disconnect();
        cleanupInterface();
        document.getElementById(SCRIPT.styleId)?.remove();

        if (
            state.originalFetch &&
            state.wrappedFetch &&
            win.fetch === state.wrappedFetch
        ) {
            win.fetch = state.originalFetch;
        }

        if (win[SCRIPT.globalKey]?.destroy === destroy) {
            delete win[SCRIPT.globalKey];
        }
    }

    win[SCRIPT.globalKey] = Object.freeze({
        version: SCRIPT.version,
        destroy
    });

    patchFetch();

    if (document.readyState === 'loading') {
        document.addEventListener(
            'DOMContentLoaded',
            begin,
            { once: true }
        );
    } else {
        begin();
    }

    console.info(
        `[${SCRIPT.name}] v${SCRIPT.version} loaded. ` +
        'Visual guidance only; no automated actions.'
    );
})();
