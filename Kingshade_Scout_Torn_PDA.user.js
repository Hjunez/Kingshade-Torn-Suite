// ==UserScript==
// @name         Kingshade Scout for Torn PDA
// @namespace    https://kingshade.tools/
// @version      0.4.1
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
    const VERSION = "0.4.1";
    const API_BASE = "https://ffscouter.com/api/v1";
    const CACHE_TTL_MS = 60 * 60 * 1000;
    const STORAGE_PREFIX = "kingshade-scout:";
    const FF_KEY_STORAGE = `${STORAGE_PREFIX}ff-api-key`;
    const BATCH_SIZE = 100;
    const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;
    const DEFAULT_SETTINGS = {
        ownBattleScore: 0,
        easyRatio: 0.75,
        cautionRatio: 1.05,
        showUnknown: true,
        markRows: true,
        buttonX: null,
        buttonY: null
    };
    let settings = loadSettings();

    const memoryCache = new Map();
    let scanTimer = null;
    let observer = null;

    const log = (...args) => console.log(`[${NAME} ${VERSION}]`, ...args);
    const warn = (...args) => console.warn(`[${NAME} ${VERSION}]`, ...args);

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");

            // Migrate older FF-threshold settings to player-relative comparison.
            if (!Number(saved.ownBattleScore)) saved.ownBattleScore = 0;
            if (!Number(saved.easyRatio)) saved.easyRatio = 0.75;
            if (!Number(saved.cautionRatio)) saved.cautionRatio = 1.05;

            return { ...DEFAULT_SETTINGS, ...saved };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {}
    }

    function hasOwnBattleScore() {
        return Number(settings.ownBattleScore) > 0;
    }

    function saveButtonPosition(x, y) {
        settings.buttonX = Math.max(8, Math.min(window.innerWidth - 56, x));
        settings.buttonY = Math.max(70, Math.min(window.innerHeight - 140, y));
        saveSettings();
    }

    function getDefaultButtonPosition() {
        return {
            x: Math.max(8, window.innerWidth - 62),
            y: Math.max(70, window.innerHeight - 190)
        };
    }

    function clampButtonPosition(x, y) {
        const maxX = Math.max(8, window.innerWidth - 56);
        const maxY = Math.max(70, window.innerHeight - 140);
        return {
            x: Math.max(8, Math.min(maxX, Number(x))),
            y: Math.max(70, Math.min(maxY, Number(y)))
        };
    }

    function normalizeSavedButtonPosition() {
        const fallback = getDefaultButtonPosition();
        const x = Number(settings.buttonX);
        const y = Number(settings.buttonY);

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            settings.buttonX = fallback.x;
            settings.buttonY = fallback.y;
            saveSettings();
            return fallback;
        }

        const safe = clampButtonPosition(x, y);
        if (safe.x !== x || safe.y !== y) {
            settings.buttonX = safe.x;
            settings.buttonY = safe.y;
            saveSettings();
        }
        return safe;
    }

    function resetButtonPosition(button) {
        const pos = getDefaultButtonPosition();
        settings.buttonX = pos.x;
        settings.buttonY = pos.y;
        saveSettings();

        if (button) {
            button.style.left = `${pos.x}px`;
            button.style.top = `${pos.y}px`;
            button.style.right = "auto";
            button.style.bottom = "auto";
        }
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

    function classify(data) {
        const target = Number(data?.bs_estimate);
        const own = Number(settings.ownBattleScore);

        if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(own) || own <= 0) {
            return { label: "UNKNOWN", color: "#666", icon: "●", ratio: null };
        }

        const ratio = target / own;

        if (ratio <= settings.easyRatio) {
            return { label: "LIKELY WIN", color: "#2e9d52", icon: "▼", ratio };
        }

        if (ratio <= settings.cautionRatio) {
            return { label: "CAUTION", color: "#d6a20b", icon: "◆", ratio };
        }

        return { label: "TOO STRONG", color: "#d24444", icon: "▲", ratio };
    }

    function ensureStyles() {
        if (document.getElementById("ks-scout-styles")) return;
        const style = document.createElement("style");
        style.id = "ks-scout-styles";
        style.textContent = `
            .ks-scout-badge{display:flex!important;align-items:center;justify-content:center;gap:4px;margin:3px 0 0;padding:4px 7px;border-radius:5px;font:800 11px/1.15 Arial,sans-serif;color:#fff!important;white-space:nowrap;box-shadow:0 0 0 1px rgba(0,0,0,.45);z-index:2;max-width:100%;overflow:hidden;text-overflow:ellipsis}
            .ks-scout-badge[data-state="loading"]{background:#555;opacity:.8}
            .ks-scout-badge .ks-scout-stats{font-weight:700;opacity:.98}
            .ks-scout-row-easy{background:linear-gradient(90deg,rgba(46,157,82,.34),rgba(46,157,82,.08) 48%,transparent 78%)!important;box-shadow:inset 6px 0 0 #2e9d52!important}
            .ks-scout-row-risky{background:linear-gradient(90deg,rgba(214,162,11,.34),rgba(214,162,11,.08) 48%,transparent 78%)!important;box-shadow:inset 6px 0 0 #d6a20b!important}
            .ks-scout-row-avoid{background:linear-gradient(90deg,rgba(210,68,68,.38),rgba(210,68,68,.09) 48%,transparent 78%)!important;box-shadow:inset 6px 0 0 #d24444!important}
            .ks-scout-row-unknown{background:linear-gradient(90deg,rgba(102,102,102,.25),rgba(102,102,102,.05) 48%,transparent 78%)!important;box-shadow:inset 6px 0 0 #666!important}
            .ks-scout-error{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(92vw,520px);padding:9px 12px;border-radius:7px;background:#b3261e;color:#fff;font:600 12px/1.35 Arial,sans-serif;z-index:2147483647;box-shadow:0 3px 12px rgba(0,0,0,.35)}
            .ks-scout-fab{position:fixed;right:14px;bottom:92px;width:50px;height:50px;border:0;border-radius:50%;background:#263238;color:#fff;font:800 12px Arial;z-index:2147483646;box-shadow:0 3px 12px rgba(0,0,0,.45);touch-action:none;user-select:none}
            .ks-scout-fab.ks-dragging{opacity:.85;transform:scale(1.06)}
            .ks-scout-setup{margin:8px 0;padding:8px;border-radius:6px;background:#5b3a00;color:#ffd98a;font-weight:700}
            .ks-status-timer{display:inline-flex!important;align-items:center;gap:3px;margin-left:5px;padding:2px 5px;border-radius:4px;background:#37474f;color:#fff!important;font:700 10px/1.15 Arial,sans-serif;white-space:nowrap;vertical-align:middle;box-shadow:0 0 0 1px rgba(0,0,0,.3)}
            .ks-status-timer[data-state="hospital"]{background:#9c2c2c}
            .ks-status-timer[data-state="jail"]{background:#705020}
            .ks-status-timer[data-state="traveling"]{background:#2e5d8a}
            .ks-status-timer[data-state="abroad"]{background:#5b4a86}
            .ks-status-ready{background:#2e9d52!important}
            .ks-scout-panel{position:fixed;right:12px;bottom:150px;width:min(88vw,300px);padding:12px;border-radius:10px;background:#202124;color:#fff;font:13px Arial;z-index:2147483646;box-shadow:0 4px 18px rgba(0,0,0,.55)}
            .ks-scout-panel label{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0}
            .ks-scout-panel input[type=number]{width:92px}.ks-scout-panel input[type=password]{width:150px;min-width:0}
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

        entry.row.classList.remove("ks-scout-row-easy", "ks-scout-row-risky", "ks-scout-row-avoid", "ks-scout-row-unknown");

        if (!data || data.no_data) {
            if (!settings.showUnknown) {
                badge.remove();
                return;
            }
            badge.dataset.state = "unknown";
            badge.style.background = "#666";
            badge.textContent = "● UNKNOWN";
            badge.title = !hasOwnBattleScore()
                ? "Enter your own battle score in KSP settings."
                : "FF Scouter has no battle-stat estimate for this player.";
            if (settings.markRows) entry.row.classList.add("ks-scout-row-unknown");
            return;
        }

        const rating = classify(data);
        badge.dataset.state = rating.label.toLowerCase();
        badge.style.background = rating.color;
        const pct = rating.ratio === null ? "?" : `${Math.round(rating.ratio * 100)}%`;
        badge.innerHTML = `${rating.icon} ${rating.label} <span class="ks-scout-stats">${escapeHtml(data.bs_estimate_human)} · ${pct}</span>`;
        badge.title = `Target estimate: ${data.bs_estimate_human} | Your score: ${formatNumber(settings.ownBattleScore)} | Target is ${pct} of your score | FF: ${data.fair_fight.toFixed(2)} | Source: ${data.source}`;

        if (settings.markRows) {
            if (rating.label === "LIKELY WIN") entry.row.classList.add("ks-scout-row-easy");
            if (rating.label === "CAUTION") entry.row.classList.add("ks-scout-row-risky");
            if (rating.label === "TOO STRONG") entry.row.classList.add("ks-scout-row-avoid");

            const memberCell = entry.anchor.closest(".member, [class*='member___'], .table-cell") || entry.anchor.parentElement;
            if (memberCell) {
                memberCell.style.borderRadius = "4px";
                memberCell.style.paddingTop = "2px";
                memberCell.style.paddingBottom = "2px";
            }
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

        const safePosition = normalizeSavedButtonPosition();
        button.style.left = `${safePosition.x}px`;
        button.style.top = `${safePosition.y}px`;
        button.style.right = "auto";
        button.style.bottom = "auto";

        const panel = document.createElement("div");
        panel.className = "ks-scout-panel";
        panel.hidden = true;
        panel.innerHTML = `
            <strong>Kingshade Scout ${VERSION}</strong>
            ${hasOwnBattleScore() ? "" : '<div class="ks-scout-setup">Enter your own battle score before using target colors.</div>'}
            <label>FF Scouter API key <input data-ksp="key" type="password" autocomplete="off" value="${getFFKey()}"></label>
            <label>Your battle score <input data-ksp="ownbs" type="number" min="1" step="1000" value="${settings.ownBattleScore || ""}"></label>
            <label>Green up to <input data-ksp="easy" type="number" min="0.1" max="2" step="0.05" value="${settings.easyRatio}"></label>
            <label>Yellow up to <input data-ksp="risky" type="number" min="0.1" max="3" step="0.05" value="${settings.cautionRatio}"></label>
            <div style="font-size:11px;opacity:.75;margin:4px 0 8px">Green/yellow/red is based on target battle score compared with yours. 0.75 = 75%.</div>
            <label>Show unknown <input data-ksp="unknown" type="checkbox" ${settings.showUnknown ? "checked" : ""}></label>
            <label>Highlight full rows <input data-ksp="rows" type="checkbox" ${settings.markRows ? "checked" : ""}></label>
            <button data-ksp="resetpos" type="button">Reset KSP button position</button>
            <button data-ksp="apply" type="button">Apply and refresh</button>
        `;

        let dragging = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        button.addEventListener("pointerdown", event => {
            dragging = true;
            moved = false;
            button.setPointerCapture?.(event.pointerId);

            const rect = button.getBoundingClientRect();
            startX = event.clientX;
            startY = event.clientY;
            startLeft = rect.left;
            startTop = rect.top;

            button.classList.add("ks-dragging");
            event.preventDefault();
        });

        button.addEventListener("pointermove", event => {
            if (!dragging) return;

            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;

            const safe = clampButtonPosition(startLeft + dx, startTop + dy);
            button.style.left = `${safe.x}px`;
            button.style.top = `${safe.y}px`;
        });

        const finishDrag = event => {
            if (!dragging) return;
            dragging = false;
            button.classList.remove("ks-dragging");

            if (moved) {
                const rect = button.getBoundingClientRect();
                const safe = clampButtonPosition(rect.left, rect.top);
                saveButtonPosition(safe.x, safe.y);
                button.style.left = `${safe.x}px`;
                button.style.top = `${safe.y}px`;
            } else {
                panel.hidden = !panel.hidden;
            }

            try {
                button.releasePointerCapture?.(event.pointerId);
            } catch {}
        };

        button.addEventListener("pointerup", finishDrag);
        button.addEventListener("pointercancel", finishDrag);

        panel.querySelector('[data-ksp="resetpos"]').addEventListener("click", () => {
            resetButtonPosition(button);
            panel.hidden = true;
        });

        panel.querySelector('[data-ksp="apply"]').addEventListener("click", () => {
            setFFKey(panel.querySelector('[data-ksp="key"]').value);

            const ownbs = Number(panel.querySelector('[data-ksp="ownbs"]').value);
            const easy = Number(panel.querySelector('[data-ksp="easy"]').value);
            const risky = Number(panel.querySelector('[data-ksp="risky"]').value);

            settings.ownBattleScore = Number.isFinite(ownbs) && ownbs > 0 ? ownbs : 0;
            settings.easyRatio = Number.isFinite(easy) ? easy : DEFAULT_SETTINGS.easyRatio;
            settings.cautionRatio = Number.isFinite(risky) ? Math.max(risky, settings.easyRatio) : DEFAULT_SETTINGS.cautionRatio;
            settings.showUnknown = panel.querySelector('[data-ksp="unknown"]').checked;
            settings.markRows = panel.querySelector('[data-ksp="rows"]').checked;
            saveSettings();

            document.querySelectorAll("[data-ks-scout-applied]").forEach(el => {
                el.removeAttribute("data-ks-scout-applied");
                el.classList.remove("ks-scout-row-easy", "ks-scout-row-risky", "ks-scout-row-avoid", "ks-scout-row-unknown");
                el.querySelectorAll(".ks-scout-badge").forEach(b => b.remove());
            });

            panel.hidden = true;
            scheduleScan(0);
        });

        const keepVisible = () => {
            const rect = button.getBoundingClientRect();
            const safe = clampButtonPosition(rect.left, rect.top);
            if (safe.x !== rect.left || safe.y !== rect.top) {
                button.style.left = `${safe.x}px`;
                button.style.top = `${safe.y}px`;
                saveButtonPosition(safe.x, safe.y);
            }
        };

        window.addEventListener("resize", keepVisible);
        window.addEventListener("orientationchange", () => setTimeout(keepVisible, 150));

        document.body.append(button, panel);

        if (!hasOwnBattleScore()) {
            setTimeout(() => {
                panel.hidden = false;
            }, 600);
        }
    }

    const statusTimers = new Map();
    let timerInterval = null;

    function parseAbsoluteTimestamp(value) {
        if (value === null || value === undefined || value === "") return null;

        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            if (numeric > 1e12) return Math.floor(numeric / 1000);
            if (numeric > 1e9) return Math.floor(numeric);
        }

        const parsed = Date.parse(String(value));
        if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
        return null;
    }

    function parseDurationSeconds(text) {
        if (!text) return null;
        const normalized = String(text).toLowerCase();

        const clock = normalized.match(/\b(?:(\d+):)?(\d{1,2}):(\d{2})\b/);
        if (clock) {
            const hours = Number(clock[1] || 0);
            const minutes = Number(clock[2] || 0);
            const seconds = Number(clock[3] || 0);
            return hours * 3600 + minutes * 60 + seconds;
        }

        let total = 0;
        let matched = false;
        const parts = [
            [/(\d+)\s*(?:d|day|days)\b/, 86400],
            [/(\d+)\s*(?:h|hr|hrs|hour|hours)\b/, 3600],
            [/(\d+)\s*(?:m|min|mins|minute|minutes)\b/, 60],
            [/(\d+)\s*(?:s|sec|secs|second|seconds)\b/, 1]
        ];

        for (const [regex, multiplier] of parts) {
            const match = normalized.match(regex);
            if (match) {
                total += Number(match[1]) * multiplier;
                matched = true;
            }
        }

        return matched ? total : null;
    }

    function inferStatus(row) {
        const statusEl =
            row.querySelector(".status") ||
            row.querySelector('[class*="status___"]') ||
            row.querySelector('[class*="statusWrap"]') ||
            row.querySelector('[aria-label*="Hospital"], [aria-label*="Jail"], [aria-label*="Travel"], [aria-label*="Abroad"]');

        if (!statusEl) return null;

        const text = [
            statusEl.textContent,
            statusEl.getAttribute("aria-label"),
            statusEl.getAttribute("title"),
            statusEl.dataset?.status,
            statusEl.dataset?.state
        ].filter(Boolean).join(" ").toLowerCase();

        if (text.includes("hospital")) return { state: "hospital", label: "Hospital", element: statusEl };
        if (text.includes("jail")) return { state: "jail", label: "Jail", element: statusEl };
        if (text.includes("travel")) return { state: "traveling", label: "Traveling", element: statusEl };
        if (text.includes("abroad") || text.includes("in ")) return { state: "abroad", label: "Abroad", element: statusEl };
        return null;
    }

    function findStatusUntil(row, statusEl) {
        const candidates = [
            statusEl?.dataset?.until,
            statusEl?.dataset?.timestamp,
            statusEl?.dataset?.time,
            statusEl?.getAttribute("data-until"),
            statusEl?.getAttribute("data-timestamp"),
            row.dataset?.until,
            row.dataset?.timestamp,
            row.dataset?.statusUntil,
            row.getAttribute("data-until"),
            row.getAttribute("data-status-until")
        ];

        const timeEl = statusEl?.querySelector?.("time") || row.querySelector("time");
        if (timeEl) {
            candidates.push(
                timeEl.getAttribute("datetime"),
                timeEl.getAttribute("data-until"),
                timeEl.getAttribute("data-timestamp")
            );
        }

        for (const candidate of candidates) {
            const ts = parseAbsoluteTimestamp(candidate);
            if (ts && ts > Date.now() / 1000 - 5) return ts;
        }

        const sourceText = [
            statusEl?.textContent,
            statusEl?.getAttribute?.("aria-label"),
            statusEl?.getAttribute?.("title"),
            row.getAttribute("aria-label"),
            row.getAttribute("title")
        ].filter(Boolean).join(" ");

        const duration = parseDurationSeconds(sourceText);
        if (duration && duration > 0) {
            return Math.floor(Date.now() / 1000) + duration;
        }

        return null;
    }

    function formatCountdown(seconds) {
        const s = Math.max(0, Math.floor(seconds));
        const days = Math.floor(s / 86400);
        const hours = Math.floor((s % 86400) / 3600);
        const minutes = Math.floor((s % 3600) / 60);
        const secs = s % 60;

        if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
        if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }

    function ensureStatusTimer(entry) {
        const status = inferStatus(entry.row);
        const old = entry.row.querySelector(`.ks-status-timer[data-player-id="${entry.id}"]`);

        if (!status) {
            old?.remove();
            statusTimers.delete(entry.id);
            return;
        }

        let timer = old;
        if (!timer) {
            timer = document.createElement("span");
            timer.className = "ks-status-timer";
            timer.dataset.playerId = String(entry.id);
            const host = status.element.parentElement || status.element;
            host.appendChild(timer);
        }

        timer.dataset.state = status.state;
        const until = findStatusUntil(entry.row, status.element);

        if (until) {
            statusTimers.set(entry.id, { timer, until, label: status.label });
            updateOneStatusTimer(entry.id);
        } else {
            statusTimers.delete(entry.id);
            timer.textContent = status.label;
            timer.title = `No exact end time was found in the page data for ${status.label.toLowerCase()}.`;
        }
    }

    function updateOneStatusTimer(id) {
        const item = statusTimers.get(id);
        if (!item) return;

        if (!item.timer.isConnected) {
            statusTimers.delete(id);
            return;
        }

        const remaining = item.until - Math.floor(Date.now() / 1000);
        if (remaining <= 0) {
            item.timer.dataset.state = "ready";
            item.timer.classList.add("ks-status-ready");
            item.timer.textContent = "Okay";
            item.timer.title = "The saved timer has expired. Reload to verify current status.";
            statusTimers.delete(id);
            return;
        }

        item.timer.classList.remove("ks-status-ready");
        item.timer.textContent = `${item.label} · ${formatCountdown(remaining)}`;
        item.timer.title = `Estimated time remaining until this status ends: ${formatCountdown(remaining)}`;
    }

    function startStatusTicker() {
        if (timerInterval) return;
        timerInterval = setInterval(() => {
            for (const id of Array.from(statusTimers.keys())) {
                updateOneStatusTimer(id);
            }
        }, 1000);
    }

    async function scan() {
        scanTimer = null;
        ensureStyles();

        const rows = findTargetRows();
        if (rows.size === 0) return;

        const freshEntries = [];
        for (const entry of rows.values()) {
            ensureStatusTimer(entry);

            if (entry.row.dataset.ksScoutApplied === "1" || entry.row.dataset.ksScoutApplied === "pending") continue;
            entry.row.dataset.ksScoutApplied = "pending";
            renderLoading(entry);
            freshEntries.push(entry);
        }

        startStatusTicker();

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
        startStatusTicker();
        startObserver();
        window.addEventListener("popstate", resetOnNavigation);
        window.addEventListener("hashchange", resetOnNavigation);
        window.navigation?.addEventListener?.("currententrychange", resetOnNavigation);
        scheduleScan(0);
        log("Loaded");
    }

    init();
})();
