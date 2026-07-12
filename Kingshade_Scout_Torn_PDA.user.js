// ==UserScript==
// @name         Kingshade Scout for Torn PDA
// @namespace    https://kingshade.tools/
// @version      0.2.1
// @description  Lightweight FF Scouter companion for Torn PDA. Adds clear green/yellow/red target markers and estimated battle stats to faction and war lists.
// @author       Kingshade
// @match        https://www.torn.com/*
// @connect      ffscouter.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(() => {
    "use strict";

    const NAME = "Kingshade Scout";
    const VERSION = "0.2.1";
    const API_BASE = "https://ffscouter.com/api/v1";
    const CACHE_TTL_MS = 60 * 60 * 1000;
    const STORAGE_PREFIX = "kingshade-scout:";
    const FF_KEY_STORAGE = `${STORAGE_PREFIX}ff-api-key`;
    const BATCH_SIZE = 100;
    const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;
    const DEFAULT_SETTINGS = {
        easyMax: 2.0,
        riskyMax: 3.5,
        showUnknown: true,
        markRows: true
    };
    let settings = loadSettings();

    const memoryCache = new Map();
    let scanTimer = null;
    let observer = null;

    const log = (...args) => console.log(`[${NAME} ${VERSION}]`, ...args);
    const warn = (...args) => console.warn(`[${NAME} ${VERSION}]`, ...args);

    function loadSettings() {
        try {
            return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")) };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {}
    }

    function readWrappedStorage(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (parsed && Object.prototype.hasOwnProperty.call(parsed, "value")) {
                if (parsed.expiration && Date.now() > parsed.expiration) return null;
                return parsed.value;
            }
            return parsed;
        } catch {
            return null;
        }
    }

    function getFFKey() {
        try {
            return localStorage.getItem(FF_KEY_STORAGE) || "";
        } catch {
            return "";
        }
    }

    function setFFKey(value) {
        try {
            const clean = String(value || "").trim();
            if (clean) localStorage.setItem(FF_KEY_STORAGE, clean);
            else localStorage.removeItem(FF_KEY_STORAGE);
        } catch {}
    }

    function normalizeResponse(resp) {
        if (!resp) return { status: 0, responseText: "" };
        if (typeof resp === "string") return { status: 200, responseText: resp };
        return {
            status: Number(resp.status ?? resp.statusCode ?? 200),
            responseText: String(resp.responseText ?? resp.body ?? resp.response ?? "")
        };
    }

    function httpGet(url) {
        if (typeof window.PDA_httpGet === "function") {
            return window.PDA_httpGet(url, {}).then(normalizeResponse);
        }

        if (typeof GM_xmlhttpRequest === "function") {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    timeout: 30000,
                    onload: resolve,
                    onerror: reject,
                    ontimeout: () => reject(new Error("Request timed out"))
                });
            }).then(normalizeResponse);
        }

        return fetch(url, { credentials: "omit" }).then(async response => ({
            status: response.status,
            responseText: await response.text()
        }));
    }

    function cacheKey(id) {
        return `${STORAGE_PREFIX}player:${id}`;
    }

    function getCached(id) {
        if (memoryCache.has(id)) return memoryCache.get(id);
        try {
            const raw = localStorage.getItem(cacheKey(id));
            if (!raw) return null;
            const item = JSON.parse(raw);
            if (!item || item.expires <= Date.now()) {
                localStorage.removeItem(cacheKey(id));
                return null;
            }
            memoryCache.set(id, item.value);
            return item.value;
        } catch {
            return null;
        }
    }

    function setCached(id, value) {
        memoryCache.set(id, value);
        try {
            localStorage.setItem(cacheKey(id), JSON.stringify({
                expires: Date.now() + CACHE_TTL_MS,
                value
            }));
        } catch {}
    }

    async function fetchBatch(ids) {
        const key = getFFKey();
        if (!key) {
            throw new Error("No FF Scouter API key saved. Tap KSP, paste the key, then press Apply and refresh.");
        }

        const query = new URLSearchParams({
            key,
            targets: ids.join(",")
        });

        const response = await httpGet(`${API_BASE}/get-stats?${query}`);
        if (response.status !== 200) {
            throw new Error(`FF Scouter API returned HTTP ${response.status}`);
        }

        let data;
        try {
            data = JSON.parse(response.responseText);
        } catch {
            throw new Error("FF Scouter API returned invalid JSON");
        }

        if (!Array.isArray(data)) {
            throw new Error(data?.error || "Unexpected FF Scouter response");
        }

        const map = new Map();
        for (const row of data) {
            if (!row?.player_id) continue;

            const value = (!row.fair_fight || !row.bs_estimate)
                ? { player_id: Number(row.player_id), no_data: true }
                : {
                    player_id: Number(row.player_id),
                    no_data: false,
                    fair_fight: Number(row.fair_fight),
                    bs_estimate: Number(row.bs_estimate),
                    bs_estimate_human: String(row.bs_estimate_human || formatNumber(row.bs_estimate)),
                    last_updated: Number(row.last_updated || 0),
                    source: String(row.source || "bss")
                };

            map.set(value.player_id, value);
            setCached(value.player_id, value);
        }

        for (const id of ids) {
            if (!map.has(id)) {
                const value = { player_id: id, no_data: true };
                map.set(id, value);
                setCached(id, value);
            }
        }
        return map;
    }

    async function getPlayers(ids) {
        const result = new Map();
        const missing = [];

        for (const id of ids) {
            const cached = getCached(id);
            if (cached) result.set(id, cached);
            else missing.push(id);
        }

        for (let i = 0; i < missing.length; i += BATCH_SIZE) {
            const fetched = await fetchBatch(missing.slice(i, i + BATCH_SIZE));
            for (const [id, value] of fetched) result.set(id, value);
        }
        return result;
    }

    function formatNumber(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "?";
        if (n >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
        if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
        if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
        return Math.round(n).toLocaleString();
    }

    function extractPlayerId(anchor) {
        try {
            const url = new URL(anchor.href, location.origin);
            for (const key of ["XID", "user2ID", "userId", "ID"]) {
                const value = url.searchParams.get(key);
                if (/^\d+$/.test(value || "")) return Number(value);
            }
        } catch {
            const match = (anchor.getAttribute("href") || "").match(/[?&](?:XID|user2ID|userId|ID)=(\d+)/i);
            if (match) return Number(match[1]);
        }
        return null;
    }

    function findTargetRows(root = document) {
        const anchors = root.querySelectorAll(
            'a[href*="profiles.php?XID="], a[href*="user2ID="], a[href*="userId="], a[href*="step=profile"][href*="ID="]'
        );
        const rows = new Map();

        for (const anchor of anchors) {
            const id = extractPlayerId(anchor);
            if (!id) continue;

            const row =
                anchor.closest(".enemy, .your, .table-row, li, [class*='row___'], [class*='member___']") ||
                anchor.parentElement;

            if (!row) continue;
            if (!rows.has(id)) rows.set(id, { id, row, anchor });
        }
        return rows;
    }

    function classify(ff) {
        if (!Number.isFinite(ff)) return { label: "UNKNOWN", color: "#666", icon: "●" };
        if (ff <= settings.easyMax) return { label: "EASY", color: "#2e9d52", icon: "▼" };
        if (ff <= settings.riskyMax) return { label: "RISKY", color: "#d6a20b", icon: "◆" };
        return { label: "AVOID", color: "#d24444", icon: "▲" };
    }

    function ensureStyles() {
        if (document.getElementById("ks-scout-styles")) return;
        const style = document.createElement("style");
        style.id = "ks-scout-styles";
        style.textContent = `
            .ks-scout-badge{display:inline-flex!important;align-items:center;gap:3px;margin-left:5px;padding:2px 5px;border-radius:4px;font:700 10px/1.2 Arial,sans-serif;color:#fff!important;white-space:nowrap;vertical-align:middle;box-shadow:0 0 0 1px rgba(0,0,0,.35);z-index:2}
            .ks-scout-badge[data-state="loading"]{background:#555;opacity:.8}
            .ks-scout-badge .ks-scout-stats{font-weight:600;opacity:.95}
            .ks-scout-row-easy{box-shadow:inset 4px 0 0 #2e9d52!important}
            .ks-scout-row-risky{box-shadow:inset 4px 0 0 #d6a20b!important}
            .ks-scout-row-avoid{box-shadow:inset 4px 0 0 #d24444!important}
            .ks-scout-error{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(92vw,520px);padding:9px 12px;border-radius:7px;background:#b3261e;color:#fff;font:600 12px/1.35 Arial,sans-serif;z-index:2147483647;box-shadow:0 3px 12px rgba(0,0,0,.35)}
            .ks-scout-fab{position:fixed;right:14px;bottom:92px;width:48px;height:48px;border:0;border-radius:50%;background:#263238;color:#fff;font:800 12px Arial;z-index:2147483646;box-shadow:0 3px 12px rgba(0,0,0,.45)}
            .ks-scout-panel{position:fixed;right:12px;bottom:150px;width:min(88vw,300px);padding:12px;border-radius:10px;background:#202124;color:#fff;font:13px Arial;z-index:2147483646;box-shadow:0 4px 18px rgba(0,0,0,.55)}
            .ks-scout-panel label{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0}
            .ks-scout-panel input[type=number]{width:72px}.ks-scout-panel input[type=password]{width:150px;min-width:0}
            .ks-scout-panel button{width:100%;margin-top:8px;padding:8px;border:0;border-radius:6px;font-weight:700}
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function getBadgeHost(anchor, row) {
        return anchor.closest(".honor-text-wrap") || row.querySelector(".member") || anchor.parentElement || row;
    }

    function renderLoading(entry) {
        const host = getBadgeHost(entry.anchor, entry.row);
        let badge = entry.row.querySelector(`.ks-scout-badge[data-player-id="${entry.id}"]`);
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "ks-scout-badge";
            badge.dataset.playerId = String(entry.id);
            badge.dataset.state = "loading";
            badge.textContent = "SCOUT…";
            host.appendChild(badge);
        }
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function renderResult(entry, data) {
        const host = getBadgeHost(entry.anchor, entry.row);
        let badge = entry.row.querySelector(`.ks-scout-badge[data-player-id="${entry.id}"]`);
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "ks-scout-badge";
            badge.dataset.playerId = String(entry.id);
            host.appendChild(badge);
        }

        entry.row.classList.remove("ks-scout-row-easy", "ks-scout-row-risky", "ks-scout-row-avoid");

        if (!data || data.no_data) {
            if (!settings.showUnknown) {
                badge.remove();
                return;
            }
            badge.dataset.state = "unknown";
            badge.style.background = "#666";
            badge.textContent = "● UNKNOWN";
            badge.title = "FF Scouter has no battle-stat estimate for this player.";
            return;
        }

        const rating = classify(data.fair_fight);
        badge.dataset.state = rating.label.toLowerCase();
        badge.style.background = rating.color;
        badge.innerHTML = `${rating.icon} ${rating.label} <span class="ks-scout-stats">${escapeHtml(data.bs_estimate_human)}</span>`;
        badge.title = `Fair Fight: ${data.fair_fight.toFixed(2)} | Estimated battle stats: ${data.bs_estimate_human} | Source: ${data.source}`;

        if (settings.markRows) {
            if (rating.label === "EASY") entry.row.classList.add("ks-scout-row-easy");
            if (rating.label === "RISKY") entry.row.classList.add("ks-scout-row-risky");
            if (rating.label === "AVOID") entry.row.classList.add("ks-scout-row-avoid");
        }
    }

    function showError(message) {
        warn(message);
        document.querySelector(".ks-scout-error")?.remove();
        const box = document.createElement("div");
        box.className = "ks-scout-error";
        box.textContent = `${NAME}: ${message}`;
        document.body.appendChild(box);
        setTimeout(() => box.remove(), 8000);
    }


    function ensureControlPanel() {
        if (document.querySelector(".ks-scout-fab")) return;

        const button = document.createElement("button");
        button.className = "ks-scout-fab";
        button.textContent = "KSP";
        button.title = "Kingshade Scout settings";

        const panel = document.createElement("div");
        panel.className = "ks-scout-panel";
        panel.hidden = true;
        panel.innerHTML = `
            <strong>Kingshade Scout ${VERSION}</strong>
            <label>FF Scouter API key <input data-ksp="key" type="password" autocomplete="off" value="${getFFKey()}"></label>
            <label>Easy max FF <input data-ksp="easy" type="number" min="1" max="5" step="0.1" value="${settings.easyMax}"></label>
            <label>Risky max FF <input data-ksp="risky" type="number" min="1" max="8" step="0.1" value="${settings.riskyMax}"></label>
            <label>Show unknown <input data-ksp="unknown" type="checkbox" ${settings.showUnknown ? "checked" : ""}></label>
            <label>Mark rows <input data-ksp="rows" type="checkbox" ${settings.markRows ? "checked" : ""}></label>
            <button data-ksp="apply">Apply and refresh</button>
        `;

        button.addEventListener("click", () => {
            panel.hidden = !panel.hidden;
        });

        panel.querySelector('[data-ksp="apply"]').addEventListener("click", () => {
            setFFKey(panel.querySelector('[data-ksp="key"]').value);
            const easy = Number(panel.querySelector('[data-ksp="easy"]').value);
            const risky = Number(panel.querySelector('[data-ksp="risky"]').value);
            settings.easyMax = Number.isFinite(easy) ? easy : DEFAULT_SETTINGS.easyMax;
            settings.riskyMax = Number.isFinite(risky) ? Math.max(risky, settings.easyMax) : DEFAULT_SETTINGS.riskyMax;
            settings.showUnknown = panel.querySelector('[data-ksp="unknown"]').checked;
            settings.markRows = panel.querySelector('[data-ksp="rows"]').checked;
            saveSettings();

            document.querySelectorAll("[data-ks-scout-applied]").forEach(el => {
                el.removeAttribute("data-ks-scout-applied");
                el.classList.remove("ks-scout-row-easy", "ks-scout-row-risky", "ks-scout-row-avoid");
                el.querySelectorAll(".ks-scout-badge").forEach(b => b.remove());
            });

            panel.hidden = true;
            scheduleScan(0);
        });

        document.body.append(button, panel);
    }

    async function scan() {
        scanTimer = null;
        ensureStyles();

        const rows = findTargetRows();
        if (rows.size === 0) return;

        const freshEntries = [];
        for (const entry of rows.values()) {
            if (entry.row.dataset.ksScoutApplied === "1" || entry.row.dataset.ksScoutApplied === "pending") continue;
            entry.row.dataset.ksScoutApplied = "pending";
            renderLoading(entry);
            freshEntries.push(entry);
        }

        if (freshEntries.length === 0) return;

        try {
            const data = await getPlayers(freshEntries.map(entry => entry.id));
            for (const entry of freshEntries) {
                renderResult(entry, data.get(entry.id));
                entry.row.dataset.ksScoutApplied = "1";
            }
        } catch (error) {
            for (const entry of freshEntries) {
                entry.row.dataset.ksScoutApplied = "";
                entry.row.querySelector(`.ks-scout-badge[data-player-id="${entry.id}"]`)?.remove();
            }
            showError(error instanceof Error ? error.message : String(error));
        }
    }

    function scheduleScan(delay = 100) {
        if (scanTimer) return;
        scanTimer = setTimeout(scan, delay);
    }

    function startObserver() {
        observer?.disconnect();
        observer = new MutationObserver(mutations => {
            if (mutations.some(m => m.addedNodes.length > 0)) scheduleScan();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function resetOnNavigation() {
        document.querySelectorAll("[data-ks-scout-applied]").forEach(el => el.removeAttribute("data-ks-scout-applied"));
        scheduleScan(250);
    }

    function init() {
        if (!document.body) {
            setTimeout(init, 100);
            return;
        }

        ensureStyles();
        ensureControlPanel();
        startObserver();
        window.addEventListener("popstate", resetOnNavigation);
        window.addEventListener("hashchange", resetOnNavigation);
        window.navigation?.addEventListener?.("currententrychange", resetOnNavigation);
        scheduleScan(0);
        log("Loaded");
    }

    init();
})();
