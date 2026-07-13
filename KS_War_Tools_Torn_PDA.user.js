// ==UserScript==
// @name         KS War Tools for Torn PDA
// @namespace    https://kingshade.tools/
// @version      0.8.2
// @description  Kingshade Suite War Tools for faction filters, sorting, exact status timers, and marked travel ETA estimates.
// @author       Kingshade
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Companion-script design:
// - Kingshade Scout Core owns FF/EST data and faction status polling.
// - This script reads the shared Scout snapshot and renders the war UI.
// - Hospital/Jail timers use Torn's exact status.until timestamp.
// - Travel timers are prefixed with ~ because Torn does not expose an exact arrival timestamp.
// - Makes no network requests and automates no Torn actions.

(() => {
    "use strict";

    const SCRIPT = Object.freeze({
        name: "Kingshade Suite",
        component: "War Tools",
        version: "0.8.2",
        instanceKey: "__ksWarToolsActive",
        sharedCoreKey: "__kingshadeScoutCore",
        sharedStorageKey: "kingshade-scout:status-core",
        sharedEvent: "kingshade-scout:status-update",
        ffEvent: "kingshade-scout:ff-update",
        readyEvent: "kingshade-war-tools:ready",
        styleId: "kswt-styles",
        toolbarId: "kswt-toolbar",
        infoId: "kswt-timer-info",
        settingsKey: "kingshade-war-tools:settings",
        coreCachePrefix: "kingshade-scout:cache:",
        coreManualPrefix: "kingshade-scout:manual:"
    });

    const DEFAULTS = Object.freeze({
        filter: "all",
        sort: "original",
        maxFF: 3.0,
        soonMinutes: 60,
        collapsed: false
    });

    const previous = window[SCRIPT.instanceKey];
    if (previous?.destroy instanceof Function) {
        try { previous.destroy(); } catch {}
    }

    const state = {
        destroyed: false,
        observer: null,
        scanTimer: null,
        clockTimer: null,
        infoTimer: null,
        settings: loadSettings(),
        originalOrder: new WeakMap(),
        managedRows: new Set(),
        applying: false,
        lastInfos: [],
        activeSnapshot: null
    };

    function loadSettings() {
        try {
            const parsed = JSON.parse(localStorage.getItem(SCRIPT.settingsKey) || "{}");
            delete parsed.showTimers;
            return { ...DEFAULTS, ...parsed };
        } catch {
            return { ...DEFAULTS };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SCRIPT.settingsKey, JSON.stringify(state.settings));
        } catch {}
    }

    function readJson(key) {
        try {
            return JSON.parse(localStorage.getItem(key) || "null");
        } catch {
            return null;
        }
    }

    function isVisiblePage() {
        return document.visibilityState === "visible" && !document.hidden;
    }

    function isFactionPage() {
        return /\/factions\.php\/?$/i.test(location.pathname);
    }

    function detectFactionId() {
        const current = String(location.href || "").replaceAll("&amp;", "&");
        const direct = current.match(/[?&#](?:ID|factionID|factionId)=(\d+)/i);
        if (direct) return Number(direct[1]);

        const counts = new Map();
        document.querySelectorAll('a[href*="factions.php"][href*="ID="]').forEach(anchor => {
            const href = String(anchor.getAttribute("href") || "").replaceAll("&amp;", "&");
            const match = href.match(/[?&]ID=(\d+)/i);
            if (!match) return;
            const id = Number(match[1]);
            counts.set(id, (counts.get(id) || 0) + 1);
        });

        let bestId = null;
        let bestCount = 0;
        for (const [id, count] of counts) {
            if (count > bestCount) {
                bestId = id;
                bestCount = count;
            }
        }
        return bestId;
    }

    function normalizeText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function plainText(value) {
        const raw = String(value || "");
        if (!raw) return "";
        if (!/[<&]/.test(raw)) return normalizeText(raw);

        try {
            const template = document.createElement("template");
            template.innerHTML = raw;
            return normalizeText(template.content.textContent || "");
        } catch {
            return normalizeText(raw.replace(/<[^>]*>/g, " "));
        }
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
        } catch {}

        const match = href.match(/[?&](?:XID|user2ID|userId)=(\d+)/i);
        return match ? Number(match[1]) : null;
    }

    function profileLinkFromStatusHtml(value) {
        const raw = String(value || "");
        if (!raw) return null;

        const candidates = [raw];
        try {
            const decoder = document.createElement("textarea");
            decoder.innerHTML = raw;
            const decoded = decoder.value;
            if (decoded && decoded !== raw) candidates.push(decoded);
        } catch {}

        for (const candidate of candidates) {
            if (!/<a\b/i.test(candidate)) continue;

            try {
                const template = document.createElement("template");
                template.innerHTML = candidate;

                for (const anchor of template.content.querySelectorAll("a[href]")) {
                    const id = playerIdFromHref(anchor.getAttribute("href") || "");
                    const name = normalizeText(anchor.textContent);
                    if (!id || !name) continue;
                    return {
                        id,
                        name,
                        href: `/profiles.php?XID=${id}`
                    };
                }
            } catch {}
        }

        return null;
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

    function coreData(playerId) {
        if (!playerId) return { cache: null, manual: null };
        const wrapped = readJson(`${SCRIPT.coreCachePrefix}${playerId}`);
        const cache = wrapped?.value && (!wrapped.expires || wrapped.expires > Date.now()) ? wrapped.value : null;
        const manual = readJson(`${SCRIPT.coreManualPrefix}${playerId}`);
        return { cache, manual };
    }

    function badgeCoreValues(row) {
        const badge = row?.querySelector?.(".ks6-badge");
        const text = normalizeText(badge?.textContent || "");
        const ffMatch = text.match(/^(?:FF|MAN)\s+(\d+(?:[.,]\d+)?)/i);
        const estimateMatch = text.match(/^EST\s+(.+)$/i);

        return {
            ff: ffMatch ? positiveNumber(String(ffMatch[1]).replace(",", ".")) : null,
            estimateText: normalizeText(estimateMatch?.[1] || ""),
            hasBadge: Boolean(badge)
        };
    }

    function resolveCoreValues(playerId, row) {
        const { cache, manual } = coreData(playerId);
        const badge = badgeCoreValues(row);
        const source = String(cache?.source || "");
        const sourceEstimate = source && cache?.available_estimates ? cache.available_estimates[source] : null;
        const coreFF = positiveNumber(sourceEstimate?.fair_fight) ?? positiveNumber(cache?.fair_fight);
        const manualFF = positiveNumber(manual?.ff);
        const ff = manualFF ?? coreFF ?? badge.ff;
        const battleStats =
            positiveNumber(manual?.battleStats) ??
            positiveNumber(sourceEstimate?.bs_estimate) ??
            positiveNumber(cache?.bs_estimate);
        const estimateText = normalizeText(
            sourceEstimate?.bs_estimate_human ||
            cache?.bs_estimate_human ||
            badge.estimateText ||
            ""
        );

        return {
            ff,
            battleStats,
            estimateText,
            hasCoreData: Boolean(cache || badge.hasBadge),
            hasManualFF: Boolean(manualFF)
        };
    }

    function displayedPlayerIds(limit = 20) {
        const ids = [];
        for (const list of findMemberLists()) {
            for (const row of rowsInList(list)) {
                const id = playerIdFromRow(row);
                if (id && !ids.includes(id)) ids.push(id);
                if (ids.length >= limit) return ids;
            }
        }
        return ids;
    }

    function snapshotMatchesCurrent(snapshot) {
        if (!snapshot?.members || typeof snapshot.members !== "object") return false;

        const currentFactionId = detectFactionId();
        const snapshotFactionId = positiveNumber(snapshot.factionId);
        if (currentFactionId && snapshotFactionId) {
            return Number(currentFactionId) === Number(snapshotFactionId);
        }

        const ids = displayedPlayerIds();
        if (!ids.length) return false;
        return ids.some(id => snapshot.members[id] || snapshot.members[String(id)]);
    }

    function getStatusSnapshot() {
        const candidates = [
            window[SCRIPT.sharedCoreKey],
            readJson(SCRIPT.sharedStorageKey)
        ];

        return candidates.find(snapshot => snapshotMatchesCurrent(snapshot)) || null;
    }

    function sharedMember(playerId, snapshot = state.activeSnapshot) {
        if (!playerId || !snapshot?.members) return null;
        return snapshot.members[playerId] || snapshot.members[String(playerId)] || null;
    }

    function findMemberLists() {
        if (!isFactionPage()) return [];
        return Array.from(document.querySelectorAll(".members-list")).filter(list => list instanceof HTMLElement);
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
        const direct = row.querySelector(".table-cell.status");
        if (direct) return direct;

        const candidates = Array.from(row.querySelectorAll("*")).filter(element => {
            const text = normalizeText(element.textContent);
            return /^(?:okay|hospital|jail|federal|traveling|travelling|abroad|fallen)$/i.test(text);
        });

        return candidates.sort((a, b) => a.children.length - b.children.length)[0] || null;
    }

    function normalizeStatusState(value) {
        const raw = normalizeText(value).toLowerCase();
        if (raw === "travelling") return "traveling";
        if (["okay", "hospital", "jail", "federal", "traveling", "abroad", "fallen"].includes(raw)) return raw;
        return "unknown";
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

    function domStatusUntil(row) {
        const statusElement = getStatusElement(row);
        const candidates = [
            statusElement?.dataset?.until,
            statusElement?.dataset?.timestamp,
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
        return null;
    }

    function resolveStatus(playerId, row, snapshot) {
        const member = sharedMember(playerId, snapshot);
        const apiStatus = member?.status || null;
        const apiState = normalizeStatusState(apiStatus?.state);
        const status = apiState !== "unknown" ? apiState : statusFromRow(row);
        const now = Math.floor(Date.now() / 1000);
        const exactUntil = positiveNumber(apiStatus?.until) ?? domStatusUntil(row);
        const travelEta = status === "traveling" ? positiveNumber(member?.travel?.eta) : null;
        const until = exactUntil && exactUntil > now ? exactUntil : travelEta && travelEta > now ? travelEta : null;
        const timerKind = exactUntil && exactUntil > now
            ? "exact"
            : travelEta && travelEta > now
                ? "estimate"
                : status === "traveling"
                    ? "estimate-unavailable"
                    : null;

        const rawDescription = String(apiStatus?.description || "");
        const rawDetails = String(apiStatus?.details || "");
        const linkedPlayer =
            profileLinkFromStatusHtml(rawDetails) ??
            profileLinkFromStatusHtml(rawDescription);

        return {
            status,
            until,
            timerKind,
            description: plainText(rawDescription),
            details: plainText(rawDetails),
            linkedPlayer,
            travel: member?.travel || null,
            level: positiveNumber(member?.level),
            hasStatusData: Boolean(member)
        };
    }

    function formatCompactDuration(totalSeconds) {
        const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.max(0, Math.round((seconds % 3600) / 60));
        if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
        return `${minutes}m`;
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

    function rowInfo(row, originalIndex = 0, snapshot = null) {
        const playerId = playerIdFromRow(row);
        const core = resolveCoreValues(playerId, row);
        const status = resolveStatus(playerId, row, snapshot);
        return { row, playerId, originalIndex, ...core, ...status };
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
                return (a.ff ?? Number.POSITIVE_INFINITY) - (b.ff ?? Number.POSITIVE_INFINITY) || a.originalIndex - b.originalIndex;
            case "status": {
                const rank = { okay: 0, hospital: 1, jail: 2, traveling: 3, abroad: 4, federal: 5, fallen: 6, unknown: 7 };
                return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
                    (a.until ?? Number.POSITIVE_INFINITY) - (b.until ?? Number.POSITIVE_INFINITY) ||
                    a.originalIndex - b.originalIndex;
            }
            case "soon":
                return (a.until ?? Number.POSITIVE_INFINITY) - (b.until ?? Number.POSITIVE_INFINITY) || a.originalIndex - b.originalIndex;
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
                return Boolean(info.status === "okay" && info.ff && info.ff <= Number(state.settings.maxFF));
            case "soon":
                return Boolean(info.until && info.until > now && info.until - now <= soonLimit);
            case "unknown":
                return !info.ff && !info.battleStats && !info.estimateText;
            default:
                return true;
        }
    }

    function removeTimer(row) {
        row.querySelectorAll(".kswt-timer").forEach(element => element.remove());
        row.querySelectorAll(".kswt-status-host").forEach(element => {
            element.classList.remove("kswt-status-host", "kswt-compact-status");
            delete element.dataset.kswtLabel;
        });
    }

    function timerTitle(info) {
        if (info.timerKind === "estimate-unavailable") {
            const reason = String(info.travel?.unavailableReason || "");
            const reasonText = reason === "destination-not-exposed"
                ? "Torn did not expose the destination"
                : reason === "route-time-unavailable"
                    ? "No verified route time is available"
                    : reason === "estimate-expired-while-still-traveling"
                        ? "The previous estimate expired while Torn still reports Traveling"
                        : "Scout could not establish a trustworthy departure estimate";
            return [
                info.description || "Traveling",
                "ETA unavailable",
                reasonText,
                "Torn exposes no exact arrival timestamp"
            ].filter(Boolean).join(" · ");
        }
        if (info.timerKind === "exact") {
            return [info.description, info.details, "Exact Torn status end time"].filter(Boolean).join(" · ");
        }
        if (info.timerKind === "estimate") {
            const source = info.travel?.estimateSource === "observed-history"
                ? `Route time learned from ${Number(info.travel?.historyCount) || 1} observed flight(s)`
                : "Published route time";
            const departure = info.travel?.departureSource === "last-action-fallback"
                ? "departure inferred from last action"
                : "departure observed by Scout";
            const confidence = String(info.travel?.confidence || "low");
            const uncertainty = positiveNumber(info.travel?.uncertaintySeconds);
            const range = uncertainty
                ? `likely remaining range ${formatCompactDuration(Math.max(0, (info.until || 0) - Math.floor(Date.now() / 1000) - uncertainty))}–${formatCompactDuration(Math.max(0, (info.until || 0) - Math.floor(Date.now() / 1000) + uncertainty))}`
                : "";
            const calibration = Number(info.travel?.actionOffsetSamples) > 0
                ? `calibrated from ${Number(info.travel.actionOffsetSamples)} completed flight(s)`
                : "not calibrated yet";
            return [
                info.description,
                source,
                departure,
                `${confidence} confidence`,
                range,
                calibration,
                "Torn exposes no exact arrival timestamp"
            ].filter(Boolean).join(" · ");
        }
        return "";
    }

    function closeTimerInfo() {
        clearTimeout(state.infoTimer);
        state.infoTimer = null;
        document.getElementById(SCRIPT.infoId)?.remove();
    }

    function appendLinkedMessage(content, message, linkedPlayer) {
        const name = normalizeText(linkedPlayer?.name);
        const id = positiveNumber(linkedPlayer?.id);
        const index = name ? message.toLowerCase().indexOf(name.toLowerCase()) : -1;

        if (!id || !name || index < 0) {
            content.textContent = message;
            return;
        }

        content.append(document.createTextNode(message.slice(0, index)));

        const link = document.createElement("a");
        link.className = "kswt-profile-link";
        link.href = `/profiles.php?XID=${id}`;
        link.textContent = message.slice(index, index + name.length) || name;
        link.setAttribute("aria-label", `Open ${name}'s Torn profile`);
        link.addEventListener("click", event => event.stopPropagation());
        content.append(link);

        content.append(document.createTextNode(message.slice(index + name.length)));
    }

    function showTimerInfo(text, linkedPlayer = null) {
        closeTimerInfo();
        const message = normalizeText(text);
        if (!message) return;

        const box = document.createElement("div");
        box.id = SCRIPT.infoId;
        box.setAttribute("role", "status");
        box.setAttribute("aria-live", "polite");

        const content = document.createElement("div");
        content.className = "kswt-info-text";
        appendLinkedMessage(content, message, linkedPlayer);

        const close = document.createElement("button");
        close.type = "button";
        close.className = "kswt-info-close";
        close.setAttribute("aria-label", "Close timer information");
        close.textContent = "×";
        close.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            closeTimerInfo();
        };

        box.append(content, close);
        document.body.appendChild(box);
        state.infoTimer = setTimeout(closeTimerInfo, 5000);
    }

    function activateTimerInfo(event) {
        event.preventDefault();
        event.stopPropagation();
        const timer = event.currentTarget;
        const linkedPlayer = timer?.dataset?.linkedPlayerId
            ? {
                id: Number(timer.dataset.linkedPlayerId),
                name: timer.dataset.linkedPlayerName || ""
            }
            : null;
        showTimerInfo(timer?.dataset?.info || "", linkedPlayer);
    }

    function compactStatusLabel(status) {
        const labels = {
            hospital: "HOSP",
            jail: "JAIL",
            federal: "FED",
            traveling: "TRAVEL",
            fallen: "FALLEN"
        };
        return labels[status] || String(status || "").toUpperCase();
    }

    function renderTimer(info) {
        removeTimer(info.row);
        if (info.status === "okay" || info.status === "abroad") return;

        const statusElement = getStatusElement(info.row);
        if (!statusElement) return;

        const isUnavailableTravel = info.timerKind === "estimate-unavailable";
        const remaining = info.until
            ? info.until - Math.floor(Date.now() / 1000)
            : null;
        if (!isUnavailableTravel && (!info.until || remaining <= 0)) return;

        statusElement.classList.add("kswt-status-host");
        const statusText = statusElement.querySelector(".ellipsis");
        if (statusText) {
            statusElement.classList.add("kswt-compact-status");
            statusElement.dataset.kswtLabel = compactStatusLabel(info.status);
        }

        const timer = document.createElement("span");
        timer.className = `kswt-timer ${
            info.timerKind === "estimate"
                ? "estimated"
                : isUnavailableTravel
                    ? "unavailable"
                    : "exact"
        }`;
        if (info.until) timer.dataset.until = String(info.until);
        timer.dataset.kind = String(info.timerKind || "");
        timer.dataset.info = timerTitle(info);
        if (info.linkedPlayer?.id && info.linkedPlayer?.name) {
            timer.dataset.linkedPlayerId = String(info.linkedPlayer.id);
            timer.dataset.linkedPlayerName = String(info.linkedPlayer.name);
        }
        timer.textContent = isUnavailableTravel
            ? "~?"
            : `${info.timerKind === "estimate" ? "~" : ""}${formatCountdown(remaining)}`;
        timer.setAttribute("aria-label", timer.dataset.info || timer.textContent);
        timer.setAttribute("role", "button");
        timer.tabIndex = 0;
        timer.addEventListener("click", activateTimerInfo);
        timer.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") activateTimerInfo(event);
        });
        statusElement.appendChild(timer);
    }

    function reorderBody(body, sortedRows) {
        const current = Array.from(body.children).filter(node => sortedRows.includes(node));
        const same = current.length === sortedRows.length && current.every((row, index) => row === sortedRows[index]);
        if (same) return;

        for (const row of sortedRows) row.dataset.ksSuiteMutating = "war-tools";
        const fragment = document.createDocumentFragment();
        for (const row of sortedRows) fragment.appendChild(row);
        body.appendChild(fragment);
        setTimeout(() => {
            for (const row of sortedRows) {
                if (row.dataset.ksSuiteMutating === "war-tools") delete row.dataset.ksSuiteMutating;
            }
        }, 0);
    }

    function applyRows() {
        if (state.destroyed || state.applying || !isVisiblePage() || !isFactionPage()) return;
        state.applying = true;
        const allInfo = [];
        state.activeSnapshot = getStatusSnapshot();

        try {
            for (const list of findMemberLists()) {
                const body = list.querySelector(".table-body");
                if (!body) continue;
                const rows = rowsInList(list);
                const original = ensureOriginalOrder(body, rows);
                const infos = rows.map(row => rowInfo(row, original.get(row) ?? 0, state.activeSnapshot));
                infos.sort(compareRows);
                reorderBody(body, infos.map(info => info.row));

                for (const info of infos) {
                    state.managedRows.add(info.row);
                    if (matchesFilter(info)) info.row.style.removeProperty("display");
                    else info.row.style.setProperty("display", "none", "important");
                    renderTimer(info);
                    allInfo.push(info);
                }
            }

            state.lastInfos = allInfo;
            updateToolbar(allInfo);
            manageClock(allInfo.some(info => info.until && info.until > Date.now() / 1000));
            dockScoutButton();
        } finally {
            state.applying = false;
        }
    }

    function tickTimers() {
        const now = Math.floor(Date.now() / 1000);
        let expired = false;
        document.querySelectorAll(".kswt-timer[data-until]").forEach(timer => {
            const until = Number(timer.dataset.until);
            const remaining = until - now;
            if (!Number.isFinite(until) || remaining <= 0) {
                timer.remove();
                expired = true;
                return;
            }
            timer.textContent = `${timer.dataset.kind === "estimate" ? "~" : ""}${formatCountdown(remaining)}`;
        });
        if (state.settings.filter === "soon") {
            for (const info of state.lastInfos) {
                if (matchesFilter(info)) info.row.style.removeProperty("display");
                else info.row.style.setProperty("display", "none", "important");
            }
        }
        updateToolbar(state.lastInfos);

        if (expired) {
            window.__kingshadeScoutActive?.forceStatusRefresh?.();
            scheduleApply(100);
        }
    }

    function manageClock(needed) {
        if (needed && !state.clockTimer) {
            state.clockTimer = setInterval(() => {
                if (!state.destroyed && isVisiblePage()) tickTimers();
            }, 1000);
        } else if (!needed && state.clockTimer) {
            clearInterval(state.clockTimer);
            state.clockTimer = null;
        }
    }

    function clearRowChanges() {
        for (const row of state.managedRows) {
            row.style.removeProperty("display");
            removeTimer(row);
        }
        state.managedRows.clear();

        for (const list of findMemberLists()) {
            const body = list.querySelector(".table-body");
            if (!body) continue;
            const rows = rowsInList(list);
            const original = state.originalOrder.get(body);
            if (!original) continue;
            rows.sort((a, b) => (original.get(a) ?? 0) - (original.get(b) ?? 0));
            reorderBody(body, rows);
        }
    }

    function countsFor(infos) {
        const now = Math.floor(Date.now() / 1000);
        const soonLimit = Number(state.settings.soonMinutes) * 60;
        return {
            all: infos.length,
            ready: infos.filter(info => info.status === "okay").length,
            easy: infos.filter(info => info.status === "okay" && info.ff && info.ff <= Number(state.settings.maxFF)).length,
            soon: infos.filter(info => info.until && info.until > now && info.until - now <= soonLimit).length,
            unknown: infos.filter(info => !info.ff && !info.battleStats && !info.estimateText).length,
            core: infos.filter(info => info.hasCoreData || info.row.querySelector(".ks6-badge")).length,
            status: infos.filter(info => info.hasStatusData).length,
            exact: infos.filter(info => info.timerKind === "exact").length,
            estimate: infos.filter(info => info.timerKind === "estimate").length,
            estimateUnavailable: infos.filter(info => info.timerKind === "estimate-unavailable").length
        };
    }

    function updateVersionWarning(toolbar = document.getElementById(SCRIPT.toolbarId)) {
        const warning = toolbar?.querySelector?.('[data-kswt="version-warning"]');
        if (!warning) return;

        const scoutVersion = String(window.__kingshadeScoutActive?.version || "");
        const mismatch = Boolean(scoutVersion && scoutVersion !== SCRIPT.version);
        warning.hidden = !mismatch;
        warning.textContent = mismatch
            ? `Version mismatch: Scout ${scoutVersion} / War Tools ${SCRIPT.version}`
            : "";
    }

    function updateToolbar(infos) {
        const toolbar = document.getElementById(SCRIPT.toolbarId);
        if (!toolbar) return;
        const counts = countsFor(infos);
        const snapshot = state.activeSnapshot && snapshotMatchesCurrent(state.activeSnapshot)
            ? state.activeSnapshot
            : getStatusSnapshot();
        state.activeSnapshot = snapshot;

        const age = snapshot?.updatedAt ? Math.max(0, Math.floor(Date.now() / 1000 - Number(snapshot.updatedAt))) : null;
        const statusPart = snapshot
            ? `Status ${counts.status}/${counts.all} · ${age === null ? "age unknown" : `${age}s old`}`
            : "Status loading…";
        toolbar.querySelector('[data-kswt="status"]').textContent =
            `FF ${counts.core}/${counts.all} · ${statusPart} · Showing ${infos.filter(matchesFilter).length}/${counts.all}`;

        updateVersionWarning(toolbar);

        const labels = { all: "ALL", ready: "READY", easy: "EASY NOW", soon: "SOON", unknown: "UNKNOWN" };
        for (const key of Object.keys(labels)) {
            const button = toolbar.querySelector(`[data-filter="${key}"]`);
            if (!button) continue;
            button.textContent = `${labels[key]} ${counts[key]}`;
            button.classList.toggle("active", state.settings.filter === key);
        }

        const timerSummary = toolbar.querySelector('[data-kswt="timer-summary"]');
        if (timerSummary) {
            timerSummary.textContent =
                `Exact timers ${counts.exact} · Travel estimates ${counts.estimate} · Travel unknown ${counts.estimateUnavailable}`;
        }
        toolbar.classList.toggle("collapsed", Boolean(state.settings.collapsed));
    }

    function ensureStyles() {
        document.getElementById(SCRIPT.styleId)?.remove();
        const style = document.createElement("style");
        style.id = SCRIPT.styleId;
        style.textContent = `
            #${SCRIPT.toolbarId}{
                box-sizing:border-box!important;width:100%!important;margin:8px 0!important;padding:9px!important;
                border:1px solid #4b4f55!important;border-radius:8px!important;background:#202124!important;color:#fff!important;
                font:12px/1.3 Arial,sans-serif!important;box-shadow:0 3px 12px rgba(0,0,0,.38)!important
            }
            #${SCRIPT.toolbarId} *{box-sizing:border-box!important}
            #${SCRIPT.toolbarId} .kswt-head{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:8px!important}
            #${SCRIPT.toolbarId} .kswt-title{color:#fff!important;font-size:14px!important;font-weight:800!important}
            #${SCRIPT.toolbarId} .kswt-component{margin-top:1px!important;color:#c9cbd0!important;font-size:9px!important}
            #${SCRIPT.toolbarId} .kswt-status{margin-top:2px!important;color:#c7c9cc!important;font-size:9.5px!important;line-height:1.25!important}
            #${SCRIPT.toolbarId} .kswt-version-warning{
                margin-top:6px!important;padding:6px!important;border:1px solid #8a6530!important;border-radius:5px!important;
                background:#493617!important;color:#ffe0a0!important;font-size:9.5px!important;font-weight:700!important
            }
            #${SCRIPT.toolbarId} .kswt-head-actions{display:flex!important;align-items:center!important;gap:6px!important;flex:0 0 auto!important}
            #${SCRIPT.toolbarId} .kswt-collapse{
                flex:0 0 34px!important;width:34px!important;height:34px!important;margin:0!important;padding:0!important;
                border:1px solid #656a70!important;border-radius:50%!important;background:#34383d!important;color:#fff!important;
                font:800 20px/30px Arial!important;text-shadow:none!important
            }
            #${SCRIPT.toolbarId} .kswt-body{margin-top:9px!important}
            #${SCRIPT.toolbarId}.collapsed .kswt-body{display:none!important}
            #${SCRIPT.toolbarId} .kswt-filters{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px!important}
            #${SCRIPT.toolbarId} .kswt-filter{
                min-width:0!important;padding:8px 3px!important;border:1px solid #5c6167!important;border-radius:5px!important;
                background:#34383d!important;color:#fff!important;font-size:9px!important;font-weight:800!important;
                text-shadow:none!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important
            }
            #${SCRIPT.toolbarId} .kswt-filter.active{border-color:#d4ab58!important;background:#5a4318!important;color:#ffe4a1!important}
            #${SCRIPT.toolbarId} .kswt-controls{display:grid!important;grid-template-columns:1fr!important;gap:7px!important;margin-top:9px!important}
            #${SCRIPT.toolbarId} label{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;color:#fff!important;font-size:11px!important}
            #${SCRIPT.toolbarId} input[type=number],#${SCRIPT.toolbarId} select{
                width:150px!important;max-width:56vw!important;min-width:0!important;height:32px!important;padding:3px 7px!important;
                border:1px solid #777!important;border-radius:4px!important;background:#fff!important;color:#111!important;font-size:12px!important
            }
            #${SCRIPT.toolbarId} input[type=number]{width:84px!important}
            #${SCRIPT.toolbarId} .kswt-note{margin-top:8px!important;color:#bfc2c6!important;font-size:10px!important;line-height:1.35!important}
            #${SCRIPT.toolbarId} .kswt-timer-summary{margin-top:6px!important;color:#e3d29f!important;font-size:9.5px!important}
            .kswt-status-host{position:relative!important;overflow:visible!important}
            .kswt-status-host.kswt-compact-status{
                display:flex!important;flex-direction:column!important;align-items:center!important;
                justify-content:center!important;gap:2px!important;text-align:center!important
            }
            .kswt-status-host.kswt-compact-status>.ellipsis{display:none!important}
            .kswt-status-host.kswt-compact-status::before{
                content:attr(data-kswt-label)!important;display:block!important;color:inherit!important;
                font:800 7.5px/1 Arial,sans-serif!important;letter-spacing:.15px!important;white-space:nowrap!important
            }
            .kswt-timer{
                display:block!important;margin:0!important;color:#fff!important;
                font:800 8px/1.05 Arial,sans-serif!important;text-shadow:0 1px 2px rgba(0,0,0,.8)!important;
                white-space:nowrap!important;cursor:pointer!important
            }
            .kswt-timer.estimated{color:#ffe6a6!important}
            .kswt-timer.unavailable{color:#ffd98a!important;font-size:9px!important}
            #${SCRIPT.infoId}{
                position:fixed!important;left:8px!important;right:8px!important;bottom:max(78px,calc(env(safe-area-inset-bottom) + 78px))!important;
                z-index:2147483647!important;display:flex!important;align-items:flex-start!important;gap:8px!important;
                max-width:520px!important;margin:0 auto!important;padding:11px 12px!important;border:1px solid #666b72!important;
                border-radius:8px!important;background:#3d3f42!important;color:#fff!important;
                box-shadow:0 5px 20px rgba(0,0,0,.65)!important;font:12px/1.4 Arial,sans-serif!important
            }
            #${SCRIPT.infoId} .kswt-info-text{flex:1 1 auto!important;min-width:0!important}
            #${SCRIPT.infoId} .kswt-profile-link{
                color:#8ec9ff!important;text-decoration:underline!important;text-decoration-thickness:1px!important;
                text-underline-offset:2px!important;font-weight:800!important
            }
            #${SCRIPT.infoId} .kswt-info-close{
                flex:0 0 30px!important;width:30px!important;height:30px!important;margin:-5px -6px 0 0!important;padding:0!important;
                border:0!important;border-radius:50%!important;background:transparent!important;color:#fff!important;
                font:800 22px/28px Arial,sans-serif!important;text-shadow:none!important
            }
            @media (min-width:520px){
                #${SCRIPT.toolbarId} .kswt-filters{grid-template-columns:repeat(5,minmax(0,1fr))!important}
                #${SCRIPT.toolbarId} .kswt-controls{grid-template-columns:1fr 1fr!important}
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function toolbarHtml() {
        return `
            <div class="kswt-head">
                <div>
                    <div class="kswt-title">${SCRIPT.name} ${SCRIPT.version}</div>
                    <div class="kswt-component">${SCRIPT.component}</div>
                    <div class="kswt-status" data-kswt="status">Waiting for Scout Core…</div>
                    <div class="kswt-version-warning" data-kswt="version-warning" hidden></div>
                </div>
                <div class="kswt-head-actions">
                    <button type="button" class="kswt-collapse" data-kswt="collapse" aria-label="Collapse">−</button>
                </div>
            </div>
            <div class="kswt-body">
                <div class="kswt-filters">
                    <button type="button" class="kswt-filter" data-filter="all">ALL</button>
                    <button type="button" class="kswt-filter" data-filter="ready">READY</button>
                    <button type="button" class="kswt-filter" data-filter="easy">EASY NOW</button>
                    <button type="button" class="kswt-filter" data-filter="soon">SOON</button>
                    <button type="button" class="kswt-filter" data-filter="unknown">UNKNOWN</button>
                </div>
                <div class="kswt-controls">
                    <label>Easy max FF
                        <input type="number" min="0.1" max="20" step="0.1" data-kswt="max-ff" value="${state.settings.maxFF}">
                    </label>
                    <label>Soon within
                        <span style="display:flex;align-items:center;gap:4px">
                            <input type="number" min="1" max="1440" step="5" data-kswt="soon" value="${state.settings.soonMinutes}">
                            <span>min</span>
                        </span>
                    </label>
                    <label>Sort
                        <select data-kswt="sort">
                            <option value="original">Original order</option>
                            <option value="ff">FF low → high</option>
                            <option value="status">Status</option>
                            <option value="soon">Ending soon</option>
                        </select>
                    </label>
                </div>
                <div class="kswt-timer-summary" data-kswt="timer-summary">Exact timers 0 · Travel estimates 0</div>
                <div class="kswt-note">
                    Hospital/Jail countdowns are exact. Travel countdowns start with ~ because Torn exposes no exact arrival timestamp; Scout improves them from observed flight history.
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
            toolbar.querySelector('[data-kswt="collapse"]').textContent = state.settings.collapsed ? "+" : "−";
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
            state.settings.soonMinutes = Number.isFinite(value) && value > 0 ? Math.min(1440, Math.max(1, value)) : DEFAULTS.soonMinutes;
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

        toolbar.classList.toggle("collapsed", state.settings.collapsed);
        toolbar.querySelector('[data-kswt="collapse"]').textContent = state.settings.collapsed ? "+" : "−";
    }

    function dockScoutButton() {
        const toolbar = document.getElementById(SCRIPT.toolbarId);
        const host = toolbar?.querySelector(".kswt-head-actions");
        const scout = document.querySelector(".ks6-fab");
        if (!host || !scout) return;
        if (scout.parentNode !== host) host.insertBefore(scout, host.firstChild);
        scout.classList.add("ks6-docked");
        scout.style.removeProperty("left");
        scout.style.removeProperty("top");
    }

    function undockScoutButton() {
        try {
            if (window.__kingshadeScoutActive?.undockButton) {
                window.__kingshadeScoutActive.undockButton();
                return;
            }
        } catch {}
        const scout = document.querySelector(".ks6-fab");
        if (!scout) return;
        document.body.appendChild(scout);
        scout.classList.remove("ks6-docked");
    }

    function ensureToolbar() {
        if (state.destroyed || !isFactionPage()) return null;
        const existing = document.getElementById(SCRIPT.toolbarId);
        if (existing) {
            dockScoutButton();
            return existing;
        }

        const firstList = findMemberLists()[0];
        if (!firstList?.parentNode) return null;
        const toolbar = document.createElement("section");
        toolbar.id = SCRIPT.toolbarId;
        toolbar.innerHTML = toolbarHtml();
        firstList.parentNode.insertBefore(toolbar, firstList);
        bindToolbar(toolbar);
        updateVersionWarning(toolbar);
        dockScoutButton();
        window.dispatchEvent(new CustomEvent(SCRIPT.readyEvent));
        return toolbar;
    }

    function scheduleApply(delay = 120) {
        clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(() => {
            state.scanTimer = null;
            if (state.destroyed || !isVisiblePage()) return;

            if (!isFactionPage() || !findMemberLists().length) {
                clearRowChanges();
                document.getElementById(SCRIPT.toolbarId)?.remove();
                undockScoutButton();
                state.activeSnapshot = null;
                return;
            }

            ensureToolbar();
            applyRows();
        }, delay);
    }

    function relevantMutationNode(node) {
        if (!(node instanceof Element)) return false;
        if (node.matches(".kswt-timer,#kswt-toolbar,.ks6-fab,.ks6-panel,.ks6-badge,.ks6-modal,.ks6-toast,[data-ks-suite-mutating]")) return false;
        if (node.closest?.("#kswt-toolbar,.ks6-panel,.ks6-modal,[data-ks-suite-mutating]")) return false;
        return true;
    }

    function closeInfoOnOutsidePointer(event) {
        const info = document.getElementById(SCRIPT.infoId);
        if (!info || info.contains(event.target) || event.target?.closest?.(".kswt-timer")) return;
        closeTimerInfo();
    }

    function handleVisibility() {
        closeTimerInfo();
        if (isVisiblePage()) {
            window.__kingshadeScoutActive?.refreshStatus?.();
            scheduleApply(0);
        } else {
            clearTimeout(state.scanTimer);
            state.scanTimer = null;
            clearInterval(state.clockTimer);
            state.clockTimer = null;
        }
    }

    function onCoreStatusUpdate() {
        state.activeSnapshot = getStatusSnapshot();
        scheduleApply(0);
    }

    function onCoreFfUpdate() {
        scheduleApply(0);
    }

    function onRouteChange() {
        closeTimerInfo();
        setTimeout(() => {
            if (!isFactionPage() || !findMemberLists().length) {
                clearRowChanges();
                document.getElementById(SCRIPT.toolbarId)?.remove();
                undockScoutButton();
                state.activeSnapshot = null;
                return;
            }
            ensureToolbar();
            window.__kingshadeScoutActive?.refreshStatus?.();
            scheduleApply(0);
        }, 150);
    }

    function init() {
        if (!document.body) {
            setTimeout(init, 100);
            return;
        }

        ensureStyles();
        ensureToolbar();
        state.observer = new MutationObserver(mutations => {
            if (state.destroyed || state.applying) return;
            const relevant = mutations.some(mutation =>
                [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)].some(relevantMutationNode)
            );
            if (relevant) scheduleApply();
        });
        state.observer.observe(document.body, { childList: true, subtree: true });

        document.addEventListener("pointerdown", closeInfoOnOutsidePointer, true);
        window.addEventListener("scroll", closeTimerInfo, true);
        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener(SCRIPT.sharedEvent, onCoreStatusUpdate);
        window.addEventListener(SCRIPT.ffEvent, onCoreFfUpdate);
        window.addEventListener("hashchange", onRouteChange);
        window.addEventListener("popstate", onRouteChange);
        window.navigation?.addEventListener?.("currententrychange", onRouteChange);

        window.__kingshadeScoutActive?.refreshStatus?.();
        scheduleApply(0);

        window[SCRIPT.instanceKey] = {
            version: SCRIPT.version,
            component: SCRIPT.component,
            refresh: () => scheduleApply(0),
            destroy
        };
    }

    function destroy() {
        if (state.destroyed) return;
        state.destroyed = true;
        clearTimeout(state.scanTimer);
        clearInterval(state.clockTimer);
        closeTimerInfo();
        state.observer?.disconnect();
        document.removeEventListener("pointerdown", closeInfoOnOutsidePointer, true);
        window.removeEventListener("scroll", closeTimerInfo, true);
        document.removeEventListener("visibilitychange", handleVisibility);
        window.removeEventListener(SCRIPT.sharedEvent, onCoreStatusUpdate);
        window.removeEventListener(SCRIPT.ffEvent, onCoreFfUpdate);
        window.removeEventListener("hashchange", onRouteChange);
        window.removeEventListener("popstate", onRouteChange);
        window.navigation?.removeEventListener?.("currententrychange", onRouteChange);
        clearRowChanges();
        document.getElementById(SCRIPT.toolbarId)?.remove();
        document.getElementById(SCRIPT.styleId)?.remove();
        undockScoutButton();
        if (window[SCRIPT.instanceKey]?.destroy === destroy) delete window[SCRIPT.instanceKey];
    }

    init();
})();
