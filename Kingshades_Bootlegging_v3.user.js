// ==UserScript==
// @name         Kingshade's Bootlegging
// @namespace    DieselBladeScripts.ARS.Kingshade
// @version      3.3.0
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

        // Stop selling before a genre reaches zero.
        // A projected stock of 10 or less triggers COPY mode.
        minimumSafeStock: 10,

        debug: false
    });

    const SCRIPT = Object.freeze({
        name: "Kingshade's Bootlegging",
        version: '3.3.0',
        styleId: 'ks-boot-v330-styles',
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
            .ks-boot-panel {
                margin: 8px 0 10px !important;
                padding: 9px 10px !important;
                box-sizing: border-box !important;

                border-radius: 6px !important;
                border: 2px solid rgba(255,255,255,.18) !important;
                background: rgba(20,20,20,.92) !important;
                color: #fff !important;

                font-family: Arial, sans-serif !important;
                text-align: center !important;
            }

            .ks-boot-panel-copy {
                border-color: #4aa3ff !important;
                box-shadow: 0 0 7px rgba(74,163,255,.45) !important;
            }

            .ks-boot-panel-sell {
                border-color: #45c96f !important;
                box-shadow: 0 0 7px rgba(69,201,111,.45) !important;
            }

            .ks-boot-panel-title {
                display: block !important;
                margin-bottom: 3px !important;

                color: #c7c7c7 !important;
                font-size: 10px !important;
                font-weight: 700 !important;
                letter-spacing: .7px !important;
                line-height: 12px !important;
                text-transform: uppercase !important;
            }

            .ks-boot-panel-action {
                display: block !important;

                font-size: 18px !important;
                font-weight: 900 !important;
                line-height: 22px !important;
            }

            .ks-boot-panel-copy .ks-boot-panel-action {
                color: #72b8ff !important;
            }

            .ks-boot-panel-sell .ks-boot-panel-action {
                color: #69df8e !important;
            }

            .ks-boot-panel-note {
                display: block !important;
                margin-top: 3px !important;

                color: #d0d0d0 !important;
                font-size: 10px !important;
                line-height: 13px !important;
            }

            .ks-boot-host {
                position: relative !important;
            }

            .ks-boot-recommended-ring {
                position: absolute !important;
                inset: 0 !important;
                z-index: 19 !important;
                border: 3px solid #4aa3ff !important;
                border-radius: inherit !important;
                box-sizing: border-box !important;
                box-shadow:
                    inset 0 0 0 1px rgba(255,255,255,.45),
                    0 0 7px rgba(74,163,255,.65) !important;
                pointer-events: none !important;
            }

            .ks-boot-star {
                position: absolute !important;
                top: 1px !important;
                right: 3px !important;
                z-index: 21 !important;

                color: #72b8ff !important;
                font-size: 14px !important;
                font-weight: 900 !important;
                line-height: 15px !important;
                text-shadow: 0 1px 1px #fff, 0 0 3px rgba(74,163,255,.9) !important;

                pointer-events: none !important;
            }

            @media (max-width: 480px) {
                .ks-boot-panel-action {
                    font-size: 17px !important;
                }

                .ks-boot-star {
                    right: 2px !important;
                    font-size: 13px !important;
                }
            }


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
                !document.querySelector('.ks-boot-panel')
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
                '.ks-boot-panel, .ks-boot-star, .ks-boot-recommended-ring'
            ) ||
            Boolean(
                node.closest(
                    '.ks-boot-panel, .ks-boot-star, .ks-boot-recommended-ring'
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

        const recommendation = chooseRecommendation(results);

        renderInstructionPanel(buttons, recommendation);

        for (const result of results) {
            decorateButton(
                result,
                recommendation.mode === 'copy' &&
                    recommendation.genre === result.genre
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

    function chooseRecommendation(results) {
        const criticallyLow = results.filter(
            result => result.projected <= CONFIG.minimumSafeStock
        );

        if (criticallyLow.length === 0) {
            return {
                mode: 'sell',
                genre: null,
                reason:
                    `All genres are above ${CONFIG.minimumSafeStock}. ` +
                    'Sell until one reaches the safety limit.'
            };
        }

        const selected = criticallyLow.reduce((best, current) => {
            if (!best) {
                return current;
            }

            if (current.diff !== best.diff) {
                return current.diff > best.diff
                    ? current
                    : best;
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

        return {
            mode: 'copy',
            genre: selected.genre,
            reason:
                `${selected.genre} is at ${selected.projected}. ` +
                `Build it above ${CONFIG.minimumSafeStock}.`
        };
    }

    function renderInstructionPanel(buttons, recommendation) {
        const firstButton = buttons[0]?.button;

        if (!firstButton) {
            return;
        }

        const container =
            firstButton.parentElement?.parentElement ||
            firstButton.parentElement;

        if (!container) {
            return;
        }

        let panel = container.querySelector(':scope > .ks-boot-panel');

        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'ks-boot-panel';
            container.insertBefore(panel, container.firstChild);
        }

        panel.classList.toggle(
            'ks-boot-panel-copy',
            recommendation.mode === 'copy'
        );
        panel.classList.toggle(
            'ks-boot-panel-sell',
            recommendation.mode === 'sell'
        );

        panel.replaceChildren();

        const title = document.createElement('span');
        title.className = 'ks-boot-panel-title';
        title.textContent = 'Do this';

        const action = document.createElement('span');
        action.className = 'ks-boot-panel-action';
        action.textContent =
            recommendation.mode === 'copy'
                ? `Copy ${recommendation.genre}`
                : 'Sell DVDs';

        const note = document.createElement('span');
        note.className = 'ks-boot-panel-note';
        note.textContent = recommendation.reason;

        panel.append(title, action, note);
    }

    function decorateButton(result, recommended) {
        const { button } = result;

        button.classList.add('ks-boot-host');

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

            star.textContent = '★';
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
                        '.ks-boot-panel, .ks-boot-star, .ks-boot-recommended-ring'
                    )
                    .forEach(element => element.remove());
            });

        document
            .querySelectorAll('.ks-boot-panel')
            .forEach(panel => panel.remove());
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
