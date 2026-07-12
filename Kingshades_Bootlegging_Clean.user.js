// ==UserScript==
// @name         Kingshade's Bootlegging Clean
// @namespace    DieselBladeScripts.ARS.Kingshade
// @version      4.0.0
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
     * Kingshade's Bootlegging v4.0.0
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
        version: '4.0.0',
        styleId: 'ks-boot-clean-v400-styles',
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
            .ks-boot-highlight-host,
            .ks-boot-sell-host {
                position: relative !important;
            }

            .ks-boot-highlight {
                position: absolute !important;
                inset: 0 !important;
                z-index: 20 !important;

                border: 3px solid #4aa3ff !important;
                border-radius: inherit !important;
                box-sizing: border-box !important;
                box-shadow:
                    inset 0 0 0 1px rgba(255, 255, 255, 0.45),
                    0 0 7px rgba(74, 163, 255, 0.68) !important;

                pointer-events: none !important;
            }

            .ks-boot-highlight::after {
                content: "★" !important;
                position: absolute !important;
                top: 1px !important;
                right: 3px !important;

                color: #72b8ff !important;
                font-size: 13px !important;
                font-weight: 900 !important;
                line-height: 14px !important;
                text-shadow:
                    0 1px 1px #fff,
                    0 0 3px rgba(74, 163, 255, 0.9) !important;
            }

            .ks-boot-sell-highlight {
                position: absolute !important;
                inset: 0 !important;
                z-index: 20 !important;

                border: 3px solid #45c96f !important;
                border-radius: inherit !important;
                box-sizing: border-box !important;
                box-shadow:
                    inset 0 0 0 1px rgba(255, 255, 255, 0.45),
                    0 0 8px rgba(69, 201, 111, 0.72) !important;

                pointer-events: none !important;
            }

            .ks-boot-sell-highlight::after {
                content: "★" !important;
                position: absolute !important;
                top: 1px !important;
                right: 4px !important;

                color: #69df8e !important;
                font-size: 13px !important;
                font-weight: 900 !important;
                line-height: 14px !important;
                text-shadow:
                    0 1px 1px #fff,
                    0 0 3px rgba(69, 201, 111, 0.9) !important;
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
            if (!state.active || !state.data || state.destroyed) {
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
            if (!state.active || !state.data || state.destroyed) {
                return;
            }

            const buttons = getGenreButtons();

            if (buttons.length === 8) {
                scheduleRender(0);
            }
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

        if (!state.active || !state.data || state.destroyed) {
            return;
        }

        const buttons = getGenreButtons();

        if (buttons.length !== 8) {
            return;
        }

        const rows = buttons.map(({ genre, button }) => {
            const owned = state.data.owned[genre];
            const queued = state.data.queued[genre];
            const projected = owned + queued;
            const target = CONFIG.targets[genre];
            const refillAt = Math.max(
                1,
                Math.ceil(target * CONFIG.refillFraction)
            );

            return {
                genre,
                button,
                owned,
                queued,
                projected,
                target,
                refillAt,
                completion: projected / target
            };
        });

        const instruction = determineInstruction(rows);

        renderHighlight(rows, instruction);
        renderSellHighlight(instruction);
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
        for (const row of rows) {
            row.button.classList.add('ks-boot-highlight-host');

            let highlight =
                row.button.querySelector('.ks-boot-highlight');

            const shouldHighlight =
                instruction.mode === 'copy' &&
                instruction.genre === row.genre;

            if (shouldHighlight) {
                if (!highlight) {
                    highlight = document.createElement('span');
                    highlight.className = 'ks-boot-highlight';
                    row.button.appendChild(highlight);
                }
            } else {
                highlight?.remove();
            }
        }
    }

    function renderSellHighlight(instruction) {
        const sellControl = findSellControl();

        document
            .querySelectorAll('.ks-boot-sell-host')
            .forEach(element => {
                if (element !== sellControl) {
                    element.classList.remove('ks-boot-sell-host');
                    element
                        .querySelectorAll(
                            ':scope > .ks-boot-sell-highlight'
                        )
                        .forEach(highlight => highlight.remove());
                }
            });

        if (!sellControl) {
            return;
        }

        sellControl.classList.add('ks-boot-sell-host');

        let highlight =
            sellControl.querySelector(
                ':scope > .ks-boot-sell-highlight'
            );

        if (instruction.mode === 'sell') {
            if (!highlight) {
                highlight = document.createElement('span');
                highlight.className = 'ks-boot-sell-highlight';
                sellControl.appendChild(highlight);
            }
        } else {
            highlight?.remove();
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

    function cleanupInterface() {
        removeLegacyInterface();

        document
            .querySelectorAll('.ks-boot-highlight-host')
            .forEach(button => {
                button.classList.remove('ks-boot-highlight-host');
                button
                    .querySelectorAll('.ks-boot-highlight')
                    .forEach(element => element.remove());
            });

        document
            .querySelectorAll('.ks-boot-sell-host')
            .forEach(element => {
                element.classList.remove('ks-boot-sell-host');
                element
                    .querySelectorAll('.ks-boot-sell-highlight')
                    .forEach(highlight => highlight.remove());
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
