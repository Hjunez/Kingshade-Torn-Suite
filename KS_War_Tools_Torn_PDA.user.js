// ==UserScript==
// @name         KS War Tools for Torn PDA
// @namespace    https://kingshade.tools/
// @version      0.1.0
// @description  Companion tools for Kingshade Scout Core: faction-list filters, sorting, and exact status countdowns without additional network requests.
// @author       Kingshade
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Companion-script design:
// - Requires the currently viewed faction member list.
// - Reads only data already stored/rendered by Kingshade Scout Core.
// - Makes no API calls and no background requests.
// - Does not automate attacks, clicks, travel, purchases, or other Torn actions.
// - Only modifies the visible faction member-list UI.

(() => {
    "use strict";

    const SCRIPT = Object.freeze({
        name: "KS War Tools",
        version: "0.1.0",
        instanceKey: "__ksWarToolsActive",
        styleId: "kswt-styles",
        toolbarId: "kswt-toolbar",
        settingsKey: "kingshade-war-tools:settings",
        coreCachePrefix: "kingshade-scout:cache:",
        coreManualPrefix: "kingshade-scout:manual:"
    });

    const DEFAULTS = Object.freeze({
        filter: "all",
        sort: "original",
        maxFF: 3.0,
        soonMinutes: 60,
        showTimers: true,
        collapsed: false
    });

    const previous = window[SCRIPT.instanceKey];
    if (previous?.destroy instanceof Function) {
        try {
            previous.destroy();
        } catch {
            // Best-effort cleanup.
        }
    }

    const state = {
        destroyed: false,
        observer: null,
        scanTimer: null,
        clockTimer: null,
        settings: loadSettings(),
        originalOrder: new WeakMap(),
        managedRows: new Set()
    };

    function loadSettings() {
        try {
            const parsed = JSON.parse(localStorage.getItem(SCRIPT.settingsKey) || "{}");
            return { ...DEFAULTS, ...parsed };
        } catch {
            return { ...DEFAULTS };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SCRIPT.settingsKey, JSON.stringify(state.settings));
        } catch {
            // Storage can be unavailable in restricted webviews.
        }
    }

    function isVisiblePage() {
        return document.visibilityState === "visible" && !document.hidden;
    }

    function isFactionPage() {
        return /\/factions\.php\/?$/i.test(location.pathname);
    }

    function normalizeText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function positiveNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : null;
    }

    function playerIdFromHref(rawHref) {
        const href = String(rawHref || "").replaceAll("&amp;", "&");
        if (!href) return null;

        try {
            const url = new URL(href, location.origin);
            for (const key of ["XID", "user2ID", "userId"]) {
                const value = url.searchParams.get(key);
                if (/^\d+$/.test(value || "")) return Number(value);
            }
        } catch {
            // Fall through to regex.
        }

        const match = href.match(/[?&](?:XID|user2ID|userId)=(\d+)/i);
        return match ? Number(match[1]) : null;
    }

    function playerIdFromRow(row) {
        const badgeId = row.querySelector(".ks6-badge[data-player-id]")?.getAttribute("data-player-id");
        if (/^\d+$/.test(badgeId || "")) return Number(badgeId);

        for (const anchor of row.querySelectorAll("a[href]")) {
            const id = playerIdFromHref(anchor.getAttribute("href") || anchor.href);
            if (id) return id;
        }

        const html = String(row.outerHTML || "");
        const match = html.match(/(?:XID|user2ID|userId)(?:=|%3D|&quot;:\s*&quot;|["']?\s*:\s*["']?)(\d+)/i);
        return match ? Number(match[1]) : null;
    }

    function readJson(key) {
        try {
            return JSON.parse(localStorage.getItem(key) || "null");
        } catch {
            return null;
        }
    }

    function coreData(playerId) {
        if (!playerId) return { cache: null, manual: null };

        const wrapped = readJson(`${SCRIPT.coreCachePrefix}${playerId}`);
        const cache = wrapped?.value && (!wrapped.expires || wrapped.expires > Date.now())
            ? wrapped.value
            : null;
        const manual = readJson(`${SCRIPT.coreManualPrefix}${playerId}`);

        return { cache, manual };
    }

    function resolveCoreValues(playerId) {
        const { cache, manual } = coreData(playerId);
        const source = String(cache?.source || "");
        const sourceEstimate = source && cache?.available_estimates
            ? cache.available_estimates[source]
            : null;

        const coreFF =
            positiveNumber(sourceEstimate?.fair_fight) ??
            positiveNumber(cache?.fair_fight);

        const manualFF = positiveNumber(manual?.ff);
        const ff = manualFF ?? coreFF;

        const battleStats =
            positiveNumber(manual?.battleStats) ??
            positiveNumber(sourceEstimate?.bs_estimate) ??
            positiveNumber(cache?.bs_estimate);

        const estimateText = normalizeText(
            sourceEstimate?.bs_estimate_human ||
            cache?.bs_estimate_human ||
            ""
        );

        return {
            ff,
            battleStats,
            estimateText,
            hasCoreData: Boolean(cache),
            hasManualFF: Boolean(manualFF)
        };
    }

    function findMemberLists() {
        if (!isFactionPage()) return [];
        return Array.from(document.querySelectorAll(".members-list"))
            .filter(list => list instanceof HTMLElement);
    }

    function rowsInList(list) {
        const body = list.querySelector(".table-body");
        if (!body) return [];

        return Array.from(body.children).filter(row =>
            row instanceof HTMLElement &&
            (row.matches(".table-row") || row.matches(".enemy") || row.matches(".your"))
        );
    }

    function getStatusElement(row) {
        const candidates = Array.from(row.querySelectorAll("*")).filter(element => {
            const text = normalizeText(element.textContent);
            return /^(?:okay|hospital|jail|federal|traveling|travelling|abroad|fallen)$/i.test(text);
        });

        return candidates.sort((a, b) => {
            const aChildren = a.children.length;
            const bChildren = b.children.length;
            return aChildren - bChildren;
        })[0] || null;
    }

    function statusFromRow(row) {
        const element = getStatusElement(row);
        const raw = normalizeText(element?.textContent || row.textContent).toLowerCase();

        if (/\btravelling\b/.test(raw)) return "traveling";
        for (const status of ["okay", "hospital", "jail", "federal", "traveling", "abroad", "fallen"]) {
            if (new RegExp(`\\b${status}\\b`, "i").test(raw)) return status;
        }
        return "unknown";
    }

    function parseAbsoluteTimestamp(value) {
        if (value === null || value === undefined || value === "") return null;

        const text = String(value).trim();
        if (!text) return null;

        if (/^\d{10,13}$/.test(text)) {
            const number = Number(text);
            return text.length >= 13 ? Math.floor(number / 1000) : number;
        }

        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }

    function parseDurationSeconds(value) {
        const text = normalizeText(value).toLowerCase();
        if (!text) return null;

        const colon = text.match(/\b(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\b/);
        if (colon) {
            const hours = Number(colon[1] || 0);
            const minutes = Number(colon[2] || 0);
            const seconds = Number(colon[3] || 0);
            return hours * 3600 + minutes * 60 + seconds;
        }

        let total = 0;
        let found = false;
        const units = [
            [/(\d+(?:[.,]\d+)?)\s*(?:d|day|days)\b/g, 86400],
            [/(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/g, 3600],
            [/(\d+(?:[.,]\d+)?)\s*(?:m|min|mins|minute|minutes)\b/g, 60],
            [/(\d+(?:[.,]\d+)?)\s*(?:s|sec|secs|second|seconds)\b/g, 1]
        ];

        for (const [pattern, multiplier] of units) {
            for (const match of text.matchAll(pattern)) {
                found = true;
                total += Number(match[1].replace(",", ".")) * multiplier;
            }
        }

        return found && total > 0 ? Math.floor(total) : null;
    }

    function statusUntil(row) {
        const statusElement = getStatusElement(row);
        const candidates = [
            statusElement?.dataset?.until,
            statusElement?.dataset?.timestamp,
            statusElement?.dataset?.time,
            statusElement?.getAttribute?.("data-until"),
            statusElement?.getAttribute?.("data-timestamp"),
            row.dataset?.until,
            row.dataset?.timestamp,
            row.dataset?.statusUntil,
            row.getAttribute("data-until"),
            row.getAttribute("data-status-until")
        ];

        const timeElement = statusElement?.querySelector?.("time") || row.querySelector("time");
        if (timeElement) {
            candidates.push(
                timeElement.getAttribute("datetime"),
                timeElement.getAttribute("data-until"),
                timeElement.getAttribute("data-timestamp")
            );
        }

        const now = Math.floor(Date.now() / 1000);
        for (const candidate of candidates) {
            const timestamp = parseAbsoluteTimestamp(candidate);
            if (timestamp && timestamp >= now - 5) return timestamp;
        }

        const sourceText = [
            statusElement?.textContent,
            statusElement?.getAttribute?.("aria-label"),
            statusElement?.getAttribute?.("title"),
            row.getAttribute("aria-label"),
            row.getAttribute("title")
        ].filter(Boolean).join(" ");

        const duration = parseDurationSeconds(sourceText);
        return duration ? now + duration : null;
    }

    function formatCountdown(totalSeconds) {
        const seconds = Math.max(0, Math.floor(totalSeconds));
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
        return `${minutes}m ${String(secs).padStart(2, "0")}s`;
    }

    function rowInfo(row, originalIndex = 0) {
        const playerId = playerIdFromRow(row);
        const core = resolveCoreValues(playerId);
        const status = statusFromRow(row);
        const until = status === "okay" ? null : statusUntil(row);

        return {
            row,
            playerId,
            originalIndex,
            status,
            until,
            ...core
        };
    }

    function ensureOriginalOrder(body, rows) {
        let map = state.originalOrder.get(body);
        if (!map) {
            map = new Map();
            state.originalOrder.set(body, map);
        }

        for (const row of rows) {
            if (!map.has(row)) map.set(row, map.size);
        }

        return map;
    }

    function compareRows(a, b) {
        switch (state.settings.sort) {
            case "ff":
                return (a.ff ?? Number.POSITIVE_INFINITY) - (b.ff ?? Number.POSITIVE_INFINITY) ||
                    a.originalIndex - b.originalIndex;

            case "status": {
                const rank = {
                    okay: 0,
                    hospital: 1,
                    jail: 2,
                    traveling: 3,
                    abroad: 4,
                    federal: 5,
                    fallen: 6,
                    unknown: 7
                };
                return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
                    (a.until ?? Number.POSITIVE_INFINITY) - (b.until ?? Number.POSITIVE_INFINITY) ||
                    a.originalIndex - b.originalIndex;
            }

            case "soon":
                return (a.until ?? Number.POSITIVE_INFINITY) - (b.until ?? Number.POSITIVE_INFINITY) ||
                    a.originalIndex - b.originalIndex;

            default:
                return a.originalIndex - b.originalIndex;
        }
    }

    function matchesFilter(info) {
        const now = Math.floor(Date.now() / 1000);
        const soonLimit = Number(state.settings.soonMinutes) * 60;

        switch (state.settings.filter) {
            case "ready":
                return info.status === "okay";

            case "easy":
                return Boolean(info.ff && info.ff <= Number(state.settings.maxFF));

            case "soon":
                return Boolean(
                    info.until &&
                    info.until > now &&
                    info.until - now <= soonLimit
                );

            case "unknown":
                return !info.ff && !info.battleStats && !info.estimateText;

            default:
                return true;
        }
    }

    function removeTimer(row) {
        row.querySelectorAll(".kswt-timer").forEach(element => element.remove());
    }

    function renderTimer(info) {
        removeTimer(info.row);
        if (!state.settings.showTimers || !info.until || info.status === "okay") return;

        const remaining = info.until - Math.floor(Date.now() / 1000);
        if (remaining <= 0) return;

        const statusElement = getStatusElement(info.row);
        if (!statusElement) return;

        statusElement.classList.add("kswt-status-host");
        const timer = document.createElement("span");
        timer.className = "kswt-timer";
        timer.dataset.until = String(info.until);
        timer.textContent = formatCountdown(remaining);
        statusElement.appendChild(timer);
    }

    function applyRows() {
        if (state.destroyed || !isVisiblePage() || !isFactionPage()) return;

        const allInfo = [];

        for (const list of findMemberLists()) {
            const body = list.querySelector(".table-body");
            if (!body) continue;

            const rows = rowsInList(list);
            const original = ensureOriginalOrder(body, rows);
            const infos = rows.map(row => rowInfo(row, original.get(row) ?? 0));

            infos.sort(compareRows);
            for (const info of infos) {
                body.appendChild(info.row);
                state.managedRows.add(info.row);

                if (matchesFilter(info)) {
                    info.row.style.removeProperty("display");
                } else {
                    info.row.style.setProperty("display", "none", "important");
                }

                renderTimer(info);
                allInfo.push(info);
            }
        }

        updateToolbar(allInfo);
        manageClock(allInfo.some(info => info.until && info.until > Date.now() / 1000));
    }

    function clearRowChanges() {
        for (const row of state.managedRows) {
            row.style.removeProperty("display");
            removeTimer(row);
            row.querySelectorAll(".kswt-status-host").forEach(element =>
                element.classList.remove("kswt-status-host")
            );
        }
        state.managedRows.clear();

        for (const list of findMemberLists()) {
            const body = list.querySelector(".table-body");
            if (!body) continue;

            const rows = rowsInList(list);
            const original = state.originalOrder.get(body);
            if (!original) continue;

            rows.sort((a, b) => (original.get(a) ?? 0) - (original.get(b) ?? 0));
            rows.forEach(row => body.appendChild(row));
        }
    }

    function countsFor(infos) {
        const now = Math.floor(Date.now() / 1000);
        const soonLimit = Number(state.settings.soonMinutes) * 60;

        return {
            all: infos.length,
            ready: infos.filter(info => info.status === "okay").length,
            easy: infos.filter(info => info.ff && info.ff <= Number(state.settings.maxFF)).length,
            soon: infos.filter(info =>
                info.until &&
                info.until > now &&
                info.until - now <= soonLimit
            ).length,
            unknown: infos.filter(info => !info.ff && !info.battleStats && !info.estimateText).length,
            core: infos.filter(info => info.hasCoreData || info.row.querySelector(".ks6-badge")).length
        };
    }

    function updateToolbar(infos) {
        const toolbar = document.getElementById(SCRIPT.toolbarId);
        if (!toolbar) return;

        const counts = countsFor(infos);
        toolbar.querySelector("[data-kswt=status]").textContent =
            `Core ${counts.core}/${counts.all} · Showing ${infos.filter(matchesFilter).length}/${counts.all}`;

        for (const key of ["all", "ready", "easy", "soon", "unknown"]) {
            const button = toolbar.querySelector(`[data-filter="${key}"]`);
            if (!button) continue;
            button.textContent = `${key.toUpperCase()} ${counts[key]}`;
            button.classList.toggle("active", state.settings.filter === key);
        }

        toolbar.classList.toggle("collapsed", Boolean(state.settings.collapsed));
    }

    function ensureStyles() {
        document.getElementById(SCRIPT.styleId)?.remove();

        const style = document.createElement("style");
        style.id = SCRIPT.styleId;
        style.textContent = `
            #${SCRIPT.toolbarId}{
                box-sizing:border-box!important;
                width:100%!important;
                margin:8px 0!important;
                padding:9px!important;
                border:1px solid #4b4f55!important;
                border-radius:8px!important;
                background:#202124!important;
                color:#fff!important;
                font:12px/1.3 Arial,sans-serif!important;
                box-shadow:0 3px 12px rgba(0,0,0,.38)!important;
            }
            #${SCRIPT.toolbarId} *{box-sizing:border-box!important}
            #${SCRIPT.toolbarId} .kswt-head{
                display:flex!important;
                align-items:center!important;
                justify-content:space-between!important;
                gap:8px!important;
            }
            #${SCRIPT.toolbarId} .kswt-title{
                color:#fff!important;
                font-size:14px!important;
                font-weight:800!important;
            }
            #${SCRIPT.toolbarId} .kswt-status{
                margin-top:2px!important;
                color:#c7c9cc!important;
                font-size:10px!important;
            }
            #${SCRIPT.toolbarId} .kswt-collapse{
                flex:0 0 32px!important;
                width:32px!important;
                height:32px!important;
                margin:0!important;
                padding:0!important;
                border:1px solid #656a70!important;
                border-radius:50%!important;
                background:#34383d!important;
                color:#fff!important;
                font:800 20px/28px Arial!important;
                text-shadow:none!important;
            }
            #${SCRIPT.toolbarId} .kswt-body{margin-top:9px!important}
            #${SCRIPT.toolbarId}.collapsed .kswt-body{display:none!important}
            #${SCRIPT.toolbarId} .kswt-filters{
                display:grid!important;
                grid-template-columns:repeat(5,minmax(0,1fr))!important;
                gap:4px!important;
            }
            #${SCRIPT.toolbarId} .kswt-filter{
                min-width:0!important;
                padding:7px 2px!important;
                border:1px solid #5c6167!important;
                border-radius:5px!important;
                background:#34383d!important;
                color:#fff!important;
                font-size:9px!important;
                font-weight:800!important;
                text-shadow:none!important;
                white-space:nowrap!important;
            }
            #${SCRIPT.toolbarId} .kswt-filter.active{
                border-color:#d4ab58!important;
                background:#5a4318!important;
                color:#ffe4a1!important;
            }
            #${SCRIPT.toolbarId} .kswt-controls{
                display:grid!important;
                grid-template-columns:1fr 1fr!important;
                gap:6px 8px!important;
                margin-top:9px!important;
            }
            #${SCRIPT.toolbarId} label{
                display:flex!important;
                align-items:center!important;
                justify-content:space-between!important;
                gap:6px!important;
                color:#fff!important;
                font-size:11px!important;
            }
            #${SCRIPT.toolbarId} input[type=number],
            #${SCRIPT.toolbarId} select{
                width:74px!important;
                min-width:0!important;
                height:30px!important;
                padding:3px 5px!important;
                border:1px solid #777!important;
                border-radius:4px!important;
                background:#fff!important;
                color:#111!important;
                font-size:12px!important;
            }
            #${SCRIPT.toolbarId} input[type=checkbox]{
                width:20px!important;
                height:20px!important;
            }
            #${SCRIPT.toolbarId} .kswt-note{
                margin-top:8px!important;
                color:#bfc2c6!important;
                font-size:10px!important;
            }
            .kswt-status-host{
                position:relative!important;
            }
            .kswt-timer{
                display:block!important;
                margin-top:1px!important;
                color:#fff!important;
                font:800 8px/1.1 Arial,sans-serif!important;
                text-shadow:0 1px 2px rgba(0,0,0,.8)!important;
                white-space:nowrap!important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function toolbarHtml() {
        return `
            <div class="kswt-head">
                <div>
                    <div class="kswt-title">KS War Tools ${SCRIPT.version}</div>
                    <div class="kswt-status" data-kswt="status">Waiting for Kingshade Scout Core…</div>
                </div>
                <button type="button" class="kswt-collapse" data-kswt="collapse" aria-label="Collapse">−</button>
            </div>

            <div class="kswt-body">
                <div class="kswt-filters">
                    <button type="button" class="kswt-filter" data-filter="all">ALL</button>
                    <button type="button" class="kswt-filter" data-filter="ready">READY</button>
                    <button type="button" class="kswt-filter" data-filter="easy">EASY</button>
                    <button type="button" class="kswt-filter" data-filter="soon">SOON</button>
                    <button type="button" class="kswt-filter" data-filter="unknown">UNKNOWN</button>
                </div>

                <div class="kswt-controls">
                    <label>Easy max FF
                        <input type="number" min="0.1" max="20" step="0.1"
                               data-kswt="max-ff" value="${state.settings.maxFF}">
                    </label>

                    <label>Soon within
                        <span style="display:flex;align-items:center;gap:4px">
                            <input type="number" min="1" max="1440" step="5"
                                   data-kswt="soon" value="${state.settings.soonMinutes}">
                            <span>min</span>
                        </span>
                    </label>

                    <label>Sort
                        <select data-kswt="sort">
                            <option value="original">Original</option>
                            <option value="ff">FF low → high</option>
                            <option value="status">Status</option>
                            <option value="soon">Ending soon</option>
                        </select>
                    </label>

                    <label>Exact timers
                        <input type="checkbox" data-kswt="timers"
                               ${state.settings.showTimers ? "checked" : ""}>
                    </label>
                </div>

                <div class="kswt-note">
                    Uses Kingshade Scout Core data already on this visible page. “SOON” only includes rows where Torn exposes an exact end time; it never guesses.
                </div>
            </div>
        `;
    }

    function bindToolbar(toolbar) {
        toolbar.querySelectorAll("[data-filter]").forEach(button => {
            button.addEventListener("click", () => {
                state.settings.filter = button.dataset.filter || "all";
                saveSettings();
                scheduleApply(0);
            });
        });

        toolbar.querySelector('[data-kswt="collapse"]').addEventListener("click", () => {
            state.settings.collapsed = !state.settings.collapsed;
            saveSettings();
            toolbar.classList.toggle("collapsed", state.settings.collapsed);
            toolbar.querySelector('[data-kswt="collapse"]').textContent =
                state.settings.collapsed ? "+" : "−";
        });

        const maxFF = toolbar.querySelector('[data-kswt="max-ff"]');
        maxFF.addEventListener("change", () => {
            const value = Number(maxFF.value);
            state.settings.maxFF = Number.isFinite(value) && value > 0 ? value : DEFAULTS.maxFF;
            maxFF.value = String(state.settings.maxFF);
            saveSettings();
            scheduleApply(0);
        });

        const soon = toolbar.querySelector('[data-kswt="soon"]');
        soon.addEventListener("change", () => {
            const value = Number(soon.value);
            state.settings.soonMinutes = Number.isFinite(value) && value > 0
                ? Math.min(1440, Math.max(1, value))
                : DEFAULTS.soonMinutes;
            soon.value = String(state.settings.soonMinutes);
            saveSettings();
            scheduleApply(0);
        });

        const sort = toolbar.querySelector('[data-kswt="sort"]');
        sort.value = state.settings.sort;
        sort.addEventListener("change", () => {
            state.settings.sort = sort.value;
            saveSettings();
            scheduleApply(0);
        });

        const timers = toolbar.querySelector('[data-kswt="timers"]');
        timers.addEventListener("change", () => {
            state.settings.showTimers = timers.checked;
            saveSettings();
            scheduleApply(0);
        });

        toolbar.classList.toggle("collapsed", state.settings.collapsed);
        toolbar.querySelector('[data-kswt="collapse"]').textContent =
            state.settings.collapsed ? "+" : "−";
    }

    function ensureToolbar() {
        if (state.destroyed || !isFactionPage()) return null;

        const existing = document.getElementById(SCRIPT.toolbarId);
        if (existing) return existing;

        const firstList = findMemberLists()[0];
        if (!firstList?.parentNode) return null;

        const toolbar = document.createElement("section");
        toolbar.id = SCRIPT.toolbarId;
        toolbar.innerHTML = toolbarHtml();
        firstList.parentNode.insertBefore(toolbar, firstList);
        bindToolbar(toolbar);

        return toolbar;
    }

    function manageClock(needed) {
        if (needed && !state.clockTimer) {
            state.clockTimer = setInterval(() => {
                if (!state.destroyed && isVisiblePage()) scheduleApply(0);
            }, 1000);
        } else if (!needed && state.clockTimer) {
            clearInterval(state.clockTimer);
            state.clockTimer = null;
        }
    }

    function scheduleApply(delay = 150) {
        clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(() => {
            state.scanTimer = null;
            if (state.destroyed || !isVisiblePage()) return;
            ensureToolbar();
            applyRows();
        }, delay);
    }

    function handleVisibility() {
        if (isVisiblePage()) {
            scheduleApply(0);
        } else {
            clearTimeout(state.scanTimer);
            state.scanTimer = null;
            if (state.clockTimer) {
                clearInterval(state.clockTimer);
                state.clockTimer = null;
            }
        }
    }

    function init() {
        if (!document.body) {
            setTimeout(init, 100);
            return;
        }

        ensureStyles();
        ensureToolbar();

        state.observer = new MutationObserver(mutations => {
            const relevant = mutations.some(mutation =>
                Array.from(mutation.addedNodes).some(node =>
                    node instanceof Element &&
                    !node.closest?.(`#${SCRIPT.toolbarId}`) &&
                    !node.matches?.(".kswt-timer")
                )
            );

            if (relevant) scheduleApply();
        });

        state.observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener("hashchange", () => scheduleApply(200));
        window.addEventListener("popstate", () => scheduleApply(200));
        window.navigation?.addEventListener?.("currententrychange", () => scheduleApply(200));

        scheduleApply(0);

        window[SCRIPT.instanceKey] = {
            version: SCRIPT.version,
            destroy
        };
    }

    function destroy() {
        if (state.destroyed) return;
        state.destroyed = true;

        clearTimeout(state.scanTimer);
        clearInterval(state.clockTimer);
        state.observer?.disconnect();

        document.removeEventListener("visibilitychange", handleVisibility);
        document.getElementById(SCRIPT.toolbarId)?.remove();
        document.getElementById(SCRIPT.styleId)?.remove();

        clearRowChanges();

        if (window[SCRIPT.instanceKey]?.destroy === destroy) {
            delete window[SCRIPT.instanceKey];
        }
    }

    init();
})();
