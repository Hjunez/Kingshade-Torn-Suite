// ==UserScript==
// @name         Kingshade's Card Skimming
// @namespace    Kingshade.Torn.Suite
// @version      1.2.3-test
// @description  Minimal location-aware Card Skimming assistant for Torn PDA.
// @author       Kingshade
// @license      MIT
// @match        https://www.torn.com/loader.php?sid=crimes*
// @match        https://www.torn.com/page.php?sid=crimes*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(() => {
    'use strict';

    const SCRIPT = Object.freeze({
        name: "Kingshade's Card Skimming",
        version: '1.2.3-test',
        styleId: 'ks-card-skimming-v123-test-styles',
        globalKey: '__ksCardSkimmingAssistant'
    });

    const CONFIG = Object.freeze({
        thresholds: Object.freeze({
            'Gas Station': 100,
            'Post Office': 870,
            'Subway Station': 415,
            'College Campus': 156
        }),
        locationAliases: Object.freeze({
            'Gas Station': ['Gas Station'],
            'Post Office': ['Post Office'],
            'Subway Station': ['Subway Station', 'Subway'],
            'College Campus': ['College Campus', 'College']
        }),
        maxSkimmers: 20,
        sellAtDetails: 10000,
        renderDelayMs: 100,
        healIntervalMs: 600
    });

    const win =
        typeof unsafeWindow !== 'undefined'
            ? unsafeWindow
            : window;

    const previous = win[SCRIPT.globalKey];

    if (previous?.destroy instanceof Function) {
        try {
            previous.destroy();
        } catch (_) {}
    }

    const state = {
        destroyed: false,
        observer: null,
        renderTimer: null,
        healTimer: null
    };

    function installStyles() {
        document.getElementById(SCRIPT.styleId)?.remove();

        const style = document.createElement('style');
        style.id = SCRIPT.styleId;
        style.textContent = `
            .ks-card-target-blue,
            .ks-card-target-green {
                position: relative !important;
                outline-offset: -3px !important;
                box-sizing: border-box !important;
            }

            .ks-card-target-blue {
                outline: 3px solid #4aa3ff !important;
                box-shadow:
                    inset 0 0 0 1px rgba(255,255,255,.35),
                    0 0 8px rgba(74,163,255,.75) !important;
            }

            .ks-card-target-green {
                outline: 3px solid #45c96f !important;
                box-shadow:
                    inset 0 0 0 1px rgba(255,255,255,.35),
                    0 0 8px rgba(69,201,111,.75) !important;
            }

            .ks-card-star {
                position: absolute !important;
                top: 2px !important;
                right: 4px !important;
                z-index: 60 !important;
                font-size: 14px !important;
                font-weight: 900 !important;
                line-height: 15px !important;
                pointer-events: none !important;
            }

            .ks-card-target-blue > .ks-card-star {
                color: #72b8ff !important;
                text-shadow:
                    0 1px 1px #fff,
                    0 0 3px rgba(74,163,255,.9) !important;
            }

            .ks-card-target-green > .ks-card-star {
                color: #69df8e !important;
                text-shadow:
                    0 1px 1px #fff,
                    0 0 3px rgba(69,201,111,.9) !important;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    function isCardSkimmingPage() {
        const pageText = normalizeText(
            document.body?.innerText || document.body?.textContent
        );

        return (
            window.location.href.toLowerCase().includes('cardskimming') ||
            (
                pageText.includes('Card Skimming') &&
                pageText.includes('Sell Card Details')
            )
        );
    }

    function normalizeText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function clearMarkers() {
        document
            .querySelectorAll(
                '.ks-card-target-blue, .ks-card-target-green'
            )
            .forEach(element => {
                element.classList.remove(
                    'ks-card-target-blue',
                    'ks-card-target-green'
                );
            });

        document
            .querySelectorAll('.ks-card-star')
            .forEach(element => element.remove());
    }

    function mark(element, colour) {
        if (!(element instanceof Element)) {
            return;
        }

        clearMarkers();

        element.classList.add(
            colour === 'green'
                ? 'ks-card-target-green'
                : 'ks-card-target-blue'
        );

        const star = document.createElement('span');
        star.className = 'ks-card-star';
        star.textContent = '★';
        element.appendChild(star);
    }

    function parseNumber(value) {
        const match = String(value || '').match(/[\d,]+/);
        return match
            ? Number(match[0].replace(/,/g, ''))
            : 0;
    }

    function identifyLocation(text) {
        const normalized = normalizeText(text).toLowerCase();

        for (
            const [location, aliases]
            of Object.entries(CONFIG.locationAliases)
        ) {
            if (
                aliases.some(alias =>
                    normalized.includes(alias.toLowerCase())
                )
            ) {
                return location;
            }
        }

        return null;
    }

    function getSkimmerRows() {
        const root =
            document.querySelector('div.crime-root.cardskimming-root') ||
            document;

        const explicitRows = Array.from(
            root.querySelectorAll('div[class*="virtualItem___"]')
        );

        const fallbackRows = Array.from(
            root.querySelectorAll('div')
        ).filter(element => {
            const text = normalizeText(element.textContent);

            if (
                !/\bActive\b/i.test(text) ||
                !/(day|days|hour|hours|minute|minutes)/i.test(text) ||
                !identifyLocation(text)
            ) {
                return false;
            }

            const rect = element.getBoundingClientRect();

            if (
                rect.width < 250 ||
                rect.height < 55 ||
                rect.height > 140
            ) {
                return false;
            }

            return true;
        });

        const rows = explicitRows.length
            ? explicitRows
            : fallbackRows;

        return rows
            .map(row => {
                const text = normalizeText(row.textContent);
                const location = identifyLocation(text);

                if (!location) {
                    return null;
                }

                const classCards =
                    row.querySelector('[class*="statusCards___"]');

                let cards = classCards
                    ? parseNumber(classCards.textContent)
                    : 0;

                if (!cards) {
                    const activeIndex = text.search(/\bActive\b/i);
                    const beforeActive =
                        activeIndex >= 0
                            ? text.slice(0, activeIndex)
                            : text;

                    const numbers = Array.from(
                        beforeActive.matchAll(/\b(\d[\d,]*)\b/g)
                    ).map(match =>
                        Number(match[1].replace(/,/g, ''))
                    );

                    cards = numbers.length
                        ? numbers[numbers.length - 1]
                        : 0;
                }

                const threshold = CONFIG.thresholds[location];
                const action = findRecoverControl(row);

                return {
                    row,
                    action,
                    location,
                    cards,
                    threshold,
                    ratio: threshold > 0
                        ? cards / threshold
                        : 0
                };
            })
            .filter(Boolean);
    }

    function isEnabledControl(element) {
        return (
            element instanceof Element &&
            !element.hasAttribute('disabled') &&
            element.getAttribute('aria-disabled') !== 'true'
        );
    }

    function findRecoverControl(row) {
        const candidates = Array.from(
            row.querySelectorAll(
                'button, [role="button"]'
            )
        ).filter(isEnabledControl);

        const named = candidates.find(element => {
            const text = normalizeText(element.textContent);
            const aria = normalizeText(
                element.getAttribute('aria-label')
            );
            const title = normalizeText(
                element.getAttribute('title')
            );

            return (
                /\bRecover\b/i.test(text) ||
                /\bRecover\b/i.test(aria) ||
                /\bRecover\b/i.test(title) ||
                /\bCollect\b/i.test(text) ||
                /\bCollect\b/i.test(aria) ||
                /\bCollect\b/i.test(title)
            );
        });

        if (named) {
            return named;
        }

        /*
         * Torn currently uses an icon-only recovery control at the far
         * right of each active skimmer row.
         */
        return candidates.length
            ? candidates[candidates.length - 1]
            : row;
    }

    function findSellSection() {
        const root =
            document.querySelector('div.crime-root.cardskimming-root') ||
            document;

        const labels = Array.from(
            root.querySelectorAll('div, span, strong')
        ).filter(element =>
            normalizeText(element.textContent) ===
            'Sell Card Details'
        );

        for (const label of labels) {
            let candidate = label.parentElement;

            for (let depth = 0; depth < 5 && candidate; depth += 1) {
                const rect = candidate.getBoundingClientRect();
                const text = normalizeText(candidate.textContent);
                const hasDetails =
                    /\b[\d,]+\s+Card Details\b/i.test(text);
                const hasControl = Boolean(
                    candidate.querySelector(
                        'button, [role="button"]'
                    )
                );

                if (
                    rect.width >= 250 &&
                    rect.height >= 55 &&
                    rect.height <= 150 &&
                    hasDetails &&
                    hasControl
                ) {
                    return candidate;
                }

                candidate = candidate.parentElement;
            }
        }

        return null;
    }

    function getSellState() {
        const section = findSellSection();

        if (!section) {
            return {
                section: null,
                details: 0,
                control: null
            };
        }

        const text = normalizeText(section.textContent);
        const match = text.match(
            /Sell Card Details\s+([\d,]+)\s+Card Details/i
        );

        const details = match
            ? Number(match[1].replace(/,/g, ''))
            : 0;

        const controls = Array.from(
            section.querySelectorAll(
                'button, [role="button"]'
            )
        ).filter(isEnabledControl);

        return {
            section,
            details,
            control: controls.length
                ? controls[controls.length - 1]
                : section
        };
    }

    function findInstallControl() {
        const root =
            document.querySelector('div.crime-root.cardskimming-root') ||
            document;

        const explicit = Array.from(
            root.querySelectorAll(
                'button, [role="button"]'
            )
        ).find(element => {
            const text = normalizeText(element.textContent);
            const aria = normalizeText(
                element.getAttribute('aria-label')
            );
            const title = normalizeText(
                element.getAttribute('title')
            );

            return (
                /\bInstall\b/i.test(text) ||
                /\bInstall\b/i.test(aria) ||
                /\bInstall\b/i.test(title)
            );
        });

        if (explicit && isEnabledControl(explicit)) {
            return explicit;
        }

        const sellSection = findSellSection();

        if (!sellSection) {
            return null;
        }

        const sellRect = sellSection.getBoundingClientRect();

        /*
         * The install control is the enabled icon button in the compact
         * action row immediately above the Sell Card Details row.
         * Restricting the search to this narrow band prevents carousel
         * arrows in the header image from being selected.
         */
        const candidates = Array.from(
            root.querySelectorAll(
                'button, [role="button"]'
            )
        )
            .filter(isEnabledControl)
            .map(element => ({
                element,
                rect: element.getBoundingClientRect()
            }))
            .filter(({rect}) =>
                rect.width >= 45 &&
                rect.width <= 120 &&
                rect.height >= 35 &&
                rect.height <= 80 &&
                rect.bottom <= sellRect.top + 4 &&
                rect.bottom >= sellRect.top - 95 &&
                rect.left >= sellRect.left + sellRect.width * 0.55
            )
            .sort((a, b) =>
                b.rect.right - a.rect.right
            );

        return candidates.length
            ? candidates[0].element
            : null;
    }

    function render() {
        if (state.destroyed) {
            return;
        }

        clearMarkers();

        if (!isCardSkimmingPage()) {
            return;
        }

        const rows = getSkimmerRows();

        /*
         * Priority 1: recover one skimmer that has reached the
         * location-specific expected-CS optimum.
         */
        const ready = rows
            .filter(entry =>
                entry.cards >= entry.threshold
            )
            .sort((a, b) =>
                b.ratio - a.ratio ||
                b.cards - a.cards
            );

        if (ready.length > 0) {
            mark(
                ready[0].action || ready[0].row,
                'green'
            );
            return;
        }

        /*
         * Priority 2: keep all available skimmer slots occupied.
         */
        if (rows.length < CONFIG.maxSkimmers) {
            const installControl = findInstallControl();

            if (installControl) {
                mark(installControl, 'blue');
                return;
            }
        }

        /*
         * Priority 3: sell only at the widely used 10,000-detail
         * breakpoint. Selling is never prioritized over recovering or
         * replacing skimmers.
         */
        const sell = getSellState();

        if (
            sell.details >= CONFIG.sellAtDetails &&
            sell.control
        ) {
            mark(sell.control, 'green');
        }

        // No marker means wait.
    }

    function scheduleRender(delay = CONFIG.renderDelayMs) {
        clearTimeout(state.renderTimer);

        state.renderTimer = setTimeout(() => {
            render();
        }, delay);
    }

    function begin() {
        installStyles();

        state.observer = new MutationObserver(mutations => {
            if (
                mutations.some(mutation =>
                    Array.from(mutation.addedNodes).some(
                        node =>
                            node instanceof Element &&
                            !node.matches('.ks-card-star')
                    )
                )
            ) {
                scheduleRender();
            }
        });

        state.observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true,
                characterData: true
            }
        );

        document.addEventListener(
            'click',
            () => {
                [100, 350, 800].forEach(delay => {
                    setTimeout(() => {
                        if (!state.destroyed) {
                            scheduleRender(0);
                        }
                    }, delay);
                });
            },
            true
        );

        state.healTimer = setInterval(() => {
            if (!state.destroyed) {
                render();
            }
        }, CONFIG.healIntervalMs);

        scheduleRender(0);
    }

    function destroy() {
        state.destroyed = true;
        clearTimeout(state.renderTimer);
        clearInterval(state.healTimer);
        state.observer?.disconnect();
        clearMarkers();
        document.getElementById(SCRIPT.styleId)?.remove();
    }

    win[SCRIPT.globalKey] = {
        destroy,
        version: SCRIPT.version
    };

    if (document.documentElement) {
        begin();
    } else {
        document.addEventListener(
            'DOMContentLoaded',
            begin,
            {once: true}
        );
    }
})();
