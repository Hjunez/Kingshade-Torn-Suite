// ==UserScript==
// @name         Kingshade Scout for Torn PDA
// @namespace    https://kingshade.tools/
// @version      0.6.1
// @description  FF Scouter overlay for Torn PDA faction lists with manual FF and compact K/M/B battle-stat overrides.
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
    const VERSION = "0.6.1";
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
        if (!key) throw new Error("Ingen FF Scouter API-nyckel är sparad. Tryck KSP och klistra in nyckeln.");

        for (let i = 0; i < missing.length; i += 100) {
            const batch = missing.slice(i, i + 100);
            const query = new URLSearchParams({ key, targets: batch.join(",") });
            const response = await httpGet(`${API_BASE}/get-stats?${query}`);

            if (response.status !== 200) {
                throw new Error(`FF Scouter svarade med HTTP ${response.status}`);
            }

            let rows;
            try {
                rows = JSON.parse(response.responseText);
            } catch {
                throw new Error("FF Scouter skickade ogiltig data.");
            }

            if (!Array.isArray(rows)) {
                throw new Error(rows?.error || "Oväntat svar från FF Scouter.");
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

    function findMemberRow(anchor) {
        let node = anchor;

        for (let depth = 0; depth < 10 && node && node !== document.body; depth++, node = node.parentElement) {
            const text = String(node.textContent || "").trim();
            const hasStatus = /\b(?:okay|hospital|jail|traveling|travelling|abroad|fallen)\b/i.test(text);
            const hasSeveralCells =
                node.children?.length >= 2 ||
                !!node.querySelector?.(".status, [class*='status___'], [class*='level___'], [class*='member___']");

            if (hasStatus && hasSeveralCells) return node;
        }

        return anchor.closest("li, .table-row, [class*='row___'], [class*='member___']");
    }

    function findRows() {
        const map = new Map();
        if (!/\/factions\.php\/?$/i.test(location.pathname)) return map;

        const anchors = document.querySelectorAll(
            'a[href*="profiles.php?XID="], a[href*="user2ID="], a[href*="userId="]'
        );

        for (const anchor of anchors) {
            const id = extractPlayerId(anchor);
            if (!id || map.has(id)) continue;

            const row = findMemberRow(anchor);
            if (!row) continue;

            const text = String(row.textContent || "");
            if (!/\b(?:okay|hospital|jail|traveling|travelling|abroad)\b/i.test(text)) continue;

            map.set(id, { id, row, anchor });
        }

        return map;
    }

    const FF_PALETTE = [
        "#1734e8", "#1788e8", "#17dbe8", "#17e8a1", "#17e84e",
        "#34e817", "#88e817", "#dbe817", "#e8a117", "#e84e17", "#e81734"
    ];

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
            .ks6-fab{position:fixed;width:50px;height:50px;border:0;border-radius:50%;background:#263238;color:#fff;font:800 12px Arial;z-index:2147483645;box-shadow:0 3px 12px rgba(0,0,0,.45);touch-action:none;user-select:none}
            .ks6-panel{position:fixed;right:12px;bottom:150px;width:min(88vw,310px);padding:12px;border-radius:10px;background:#202124;color:#fff;font:13px Arial;z-index:2147483646;box-shadow:0 4px 18px rgba(0,0,0,.55)}
            .ks6-panel label{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:9px 0}
            .ks6-panel input[type=password]{width:155px;min-width:0}
            .ks6-panel button{width:100%;margin-top:8px;padding:9px;border:0;border-radius:6px;font-weight:700}
            .ks6-status{margin:5px 0 10px;padding:7px;border-radius:6px;background:#303238;font-size:11px}
            .ks6-badge{position:absolute!important;right:3px;bottom:2px;display:inline-flex!important;align-items:center;justify-content:center;padding:3px 5px;border-radius:4px;color:#fff!important;font:800 9px/1 Arial;white-space:nowrap;z-index:5;box-shadow:0 0 0 1px rgba(0,0,0,.45);cursor:pointer}
            .ks6-modal{position:fixed;inset:0;background:rgba(0,0,0,.74);display:flex;align-items:center;justify-content:center;z-index:2147483647}
            .ks6-card{width:min(91vw,350px);background:#202124;color:#fff;border-radius:10px;padding:14px;font:13px Arial;box-shadow:0 5px 25px rgba(0,0,0,.65)}
            .ks6-card label{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:11px 0}
            .ks6-card input,.ks6-card select{min-height:31px}
            .ks6-actions{display:flex;gap:7px;margin-top:13px}
            .ks6-actions button{flex:1;padding:9px;border:0;border-radius:6px;font-weight:700}
            .ks6-toast{position:fixed;left:50%;bottom:25px;transform:translateX(-50%);max-width:90vw;padding:9px 12px;border-radius:7px;background:#b3261e;color:#fff;font:600 12px Arial;z-index:2147483647}
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
        const host = entry.anchor.closest(".honor-text-wrap") || entry.anchor.parentElement || entry.row;
        if (host && getComputedStyle(host).position === "static") host.style.position = "relative";
        return host;
    }

    function openEditor(entry, ffsData) {
        document.querySelector(".ks6-modal")?.remove();

        const manual = getManual(entry.id);
        const bs = compactParts(manual?.battleStats || ffsData?.bs_estimate);
        const ffsFF = Number(ffsData?.fair_fight);

        const modal = document.createElement("div");
        modal.className = "ks6-modal";
        modal.innerHTML = `
            <div class="ks6-card">
                <strong>${escapeHtml(entry.anchor.textContent?.trim() || `Player ${entry.id}`)}</strong>
                <div style="opacity:.72;margin-top:4px">FF Scouter: ${Number.isFinite(ffsFF) && ffsFF > 0 ? ffsFF.toFixed(2) : "ingen data"}</div>

                <label>Använd eget FF
                    <input data-x="use" type="checkbox" ${Number(manual?.ff) > 0 ? "checked" : ""}>
                </label>

                <label>Eget FF
                    <input data-x="ff" type="number" min="0.1" max="20" step="0.01" value="${Number(manual?.ff) > 0 ? manual.ff : ""}">
                </label>

                <label>Battle stats
                    <span style="display:flex;gap:5px">
                        <input data-x="bs" type="number" min="0.1" step="0.1" style="width:90px" value="${bs.value}">
                        <select data-x="unit">
                            <option value="K" ${bs.unit === "K" ? "selected" : ""}>K</option>
                            <option value="M" ${bs.unit === "M" ? "selected" : ""}>M</option>
                            <option value="B" ${bs.unit === "B" ? "selected" : ""}>B</option>
                        </select>
                    </span>
                </label>

                <label>Anteckning
                    <input data-x="note" type="text" style="width:180px" value="${escapeHtml(manual?.note || "")}">
                </label>

                <div class="ks6-actions">
                    <button data-x="clear">Rensa eget</button>
                    <button data-x="cancel">Avbryt</button>
                    <button data-x="save">Spara</button>
                </div>
            </div>
        `;

        const close = () => modal.remove();

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

    function refreshRow(row) {
        row.removeAttribute("data-ks6-applied");
        row.querySelectorAll(".ks6-badge").forEach(el => el.remove());
        row.style.removeProperty("box-shadow");
        scheduleScan(0);
    }

    function render(entry, data) {
        const host = badgeHost(entry);
        if (!host) return;

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
        const activeFF = Number.isFinite(manualFF) && manualFF > 0 ? manualFF : ffsFF;
        const source = Number.isFinite(manualFF) && manualFF > 0 ? "MAN" : "FFS";

        if (!Number.isFinite(activeFF) || activeFF <= 0) {
            if (!settings.showUnknown) {
                badge.remove();
                return;
            }
            badge.style.background = "#666";
            badge.textContent = "FF ?";
        } else {
            const style = ffStyle(activeFF);
            badge.style.background = style.color;
            badge.textContent = `${source} ${activeFF.toFixed(2)}`;

            entry.row.style.removeProperty("box-shadow");
            if (settings.showStripe) entry.row.style.boxShadow = `inset 5px 0 0 ${style.color}`;
        }

        const battleStats = manual?.battleStats || data?.bs_estimate;
        badge.title = `${source} FF ${Number.isFinite(activeFF) ? activeFF.toFixed(2) : "?"} | FFS ${Number.isFinite(ffsFF) ? ffsFF.toFixed(2) : "?"} | BS ${formatCompact(battleStats)}${manual?.note ? ` | ${manual.note}` : ""}`;
        badge.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            openEditor(entry, data);
        };
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
            <strong>Kingshade Scout ${VERSION}</strong>
            <div class="ks6-status" data-ksp="status">Väntar på scanning…</div>
            <label>FF Scouter API key
                <input data-ksp="key" type="password" value="${escapeHtml(getApiKey())}">
            </label>
            <label>Visa okända
                <input data-ksp="unknown" type="checkbox" ${settings.showUnknown ? "checked" : ""}>
            </label>
            <label>Visa färgrand
                <input data-ksp="stripe" type="checkbox" ${settings.showStripe ? "checked" : ""}>
            </label>
            <div style="font-size:11px;opacity:.75;margin-top:8px">Tryck på en FFS/MAN-ruta vid en spelare för att ange eget FF och battle stats som K, M eller B.</div>
            <button data-ksp="rescan">Scanna om factionlistan</button>
            <button data-ksp="reset">Återställ KSP-position</button>
            <button data-ksp="save">Spara inställningar</button>
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
            } else {
                panel.hidden = !panel.hidden;
            }

            try { button.releasePointerCapture?.(event.pointerId); } catch {}
        };

        button.onpointerup = finishPointer;
        button.onpointercancel = finishPointer;
        button.onlostpointercapture = () => { dragging = false; };

        panel.querySelector('[data-ksp="save"]').onclick = () => {
            setApiKey(panel.querySelector('[data-ksp="key"]').value);
            settings.showUnknown = panel.querySelector('[data-ksp="unknown"]').checked;
            settings.showStripe = panel.querySelector('[data-ksp="stripe"]').checked;
            saveSettings();
            panel.hidden = true;
            clearRendered();
            scheduleScan(0);
        };

        panel.querySelector('[data-ksp="rescan"]').onclick = () => {
            clearRendered();
            scheduleScan(0);
        };

        panel.querySelector('[data-ksp="reset"]').onclick = () => {
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

    function updatePanelStatus(text) {
        const el = document.querySelector('[data-ksp="status"]');
        if (el) el.textContent = text;
    }

    function clearRendered() {
        document.querySelectorAll(".ks6-badge").forEach(el => el.remove());
        document.querySelectorAll("[data-ks6-applied]").forEach(row => {
            row.removeAttribute("data-ks6-applied");
            row.style.removeProperty("box-shadow");
        });
    }

    async function scan() {
        scanTimer = null;
        if (!/\/factions\.php\/?$/i.test(location.pathname)) {
            updatePanelStatus("Öppna en factionlista för att scanna.");
            return;
        }

        const profileLinkCount = document.querySelectorAll(
            'a[href*="profiles.php?XID="], a[href*="user2ID="], a[href*="userId="]'
        ).length;
        const rows = findRows();
        updatePanelStatus(`${rows.size} rader av ${profileLinkCount} profillänkar hittades`);

        if (!rows.size) return;

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
                render(entry, data.get(entry.id));
                entry.row.dataset.ks6Applied = VERSION;
                entry.row.removeAttribute("data-ks6-pending");
            }
            updatePanelStatus(`${rows.size} rader av ${profileLinkCount} profillänkar · FF laddat`);
        } catch (error) {
            for (const entry of fresh) {
                entry.row.removeAttribute("data-ks6-applied");
                entry.row.removeAttribute("data-ks6-pending");
            }
            updatePanelStatus(`${rows.size} rader av ${profileLinkCount} profillänkar · fel vid FF-hämtning`);
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

        window.addEventListener("hashchange", () => scheduleScan(200));
        window.addEventListener("popstate", () => scheduleScan(200));
        window.navigation?.addEventListener?.("currententrychange", () => scheduleScan(200));

        scheduleScan(0);

        window[INSTANCE_KEY] = {
            destroy() {
                clearTimeout(scanTimer);
                observer?.disconnect();
                document.querySelectorAll(
                    ".ks6-fab,.ks6-panel,.ks6-badge,.ks6-modal,.ks6-toast"
                ).forEach(el => el.remove());
                document.querySelectorAll("[data-ks6-applied],[data-ks6-pending]").forEach(row => {
                    row.removeAttribute("data-ks6-applied");
                    row.removeAttribute("data-ks6-pending");
                    row.style.removeProperty("box-shadow");
                });
            }
        };
    }

    init();
})();
