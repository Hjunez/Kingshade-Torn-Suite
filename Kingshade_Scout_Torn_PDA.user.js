// ==UserScript==
// @name         Kingshade Scout for Torn PDA
// @namespace    https://kingshade.tools/
// @version      0.6.7
// @description  Mobile FF Scouter overlay for Torn PDA faction member lists with optional manual overrides.
// @author       Kingshade
// @match        https://www.torn.com/*
// @connect      ffscouter.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(() => {
    "use strict";

    const INSTANCE_KEY = "__kingshadeScoutActive";
    if (window[INSTANCE_KEY]) {
        try { window[INSTANCE_KEY].destroy?.(); } catch {}
    }

    const NAME = "Kingshade Scout";
    const VERSION = "0.6.7";
    const API_BASE = "https://ffscouter.com/api/v1";
    const PREFIX = "kingshade-scout:";
    const SETTINGS_KEY = `${PREFIX}settings`;
    const API_KEY_STORAGE = `${PREFIX}ff-api-key`;
    const MANUAL_PREFIX = `${PREFIX}manual:`;
    const CACHE_PREFIX = `${PREFIX}cache:`;
    const CACHE_MS = 60 * 60 * 1000;

    const DEFAULTS = {
        showUnknown: true,
        showStripe: true,
        buttonX: null,
        buttonY: null
    };

    let settings = loadSettings();
    let scanTimer = null;
    let observer = null;
    const memoryCache = new Map();
    const onRouteChange = () => scheduleScan(200);

    function loadSettings() {
        try {
            return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
        } catch {
            return { ...DEFAULTS };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {}
    }

    function getApiKey() {
        try {
            return localStorage.getItem(API_KEY_STORAGE) || "";
        } catch {
            return "";
        }
    }

    function setApiKey(value) {
        try {
            const clean = String(value || "").trim();
            if (clean) localStorage.setItem(API_KEY_STORAGE, clean);
            else localStorage.removeItem(API_KEY_STORAGE);
        } catch {}
    }

    function getManual(playerId) {
        try {
            return JSON.parse(localStorage.getItem(`${MANUAL_PREFIX}${playerId}`) || "null");
        } catch {
            return null;
        }
    }

    function setManual(playerId, value) {
        try {
            if (!value) localStorage.removeItem(`${MANUAL_PREFIX}${playerId}`);
            else localStorage.setItem(`${MANUAL_PREFIX}${playerId}`, JSON.stringify(value));
        } catch {}
    }

    function compactParts(total) {
        const n = Number(total);
        if (!Number.isFinite(n) || n <= 0) return { value: "", unit: "K" };
        if (n >= 1e9) return { value: +(n / 1e9).toFixed(2), unit: "B" };
        if (n >= 1e6) return { value: +(n / 1e6).toFixed(2), unit: "M" };
        return { value: +(n / 1e3).toFixed(2), unit: "K" };
    }

    function parseCompact(value, unit) {
        const n = Number(String(value || "").replace(",", "."));
        if (!Number.isFinite(n) || n <= 0) return null;
        return n * (unit === "B" ? 1e9 : unit === "M" ? 1e6 : 1e3);
    }

    function formatCompact(total) {
        const parts = compactParts(total);
        return parts.value ? `${parts.value}${parts.unit}` : "?";
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function normalizeResponse(resp) {
        if (!resp) return { status: 0, responseText: "" };
        if (typeof resp === "string") return { status: 200, responseText: resp };
        return {
            status: Number(resp.status ?? resp.statusCode ?? 200),
            responseText: String(resp.responseText ?? resp.body ?? resp.response ?? "")
        };
    }

    async function httpGet(url) {
        if (typeof window.PDA_httpGet === "function") {
            return normalizeResponse(await window.PDA_httpGet(url, {}));
        }

        if (typeof GM_xmlhttpRequest === "function") {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    timeout: 30000,
                    onload: response => resolve(normalizeResponse(response)),
                    onerror: reject,
                    ontimeout: () => reject(new Error("Request timed out"))
                });
            });
        }

        const response = await fetch(url, { credentials: "omit" });
        return { status: response.status, responseText: await response.text() };
    }

    function getCached(playerId) {
        if (memoryCache.has(playerId)) return memoryCache.get(playerId);
        try {
            const key = `${CACHE_PREFIX}${playerId}`;
            const parsed = JSON.parse(localStorage.getItem(key) || "null");
            if (!parsed || parsed.expires <= Date.now()) {
                localStorage.removeItem(key);
                return null;
            }
            memoryCache.set(playerId, parsed.value);
            return parsed.value;
        } catch {
            return null;
        }
    }

    function setCached(playerId, value) {
        memoryCache.set(playerId, value);
        try {
            localStorage.setItem(`${CACHE_PREFIX}${playerId}`, JSON.stringify({
                expires: Date.now() + CACHE_MS,
                value
            }));
        } catch {}
    }

    async function fetchPlayers(ids) {
        const result = new Map();
        const missing = [];

        for (const id of ids) {
            const cached = getCached(id);
            if (cached) result.set(id, cached);
            else missing.push(id);
        }

        if (!missing.length) return result;

        const key = getApiKey();
        if (!key) throw new Error("No FF Scouter API key is saved. Open KSP and paste your key.");

        for (let i = 0; i < missing.length; i += 100) {
            const batch = missing.slice(i, i + 100);
            const query = new URLSearchParams({ key, targets: batch.join(",") });
            const response = await httpGet(`${API_BASE}/get-stats?${query}`);

            if (response.status !== 200) {
                throw new Error(`FF Scouter returned HTTP ${response.status}`);
            }

            let rows;
            try {
                rows = JSON.parse(response.responseText);
            } catch {
                throw new Error("FF Scouter returned invalid data.");
            }

            if (!Array.isArray(rows)) {
                throw new Error(rows?.error || "Unexpected response from FF Scouter.");
            }

            const returned = new Set();

            for (const row of rows) {
                const playerId = Number(row?.player_id);
                if (!playerId) continue;

                const value = {
                    player_id: playerId,
                    fair_fight: Number(row.fair_fight),
                    bs_estimate: Number(row.bs_estimate),
                    bs_estimate_human: String(row.bs_estimate_human || ""),
                    source: String(row.source || "FFS")
                };

                returned.add(playerId);
                result.set(playerId, value);
                setCached(playerId, value);
            }

            for (const id of batch) {
                if (!returned.has(id)) {
                    const value = { player_id: id, fair_fight: null, bs_estimate: null, bs_estimate_human: "" };
                    result.set(id, value);
                    setCached(id, value);
                }
            }
        }

        return result;
    }

    function extractPlayerId(anchor) {
        try {
            const url = new URL(anchor.href, location.origin);
            for (const key of ["XID", "user2ID", "userId", "ID"]) {
                const value = url.searchParams.get(key);
                if (/^\d+$/.test(value || "")) return Number(value);
            }
        } catch {}

        const match = (anchor.getAttribute("href") || "").match(/[?&](?:XID|user2ID|userId|ID)=(\d+)/i);
        return match ? Number(match[1]) : null;
    }

    const PROFILE_SELECTOR = [
        'a[href*="profiles.php?XID="]',
        'a[href*="user2ID="]',
        'a[href*="userId="]',
        'a[href*="step=profile"][href*="ID="]'
    ].join(", ");

    function normalizedText(element) {
        return String(element?.textContent || "").replace(/\s+/g, " ").trim();
    }

    const MEMBER_STATUS_PATTERN = /\b(?:okay|hospital|jail|federal|traveling|travelling|abroad|fallen)\b/i;

    function profileIdsInside(element) {
        const ids = new Set();
        element?.querySelectorAll?.(PROFILE_SELECTOR).forEach(anchor => {
            const id = extractPlayerId(anchor);
            if (id) ids.add(id);
        });
        return ids;
    }

    function findMemberCell(element, kind) {
        return element?.querySelector?.(
            `.table-cell.${kind}, [class~="${kind}"][class*="table-cell"], [class*="${kind}___"]`
        ) || null;
    }

    function looksLikeMemberRow(element, playerId) {
        if (!element || element === document.body) return false;

        // Validate the actual Torn member-table structure. Requiring dedicated
        // Days and Status cells prevents faction News, Leader and Co-leader
        // links from ever being treated as member rows.
        const daysCell = findMemberCell(element, "days");
        const statusCell = findMemberCell(element, "status");
        if (!daysCell || !statusCell) return false;

        if (!/^\d{1,5}$/.test(normalizedText(daysCell))) return false;
        if (!MEMBER_STATUS_PATTERN.test(normalizedText(statusCell))) return false;

        const ids = profileIdsInside(element);
        if (ids.size !== 1 || !ids.has(playerId)) return false;

        return true;
    }

    function findMemberRow(anchor, playerId) {
        let node = anchor.parentElement;

        // Return the smallest ancestor containing this player's complete
        // member-row cells. Torn PDA currently renders each member as an <li>,
        // but the structural cell check also survives wrapper-class changes.
        for (let depth = 0; depth < 12 && node && node !== document.body; depth++, node = node.parentElement) {
            if (looksLikeMemberRow(node, playerId)) return node;
        }

        return null;
    }

    function findRows() {
        const map = new Map();
        if (!/\/factions\.php\/?$/i.test(location.pathname)) {
            return { rows: map, profileLinks: 0 };
        }

        const anchors = document.querySelectorAll(PROFILE_SELECTOR);

        for (const anchor of anchors) {
            const id = extractPlayerId(anchor);
            if (!id || map.has(id)) continue;

            const row = findMemberRow(anchor, id);
            if (!row) continue;

            map.set(id, { id, row, anchor });
        }

        return { rows: map, profileLinks: anchors.length };
    }

    const FF_PALETTE = [
        "#1734e8", "#1788e8", "#17dbe8", "#17e8a1", "#17e84e",
        "#34e817", "#88e817", "#dbe817", "#e8a117", "#e84e17", "#e81734"
    ];

    function hexToRgba(hex, alpha) {
        const clean = String(hex || "").replace("#", "");
        const value = clean.length === 3
            ? clean.split("").map(ch => ch + ch).join("")
            : clean.padEnd(6, "0").slice(0, 6);

        const number = Number.parseInt(value, 16);
        const r = (number >> 16) & 255;
        const g = (number >> 8) & 255;
        const b = number & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function ffStyle(ff) {
        const value = Number(ff);
        if (!Number.isFinite(value) || value <= 0) return { color: "#666", label: "UNKNOWN" };

        const clamped = Math.max(1, Math.min(5, value));
        const index = Math.floor(((clamped - 1) / 4) * 10);

        let label;
        if (value <= 1) label = "EXTREMELY EASY";
        else if (value <= 2) label = "EASY";
        else if (value <= 3.5) label = "MODERATE";
        else if (value <= 4.5) label = "DIFFICULT";
        else label = "MAY BE IMPOSSIBLE";

        return { color: FF_PALETTE[index] || "#666", label };
    }

    function ensureStyles() {
        document.getElementById("ks6-styles")?.remove();
        const style = document.createElement("style");
        style.id = "ks6-styles";
        style.textContent = `
            .ks6-fab{
                position:fixed;width:50px;height:50px;border:1px solid #46515a;border-radius:50%;
                background:#263238!important;color:#fff!important;font:800 12px/1 Arial!important;
                text-shadow:none!important;z-index:2147483645;box-shadow:0 3px 12px rgba(0,0,0,.45);
                touch-action:none;user-select:none
            }

            .ks6-panel{
                position:fixed;right:12px;bottom:150px;width:min(88vw,320px);padding:13px;
                border:1px solid #40444a;border-radius:10px;background:#202124!important;color:#fff!important;
                font:13px/1.35 Arial,sans-serif;z-index:2147483646;box-shadow:0 4px 18px rgba(0,0,0,.58)
            }
            .ks6-panel *{box-sizing:border-box}
            .ks6-panel-head,.ks6-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
            .ks6-panel strong,.ks6-card strong{font-size:16px;color:#fff!important}
            .ks6-close{
                flex:0 0 34px!important;width:34px!important;height:34px!important;margin:0!important;padding:0!important;
                border:1px solid #686d73!important;border-radius:50%!important;background:#34383d!important;
                color:#fff!important;font:800 22px/30px Arial!important;text-shadow:none!important
            }
            .ks6-panel label{
                display:flex;justify-content:space-between;align-items:center;gap:10px;
                margin:10px 0;color:#fff!important
            }
            .ks6-panel input[type=password]{
                width:158px;min-width:0;height:31px;padding:4px 7px;
                border:1px solid #777;border-radius:4px;background:#fff!important;color:#111!important
            }
            .ks6-panel > button{
                width:100%;margin-top:9px;padding:10px;border:1px solid #686d73;border-radius:6px;
                background:#3b3f44!important;color:#fff!important;font-weight:800!important;text-shadow:none!important
            }
            .ks6-panel > button:active{background:#50555c!important}
            .ks6-status{
                margin:7px 0 11px;padding:8px;border-radius:6px;background:#303238!important;
                color:#fff!important;font-size:11px
            }
            .ks6-help{font-size:11px;color:#c9cbd0!important;margin:8px 0 2px}

            .ks6-colored-row{
                --ks6-row-color:#666;
                --ks6-row-tint:rgba(102,102,102,.22);
                position:relative!important;
                box-shadow:inset 5px 0 0 var(--ks6-row-color)!important
            }
            .ks6-colored-row.ks6-no-stripe{box-shadow:none!important}
            .ks6-colored-row,
            .ks6-colored-row > *,
            .ks6-colored-row [class*='table-cell'],
            .ks6-colored-row [class*='cell___']{
                background-color:var(--ks6-row-tint)!important
            }
            .ks6-name-host{position:relative!important;overflow:visible!important}
            .ks6-badge{
                position:absolute!important;right:2px;bottom:1px;display:inline-flex!important;
                align-items:center;justify-content:center;max-width:64px;padding:1px 4px;
                border:1px solid var(--ks6-row-color)!important;border-radius:3px;
                background:rgba(0,0,0,.76)!important;color:#fff!important;
                font:800 8px/1.15 Arial,sans-serif!important;white-space:nowrap;
                text-shadow:none!important;z-index:6;cursor:pointer
            }

            .ks6-modal{
                position:fixed;inset:0;background:rgba(0,0,0,.76);display:flex;
                align-items:center;justify-content:center;z-index:2147483647
            }
            .ks6-card{
                width:min(92vw,360px);padding:15px;border:1px solid #44484e;border-radius:11px;
                background:#202124!important;color:#fff!important;font:13px/1.35 Arial,sans-serif;
                box-shadow:0 5px 25px rgba(0,0,0,.68)
            }
            .ks6-card *{box-sizing:border-box}
            .ks6-card label{
                display:flex;justify-content:space-between;align-items:center;gap:10px;
                margin:12px 0;color:#fff!important
            }
            .ks6-card input[type=number],.ks6-card input[type=text],.ks6-card select{
                min-height:32px;padding:4px 7px;border:1px solid #777;border-radius:4px;
                background:#fff!important;color:#111!important
            }
            .ks6-card input[type=checkbox]{width:22px;height:22px}
            .ks6-actions{display:flex;gap:7px;margin-top:14px}
            .ks6-actions button{
                flex:1;padding:10px 6px;border:1px solid #686d73;border-radius:6px;
                background:#3b3f44!important;color:#fff!important;font-weight:800!important;text-shadow:none!important
            }
            .ks6-actions button[data-x=save]{background:#286b3b!important}
            .ks6-actions button[data-x=clear]{background:#693232!important}

            .ks6-toast{
                position:fixed;left:50%;bottom:25px;transform:translateX(-50%);
                max-width:90vw;padding:9px 12px;border-radius:7px;background:#b3261e!important;
                color:#fff!important;font:600 12px Arial;z-index:2147483647
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function showToast(message) {
        document.querySelector(".ks6-toast")?.remove();
        const toast = document.createElement("div");
        toast.className = "ks6-toast";
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 7000);
    }

    function badgeHost(entry) {
        const host =
            entry.anchor.closest(".honor-text-wrap") ||
            entry.anchor.parentElement;

        host?.classList.add("ks6-name-host");
        return host;
    }

    function getPlayerDisplayName(entry) {
        const candidates = [
            normalizedText(entry.anchor),
            entry.anchor.getAttribute("title"),
            entry.anchor.getAttribute("aria-label"),
            entry.anchor.querySelector?.("img[alt]")?.getAttribute("alt"),
            entry.anchor.querySelector?.("img[title]")?.getAttribute("title")
        ];

        for (const candidate of candidates) {
            const clean = String(candidate || "").replace(/\s+/g, " ").trim();
            if (clean && !/^(profile|view profile)$/i.test(clean)) return clean;
        }

        return `Player ${entry.id}`;
    }

    function openEditor(entry, ffsData) {
        document.querySelector(".ks6-modal")?.remove();

        const manual = getManual(entry.id);
        const bs = compactParts(manual?.battleStats || ffsData?.bs_estimate);
        const ffsFF = Number(ffsData?.fair_fight);
        const playerName = getPlayerDisplayName(entry);

        const modal = document.createElement("div");
        modal.className = "ks6-modal";
        modal.innerHTML = `
            <div class="ks6-card">
                <div class="ks6-card-head">
                    <strong>${escapeHtml(playerName)}</strong>
                    <button type="button" class="ks6-close" data-x="close" aria-label="Close">×</button>
                </div>
                <div style="color:#c9cbd0;margin-top:4px">
                    FF Scouter: ${Number.isFinite(ffsFF) && ffsFF > 0 ? ffsFF.toFixed(2) : "No data"}
                </div>

                <label>Use custom Fair Fight
                    <input data-x="use" type="checkbox" ${Number(manual?.ff) > 0 ? "checked" : ""}>
                </label>

                <label>Custom Fair Fight
                    <input data-x="ff" type="number" min="0.1" max="20" step="0.01"
                           style="width:110px" value="${Number(manual?.ff) > 0 ? manual.ff : ""}">
                </label>

                <label>Battle stats (optional)
                    <span style="display:flex;gap:5px">
                        <input data-x="bs" type="number" min="0.1" step="0.1"
                               style="width:92px" value="${bs.value}">
                        <select data-x="unit">
                            <option value="K" ${bs.unit === "K" ? "selected" : ""}>K</option>
                            <option value="M" ${bs.unit === "M" ? "selected" : ""}>M</option>
                            <option value="B" ${bs.unit === "B" ? "selected" : ""}>B</option>
                        </select>
                    </span>
                </label>

                <label>Note (optional)
                    <input data-x="note" type="text" style="width:180px"
                           value="${escapeHtml(manual?.note || "")}">
                </label>

                <div class="ks6-actions">
                    <button type="button" data-x="clear">Clear custom</button>
                    <button type="button" data-x="cancel">Cancel</button>
                    <button type="button" data-x="save">Save</button>
                </div>
            </div>
        `;

        const close = () => modal.remove();

        modal.querySelector('[data-x="close"]').onclick = close;
        modal.querySelector('[data-x="cancel"]').onclick = close;
        modal.querySelector('[data-x="clear"]').onclick = () => {
            setManual(entry.id, null);
            close();
            refreshRow(entry.row);
        };

        modal.querySelector('[data-x="save"]').onclick = () => {
            const use = modal.querySelector('[data-x="use"]').checked;
            const ff = Number(modal.querySelector('[data-x="ff"]').value);
            const battleStats = parseCompact(
                modal.querySelector('[data-x="bs"]').value,
                modal.querySelector('[data-x="unit"]').value
            );
            const note = modal.querySelector('[data-x="note"]').value.trim();

            setManual(entry.id, {
                ff: use && Number.isFinite(ff) && ff > 0 ? ff : null,
                battleStats,
                note
            });

            close();
            refreshRow(entry.row);
        };

        modal.onclick = event => {
            if (event.target === modal) close();
        };

        document.body.appendChild(modal);
    }

    function clearRowVisuals(row) {
        row.removeAttribute("data-ks6-applied");
        row.removeAttribute("data-ks6-pending");
        row.classList.remove("ks6-colored-row", "ks6-no-stripe");
        row.style.removeProperty("--ks6-row-color");
        row.style.removeProperty("--ks6-row-tint");
        row.style.removeProperty("box-shadow");
        row.querySelectorAll(".ks6-badge").forEach(element => element.remove());
        row.querySelectorAll(".ks6-name-host").forEach(host => {
            host.classList.remove("ks6-name-host");
            host.style.removeProperty("--ks6-row-color");
        });
    }

    function refreshRow(row) {
        clearRowVisuals(row);
        scheduleScan(0);
    }

    function render(entry, data) {
        const host = badgeHost(entry);
        if (!host) return false;

        let badge = entry.row.querySelector(`.ks6-badge[data-player-id="${entry.id}"]`);
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "ks6-badge";
            badge.dataset.playerId = String(entry.id);
            host.appendChild(badge);
        }

        const manual = getManual(entry.id);
        const ffsFF = Number(data?.fair_fight);
        const manualFF = Number(manual?.ff);
        const hasManual = Number.isFinite(manualFF) && manualFF > 0;
        const activeFF = hasManual ? manualFF : ffsFF;
        const source = hasManual ? "MAN" : "FFS";

        let color = "#666";
        let tint = "rgba(102,102,102,.22)";

        if (!Number.isFinite(activeFF) || activeFF <= 0) {
            if (!settings.showUnknown) {
                clearRowVisuals(entry.row);
                return true;
            }
            badge.textContent = "FF ?";
        } else {
            const style = ffStyle(activeFF);
            color = style.color;
            tint = hexToRgba(style.color, 0.34);
            badge.textContent = hasManual ? `MAN ${activeFF.toFixed(2)}` : `FF ${activeFF.toFixed(2)}`;
        }

        entry.row.classList.add("ks6-colored-row");
        entry.row.style.setProperty("--ks6-row-color", color);
        entry.row.style.setProperty("--ks6-row-tint", tint);
        host.style.setProperty("--ks6-row-color", color);

        entry.row.classList.toggle("ks6-no-stripe", !settings.showStripe);

        const battleStats = manual?.battleStats || data?.bs_estimate;
        badge.title = `${source} FF ${Number.isFinite(activeFF) ? activeFF.toFixed(2) : "?"} | FFS ${Number.isFinite(ffsFF) ? ffsFF.toFixed(2) : "?"} | BS ${formatCompact(battleStats)}${manual?.note ? ` | ${manual.note}` : ""}`;
        badge.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            openEditor(entry, data);
        };

        return true;
    }

    function buttonPosition() {
        const fallback = { x: Math.max(8, innerWidth - 62), y: Math.max(70, innerHeight - 190) };
        const x = Number(settings.buttonX);
        const y = Number(settings.buttonY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback;
        return {
            x: Math.max(8, Math.min(innerWidth - 58, x)),
            y: Math.max(70, Math.min(innerHeight - 145, y))
        };
    }

    function ensurePanel() {
        if (!/\/factions\.php\/?$/i.test(location.pathname)) return;
        if (document.querySelector(".ks6-fab")) return;

        const button = document.createElement("button");
        button.className = "ks6-fab";
        button.textContent = "KSP";

        const pos = buttonPosition();
        button.style.left = `${pos.x}px`;
        button.style.top = `${pos.y}px`;

        const panel = document.createElement("div");
        panel.className = "ks6-panel";
        panel.hidden = true;
        panel.innerHTML = `
            <div class="ks6-panel-head">
                <strong>Kingshade Scout ${VERSION}</strong>
                <button type="button" class="ks6-close" data-ksp="close" aria-label="Close">×</button>
            </div>
            <div class="ks6-status" data-ksp="status">Waiting for faction scan…</div>

            <label>FF Scouter API key
                <input data-ksp="key" type="password" value="${escapeHtml(getApiKey())}">
            </label>

            <label>Show players without FF data
                <input data-ksp="unknown" type="checkbox" ${settings.showUnknown ? "checked" : ""}>
            </label>

            <label>Show left color bar
                <input data-ksp="stripe" type="checkbox" ${settings.showStripe ? "checked" : ""}>
            </label>

            <div class="ks6-help">
                Changes are saved automatically when this panel is closed. Tap a player's small FF label to add a custom value or note.
            </div>

            <button type="button" data-ksp="rescan">Rescan faction member list</button>
            <button type="button" data-ksp="reset">Reset KSP button position</button>
        `;

        let dragging = false;
        let moved = false;
        let sx = 0, sy = 0, sl = 0, st = 0;

        button.onpointerdown = event => {
            dragging = true;
            moved = false;
            const rect = button.getBoundingClientRect();
            sx = event.clientX;
            sy = event.clientY;
            sl = rect.left;
            st = rect.top;
            button.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        };

        button.onpointermove = event => {
            if (!dragging) return;
            const dx = event.clientX - sx;
            const dy = event.clientY - sy;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
            const x = Math.max(8, Math.min(innerWidth - 58, sl + dx));
            const y = Math.max(70, Math.min(innerHeight - 145, st + dy));
            button.style.left = `${x}px`;
            button.style.top = `${y}px`;
        };

        const finishPointer = event => {
            if (!dragging) return;
            dragging = false;

            if (moved) {
                const rect = button.getBoundingClientRect();
                settings.buttonX = rect.left;
                settings.buttonY = rect.top;
                saveSettings();
            } else if (panel.hidden) {
                panel.hidden = false;
            } else {
                closePanel();
            }

            try { button.releasePointerCapture?.(event.pointerId); } catch {}
        };

        button.onpointerup = finishPointer;
        button.onpointercancel = event => {
            dragging = false;
            moved = false;
            try { button.releasePointerCapture?.(event.pointerId); } catch {}
        };
        button.onlostpointercapture = () => {
            dragging = false;
            moved = false;
        };

        const persistPanelSettings = () => {
            const previousKey = getApiKey();
            const previousUnknown = settings.showUnknown;
            const previousStripe = settings.showStripe;

            const nextKey = panel.querySelector('[data-ksp="key"]').value.trim();
            const nextUnknown = panel.querySelector('[data-ksp="unknown"]').checked;
            const nextStripe = panel.querySelector('[data-ksp="stripe"]').checked;

            setApiKey(nextKey);
            settings.showUnknown = nextUnknown;
            settings.showStripe = nextStripe;
            saveSettings();

            return previousKey !== nextKey || previousUnknown !== nextUnknown || previousStripe !== nextStripe;
        };

        const closePanel = () => {
            const changed = persistPanelSettings();
            panel.hidden = true;
            if (changed) {
                clearRendered();
                scheduleScan(0);
            }
        };

        panel.querySelector('[data-ksp="close"]').onclick = closePanel;

        panel.querySelector('[data-ksp="rescan"]').onclick = () => {
            persistPanelSettings();
            clearRendered();
            scheduleScan(0);
        };

        panel.querySelector('[data-ksp="reset"]').onclick = () => {
            persistPanelSettings();
            settings.buttonX = null;
            settings.buttonY = null;
            saveSettings();
            const reset = buttonPosition();
            button.style.left = `${reset.x}px`;
            button.style.top = `${reset.y}px`;
            panel.hidden = true;
        };

        document.body.append(button, panel);
    }

    function removePanel() {
        document.querySelectorAll(".ks6-fab,.ks6-panel,.ks6-modal").forEach(element => element.remove());
    }

    function updatePanelStatus(text) {
        const el = document.querySelector('[data-ksp="status"]');
        if (el) el.textContent = text;
    }

    function clearRendered() {
        document.querySelectorAll(".ks6-badge").forEach(element => element.remove());
        document.querySelectorAll(".ks6-name-host").forEach(host => host.classList.remove("ks6-name-host"));
        document.querySelectorAll(".ks6-colored-row,[data-ks6-applied],[data-ks6-pending]").forEach(clearRowVisuals);
    }

    async function scan() {
        scanTimer = null;
        if (!/\/factions\.php\/?$/i.test(location.pathname)) {
            clearRendered();
            removePanel();
            return;
        }

        ensurePanel();

        const result = findRows();
        const rows = result.rows;

        updatePanelStatus(`${rows.size} member rows found · ${result.profileLinks} profile links detected`);

        if (!rows.size) {
            // Torn sometimes rebuilds the member table in stages. Leave the
            // page untouched and allow the MutationObserver to retry.
            return;
        }

        const fresh = [];
        for (const entry of rows.values()) {
            if (entry.row.dataset.ks6Applied === VERSION) continue;
            if (entry.row.dataset.ks6Pending === "1") continue;
            entry.row.dataset.ks6Pending = "1";
            fresh.push(entry);
        }

        if (!fresh.length) return;

        try {
            const data = await fetchPlayers(fresh.map(entry => entry.id));
            for (const entry of fresh) {
                const rendered = render(entry, data.get(entry.id));
                if (rendered) entry.row.dataset.ks6Applied = VERSION;
                else entry.row.removeAttribute("data-ks6-applied");
                entry.row.removeAttribute("data-ks6-pending");
            }
            updatePanelStatus(`${rows.size} member rows · FF data loaded`);
        } catch (error) {
            for (const entry of fresh) {
                entry.row.removeAttribute("data-ks6-applied");
                entry.row.removeAttribute("data-ks6-pending");
            }
            updatePanelStatus(`${rows.size} member rows · FF request failed`);
            showToast(error instanceof Error ? error.message : String(error));
        }
    }

    function scheduleScan(delay = 120) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, delay);
    }

    function init() {
        if (!document.body) {
            setTimeout(init, 100);
            return;
        }

        // Remove output from every previous version.
        document.querySelectorAll(
            ".ks6-fab,.ks6-panel,.ks6-badge,.ks6-modal,.ks6-toast,.ks-scout-fab,.ks-scout-panel,.ks-scout-badge,.ks-status-timer,.ks-scout-error"
        ).forEach(el => el.remove());

        document.querySelectorAll(".ks6-name-host").forEach(host => host.classList.remove("ks6-name-host"));
        document.querySelectorAll(".ks6-colored-row").forEach(clearRowVisuals);

        document.querySelectorAll("[data-ks-scout-applied],[data-ks6-applied]").forEach(row => {
            row.removeAttribute("data-ks-scout-applied");
            row.removeAttribute("data-ks6-applied");
            row.style.removeProperty("background");
            row.style.removeProperty("box-shadow");
        });

        ensureStyles();
        ensurePanel();

        observer = new MutationObserver(mutations => {
            const relevant = mutations.some(mutation =>
                Array.from(mutation.addedNodes).some(node => {
                    if (!(node instanceof Element)) return false;
                    return !node.matches(".ks6-fab,.ks6-panel,.ks6-badge,.ks6-modal,.ks6-toast") &&
                           !node.closest?.(".ks6-panel,.ks6-modal");
                })
            );

            if (relevant) scheduleScan();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        window.addEventListener("hashchange", onRouteChange);
        window.addEventListener("popstate", onRouteChange);
        window.navigation?.addEventListener?.("currententrychange", onRouteChange);

        scheduleScan(0);

        window[INSTANCE_KEY] = {
            destroy() {
                clearTimeout(scanTimer);
                observer?.disconnect();
                window.removeEventListener("hashchange", onRouteChange);
                window.removeEventListener("popstate", onRouteChange);
                window.navigation?.removeEventListener?.("currententrychange", onRouteChange);
                document.querySelectorAll(
                    ".ks6-fab,.ks6-panel,.ks6-badge,.ks6-modal,.ks6-toast"
                ).forEach(el => el.remove());
                document.querySelectorAll(".ks6-name-host").forEach(host => host.classList.remove("ks6-name-host"));
                document.querySelectorAll(".ks6-colored-row,[data-ks6-applied],[data-ks6-pending]").forEach(clearRowVisuals);
            }
        };
    }

    init();
})();
