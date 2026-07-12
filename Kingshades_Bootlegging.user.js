// ==UserScript==
// @name         Kingshade's Bootlegging
// @namespace    DieselBladeScripts.ARS.Kingshade
// @version      3.4.0
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
     * Kingshade's Bootlegging v3.4.0
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
        name: "Kingshade's Bootlegging",
        version: '3.4.0',
        styleId: 'ks-boot-v340-styles',
        panelId: 'ks-boot-v340-panel',
        globalKey: '__ksBootleggingAssistant'
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
            #${SCRIPT.panelId} {
                margin: 8px 0 10px !important;
                padding: 10px 12px !important;
                box-sizing: border-box !important;

                border: 2px solid #777 !important;
                border-radius: 7px !important;
                background: rgba(20, 20, 20, 0.94) !important;
                color: #fff !important;

                font-family: Arial, sans-serif !important;
                text-align: center !important;
            }

            #${SCRIPT.panelId}.ks-mode-copy {
                border-color: #4aa3ff !important;
                box-shadow: 0 0 8px rgba(74, 163, 255, 0.45) !important;
            }

            #${SCRIPT.panelId}.ks-mode-sell {
                border-color: #45c96f !important;
                box-shadow: 0 0 8px rgba(69, 201, 111, 0.45) !important;
            }

            #${SCRIPT.panelId}.ks-mode-wait {
                border-color: #e0ad35 !important;
                box-shadow: 0 0 8px rgba(224, 173, 53, 0.42) !important;
            }

            .ks-boot-heading {
                display: block !important;
                margin-bottom: 4px !important;

                color: #c9c9c9 !important;
                font-size: 10px !important;
                font-weight: 800 !important;
                letter-spacing: 0.8px !important;
                line-height: 12px !important;
                text-transform: uppercase !important;
            }

            .ks-boot-command {
                display: block !important;
                margin-bottom: 5px !important;

                font-size: 20px !important;
                font-weight: 900 !important;
                line-height: 23px !important;
            }

            .ks-mode-copy .ks-boot-command {
                color: #72b8ff !important;
            }

            .ks-mode-sell .ks-boot-command {
                color: #69df8e !important;
            }

            .ks-mode-wait .ks-boot-command {
                color: #f0c65e !important;
            }

            .ks-boot-step {
                display: block !important;
                margin-top: 2px !important;

                color: #ececec !important;
                font-size: 11px !important;
                font-weight: 700 !important;
                line-height: 15px !important;
            }

            .ks-boot-note {
                display: block !important;
                margin-top: 5px !important;

                color: #bdbdbd !important;
                font-size: 9px !important;
                line-height: 12px !important;
            }

            .ks-boot-highlight-host {
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
                    0 0 8px rgba(74, 163, 255, 0.72) !important;

                pointer-events: none !important;
            }

            .ks-boot-highlight::after {
                content: "★" !important;
                position: absolute !important;
                top: 1px !important;
                right: 3px !important;

                color: #72b8ff !important;
                font-size: 14px !important;
                font-weight: 900 !important;
                line-height: 15px !important;
                text-shadow:
                    0 1px 1px #fff,
                    0 0 3px rgba(74, 163, 255, 0.9) !important;
            }

            @media (max-width: 480px) {
                .ks-boot-command {
                    font-size: 18px !important;
                    line-height: 21px !important;
                }

                .ks-boot-step {
                    font-size: 10px !important;
                    line-height: 14px !important;
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
            cleanupInterface();
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
                scheduleRender(45);
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
                !document.getElementById(SCRIPT.panelId)
            ) {
                scheduleRender(0);
            }
        }, 400);
    }

    function isOwnNode(node) {
        if (!(node instanceof Element)) {
            return false;
        }

        return (
            node.id === SCRIPT.panelId ||
            node.matches('.ks-boot-highlight') ||
            Boolean(node.closest(`#${SCRIPT.panelId}, .ks-boot-highlight`))
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

        renderPanel(buttons, instruction);
        renderHighlight(rows, instruction);
    }

    function determineInstruction(rows) {
        const needsRefill = rows.filter(
            row => row.owned <= row.refillAt
        );

        if (needsRefill.length === 0) {
            return {
                mode: 'sell',
                command: 'SELL NOW',
                steps: [
                    'Tap "Sell Counterfeit DVDs".',
                    'Keep selling until this box changes.'
                ],
                note:
                    'The script will switch to COPY when a genre reaches its refill level.'
            };
        }

        const notCoveredByQueue = needsRefill.filter(
            row => row.projected < row.target
        );

        if (notCoveredByQueue.length === 0) {
            const waitingFor = needsRefill
                .filter(row => row.queued > 0)
                .sort((a, b) => a.completion - b.completion)[0];

            return {
                mode: 'wait',
                command: 'WAIT',
                steps: [
                    'Your queued copies already cover the refill.',
                    waitingFor
                        ? `Wait for ${waitingFor.genre} to finish copying.`
                        : 'Wait for the copying queue to finish.'
                ],
                note:
                    'Do not add more copies unless this instruction changes.'
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

        const remaining = Math.max(
            0,
            selected.target - selected.projected
        );

        return {
            mode: 'copy',
            genre: selected.genre,
            command: `COPY ${selected.genre.toUpperCase()}`,
            steps: [
                `Tap "${selected.genre}".`,
                `Add ${remaining} more to the copying queue.`,
                `Stop when stock + queued reaches ${selected.target}.`
            ],
            note:
                'Queued copies count toward the target. The instruction updates automatically.'
        };
    }

    function renderPanel(buttons, instruction) {
        const commonContainer = findCommonContainer(
            buttons.map(item => item.button)
        );

        if (!commonContainer?.parentElement) {
            return;
        }

        let panel = document.getElementById(SCRIPT.panelId);

        if (!panel) {
            panel = document.createElement('div');
            panel.id = SCRIPT.panelId;
            commonContainer.parentElement.insertBefore(
                panel,
                commonContainer
            );
        }

        panel.className = `ks-mode-${instruction.mode}`;
        panel.replaceChildren();

        const heading = document.createElement('span');
        heading.className = 'ks-boot-heading';
        heading.textContent = 'Follow this instruction';

        const command = document.createElement('span');
        command.className = 'ks-boot-command';
        command.textContent = instruction.command;

        panel.append(heading, command);

        instruction.steps.forEach((text, index) => {
            const step = document.createElement('span');
            step.className = 'ks-boot-step';
            step.textContent = `${index + 1}. ${text}`;
            panel.appendChild(step);
        });

        const note = document.createElement('span');
        note.className = 'ks-boot-note';
        note.textContent = instruction.note;
        panel.appendChild(note);
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

    function cleanupInterface() {
        document.getElementById(SCRIPT.panelId)?.remove();

        document
            .querySelectorAll('.ks-boot-highlight-host')
            .forEach(button => {
                button.classList.remove('ks-boot-highlight-host');
                button
                    .querySelectorAll('.ks-boot-highlight')
                    .forEach(element => element.remove());
            });
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
