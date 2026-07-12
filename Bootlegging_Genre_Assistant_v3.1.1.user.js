// ==UserScript==
// @name         Bootlegging Genre Assistant
// @namespace    DieselBladeScripts.ARS.Kingshade
// @version      3.1.1
// @description  Rule-conscious Bootlegging stock display and genre recommendation
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
     * Bootlegging Genre Assistant v3.1.1
     *
     * Rule-conscious behaviour:
     * - does not click anything;
     * - does not initiate or repeat Torn requests;
     * - does not perform crimes;
     * - only observes Torn data already loaded on the visible Crimes page.
     */

    const CONFIG = Object.freeze({
        useProjectedStockForRecommendation: true,
        showProjectedStock: true,
        minimumHistoricalSales: 100,
        highlightStrength: 1,
        recommendationSymbol: '★',
        debug: false
    });

    const SCRIPT = Object.freeze({
        name: 'Bootlegging Genre Assistant',
        version: '3.1.1',
        styleId: 'ks-bootlegging-assistant-styles',
        globalKey: '__ksBootleggingGenreAssistant'
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

    const previousController = win[SCRIPT.globalKey];

    if (previousController?.destroy instanceof Function) {
        try {
            previousController.destroy();
        } catch {
            // Best-effort cleanup of an older injected instance.
        }
    }

    const state = {
        data: null,
        observer: null,
        renderTimer: null,
        healTimer: null,
        lastSignature: '',
        active: false,
        destroyed: false,
        originalFetch: null,
        observedFetch: null,
    };

    function log(...values) {
        if (CONFIG.debug) {
            console.log(`[${SCRIPT.name} v${SCRIPT.version}]`, ...values);
        }
    }

    function logError(message, error) {
        console.error(`[${SCRIPT.name} v${SCRIPT.version}] ${message}`, error);
    }

    function installStyles() {
        document.getElementById(SCRIPT.styleId)?.remove();

        const style = document.createElement('style');
        style.id = SCRIPT.styleId;

        const glow =
            CONFIG.highlightStrength === 2
                ? '0 0 10px rgba(75, 200, 105, 0.95)'
                : CONFIG.highlightStrength === 1
                    ? '0 0 6px rgba(75, 200, 105, 0.65)'
                    : 'none';

        style.textContent = `
            .ks-boot-genre {
                position: relative !important;
                box-sizing: border-box !important;
                padding-bottom: 18px !important;
                overflow: hidden !important;
            }

            .ks-boot-stock-line {
                position: absolute !important;
                left: 2px !important;
                right: 2px !important;
                bottom: 2px !important;
                z-index: 4 !important;
                display: block !important;
                box-sizing: border-box !important;
                height: 14px !important;
                margin: 0 !important;
                padding: 0 2px !important;
                overflow: hidden !important;
                color: #555 !important;
                font-size: 11px !important;
                font-weight: 700 !important;
                line-height: 14px !important;
                text-align: center !important;
                text-overflow: ellipsis !important;
                white-space: nowrap !important;
                background: rgba(255, 255, 255, 0.68) !important;
                border-radius: 3px !important;
                pointer-events: none !important;
            }

            .dark-mode .ks-boot-stock-line,
            [class*="dark"] .ks-boot-stock-line {
                color: #ddd !important;
                background: rgba(20, 20, 20, 0.72) !important;
            }

            .ks-boot-recommended {
                outline: 3px solid #45c96f !important;
                outline-offset: -3px !important;
                box-shadow: ${glow} !important;
            }

            .ks-boot-star {
                position: absolute !important;
                top: 2px !important;
                right: 4px !important;
                z-index: 6 !important;
                color: #178d42 !important;
                font-size: 15px !important;
                font-weight: 900 !important;
                line-height: 16px !important;
                text-shadow:
                    0 1px 1px rgba(255, 255, 255, 0.9),
                    0 0 3px rgba(69, 201, 111, 0.8) !important;
                pointer-events: none !important;
            }

            @media (max-width: 480px) {
                .ks-boot-stock-line {
                    font-size: 10px !important;
                    letter-spacing: 0 !important;
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
            log('window.fetch is not available.');
            return;
        }

        const originalFetch = win.fetch.bind(win);
        state.originalFetch = win.fetch;

        const observedFetch = async function (...args) {
            const response = await originalFetch(...args);

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
                    inspectCrimesResponse(response.clone()).catch(error => {
                        logError('Could not inspect crimesData.', error);
                    });
                }
            } catch (error) {
                logError('Fetch observation failed.', error);
            }

            return response;
        };

        try {
            Object.defineProperty(observedFetch, 'name', {
                value: 'fetch',
                configurable: true
            });
        } catch {
            // Cosmetic only.
        }

        state.observedFetch = observedFetch;
        win.fetch = observedFetch;
        log('Fetch observer installed.');
    }

    async function inspectCrimesResponse(response) {
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
            if (state.active) {
                state.active = false;
                state.data = null;
                cleanupInterface();
            }
            return;
        }

        state.data = parsed;
        state.active = true;
        scheduleRender(40);
    }

    function parseBootleggingData(db) {
        const rawOwned = db?.generalInfo?.CDs;

        if (!rawOwned || typeof rawOwned !== 'object' || Array.isArray(rawOwned)) {
            return null;
        }

        const owned = {};
        const queued = {};
        const sold = {};

        for (let number = 1; number <= 8; number += 1) {
            const id = String(number);

            const ownedValue = parseRequiredNonNegativeNumber(
                rawOwned[id] ?? rawOwned[number]
            );

            if (ownedValue === null) {
                log(`Missing or invalid owned value for genre ${number}.`);
                return null;
            }

            owned[id] = ownedValue;
            queued[id] = 0;

            const soldValue = findSoldStatistic(db, number);

            if (soldValue === null) {
                log(`Missing or invalid sold statistic for genre ${number}.`);
                return null;
            }

            sold[id] = soldValue;
        }

        const queue = findBootleggingQueue(db);

        if (queue === null) {
            log('Bootlegging queue could not be identified.');
            return null;
        }

        for (const rawId of queue) {
            const id = String(rawId);

            if (!Object.prototype.hasOwnProperty.call(queued, id)) {
                log(`Unknown queue genre id: ${id}`);
                return null;
            }

            queued[id] += 1;
        }

        return {
            owned,
            queued,
            sold,
            genres: GENRES,
            receivedAt: Date.now()
        };
    }

    function findSoldStatistic(db, number) {
        const wantedName = `CDType${number}Sold`;
        const sources = [
            db?.currentUserStats,
            db?.currentUserStatistics
        ];

        for (const source of sources) {
            if (!source) {
                continue;
            }

            if (!Array.isArray(source) && typeof source === 'object') {
                const direct = parseRequiredNonNegativeNumber(source[wantedName]);

                if (direct !== null) {
                    return direct;
                }
            }

            if (Array.isArray(source)) {
                const entry = source.find(item =>
                    item?.key === wantedName ||
                    item?.name === wantedName ||
                    item?.title === wantedName
                );

                const parsed = parseRequiredNonNegativeNumber(entry?.value);

                if (parsed !== null) {
                    return parsed;
                }
            }
        }

        return null;
    }

    function findBootleggingQueue(db) {
        const crimesByType = db?.crimesByType;

        if (!crimesByType || typeof crimesByType !== 'object') {
            return null;
        }

        const queues = Object.values(crimesByType)
            .map(entry => entry?.additionalInfo?.currentQueue)
            .filter(Array.isArray);

        if (queues.length !== 1) {
            return null;
        }

        return queues[0];
    }

    function beginObserving() {
        if (state.destroyed) {
            return;
        }

        installStyles();
        state.observer?.disconnect();

        state.observer = new MutationObserver(mutations => {
            if (!state.active || !state.data || state.destroyed) {
                return;
            }

            const hasRelevantMutation = mutations.some(mutation => {
                const changedNodes = [
                    ...mutation.addedNodes,
                    ...mutation.removedNodes
                ];

                if (
                    changedNodes.length > 0 &&
                    changedNodes.every(isOwnInterfaceNode)
                ) {
                    return false;
                }

                const target = mutation.target;

                if (
                    target instanceof Element &&
                    (
                        target.matches('.ks-boot-stock-line, .ks-boot-star') ||
                        target.closest('.ks-boot-stock-line, .ks-boot-star')
                    )
                ) {
                    return false;
                }

                return true;
            });

            if (hasRelevantMutation) {
                scheduleRender(80);
            }
        });

        state.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'aria-label']
        });

        startSelfHeal();
        scheduleRender(100);
    }

    function isOwnInterfaceNode(node) {
        if (!(node instanceof Element)) {
            return node.nodeType === Node.TEXT_NODE &&
                node.parentElement?.closest(
                    '.ks-boot-stock-line, .ks-boot-star'
                );
        }

        return (
            node.matches('.ks-boot-stock-line, .ks-boot-star') ||
            Boolean(node.closest('.ks-boot-stock-line, .ks-boot-star'))
        );
    }

    function startSelfHeal() {
        clearInterval(state.healTimer);

        state.healTimer = setInterval(() => {
            if (
                state.destroyed ||
                !state.active ||
                !state.data
            ) {
                return;
            }

            const buttons = getGenreButtons();

            if (
                buttons.length === 8 &&
                buttons.some(({ button }) =>
                    !button.querySelector('.ks-boot-stock-line')
                )
            ) {
                scheduleRender(0);
            }
        }, 500);
    }

    function scheduleRender(delay = 80) {
        clearTimeout(state.renderTimer);
        clearInterval(state.healTimer);

        state.renderTimer = setTimeout(() => {
            if (state.destroyed) {
                return;
            }

            try {
                render();
            } catch (error) {
                logError('Rendering failed.', error);
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
            const genre = readGenreName(button);

            if (genre && GENRES[genre] && !unique.has(genre)) {
                unique.set(genre, button);
            }
        }

        return Array.from(unique.entries()).map(([genre, button]) => ({
            genre,
            button
        }));
    }

    function readGenreName(button) {
        const ariaLabel = button.getAttribute('aria-label') || '';

        const ariaGenre = ariaLabel
            .split(' - ')[0]
            .replace(/^Copying\s+/i, '')
            .trim();

        if (GENRES[ariaGenre]) {
            return ariaGenre;
        }

        const visibleText = button.textContent || '';

        return Object.keys(GENRES).find(genre =>
            visibleText.includes(genre)
        ) || '';
    }

    function render() {
        if (!state.active || !state.data || state.destroyed) {
            return;
        }

        const genreButtons = getGenreButtons();

        if (genreButtons.length !== 8) {
            log(`Expected 8 genre buttons, found ${genreButtons.length}.`);
            return;
        }

        const totalOwned = sumValues(state.data.owned);
        const totalQueued = sumValues(state.data.queued);
        const totalProjected = totalOwned + totalQueued;
        const totalSold = sumValues(state.data.sold);

        const useHistoricalRatios =
            totalSold >= CONFIG.minimumHistoricalSales;

        const recommendationStockTotal =
            CONFIG.useProjectedStockForRecommendation
                ? totalProjected
                : totalOwned;

        const targets = allocateTargets(
            genreButtons,
            state.data,
            recommendationStockTotal,
            totalSold,
            useHistoricalRatios
        );

        const results = genreButtons.map(({ genre, button }) => {
            const id = state.data.genres[genre];
            const owned = state.data.owned[id];
            const queued = state.data.queued[id];
            const projected = owned + queued;
            const historicalSold = state.data.sold[id];
            const target = targets[id];

            const comparisonStock =
                CONFIG.useProjectedStockForRecommendation
                    ? projected
                    : owned;

            return {
                genre,
                id,
                button,
                owned,
                queued,
                projected,
                historicalSold,
                target,
                diff: target - comparisonStock
            };
        });

        if (!validateResults(results, recommendationStockTotal)) {
            log('Result validation failed. Recommendation suppressed.');
            cleanupInterface();
            return;
        }

        const recommended = chooseRecommendedGenre(results);
        const maxShortage = Math.max(
            0,
            ...results.map(result => result.diff)
        );

        const signature = createSignature(results, recommended);

        const interfaceIncomplete = results.some(result => {
            const shouldBeRecommended =
                recommended?.genre === result.genre;

            return (
                !result.button.querySelector('.ks-boot-stock-line') ||
                result.button.classList.contains('ks-boot-recommended') !==
                    shouldBeRecommended ||
                Boolean(result.button.querySelector('.ks-boot-star')) !==
                    shouldBeRecommended
            );
        });

        if (
            signature === state.lastSignature &&
            !interfaceIncomplete
        ) {
            return;
        }

        state.lastSignature = signature;

        results.forEach(result => {
            renderGenreButton({
                result,
                recommended: recommended?.genre === result.genre
            });
        });

        log('Rendered results:', results);
    }

    function allocateTargets(
        genreButtons,
        data,
        stockTotal,
        totalSold,
        useHistoricalRatios
    ) {
        const exact = genreButtons.map(({ genre }) => {
            const id = data.genres[genre];

            const ratio =
                useHistoricalRatios && totalSold > 0
                    ? data.sold[id] / totalSold
                    : 1 / 8;

            const exactTarget = ratio * stockTotal;
            const floorTarget = Math.floor(exactTarget);

            return {
                id,
                floorTarget,
                remainder: exactTarget - floorTarget
            };
        });

        let assigned = exact.reduce(
            (sum, item) => sum + item.floorTarget,
            0
        );

        const remaining = Math.max(0, stockTotal - assigned);

        exact
            .sort((a, b) =>
                b.remainder - a.remainder ||
                Number(a.id) - Number(b.id)
            )
            .slice(0, remaining)
            .forEach(item => {
                item.floorTarget += 1;
                assigned += 1;
            });

        return Object.fromEntries(
            exact.map(item => [item.id, item.floorTarget])
        );
    }

    function chooseRecommendedGenre(results) {
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

                if (current.historicalSold !== best.historicalSold) {
                    return current.historicalSold > best.historicalSold
                        ? current
                        : best;
                }

                return current.projected < best.projected
                    ? current
                    : best;
            }, null);
        }

        return results.reduce((lowest, current) => {
            if (!lowest) {
                return current;
            }

            if (current.projected !== lowest.projected) {
                return current.projected < lowest.projected
                    ? current
                    : lowest;
            }

            return current.historicalSold > lowest.historicalSold
                ? current
                : lowest;
        }, null);
    }

    function validateResults(results, expectedTargetTotal) {
        return (
            results.length === 8 &&
            results.every(result =>
                GENRES[result.genre] &&
                Number.isFinite(result.owned) &&
                Number.isFinite(result.queued) &&
                Number.isFinite(result.projected) &&
                Number.isFinite(result.target) &&
                Number.isFinite(result.diff) &&
                result.owned >= 0 &&
                result.queued >= 0 &&
                result.projected >= 0 &&
                result.target >= 0
            ) &&
            results.reduce(
                (sum, result) => sum + result.target,
                0
            ) === expectedTargetTotal
        );
    }

    function createSignature(results, recommended) {
        return [
            `recommended=${recommended?.genre || 'none'}`,
            ...results
                .map(result =>
                    [
                        result.genre,
                        result.owned,
                        result.queued,
                        result.target,
                        result.diff
                    ].join(':')
                )
                .sort()
        ].join('|');
    }

    function renderGenreButton({
        result,
        recommended
    }) {
        const {
            button,
            owned,
            queued,
            projected,
            diff
        } = result;

        button.classList.add('ks-boot-genre');
        button.classList.toggle(
            'ks-boot-recommended',
            recommended
        );

        renderStockLine(button, {
            owned,
            queued,
            projected,
            diff
        });
        renderRecommendationStar(button, recommended);
    }

    function renderStockLine(
        button,
        { owned, queued, projected, diff }
    ) {
        let line = button.querySelector('.ks-boot-stock-line');

        if (!line) {
            line = document.createElement('span');
            line.className = 'ks-boot-stock-line';
            button.appendChild(line);
        }

        const stockPart =
            queued > 0
                ? CONFIG.showProjectedStock
                    ? `${owned}+${queued}=${projected}`
                    : `${owned}+${queued}`
                : `${owned}`;

        line.textContent = stockPart;
        line.setAttribute(
            'aria-label',
            [
                `${owned} currently owned`,
                `${queued} currently queued`,
                `${projected} projected total`,
                diff > 0
                    ? `${diff} below target`
                    : diff < 0
                        ? `${Math.abs(diff)} above target`
                        : 'On target'
            ].join(' · ')
        );
    }

    function renderRecommendationStar(button, recommended) {
        let star = button.querySelector('.ks-boot-star');

        if (recommended) {
            if (!star) {
                star = document.createElement('span');
                star.className = 'ks-boot-star';
                button.appendChild(star);
            }

            star.textContent = CONFIG.recommendationSymbol;
            star.setAttribute('aria-label', 'Recommended genre');
        } else {
            star?.remove();
        }
    }

    function cleanupInterface() {
        document
            .querySelectorAll('.ks-boot-genre')
            .forEach(button => {
                button.classList.remove(
                    'ks-boot-genre',
                    'ks-boot-recommended'
                );

                button
                    .querySelectorAll(
                        '.ks-boot-stock-line, .ks-boot-star'
                    )
                    .forEach(element => element.remove());
            });

        state.lastSignature = '';
    }

    function parseRequiredNonNegativeNumber(value) {
        if (
            value === null ||
            value === undefined ||
            value === ''
        ) {
            return null;
        }

        const parsed = Number(value);

        return Number.isFinite(parsed) && parsed >= 0
            ? parsed
            : null;
    }

    function sumValues(object) {
        return Object.values(object).reduce(
            (total, value) => total + value,
            0
        );
    }

    function clamp(value, minimum, maximum) {
        return Math.min(
            maximum,
            Math.max(minimum, value)
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
        cleanupInterface();
        document.getElementById(SCRIPT.styleId)?.remove();

        if (
            state.originalFetch &&
            state.observedFetch &&
            win.fetch === state.observedFetch
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
            beginObserving,
            { once: true }
        );
    } else {
        beginObserving();
    }

    console.info(
        `[${SCRIPT.name}] Version ${SCRIPT.version} loaded. ` +
        'Visual assistance only; no automated actions.'
    );
})();
