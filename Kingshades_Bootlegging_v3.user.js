// ==UserScript==
// @name         Kingshade's Bootlegging
// @namespace    DieselBladeScripts.ARS.Kingshade
// @version      3.2.0
// @description  Stable mobile-first Bootlegging stock display and genre recommendation
// @license      GPL-3.0-or-later
// @author       DieselBlade [1701621], Hemicopter [2780600], modified for personal use
// @match        https://www.torn.com/page.php?sid=crimes*
// @match        https://torn.com/page.php?sid=crimes*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(() => {
    'use strict';

    const CONFIG = Object.freeze({
        useProjectedStock: true,
        minimumHistoricalSales: 100,
        recommendationSymbol: '★',
        debug: false
    });

    const SCRIPT = Object.freeze({
        name: "Kingshade's Bootlegging",
        version: '3.2.0',
        styleId: 'ks-boot-v320-styles',
        globalKey: '__ksBootleggingAssistant'
    });

    const GENRES = Object.freeze({
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

    const oldController = win[SCRIPT.globalKey];

    if (oldController?.destroy instanceof Function) {
        try {
            oldController.destroy();
        } catch {
            // Best-effort cleanup.
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
        wrappedFetch: null
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
            .ks-boot-host {
                position: relative !important;
            }

            .ks-boot-badge {
                position: absolute !important;
                left: 50% !important;
                bottom: 2px !important;
                transform: translateX(-50%) !important;
                z-index: 20 !important;

                min-width: 28px !important;
                max-width: calc(100% - 6px) !important;
                height: 15px !important;
                padding: 0 4px !important;
                box-sizing: border-box !important;

                overflow: hidden !important;
                white-space: nowrap !important;
                text-overflow: ellipsis !important;

                border-radius: 4px !important;
                background: rgba(20, 20, 20, 0.78) !important;
                color: #fff !important;

                font-size: 10px !important;
                font-weight: 800 !important;
                line-height: 15px !important;
                text-align: center !important;

                pointer-events: none !important;
            }

            .ks-boot-recommended-ring {
                position: absolute !important;
                inset: 0 !important;
                z-index: 19 !important;
                border: 3px solid #45c96f !important;
                border-radius: inherit !important;
                box-sizing: border-box !important;
                box-shadow: inset 0 0 0 1px rgba(255,255,255,.55),
                            0 0 7px rgba(69,201,111,.75) !important;
                pointer-events: none !important;
            }

            .ks-boot-star {
                position: absolute !important;
                top: 1px !important;
                right: 3px !important;
                z-index: 21 !important;

                color: #1fb454 !important;
                font-size: 14px !important;
                font-weight: 900 !important;
                line-height: 15px !important;
                text-shadow: 0 1px 1px #fff, 0 0 3px rgba(69,201,111,.9) !important;

                pointer-events: none !important;
            }

            @media (max-width: 480px) {
                .ks-boot-badge {
                    font-size: 9px !important;
                    min-width: 24px !important;
                    padding: 0 3px !important;
                }

                .ks-boot-star {
                    right: 2px !important;
                    font-size: 13px !important;
                }
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
                    inspectResponse(response.clone()).catch(error => {
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

    async function inspectResponse(response) {
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
            state.active = false;
            state.data = null;
            cleanup();
            return;
        }

        state.data = parsed;
        state.active = true;
        scheduleRender(20);
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
        const sold = {};

        for (let number = 1; number <= 8; number += 1) {
            const id = String(number);

            const ownedValue = requiredNumber(
                rawOwned[id] ?? rawOwned[number]
            );

            const soldValue = findSoldValue(db, number);

            if (ownedValue === null || soldValue === null) {
                return null;
            }

            owned[id] = ownedValue;
            queued[id] = 0;
            sold[id] = soldValue;
        }

        const queue = findQueue(db);

        if (queue === null) {
            return null;
        }

        for (const rawId of queue) {
            const id = String(rawId);

            if (!Object.prototype.hasOwnProperty.call(queued, id)) {
                return null;
            }

            queued[id] += 1;
        }

        return { owned, queued, sold };
    }

    function findSoldValue(db, number) {
        const key = `CDType${number}Sold`;

        for (const source of [
            db?.currentUserStats,
            db?.currentUserStatistics
        ]) {
            if (!source) {
                continue;
            }

            if (!Array.isArray(source) && typeof source === 'object') {
                const direct = requiredNumber(source[key]);

                if (direct !== null) {
                    return direct;
                }
            }

            if (Array.isArray(source)) {
                const entry = source.find(item =>
                    item?.key === key ||
                    item?.name === key ||
                    item?.title === key
                );

                const value = requiredNumber(entry?.value);

                if (value !== null) {
                    return value;
                }
            }
        }

        return null;
    }

    function findQueue(db) {
        const crimesByType = db?.crimesByType;

        if (!crimesByType || typeof crimesByType !== 'object') {
            return null;
        }

        const queues = Object.values(crimesByType)
            .map(entry => entry?.additionalInfo?.currentQueue)
            .filter(Array.isArray);

        return queues.length === 1
            ? queues[0]
            : null;
    }

    function begin() {
        if (state.destroyed) {
            return;
        }

        installStyles();

        state.observer = new MutationObserver(mutations => {
            if (!state.active || !state.data || state.destroyed) {
                return;
            }

            const relevant = mutations.some(mutation => {
                const ownNodes = [
                    ...mutation.addedNodes,
                    ...mutation.removedNodes
                ];

                if (
                    ownNodes.length > 0 &&
                    ownNodes.every(isOwnNode)
                ) {
                    return false;
                }

                return true;
            });

            if (relevant) {
                scheduleRender(40);
            }
        });

        state.observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        state.healTimer = setInterval(() => {
            if (!state.active || !state.data || state.destroyed) {
                return;
            }

            const buttons = getGenreButtons();

            if (
                buttons.length === 8 &&
                buttons.some(({ button }) =>
                    !button.querySelector('.ks-boot-badge')
                )
            ) {
                scheduleRender(0);
            }
        }, 300);
    }

    function isOwnNode(node) {
        if (!(node instanceof Element)) {
            return false;
        }

        return (
            node.matches(
                '.ks-boot-badge, .ks-boot-star, .ks-boot-recommended-ring'
            ) ||
            Boolean(
                node.closest(
                    '.ks-boot-badge, .ks-boot-star, .ks-boot-recommended-ring'
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

            if (genre && GENRES[genre] && !unique.has(genre)) {
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

        if (GENRES[fromAria]) {
            return fromAria;
        }

        const text = button.textContent || '';

        return Object.keys(GENRES).find(genre =>
            text.includes(genre)
        ) || '';
    }

    function render() {
        if (!state.active || !state.data || state.destroyed) {
            return;
        }

        const buttons = getGenreButtons();

        if (buttons.length !== 8) {
            return;
        }

        const totalOwned = sum(state.data.owned);
        const totalQueued = sum(state.data.queued);
        const totalStock = CONFIG.useProjectedStock
            ? totalOwned + totalQueued
            : totalOwned;
        const totalSold = sum(state.data.sold);

        const useHistory =
            totalSold >= CONFIG.minimumHistoricalSales;

        const targets = allocateTargets(
            buttons,
            totalStock,
            totalSold,
            useHistory
        );

        const results = buttons.map(({ genre, button }) => {
            const id = GENRES[genre];
            const owned = state.data.owned[id];
            const queued = state.data.queued[id];
            const projected = owned + queued;
            const comparison = CONFIG.useProjectedStock
                ? projected
                : owned;

            return {
                genre,
                id,
                button,
                owned,
                queued,
                projected,
                sold: state.data.sold[id],
                target: targets[id],
                diff: targets[id] - comparison
            };
        });

        const recommended = chooseRecommended(results);

        for (const result of results) {
            decorateButton(
                result,
                recommended?.genre === result.genre
            );
        }
    }

    function allocateTargets(
        buttons,
        stockTotal,
        totalSold,
        useHistory
    ) {
        const rows = buttons.map(({ genre }) => {
            const id = GENRES[genre];
            const ratio =
                useHistory && totalSold > 0
                    ? state.data.sold[id] / totalSold
                    : 1 / 8;

            const exact = ratio * stockTotal;

            return {
                id,
                target: Math.floor(exact),
                remainder: exact - Math.floor(exact)
            };
        });

        const assigned = rows.reduce(
            (total, row) => total + row.target,
            0
        );

        const remaining = Math.max(0, stockTotal - assigned);

        rows
            .sort((a, b) =>
                b.remainder - a.remainder ||
                Number(a.id) - Number(b.id)
            )
            .slice(0, remaining)
            .forEach(row => {
                row.target += 1;
            });

        return Object.fromEntries(
            rows.map(row => [row.id, row.target])
        );
    }

    function chooseRecommended(results) {
        const shortages = results.filter(result => result.diff > 0);

        if (shortages.length > 0) {
            return shortages.reduce((best, current) => {
                if (!best) {
                    return current;
                }

                if (current.diff !== best.diff) {
                    return current.diff > best.diff
                        ? current
                        : best;
                }

                if (current.sold !== best.sold) {
                    return current.sold > best.sold
                        ? current
                        : best;
                }

                return current.projected < best.projected
                    ? current
                    : best;
            }, null);
        }

        return results.reduce((best, current) => {
            if (!best) {
                return current;
            }

            if (current.projected !== best.projected) {
                return current.projected < best.projected
                    ? current
                    : best;
            }

            return current.sold > best.sold
                ? current
                : best;
        }, null);
    }

    function decorateButton(result, recommended) {
        const { button, owned, queued, projected, diff } = result;

        button.classList.add('ks-boot-host');

        let badge = button.querySelector('.ks-boot-badge');

        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'ks-boot-badge';
            button.appendChild(badge);
        }

        badge.textContent =
            queued > 0
                ? `${owned}+${queued}`
                : `${owned}`;

        badge.setAttribute(
            'aria-label',
            [
                `${owned} owned`,
                `${queued} queued`,
                `${projected} projected`,
                diff > 0
                    ? `${diff} below target`
                    : diff < 0
                        ? `${Math.abs(diff)} above target`
                        : 'On target'
            ].join(', ')
        );

        let ring = button.querySelector('.ks-boot-recommended-ring');
        let star = button.querySelector('.ks-boot-star');

        if (recommended) {
            if (!ring) {
                ring = document.createElement('span');
                ring.className = 'ks-boot-recommended-ring';
                button.appendChild(ring);
            }

            if (!star) {
                star = document.createElement('span');
                star.className = 'ks-boot-star';
                button.appendChild(star);
            }

            star.textContent = CONFIG.recommendationSymbol;
        } else {
            ring?.remove();
            star?.remove();
        }
    }

    function cleanup() {
        document
            .querySelectorAll('.ks-boot-host')
            .forEach(button => {
                button.classList.remove('ks-boot-host');
                button
                    .querySelectorAll(
                        '.ks-boot-badge, .ks-boot-star, .ks-boot-recommended-ring'
                    )
                    .forEach(element => element.remove());
            });
    }

    function requiredNumber(value) {
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

    function sum(object) {
        return Object.values(object).reduce(
            (total, value) => total + value,
            0
        );
    }

    function destroy() {
        if (state.destroyed) {
            return;
        }

        state.destroyed = true;
        clearTimeout(state.renderTimer);
        clearInterval(state.healTimer);
        state.observer?.disconnect();
        cleanup();
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
        'Visual assistance only; no automated actions.'
    );
})();
