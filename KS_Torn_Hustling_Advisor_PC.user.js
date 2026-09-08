// ==UserScript==
// @name         KS Torn Hustling Advisor PC
// @namespace    DieselBladeScripts.ARS.Kingshade
// @version      0.1.3
// @description  Read-only Hustling next-action advisor for Torn on PC. Reads only the Hustling view you have open and shows exactly one recommended manual action, its nerve cost and the warnings that follow from visible data. It never clicks, submits, navigates, stores, exports or sends anything, and it makes no network or API calls.
// @license      GPL-3.0-or-later
// @author       Kingshade
// @match        https://www.torn.com/page.php?sid=crimes*
// @match        https://torn.com/page.php?sid=crimes*
// @match        https://www.torn.com/loader.php?sid=crimes*
// @match        https://torn.com/loader.php?sid=crimes*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    /*
     * KS Torn Hustling Advisor PC v0.1.3 — STATUS: CANDIDATE
     *
     * ---------------------------------------------------------------------
     * CHANGELOG
     *
     * 0.1.3
     *
     *   FIXED
     *     - The advisor no longer walks the player into an empty wallet without
     *       saying anything. Torn's wiki states that raising a game's Technique
     *       raises the audience's betting values, and Technique rises on every Win
     *       and Lose — so following this advisor's own advice drives the stake up.
     *       The owner's measured series on one Snail Racing row ran $1,102 ->
     *       $2,238 -> $5,190 -> $8,106 and then the money was gone. Up to 0.1.2 the
     *       advisor read neither the balance nor Technique and could not see it
     *       coming; the only signal was Torn blocking the button afterwards, which
     *       0.1.2 reports but which arrives too late to act on.
     *
     *   ADDED
     *     - The player's cash is read from Torn's own sidebar: the unhashed
     *       id="user-money", whose data-money attribute carries the amount as a
     *       plain integer. Present exactly once in all eleven captures from
     *       2026-08-28 and 2026-09-08. The rendered text is a normalised fallback.
     *     - A warning whenever a live bet is CASH_WARNING_RATIO of the balance or
     *       more, naming the game, the stake, the balance and how many further
     *       losses the balance can absorb. It is raised whatever action ends up
     *       being recommended, because it describes the table and not the advice.
     *       It sits after the blocked-bet warning and before the attention one.
     *     - A fail-closed notice when the balance cannot be read at all, so an
     *       unreadable balance is never silently taken for a healthy one.
     *
     *   CHANGED
     *     - Nothing in the recommendation logic. The action ranking, the attention
     *       threshold and the blocked-bet warning are all untouched.
     *     - readState now takes an optional document, defaulting to the root's own,
     *       so the sidebar read stays in the adapter layer and is testable.
     *
     *   KNOWN ISSUES
     *     - CASH_WARNING_RATIO = 0.2 is a DERIVED SAFETY MARGIN from the owner's
     *       own measured stake series, not a Torn-verified figure — the same
     *       standing as ATTENTION_THRESHOLD.
     *     - affordableLosses() assumes a clean doubling per loss. That is the
     *       owner's measured series, not a published rule, so the count is an
     *       estimate and nothing more. It is also demonstrably incomplete:
     *       on 2026-09-08 the Cornhole stake went DOWN, from $4,428 to $2,804,
     *       when the audience shrank from two bettors to one. Torn's wiki says
     *       "The more audience members betting at once, the larger the size of
     *       the bets", so the stake is driven by at least Technique, the number
     *       of bettors and their wealth — and it can fall as well as rise.
     *     - Technique itself is still not read, so the advisor cannot say how fast
     *       the stake will climb from here — only where it stands now.
     *     - The balance is read at render time only. A balance that changes while
     *       nothing on the Hustling board changes is not noticed until the next
     *       board update. That is deliberate: no polling, no extra observer.
     *     - The attention ceiling (attention + suspicion = 100) is still not used.
     *     - Still no suspicion logic, still no lower attention bound of 40, and
     *       CRITICAL FAILURE's outcome class is still unobserved.
     *
     *   VERIFICATION
     *     - Vitest: full suite green against the real published file.
     *     - ESLint, Prettier, tsc, node --check, suite validator: green.
     *     - KS compliance-syntax gate on this file: zero hits, unchanged from 0.1.2.
     *     - Playwright: NOT green and not touched — a pre-existing War Dibs
     *       harness mismatch fails the whole browser suite.
     *     - Real Torn PC runtime, the "is more than" branch: VERIFIED on PC
     *       2026-09-08. With $297 in hand and a $472 bet on Cornhole the panel
     *       read "Cornhole has an active $472 bet you cannot act on: \"You're not
     *       carrying enough money\"" followed by "Cornhole's $472 bet is more than
     *       the $297 you are carrying", in that order and ahead of the attention
     *       warning, with no ratio or internal value printed — and the advice
     *       still pointed at a feasible action on another row.
     *     - The percentage branch (a stake at 20-99% of the balance, "About N more
     *       losses would empty you") and the UNKNOWN branch (unreadable balance)
     *       have NOT been seen in live runtime. Both are covered by tests only.
     *     - The nerve block with a live bet, carried over from 0.1.2 as a
     *       candidate, was verified in the same session. It runs through the same
     *       code path, so that verification applies to both versions.
     *
     * 0.1.2  (runtime-verified on PC 2026-09-08, no-money case)
     *
     *   FIXED
     *     - A blocked bet no longer disappears from the state.
     *       Torn overwrites a blocked button's aria-label with the block reason,
     *       so once Lose and Win were both blocked the adapter lost every trace
     *       of the bet, reported hasActiveBet: false, fell back to
     *       AUDIENCE_NO_BET and advised Demo as though nothing had happened.
     *       Caught in runtime on 2026-09-08 09:27:34: a $5,190 bet stood on
     *       Snail Racing against a $248 balance, both buttons read "You're not
     *       carrying enough money", and the panel said "DEMO — Cornhole,
     *       confidence low" without mentioning the bet at all. The same gap
     *       existed for nerve, with $4,328 standing behind "You don't have
     *       enough nerve".
     *       The row's bet state is now read in this order: an enabled Lose or
     *       Win means an actionable bet; otherwise a betAmount above zero beside
     *       a blocked commit button means the bet is live but out of reach;
     *       otherwise there is no bet. The amount is the primary signal — the
     *       hashed `dim` class on an empty "$0" is never read on its own.
     *
     *   ADDED
     *     - A warning, first in the list, naming the game, the amount and Torn's
     *       own reason verbatim:
     *         Snail Racing has an active $5,190 bet you cannot act on:
     *         "You're not carrying enough money"
     *     - A betAmount element that is present but unparsable now makes the row
     *       unknown rather than "no bet". Nothing on such a row is recommended,
     *       and a warning says so.
     *
     *   CHANGED
     *     - Confidence drops one step (high->medium, medium->low, low stays low)
     *       while a blocked bet is on the board, because that is not the
     *       situation this mode optimises for. The all-blocked HOLD is exempt and
     *       is unchanged: Torn itself is the source there, so it stays 'high'.
     *     - The recommendation itself is NOT forced to HOLD. If Demo or Gather
     *       are still possible they are still advised, because they still earn
     *       skill. Only the existing all-blocked case yields HOLD.
     *
     *   KNOWN ISSUES
     *     - The advisor does not read the player's balance. It sits outside
     *       hustling-root and would need a new DOM surface and a third observer,
     *       so there is no warning BEFORE the block hits — only after, in Torn's
     *       own words. A forewarning is a later version.
     *     - The attention ceiling (attention + suspicion = 100, measured across
     *       the 2026-09-08 captures) is not used yet. A member whose suspicion is
     *       above 40 can never reach the threshold of 60 again, and the panel
     *       cannot say so.
     *     - Still no suspicion logic. The "Suspicion is above 0" warning is
     *       carried over verbatim.
     *     - The lower bound of 40 from the community band is still not
     *       implemented; only the upper bound of 60 exists.
     *     - CRITICAL FAILURE's outcome class is still unobserved.
     *
     *   VERIFICATION
     *     - Vitest: full suite green against the real published file.
     *     - ESLint, Prettier, tsc, node --check, suite validator: green.
     *     - KS compliance-syntax gate on this file: zero hits.
     *     - Playwright: NOT green and not touched — a pre-existing War Dibs
     *       harness mismatch fails the whole browser suite.
     *     - Real Torn PC runtime, no-money case: VERIFIED on PC 2026-09-08. With
     *       a $248 balance against a $256 bet on Snail Racing and both buttons
     *       blocked, the panel read "Snail Racing has an active $256 bet you
     *       cannot act on: \"You're not carrying enough money\"". 0.1.1 reported
     *       hasActiveBet: false on the same board and said nothing about the bet.
     *     - The no-nerve case and the case where Torn blocks without stating a
     *       reason run through the same code path, but neither has been observed
     *       in live runtime. Both are covered by tests only.
     *
     * 0.1.1  (runtime-verified on PC 2026-09-08)
     *
     *   FIXED
     *     - Nothing. No defect was reported against 0.1.0-alpha.1.
     *
     *   ADDED
     *     - Nothing. This release carries a single behavioural change and no
     *       new feature, constant, observer, warning or DOM read.
     *
     *   CHANGED
     *     - ATTENTION_THRESHOLD moves from 50 to 60.
     *       Two independent community sources describe a PAIR of thresholds
     *       rather than one: build attention up above 60, take it back down to
     *       around 40, repeat. Emforu's Torn-hosted in-depth guide gives
     *       "Lose until someone's attention is maxed or overall attention is
     *       over 60% / Win until attention is around 40%, then lose", and
     *       torn-intel's Hustling guide gives the same 60/40 pair independently.
     *       A single threshold sitting in the middle of that band made the
     *       advice flip-flop around 50 instead of running the cycle. With the
     *       upper bound at 60 the cycle emerges on its own — a Win lowers
     *       attention, a Lose raises it — so the script still needs no memory of
     *       which phase it is in, and still stores nothing.
     *       Concretely: a betting audience at attention 53 now reads LOSE where
     *       0.1.0-alpha.1 read WIN. At 65 it still reads WIN, unchanged.
     *     - options.attentionThreshold in decide() is unchanged and still
     *       overrides the default.
     *
     *   KNOWN ISSUES
     *     - 60 is a COMMUNITY HEURISTIC. It is not Torn-verified, and the panel
     *       must never present it as a verified line. It is stated as community
     *       data in the panel footer.
     *     - The lower bound of 40, from the same two sources, is NOT implemented
     *       in this version. Only the upper bound exists, so the script advises
     *       Lose all the way down to 0 rather than stopping at 40.
     *     - No suspicion logic. The existing "Suspicion is above 0" warning is
     *       carried over verbatim and its wording is known to be due for review.
     *     - CRITICAL FAILURE's outcome class is still unobserved and still
     *       treated as an unknown outcome.
     *
     *   VERIFICATION
     *     - Vitest: full suite green against the real published file and the
     *       sanitised PC capture fixtures.
     *     - ESLint, Prettier, tsc, node --check, suite validator: green.
     *     - KS compliance-syntax gate on this file: zero hits.
     *     - Playwright: NOT green, and not touched by this release. The whole
     *       browser suite fails on a pre-existing War Dibs harness mismatch.
     *     - Real Torn PC runtime: NOT verified. Status stays CANDIDATE until
     *       the owner has run it on a live Hustling page.
     * ---------------------------------------------------------------------
     *
     * One feature, nothing else: read the Hustling view the player is actually
     * looking at and show exactly one recommended next MANUAL action, its nerve
     * cost, a short reason and the warnings that follow from visible data.
     *
     * Disclosure (KS baseline rule 10 — no undocumented functionality):
     *   - Network calls: none. No fetch, no XHR, no WebSocket, no GM_* transport,
     *     no @connect host, no Torn API, no API key is read, asked for or stored.
     *   - Storage: none. No localStorage, no sessionStorage, no cookies, no logs.
     *     The minimise state lives in memory for the lifetime of the page only.
     *   - Data leaving the page: none. Nothing is collected, exported or shared.
     *   - Gameplay: none. The script never clicks, submits, navigates, scrolls,
     *     dispatches events at Torn's DOM or injects an iframe. Every real action
     *     is performed by the player on Torn's own control.
     *   - Reading scope: the subtree under div.crime-root.hustling-root on the page
     *     the player has manually opened, and only while that page is visible and
     *     focused. Observation is disconnected when it is not.
     *
     * Uncertainty that the panel must never present as fact:
     *   - Exact CE per Hustling action is unknown. No CE number is ever displayed.
     *   - The CS-per-nerve ranking used as a tie-break is community data, not Torn.
     *   - The attention threshold is a community heuristic, not a Torn-verified line.
     *   - Suspicion was 0 in every capture the DOM contract was read from. The scale
     *     is assumed, never presented as verified.
     *   - CRITICAL FAILURE's outcome class has never been observed. Any outcome class
     *     that is neither success nor failure is treated as an unknown outcome.
     *
     * Platform: PC / Tampermonkey. Torn PDA is deliberately NOT supported by this
     * file — no Hustling capture from PDA exists, so its DOM would be guesswork.
     */

    const VERSION = '0.1.3';
    const STATUS = 'CANDIDATE';
    const MODE = 'MAX CE + CS';
    const INSTANCE_KEY = '__ksTornHustlingAdvisorV010A1';
    const PANEL_ID = 'ks-hustling-advisor-panel';

    if (Object.prototype.hasOwnProperty.call(window, INSTANCE_KEY)) return;

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    /**
     * Upper bound of the community attention band. COMMUNITY HEURISTIC — Torn has
     * never published an optimal attention line, and this must never be presented
     * as a verified one.
     *
     * Two independent sources give the same pair of numbers, not a single line:
     *   - Emforu's Torn-hosted in-depth Hustling guide: "Lose until someone's
     *     attention is maxed or overall attention is over 60% / Win until
     *     attention is around 40%, then lose."
     *   - torn-intel's Hustling guide: the same 60 up / 40 down pair, arrived at
     *     independently.
     *
     * Only the upper bound is implemented here. Because a Win lowers attention and
     * a Lose raises it, comparing against 60 alone already produces the cycle
     * without the script remembering which phase it is in — so it still keeps no
     * state and still stores nothing. The lower bound of 40 is not implemented.
     */
    const ATTENTION_THRESHOLD = 60;

    /**
     * Warn once a row's live bet is this share of the player's cash, or more.
     *
     * DERIVED SAFETY MARGIN — not Torn-verified, same standing as
     * ATTENTION_THRESHOLD. Torn's wiki states that raising a game's Technique
     * raises the audience's betting values, and Technique rises on every Win and
     * Lose. Following this advisor therefore drives the stake up on its own. The
     * owner's measured series on one Snail Racing row ran
     * $1,102 -> $2,238 -> $5,190 -> $8,106: roughly a doubling per successful
     * Lose. At one fifth of the balance there is room for about two more losses;
     * below that there is margin, above it the next pair is the one that empties
     * the account.
     */
    const CASH_WARNING_RATIO = 0.2;

    /**
     * Torn's own sidebar balance. Unhashed id, and it carries the amount as a
     * plain integer in data-money. Present exactly once in all eleven captures
     * from 2026-08-28 and 2026-09-08.
     */
    const CASH_ELEMENT_ID = 'user-money';

    /** Actions this version is allowed to recommend. Anything else is fail-closed. */
    const RECOMMENDABLE = ['WIN', 'LOSE', 'HYPE', 'DEMO', 'GATHER'];

    /** aria-label action word -> internal kind. Unlisted words become OTHER. */
    const ACTION_KINDS = {
        Gather: 'GATHER',
        Demo: 'DEMO',
        Hype: 'HYPE',
        Lose: 'LOSE',
        Win: 'WIN',
    };

    const ROOT_SELECTOR = 'div.crime-root.hustling-root';
    const UPDATE_DEBOUNCE_MS = 120;

    /** Bounded, one-shot discovery attempts after boot or a route change. Never a poll loop. */
    const DISCOVERY_DELAYS_MS = [0, 250, 500, 1000, 2000, 4000, 8000];

    /* ------------------------------------------------------------------ *
     * Layer 1 — pure parsers (no DOM, no side effects)
     * ------------------------------------------------------------------ */

    /**
     * "$2,159" -> 2159. Returns null when the text is not a money amount.
     */
    function parseMoney(text) {
        const match = /^\s*\$\s*(-?[\d,]+)\s*$/.exec(String(text ?? ''));
        if (!match) return null;
        const value = Number(match[1].replace(/,/g, ''));
        return Number.isFinite(value) ? value : null;
    }

    /**
     * Reads an action button's aria-label: "Gather, 4 nerve" -> Gather / 4.
     * The nerve cost comes from the label, never from the digit beside the icon.
     * Win and Lose are told apart by the word, never by colour, icon or SVG class.
     */
    function parseActionLabel(label) {
        const match = /^\s*([A-Za-z][A-Za-z' ]*?)\s*,\s*(\d+)\s*nerve\s*$/.exec(String(label ?? ''));
        if (!match) return null;
        const name = match[1];
        const nerve = Number(match[2]);
        if (!Number.isFinite(nerve)) return null;
        return {
            name,
            kind: Object.prototype.hasOwnProperty.call(ACTION_KINDS, name) ? ACTION_KINDS[name] : 'OTHER',
            nerve,
        };
    }

    /**
     * Reads the audience screen-reader summary.
     * Verified shapes: "No audience", "1 person, no bets", "4 people, no bets",
     * "4 people, 1 bet, $177 in total", "4 people, 2 bets, $2,159 in total".
     * Anything else parses as unparsed rather than throwing or guessing.
     */
    function parseAudienceSummary(text) {
        const raw = String(text ?? '').trim();
        const unparsed = { parsed: false, text: raw, people: null, bets: null, totalBet: null };
        if (!raw) return unparsed;

        if (/^no audience$/i.test(raw)) {
            return { parsed: true, text: raw, people: 0, bets: 0, totalBet: 0 };
        }

        const noBets = /^(\d+)\s+(?:person|people)\s*,\s*no bets\s*$/i.exec(raw);
        if (noBets) {
            return { parsed: true, text: raw, people: Number(noBets[1]), bets: 0, totalBet: 0 };
        }

        const withBets = /^(\d+)\s+(?:person|people)\s*,\s*(\d+)\s+bets?\s*,\s*\$([\d,]+)\s+in total\s*$/i.exec(raw);
        if (withBets) {
            return {
                parsed: true,
                text: raw,
                people: Number(withBets[1]),
                bets: Number(withBets[2]),
                totalBet: Number(withBets[3].replace(/,/g, '')),
            };
        }

        return unparsed;
    }

    /**
     * Reads one audience member's aria-label. Two verified shapes:
     *   "Audience member 1 of 4, betting, attention 88% suspicion 0% wealth 5 out of 12"
     *   "Member 2 betting, attention 6 suspicion 0 wealth 6"
     * The word "betting" is the only permitted reading of the dollar icon.
     * Values are never derived from element width, colour or pixel position.
     */
    function parseAudienceMemberLabel(label) {
        const raw = String(label ?? '').trim();
        if (!raw) return null;

        const attention = readLabelNumber(raw, /attention\s+(\d+)\s*%?/i);
        const suspicion = readLabelNumber(raw, /suspicion\s+(\d+)\s*%?/i);
        const wealthMatch = /wealth\s+(\d+)(?:\s+out of\s+(\d+))?/i.exec(raw);
        const wealth = wealthMatch ? Number(wealthMatch[1]) : null;
        const wealthMax = wealthMatch && wealthMatch[2] !== undefined ? Number(wealthMatch[2]) : null;

        const longIndex = /^audience member\s+(\d+)\s+of\s+(\d+)/i.exec(raw);
        const shortIndex = /^member\s+(\d+)/i.exec(raw);
        const index = longIndex ? Number(longIndex[1]) : shortIndex ? Number(shortIndex[1]) : null;
        const total = longIndex ? Number(longIndex[2]) : null;

        return {
            text: raw,
            index,
            total,
            betting: /\bbetting\b/i.test(raw),
            attention,
            suspicion,
            wealth,
            wealthMax,
            parsed: attention !== null && suspicion !== null,
        };
    }

    function readLabelNumber(text, pattern) {
        const match = pattern.exec(text);
        if (!match) return null;
        const value = Number(match[1]);
        return Number.isFinite(value) ? value : null;
    }

    /**
     * Torn's own outcome class decides the outcome. Never the button colour, never
     * the word "lost" in the story text, never the direction of the money.
     * An intentional loss is crimes-outcome-success and must classify as SUCCESS.
     */
    function classifyOutcomeClasses(classes) {
        const list = Array.from(classes ?? []);
        const outcomeClasses = list.filter((name) => name.startsWith('crimes-outcome-'));
        const success = outcomeClasses.includes('crimes-outcome-success');
        const failure = outcomeClasses.includes('crimes-outcome-failure');
        if (success && !failure) return 'SUCCESS';
        if (failure && !success) return 'FAILURE';
        return 'UNKNOWN';
    }

    /* ------------------------------------------------------------------ *
     * Layer 2 — DOM adapter (reads, never writes, never saves node references)
     * ------------------------------------------------------------------ */

    /**
     * The player's cash, read from Torn's sidebar.
     *
     * This is the one thing the advisor reads outside hustling-root, and it is read
     * at render time only — inside readState, on the same debounced pass that reads
     * the rows. No observer watches the sidebar, no timer polls it, and no new
     * container is observed. Torn keeps the amount in a data attribute, so nothing
     * has to be inferred from formatting; the rendered text is only a fallback and
     * is normalised rather than assumed to keep any one shape.
     *
     * Fail-closed: an unreadable balance is reported as unreadable. It is never
     * treated as "plenty", and it never blocks the recommendation.
     */
    function readCash(doc) {
        if (!doc) return { amount: null, readable: false };
        const element = doc.getElementById(CASH_ELEMENT_ID);
        if (!element) return { amount: null, readable: false };

        const raw = element.getAttribute('data-money');
        if (raw !== null && raw.trim() !== '') {
            const value = Number(raw.trim());
            if (Number.isFinite(value)) return { amount: value, readable: true };
        }

        const normalised = (element.textContent ?? '').replace(/[$,\s]/g, '');
        if (/^-?\d+$/.test(normalised)) {
            const value = Number(normalised);
            if (Number.isFinite(value)) return { amount: value, readable: true };
        }

        return { amount: null, readable: false };
    }

    /**
     * How many further losses the balance can absorb when the stake roughly
     * doubles each time. Losing n times in a row costs bet * (2^n - 1).
     */
    function affordableLosses(bet, cash) {
        if (!(bet > 0) || !(cash > 0)) return 0;
        return Math.floor(Math.log2(cash / bet + 1));
    }

    function emptyAudience() {
        return { summary: parseAudienceSummary(''), members: [], memberCount: 0, confidence: 'none' };
    }

    /**
     * Everything below recounts from the passed root on every call. The game rows
     * live in a virtualised list that mounts and unmounts on scroll, so no node
     * reference may survive an update.
     */
    /**
     * @param {Element | null} root
     * @param {Document} [doc] where to look for Torn's sidebar balance. Defaults to
     *   the root's own document, so callers normally pass nothing.
     */
    function readState(root, doc) {
        const documentRef = doc ?? (root ? root.ownerDocument : null);

        if (!root) {
            return {
                ready: false,
                rows: [],
                audience: emptyAudience(),
                cash: readCash(documentRef),
                counters: null,
                skill: null,
                notes: ['The Hustling root element is not present.'],
            };
        }

        const notes = [];
        const rows = [];
        for (const option of root.querySelectorAll('.crime-option')) {
            rows.push(readRow(option, notes));
        }

        const audienceRow = rows.find((row) => row.kind === 'AUDIENCE');
        const audience = audienceRow && audienceRow.audience ? audienceRow.audience : emptyAudience();

        if (audienceRow && !audience.summary.parsed) {
            notes.push('The audience summary text could not be read; members were counted instead.');
        }

        return {
            ready: rows.length > 0,
            rows,
            audience,
            /* Read on the same render pass as the rows. No observer, no timer. */
            cash: readCash(documentRef),
            counters: readCounters(root),
            skill: readSkill(root),
            notes,
        };
    }

    function readRow(option, notes) {
        const sections = option.querySelector('.crime-option-sections');
        const virtualItem = option.closest('.virtual-item');
        const audienceSection = option.querySelector('[class*="audienceSection"]');
        const betElement = option.querySelector('[class*="betAmount"]');
        const locked = option.classList.contains('crime-option-locked');

        const actions = [];
        for (const button of option.querySelectorAll('button.commit-button')) {
            const action = readActionButton(button);
            if (!action.recognised && !action.disabled) {
                notes.push(`An action button carries an unrecognised label: "${action.label}".`);
            }
            actions.push(action);
        }

        const kind = audienceSection ? 'AUDIENCE' : locked ? 'LOCKED' : betElement ? 'GAME' : 'OTHER';

        const betText = betElement ? (betElement.textContent ?? '').trim() : null;
        const bet = betElement ? parseMoney(betElement.textContent) : null;
        /* A betAmount element that is present but unreadable is not "no bet". The row
         * is unknown, and an unknown row is never recommended from. */
        const betUnreadable = betElement !== null && bet === null;

        /* Reading the row's bet state.
         *
         * Until 0.1.2 this was "the row shows Lose and Win", which held only while
         * the buttons were usable. Torn overwrites a blocked button's aria-label with
         * the block reason, so a bet the player cannot cover made the whole bet
         * disappear from the state and the panel fell back to advising Demo. Verified
         * on 2026-09-08 09:27:34 with a $5,190 bet against a $248 balance, and again
         * on the nerve-blocked capture holding $4,328.
         *
         * The order below is deliberate:
         *   1. An enabled Lose or Win means an actionable bet, as before.
         *   2. Otherwise a betAmount above zero next to a blocked commit button means
         *      the bet is still live but out of reach. Torn's own words are kept.
         *   3. Otherwise there is no bet.
         *
         * The amount is the primary signal. The hashed `dim` class that Torn puts on
         * an empty "$0" may corroborate it but is never read on its own. */
        const disabledActions = actions.filter((action) => action.disabled);
        const actionableBet = actions.some(
            (action) => (action.kind === 'LOSE' || action.kind === 'WIN') && !action.disabled,
        );
        const betBlocked =
            !actionableBet && typeof bet === 'number' && bet > 0 && disabledActions.length > 0;
        const blockingAction = betBlocked
            ? disabledActions.find((action) => action.blockedReason !== null)
            : undefined;

        return {
            name: readRowName(sections, Boolean(audienceSection)),
            kind,
            locked,
            bet,
            betText,
            betUnreadable,
            hasActiveBet: actionableBet || betBlocked,
            betBlocked,
            betBlockedReason: blockingAction ? blockingAction.blockedReason : null,
            actions,
            outcome: readOutcome(virtualItem),
            audience: audienceSection ? readAudience(audienceSection) : null,
        };
    }

    function readRowName(sections, isAudienceRow) {
        if (sections) {
            for (const child of sections.children) {
                if (/(?:^|\s)title(?:Section)?___/.test(child.className)) {
                    const text = (child.textContent ?? '').trim();
                    if (text) return text;
                }
            }
        }
        return isAudienceRow ? 'Audience' : null;
    }

    function readActionButton(button) {
        const label = (button.getAttribute('aria-label') ?? '').trim();
        const disabled =
            button.classList.contains('disabled') ||
            button.getAttribute('aria-disabled') === 'true' ||
            button.disabled === true;
        const parsed = parseActionLabel(label);

        if (parsed) {
            return {
                label,
                name: parsed.name,
                kind: parsed.kind,
                nerve: parsed.nerve,
                disabled,
                blockedReason: null,
                recognised: true,
            };
        }

        return {
            label,
            name: null,
            kind: 'UNKNOWN',
            nerve: null,
            disabled,
            /* Torn writes the reason into the label of a blocked button. Show it as it is. */
            blockedReason: disabled && label ? label : null,
            recognised: false,
        };
    }

    function readAudience(audienceSection) {
        const srOnly = audienceSection.querySelector('[class*="srOnly"]');
        const summary = parseAudienceSummary(srOnly ? srOnly.textContent : '');

        const members = [];
        /* The banner carries decorative audienceMember* nodes with no aria-label.
         * Requiring the attribute keeps them out of the real audience. */
        for (const element of audienceSection.querySelectorAll('[class*="audienceMember"][aria-label]')) {
            const member = parseAudienceMemberLabel(element.getAttribute('aria-label'));
            if (member) members.push(member);
        }

        return {
            summary,
            members,
            memberCount: summary.parsed && summary.people !== null ? summary.people : members.length,
            confidence: summary.parsed ? 'high' : members.length > 0 ? 'low' : 'none',
        };
    }

    function readOutcome(virtualItem) {
        if (!virtualItem || !virtualItem.classList.contains('outcome-expanded')) return null;
        const content =
            virtualItem.querySelector('.outcome-content') ??
            virtualItem.querySelector('[class*="outcomeContent"]');
        if (!content) return { result: 'UNKNOWN', classes: [] };
        const classes = Array.from(content.classList).filter((name) => name.startsWith('crimes-outcome-'));
        return { result: classifyOutcomeClasses(content.classList), classes };
    }

    function readCounters(root) {
        const container = root.querySelector('[class*="resultCounts"]');
        if (!container) return null;
        const counters = { successes: null, fails: null, criticalFails: null };
        for (const element of container.querySelectorAll('[class*="resultCount"][aria-label]')) {
            const match = /^\s*(\d+)\s+(critical fails|fails|successes)\s*$/i.exec(
                element.getAttribute('aria-label') ?? '',
            );
            if (!match) continue;
            const value = Number(match[1]);
            const which = match[2].toLowerCase();
            if (which === 'successes') counters.successes = value;
            else if (which === 'fails') counters.fails = value;
            else counters.criticalFails = value;
        }
        return counters;
    }

    function readSkill(root) {
        const element = root.querySelector('[class*="progressFill"][aria-label]');
        if (!element) return null;
        const label = element.getAttribute('aria-label') ?? '';
        const match = /crime skill:\s*(\d+)\s*\((\d+)%\)(?:\s*,\s*(.+?))?\s*$/i.exec(label);
        if (!match) return null;
        return {
            level: Number(match[1]),
            progressPercent: Number(match[2]),
            demoralization: match[3] ? match[3].trim() : null,
        };
    }

    /* ------------------------------------------------------------------ *
     * Layer 3 — decision engine (pure: no DOM, no network, no storage)
     * ------------------------------------------------------------------ */

    function recommendation(action, target, nerve, reason, confidence, warnings, blockedReason) {
        return {
            action,
            target: target ?? null,
            nerve: typeof nerve === 'number' ? nerve : null,
            reason,
            confidence,
            warnings: warnings.slice(),
            blockedReason: blockedReason ?? null,
        };
    }

    /** 5190 -> "5,190". Local, so the output never depends on the viewer's locale. */
    function formatMoney(amount) {
        return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** One step down the confidence ladder. 'low' is the floor. */
    function lowerConfidence(confidence) {
        if (confidence === 'high') return 'medium';
        if (confidence === 'medium') return 'low';
        return 'low';
    }

    function collectWarnings(state, threshold) {
        const warnings = [];

        /* First in the list, deliberately. A bet the player cannot act on is the most
         * important thing on the screen, and 0.1.1 did not mention it at all. Torn's
         * own wording is quoted verbatim and never translated, exactly as the
         * all-blocked HOLD reason already is. */
        for (const row of state.rows) {
            if (!row.betBlocked) continue;
            const amount = typeof row.bet === 'number' ? `$${formatMoney(row.bet)}` : 'an';
            const name = row.name ?? 'A row';
            warnings.push(
                row.betBlockedReason
                    ? `${name} has an active ${amount} bet you cannot act on: "${row.betBlockedReason}"`
                    : `${name} has an active ${amount} bet you cannot act on, and Torn did not say why.`,
            );
        }

        /* Cash check, immediately after the blocked-bet warning and well before the
         * attention one: a bet you cannot act on still outranks a bet you can act on
         * but cannot afford. This is information about the table, so it is raised
         * whatever action ends up being recommended. */
        const cash = state.cash ?? { amount: null, readable: false };
        const liveBets = state.rows.filter(
            (row) => row.hasActiveBet && typeof row.bet === 'number' && row.bet > 0,
        );
        if (liveBets.length > 0 && !cash.readable) {
            warnings.push(
                'Your cash could not be read from the sidebar, so no stake can be checked ' +
                    'against it. The cash check is UNKNOWN — that is not the same as having plenty.',
            );
        } else if (liveBets.length > 0 && typeof cash.amount === 'number') {
            for (const row of liveBets) {
                const share = cash.amount > 0 ? row.bet / cash.amount : Infinity;
                if (share < CASH_WARNING_RATIO) continue;
                const name = row.name ?? 'A row';
                const stake = `$${formatMoney(row.bet)}`;
                const held = `$${formatMoney(cash.amount)}`;
                if (share >= 1) {
                    warnings.push(`${name}'s ${stake} bet is more than the ${held} you are carrying.`);
                    continue;
                }
                const losses = affordableLosses(row.bet, cash.amount);
                warnings.push(
                    `${name}'s ${stake} bet is ${Math.round(share * 100)}% of your ${held} cash. ` +
                        (losses <= 1
                            ? 'One more loss would empty you.'
                            : `About ${losses} more losses would empty you.`),
                );
            }
        }

        for (const row of state.rows) {
            if (!row.betUnreadable) continue;
            warnings.push(
                `${row.name ?? 'A row'} shows a bet amount that could not be read ("${row.betText}"). ` +
                    'The row is treated as unknown and nothing on it will be recommended.',
            );
        }

        for (const note of state.notes) warnings.push(note);

        for (const row of state.rows) {
            if (!row.outcome) continue;
            if (row.outcome.result === 'FAILURE') {
                warnings.push(`Last visible outcome on ${row.name ?? 'a row'} was a FAILURE — crime chain at risk.`);
            } else if (row.outcome.result === 'UNKNOWN') {
                warnings.push(
                    `An outcome box on ${row.name ?? 'a row'} carries an unrecognised class — outcome treated as unknown.`,
                );
            }
        }

        const suspicious = state.audience.members.filter(
            (member) => typeof member.suspicion === 'number' && member.suspicion > 0,
        );
        if (suspicious.length > 0) {
            warnings.push(
                `Suspicion is above 0 on ${suspicious.length} audience member(s). The suspicion scale is an assumption, not verified.`,
            );
        }

        const unreadable = state.audience.members.filter((member) => !member.parsed);
        if (unreadable.length > 0) {
            warnings.push(`${unreadable.length} audience member label(s) could not be read.`);
        }

        if (state.skill && state.skill.demoralization && !/^no demoralization$/i.test(state.skill.demoralization)) {
            warnings.push(`Torn reports "${state.skill.demoralization}" — progression gains are temporarily reduced.`);
        }

        const bettors = state.audience.members.filter((member) => member.betting);
        const bettorAttention = bettors
            .map((member) => member.attention)
            .filter((value) => typeof value === 'number');
        if (bettorAttention.length > 0 && Math.min.apply(null, bettorAttention) < threshold) {
            warnings.push(
                `Attention on a betting member is ${Math.min.apply(null, bettorAttention)}, below the community threshold of ${threshold}.`,
            );
        }

        for (const row of state.rows) {
            for (const action of row.actions) {
                if (!action.recognised && !action.disabled) {
                    warnings.push(`Unrecognised enabled action "${action.label}" — it will never be recommended.`);
                }
            }
        }

        return warnings;
    }

    /**
     * MAX CE + CS. There is no mode selector and there will not be one in this version.
     *
     * Priority 1 protects the crime chain: an action whose risk cannot be judged from
     * visible data is not recommended. Priority 2 is the community CS-per-nerve ranking,
     * used only as a tie-break and labelled as community data in the UI. Priority 3
     * preserves a usable audience so future 2-nerve actions are not replaced by 4-nerve
     * Gather. Cash is a feasibility limit only, and Torn enforces it by disabling the
     * button and writing the reason into its label.
     *
     * @param {object} state normalized state from readState
     * @param {{attentionThreshold?: number}} [options]
     */
    function decide(state, options) {
        const threshold =
            options && typeof options.attentionThreshold === 'number'
                ? options.attentionThreshold
                : ATTENTION_THRESHOLD;

        if (!state || !state.ready) {
            return recommendation('WAIT', null, null, 'The Hustling view is not readable yet.', 'low', [], null);
        }

        const warnings = collectWarnings(state, threshold);

        /** Every action this version is allowed to point at, paired with its row. */
        const available = [];
        for (const row of state.rows) {
            if (row.locked) continue;
            /* A row whose bet amount could not be read is unknown, and nothing is
             * recommended off an unknown row. */
            if (row.betUnreadable) continue;
            for (const action of row.actions) {
                if (action.disabled) continue;
                if (!RECOMMENDABLE.includes(action.kind)) continue;
                available.push({ row, action });
            }
        }

        if (available.length === 0) {
            /* Everything Torn shows is blocked. This is the existing BLOCKED mode and
             * it is unchanged: HOLD, Torn's own reason, stated with full confidence,
             * because Torn itself is the source. It is not downgraded below. */
            const reason = dominantBlockedReason(state);
            return recommendation(
                'HOLD',
                null,
                null,
                reason
                    ? `Torn blocks every visible action: "${reason}".`
                    : 'No usable action is visible. Nothing can be recommended.',
                'high',
                warnings,
                reason,
            );
        }

        const chosen = chooseFeasibleAction(state, available, threshold, warnings);

        /* An out-of-reach bet means the board is not the one this mode optimises for,
         * so whatever is still feasible is advised with one step less confidence. */
        if (state.rows.some((row) => row.betBlocked)) {
            chosen.confidence = lowerConfidence(chosen.confidence);
        }
        return chosen;
    }

    /**
     * Picks the best feasible action once it is known that at least one exists.
     *
     * @param {object} state
     * @param {{row: object, action: object}[]} available
     * @param {number} threshold
     * @param {string[]} warnings
     */
    function chooseFeasibleAction(state, available, threshold, warnings) {
        const betRows = state.rows.filter((row) => row.hasActiveBet && !row.locked);
        /* A bet that can still be acted on outranks one Torn has blocked. */
        const betRow =
            betRows.find((row) => !row.betBlocked) ?? (betRows.length > 0 ? betRows[0] : undefined);
        if (betRow) {
            const resolved = decideOnActiveBet(betRow, state, threshold, warnings);
            if (resolved) return resolved;
        }

        const hype = available.filter((entry) => entry.action.kind === 'HYPE');
        if (hype.length > 0) {
            const chosen = hype[0];
            const ambiguous = hype.length > 1;
            return recommendation(
                'HYPE',
                chosen.row.name,
                chosen.action.nerve,
                ambiguous
                    ? `${hype.length} rows offer an equivalent Hype; ${chosen.row.name} is simply the first.`
                    : `No active bet on ${chosen.row.name}. Hype raises audience interest and sets the next bet.`,
                ambiguous ? 'low' : 'medium',
                warnings,
                null,
            );
        }

        const demo = available.filter((entry) => entry.action.kind === 'DEMO');
        if (demo.length > 0) {
            const chosen = demo[0];
            const ambiguous = demo.length > 1;
            return recommendation(
                'DEMO',
                chosen.row.name,
                chosen.action.nerve,
                ambiguous
                    ? `${demo.length} games offer an equivalent Demo; ${chosen.row.name} is simply the first. Nothing visible separates them.`
                    : `No game is warmed up yet. Demo opens ${chosen.row.name}.`,
                'low',
                warnings,
                null,
            );
        }

        const gather = available.find((entry) => entry.action.kind === 'GATHER');
        if (gather) {
            const people = state.audience.memberCount;
            return recommendation(
                'GATHER',
                gather.row.name,
                gather.action.nerve,
                people === 0
                    ? 'No audience is present. Gather is the only thing that can start one.'
                    : 'No cheaper action is available; Gather adds audience.',
                people === 0 ? 'high' : 'medium',
                warnings,
                null,
            );
        }

        return recommendation(
            'HOLD',
            null,
            null,
            'Only unrecognised actions are enabled. Nothing will be recommended on a label this version does not know.',
            'low',
            warnings,
            null,
        );
    }

    function decideOnActiveBet(betRow, state, threshold, warnings) {
        const win = betRow.actions.find((action) => action.kind === 'WIN' && !action.disabled);
        const lose = betRow.actions.find((action) => action.kind === 'LOSE' && !action.disabled);
        if (!win && !lose) return null;

        const bettors = state.audience.members.filter((member) => member.betting);
        const attentions = bettors
            .map((member) => member.attention)
            .filter((value) => typeof value === 'number');

        if (win && !lose) {
            return recommendation(
                'WIN',
                betRow.name,
                win.nerve,
                `Win is the only bet action Torn leaves enabled on ${betRow.name}.`,
                'medium',
                warnings,
                null,
            );
        }

        if (lose && !win) {
            return recommendation(
                'LOSE',
                betRow.name,
                lose.nerve,
                `Lose is the only bet action Torn leaves enabled on ${betRow.name}.`,
                'medium',
                warnings,
                null,
            );
        }

        if (attentions.length === 0) {
            /* Fail-closed on the decision, not on the reading: without a readable
             * attention value a Win could quietly empty the audience, so the
             * audience-preserving action wins and the confidence says why. */
            return recommendation(
                'LOSE',
                betRow.name,
                lose.nerve,
                `Attention on the betting audience could not be read. Lose keeps the audience alive on ${betRow.name}.`,
                'low',
                warnings,
                null,
            );
        }

        const lowest = Math.min.apply(null, attentions);
        if (lowest < threshold) {
            return recommendation(
                'LOSE',
                betRow.name,
                lose.nerve,
                `Attention ${lowest} on the betting audience is below the ${threshold} community threshold. Lose restores interest.`,
                'medium',
                warnings,
                null,
            );
        }

        return recommendation(
            'WIN',
            betRow.name,
            win.nerve,
            `Attention ${lowest} on the betting audience is at or above the ${threshold} community threshold.`,
            'medium',
            warnings,
            null,
        );
    }

    function dominantBlockedReason(state) {
        const counts = new Map();
        for (const row of state.rows) {
            if (row.locked) continue;
            for (const action of row.actions) {
                if (!action.blockedReason) continue;
                counts.set(action.blockedReason, (counts.get(action.blockedReason) ?? 0) + 1);
            }
        }
        let best = null;
        let bestCount = 0;
        for (const [reason, count] of counts) {
            if (count > bestCount) {
                best = reason;
                bestCount = count;
            }
        }
        return best;
    }

    /* ------------------------------------------------------------------ *
     * Layer 4 — presentation
     * ------------------------------------------------------------------ */

    const PANEL_STYLES = `
:host { all: initial; }
.wrap {
  box-sizing: border-box;
  margin: 6px 0;
  padding: 8px 10px;
  border: 1px solid #3a3a3a;
  border-left: 3px solid #7a5cff;
  border-radius: 4px;
  background: #1d1d1d;
  color: #ddd;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 12px;
  line-height: 1.45;
}
.head { display: flex; align-items: center; gap: 8px; }
.brand { font-weight: bold; letter-spacing: .04em; color: #b7a6ff; }
.tag {
  padding: 0 5px; border: 1px solid #4a4a4a; border-radius: 3px;
  font-size: 10px; letter-spacing: .06em; color: #aaa;
}
.spacer { flex: 1 1 auto; }
.toggle {
  all: unset; cursor: pointer; padding: 0 6px; border: 1px solid #4a4a4a;
  border-radius: 3px; font-size: 11px; color: #bbb;
}
.toggle:focus-visible { outline: 1px solid #7a5cff; }
.body { margin-top: 6px; }
.wrap.collapsed .body { display: none; }
.call { font-size: 14px; font-weight: bold; color: #fff; }
.call .verb { color: #7ee08a; }
.call.hold .verb, .call.wait .verb { color: #e0c27e; }
.cost { color: #aaa; font-weight: normal; }
.reason { margin-top: 2px; color: #cfcfcf; }
.warns { margin: 5px 0 0; padding-left: 16px; color: #e0c27e; }
.warns li { margin: 1px 0; }
.foot { margin-top: 6px; font-size: 10px; color: #888; }
`;

    function buildPanel() {
        const host = document.createElement('div');
        host.id = PANEL_ID;
        const shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = PANEL_STYLES;

        const wrap = document.createElement('div');
        wrap.className = 'wrap';

        const head = document.createElement('div');
        head.className = 'head';
        head.append(
            labelled('brand', 'KS HUSTLING ADVISOR'),
            labelled('tag', STATUS),
            labelled('tag', MODE),
        );
        const spacer = document.createElement('div');
        spacer.className = 'spacer';
        head.append(spacer);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'toggle';
        toggle.textContent = '–';
        toggle.setAttribute('aria-label', 'Minimise the Kingshade Hustling Advisor panel');
        /* The panel lives outside hustling-root and this button only toggles a class
         * on the panel's own shadow DOM. It can never reach a Torn control. */
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            const collapsed = wrap.classList.toggle('collapsed');
            toggle.textContent = collapsed ? '+' : '–';
        });
        head.append(toggle);

        const body = document.createElement('div');
        body.className = 'body';

        wrap.append(head, body);
        shadow.append(style, wrap);

        return { host, wrap, body };
    }

    function labelled(className, text) {
        const node = document.createElement('span');
        node.className = className;
        node.textContent = text;
        return node;
    }

    function renderPaused(panel) {
        panel.body.replaceChildren(
            line('call hold', [span('verb', 'PAUSED'), span('cost', ' — page not visible or not focused')]),
            line('reason', [document.createTextNode('Observation is disconnected. Nothing is read while you are looking elsewhere.')]),
        );
    }

    function renderRecommendation(panel, result) {
        const nodes = [];

        const verbClass =
            result.action === 'HOLD' || result.action === 'WAIT' ? 'call hold' : 'call';
        const head = [span('verb', result.action)];
        if (result.target) head.push(document.createTextNode(` — ${result.target}`));
        if (typeof result.nerve === 'number') head.push(span('cost', `  ·  ${result.nerve} nerve`));
        head.push(span('cost', `  ·  confidence ${result.confidence}`));
        nodes.push(line(verbClass, head));

        nodes.push(line('reason', [document.createTextNode(result.reason)]));

        if (result.warnings.length > 0) {
            const list = document.createElement('ul');
            list.className = 'warns';
            for (const warning of result.warnings) {
                const item = document.createElement('li');
                item.textContent = warning;
                list.append(item);
            }
            nodes.push(list);
        }

        const foot = document.createElement('div');
        foot.className = 'foot';
        foot.textContent =
            `Read-only. No network, no API key, no storage — you perform every action yourself. ` +
            `Ranking tie-break is a community CS-per-nerve estimate, not Torn-verified. ` +
            `Attention threshold ${ATTENTION_THRESHOLD} is a community heuristic. Exact CE per action is unknown and is never shown.`;
        nodes.push(foot);

        panel.body.replaceChildren.apply(panel.body, nodes);
    }

    function line(className, children) {
        const node = document.createElement('div');
        node.className = className;
        node.append.apply(node, children);
        return node;
    }

    function span(className, text) {
        const node = document.createElement('span');
        node.className = className;
        node.textContent = text;
        return node;
    }

    /* ------------------------------------------------------------------ *
     * Layer 5 — lifecycle
     * BOOT -> DETECT PAGE -> INITIALIZE -> RENDER -> OBSERVE -> UPDATE -> DISPOSE
     * ------------------------------------------------------------------ */

    let root = null;
    let panel = null;
    let destroyed = false;
    let updateTimer = null;
    let observing = false;
    let discoveryTimers = [];

    const rowObserver = new MutationObserver((records) => {
        if (records.every(isOwnMutation)) return;
        scheduleUpdate();
    });

    /* childList only, one level, on the container that holds crime-root. This exists
     * purely to notice that Torn swapped the root out under an SPA rerender. It is
     * not a body scan and it never walks a subtree. */
    const containerObserver = new MutationObserver(() => {
        if (destroyed) return;
        if (!root || !root.isConnected) {
            unmount();
            scheduleDiscovery();
            return;
        }
        scheduleUpdate();
    });

    function isOwnMutation(record) {
        if (!panel) return false;
        const target = record.target;
        return target instanceof Node && panel.host.contains(target);
    }

    function isActive() {
        return document.visibilityState === 'visible' && document.hasFocus();
    }

    function scheduleUpdate() {
        if (destroyed || updateTimer !== null) return;
        updateTimer = setTimeout(() => {
            updateTimer = null;
            update();
        }, UPDATE_DEBOUNCE_MS);
    }

    function clearDiscovery() {
        for (const timer of discoveryTimers) clearTimeout(timer);
        discoveryTimers = [];
    }

    function scheduleDiscovery() {
        if (destroyed) return;
        clearDiscovery();
        for (const delay of DISCOVERY_DELAYS_MS) {
            discoveryTimers.push(setTimeout(discover, delay));
        }
    }

    function discover() {
        if (destroyed) return;
        if (root && root.isConnected) return;
        const found = document.querySelector(ROOT_SELECTOR);
        /* No hustling-root means this is not the Hustling view. Mount nothing. */
        if (!found) return;
        clearDiscovery();
        root = found;
        mount();
        update();
    }

    function mount() {
        if (!root || !root.parentElement) return;
        if (!panel) panel = buildPanel();
        if (panel.host.parentElement !== root.parentElement || panel.host.nextSibling !== root) {
            /* Sibling above the view, never inside it: the panel can never trigger the
             * row observer, and it never covers or blocks a Torn control. */
            root.parentElement.insertBefore(panel.host, root);
        }
        containerObserver.disconnect();
        /* Never document.body. On Torn the parent is div.crimes-app; anywhere else
         * the swap watcher is simply skipped and route events drive rediscovery. */
        if (root.parentElement !== document.body) {
            containerObserver.observe(root.parentElement, { childList: true });
        }
    }

    function unmount() {
        stopObserving();
        containerObserver.disconnect();
        if (updateTimer !== null) {
            clearTimeout(updateTimer);
            updateTimer = null;
        }
        if (panel && panel.host.parentElement) panel.host.remove();
        panel = null;
        root = null;
    }

    function startObserving() {
        if (observing || !root) return;
        rowObserver.observe(root, {
            attributeFilter: ['class', 'aria-label', 'aria-disabled'],
            attributes: true,
            childList: true,
            subtree: true,
        });
        observing = true;
    }

    function stopObserving() {
        if (!observing) return;
        rowObserver.disconnect();
        observing = false;
    }

    function update() {
        if (destroyed) return;

        if (!root || !root.isConnected) {
            unmount();
            scheduleDiscovery();
            return;
        }

        if (!isActive()) {
            stopObserving();
            if (panel) renderPaused(panel);
            return;
        }

        startObserving();
        if (!panel) mount();
        if (!panel) return;

        renderRecommendation(panel, decide(readState(root)));
    }

    function onVisibilityChange() {
        if (destroyed) return;
        if (isActive()) scheduleUpdate();
        else update();
    }

    function onRouteChange() {
        if (destroyed) return;
        if (!root || !root.isConnected) unmount();
        scheduleDiscovery();
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        clearDiscovery();
        unmount();
        rowObserver.disconnect();
        containerObserver.disconnect();
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('focus', onVisibilityChange);
        window.removeEventListener('blur', onVisibilityChange);
        window.removeEventListener('hashchange', onRouteChange);
        window.removeEventListener('popstate', onRouteChange);
        Reflect.deleteProperty(window, INSTANCE_KEY);
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onVisibilityChange);
    window.addEventListener('blur', onVisibilityChange);
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('popstate', onRouteChange);

    /**
     * Lifecycle controller. `internals` is a documented test and debug surface: the
     * pure parsers and the pure decision engine, so the regression suite can drive
     * the published file itself instead of a rewritten copy. It performs no action.
     */
    Object.defineProperty(window, INSTANCE_KEY, {
        configurable: true,
        value: Object.freeze({
            version: VERSION,
            status: STATUS,
            mode: MODE,
            destroy,
            internals: Object.freeze({
                ATTENTION_THRESHOLD,
                CASH_WARNING_RATIO,
                classifyOutcomeClasses,
                decide,
                isObserving: () => observing,
                isMounted: () => Boolean(panel && panel.host.isConnected),
                panelId: PANEL_ID,
                parseActionLabel,
                parseAudienceMemberLabel,
                parseAudienceSummary,
                parseMoney,
                readCash,
                readState,
            }),
        }),
        writable: false,
    });

    scheduleDiscovery();
})();
