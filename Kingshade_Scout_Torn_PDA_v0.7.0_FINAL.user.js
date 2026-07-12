// ==UserScript==
// @name         Kingshade Scout for Torn PDA
// @namespace    https://kingshade.tools/
// @version      0.7.2
// @description  Mobile FF Scouter overlay for Torn PDA faction member lists with FF, estimate fallbacks, and optional manual overrides.
// @author       Kingshade
// @match        https://www.torn.com/*
// @connect      ffscouter.com
// @connect      api.torn.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(() => {
    "use strict";

    const INSTANCE_KEY = "__kingshadeScoutActive";
    if (window[INSTANCE_KEY]) {
        try { window[INSTANCE_KEY].destroy?.(); } catch {}
    }

    const NAME = "Kingshade Scout PDA";
    const VERSION = "0.7.3";
    const API_BASE = "https://ffscouter.com/api/v1";
    const TORN_API_BASE = "https://api.torn.com";
    const PREFIX = "kingshade-scout:";
    const SETTINGS_KEY = `${PREFIX}settings`;
    const API_KEY_STORAGE = `${PREFIX}ff-api-key`;
    const MANUAL_PREFIX = `${PREFIX}manual:`;
    const PROFILE_EST_PREFIX = `${PREFIX}profile-estimate:`;
    const CACHE_PREFIX = `${PREFIX}cache:`;
    const CACHE_MS = 60 * 60 * 1000;
    const FACTION_DIRECTORY_MS = 5 * 60 * 1000;
    const OLD_ESTIMATE_SECONDS = 14 * 24 * 60 * 60;

    const DEFAULTS = {
        showUnknown: true,
        buttonStyle: "crest",
        buttonX: null,
        buttonY: null
    };

    let settings = loadSettings();
    let scanTimer = null;
    let observer = null;
    const memoryCache = new Map();
    const factionDirectoryCache = new Map();
    let scanRunning = false;
    let rescanRequested = false;
    const onRouteChange = () => scheduleScan(200);

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
            // Keep old installations compatible while removing the obsolete stripe option.
            delete saved.showStripe;
            return { ...DEFAULTS, ...saved };
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

    function normalizeEstimateText(value) {
        const text = String(value || "")
            .replace(/\s+/g, " ")
            .replace(/\s*(?:-|–|to)\s*/gi, "–")
            .trim();

        if (!text || /^(?:unk|unknown|n\/a|none|\?)$/i.test(text)) return "";

        return text
            .replace(/(\d(?:[.,]\d+)?)\s*([kmb])\b/gi, (_, number, unit) => `${number}${unit.toUpperCase()}`)
            .replace(/^<\s+/, "<");
    }

    function extractEstimateFragment(value) {
        const text = String(value || "").replace(/\s+/g, " ").trim();
        const match = text.match(/(?:<\s*)?\d+(?:[.,]\d+)?\s*[KMB](?:\s*(?:-|–|to)\s*\d+(?:[.,]\d+)?\s*[KMB])?/i);
        return normalizeEstimateText(match?.[0] || "");
    }

    function getProfileEstimate(playerId) {
        try {
            const parsed = JSON.parse(localStorage.getItem(`${PROFILE_EST_PREFIX}${playerId}`) || "null");
            return parsed?.human ? parsed : null;
        } catch {
            return null;
        }
    }

    function setProfileEstimate(playerId, human, source = "profile") {
        const clean = extractEstimateFragment(human);
        if (!playerId || !clean) return;
        try {
            localStorage.setItem(`${PROFILE_EST_PREFIX}${playerId}`, JSON.stringify({
                human: clean,
                source,
                capturedAt: Date.now()
            }));
        } catch {}
    }

    function captureProfileEstimate() {
        if (!/\/profiles\.php\/?$/i.test(location.pathname)) return;

        const playerId = playerIdFromUrl(location.href);
        if (!playerId) return;

        const text = String(document.body?.innerText || "");
        const detailed = text.match(/(?:^|\n)\s*>?\s*Estimated stats:\s*([^\n]+)/i);
        const header = text.match(/(?:^|\n)\s*\(EST\)\s*([^\n]+)/i);
        const human = extractEstimateFragment(detailed?.[1] || header?.[1] || "");

        if (human) setProfileEstimate(playerId, human, detailed ? "FF Scouter profile" : "profile header");
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

    function normalizedText(element) {
        return String(element?.textContent || "").replace(/\s+/g, " ").trim();
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
        if (!key) throw new Error("No FF Scouter API key is saved. Open KS and paste your key.");

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
                    last_updated: Number(row.last_updated),
                    bs_estimate: Number(row.bs_estimate),
                    bs_estimate_human: String(row.bs_estimate_human || ""),
                    bss_public: Number(row.bss_public),
                    source: String(row.source || "bss"),
                    available_estimates: row.available_estimates && typeof row.available_estimates === "object"
                        ? row.available_estimates
                        : null,
                    premium_insights_available: Boolean(row.premium_insights_available),
                    distribution: row.distribution || null,
                    spies: Array.isArray(row.spies) ? row.spies : []
                };

                returned.add(playerId);
                result.set(playerId, value);
                setCached(playerId, value);
            }

            for (const id of batch) {
                if (!returned.has(id)) {
                    const value = {
                        player_id: id,
                        fair_fight: null,
                        last_updated: null,
                        bs_estimate: null,
                        bs_estimate_human: "",
                        bss_public: null,
                        source: "",
                        available_estimates: null,
                        premium_insights_available: false,
                        distribution: null,
                        spies: []
                    };
                    result.set(id, value);
                    setCached(id, value);
                }
            }
        }

        return result;
    }

    function playerIdFromUrl(rawHref) {
        const href = String(rawHref || "").replaceAll("&amp;", "&");
        if (!href) return null;

        try {
            const url = new URL(href, location.origin);
            const path = url.pathname.toLowerCase();
            const isProfilePath = path.includes("/profiles");

            for (const key of ["XID", "user2ID", "userId"]) {
                const value = url.searchParams.get(key);
                if (/^\d+$/.test(value || "") && (isProfilePath || key !== "XID")) {
                    return Number(value);
                }
            }
        } catch {}

        const explicit = href.match(/[?&](?:XID|user2ID|userId)=(\d+)/i);
        if (explicit && /profiles|user2ID|userId/i.test(href)) return Number(explicit[1]);
        return null;
    }

    function extractPlayerId(anchor) {
        return playerIdFromUrl(anchor?.getAttribute?.("href") || anchor?.href || "");
    }

    function extractPlayerIdFromRow(row) {
        for (const anchor of row.querySelectorAll("a[href]")) {
            const id = extractPlayerId(anchor);
            if (id) return { id, anchor };
        }

        const html = String(row.outerHTML || "");
        const match = html.match(/(?:XID|user2ID|userId)(?:=|%3D|&quot;:\s*&quot;|["']?\s*[:]\s*["']?)(\d+)/i);
        if (match) return { id: Number(match[1]), anchor: null };

        return { id: null, anchor: null };
    }

    function normalizePlayerName(value) {
        return String(value || "")
            .normalize("NFKC")
            .replace(/^view\s+/i, "")
            .replace(/[’']s\s+(?:profile|honor bar).*$/i, "")
            .replace(/\s+(?:profile|honor bar)$/i, "")
            .replace(/^player\s+/i, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    function rowNameCandidates(row) {
        const scope = row.querySelector(".member") || row;
        const values = new Set();
        const add = value => {
            const text = String(value || "").trim();
            if (text && text.length <= 100) values.add(text);
        };

        add(scope.textContent);
        for (const element of scope.querySelectorAll("img[alt], [title], [aria-label], [data-name], [data-username]")) {
            add(element.getAttribute("alt"));
            add(element.getAttribute("title"));
            add(element.getAttribute("aria-label"));
            add(element.getAttribute("data-name"));
            add(element.getAttribute("data-username"));
            add(element.textContent);
        }

        return Array.from(values).map(value => ({ raw: value, normalized: normalizePlayerName(value) }));
    }

    function detectFactionId() {
        const current = String(location.href || "");
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

    async function fetchFactionDirectory() {
        const key = getApiKey();
        if (!key) return null;

        const factionId = detectFactionId();
        const cacheKey = factionId ? String(factionId) : "self";
        const cached = factionDirectoryCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) return cached.value;

        const path = factionId ? `/faction/${factionId}` : "/faction/";
        const query = new URLSearchParams({
            selections: "basic",
            key,
            comment: "KingshadeScout"
        });

        try {
            const response = await httpGet(`${TORN_API_BASE}${path}?${query}`);
            if (response.status !== 200) return null;

            const payload = JSON.parse(response.responseText || "null");
            if (!payload || payload.error || !payload.members) return null;

            const byName = new Map();
            const byId = new Map();
            const entries = Array.isArray(payload.members)
                ? payload.members.map(member => [member?.id ?? member?.player_id, member])
                : Object.entries(payload.members);

            for (const [rawId, member] of entries) {
                const id = Number(member?.id ?? member?.player_id ?? rawId);
                const name = String(member?.name || member?.player_name || "").trim();
                if (!id || !name) continue;

                const normalized = normalizePlayerName(name);
                if (!normalized) continue;

                byId.set(id, { id, name });
                const existing = byName.get(normalized);
                if (!existing) byName.set(normalized, { id, name, ambiguous: false });
                else if (existing.id !== id) byName.set(normalized, { id: null, name, ambiguous: true });
            }

            const value = { factionId, byName, byId };
            factionDirectoryCache.set(cacheKey, { expires: Date.now() + FACTION_DIRECTORY_MS, value });
            return value;
        } catch {
            return null;
        }
    }

    function matchRowByName(row, directory) {
        if (!directory?.byName?.size) return null;
        const candidates = rowNameCandidates(row);

        for (const candidate of candidates) {
            const exact = directory.byName.get(candidate.normalized);
            if (exact && !exact.ambiguous && exact.id) return exact;
        }

        for (const candidate of candidates) {
            if (!candidate.normalized) continue;
            const matches = [];
            for (const [normalized, member] of directory.byName) {
                if (member.ambiguous || !member.id || normalized.length < 4) continue;
                if (candidate.normalized.includes(normalized)) matches.push(member);
            }
            if (matches.length === 1) return matches[0];
        }

        return null;
    }

    async function findRows() {
        const map = new Map();
        if (!/\/factions\.php\/?$/i.test(location.pathname)) {
            return { rows: map, memberLists: 0, candidateRows: 0, directIds: 0, nameIds: 0 };
        }

        const memberLists = Array.from(document.querySelectorAll(".members-list"));
        const candidates = [];

        for (const membersList of memberLists) {
            for (const row of membersList.querySelectorAll(".table-body > .table-row, .enemy, .your")) {
                if (!candidates.includes(row)) candidates.push(row);
            }
        }

        let directIds = 0;
        let nameIds = 0;
        const unresolved = [];

        for (const row of candidates) {
            const direct = extractPlayerIdFromRow(row);
            if (direct.id && !map.has(direct.id)) {
                const anchor = direct.anchor || row.querySelector(".member a[href], a[href]") || row;
                map.set(direct.id, { id: direct.id, row, anchor });
                directIds++;
            } else {
                unresolved.push(row);
            }
        }

        if (unresolved.length) {
            const directory = await fetchFactionDirectory();
            if (directory) {
                for (const row of unresolved) {
                    const member = matchRowByName(row, directory);
                    if (!member?.id || map.has(member.id)) continue;
                    const anchor = row.querySelector(".member a[href], .member, a[href]") || row;
                    map.set(member.id, { id: member.id, row, anchor, resolvedName: member.name });
                    nameIds++;
                }
            }
        }

        return {
            rows: map,
            memberLists: memberLists.length,
            candidateRows: candidates.length,
            directIds,
            nameIds
        };
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

    function positiveNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : null;
    }

    function resolveEstimate(data) {
        const source = String(data?.source || "");
        const candidate = source && data?.available_estimates
            ? data.available_estimates[source]
            : null;

        return {
            source: source || "bss",
            fairFight: positiveNumber(candidate?.fair_fight) ?? positiveNumber(data?.fair_fight),
            battleStats: positiveNumber(candidate?.bs_estimate) ?? positiveNumber(data?.bs_estimate),
            battleStatsHuman: normalizeEstimateText(candidate?.bs_estimate_human || data?.bs_estimate_human || ""),
            lastUpdated: positiveNumber(candidate?.last_updated) ?? positiveNumber(data?.last_updated)
        };
    }

    function sourceLabel(source) {
        switch (String(source || "").toLowerCase()) {
            case "spies": return "SPY";
            case "premium": return "PREMIUM";
            case "bss": return "BSS";
            case "manual": return "MANUAL";
            case "ff scouter profile": return "PROFILE";
            case "profile header": return "PROFILE";
            default: return String(source || "FFS").toUpperCase();
        }
    }

    function estimateAge(lastUpdated) {
        const timestamp = positiveNumber(lastUpdated);
        if (!timestamp) return { label: "", old: false };

        const ageSeconds = Math.max(0, Date.now() / 1000 - timestamp);
        const old = ageSeconds > OLD_ESTIMATE_SECONDS;

        if (ageSeconds < 24 * 60 * 60) return { label: "today", old };
        const days = Math.max(1, Math.round(ageSeconds / (24 * 60 * 60)));
        return { label: `${days}d old`, old };
    }

    function ensureStyles() {
        document.getElementById("ks6-styles")?.remove();
        const style = document.createElement("style");
        style.id = "ks6-styles";
        style.textContent = `
            .ks6-fab{
                position:fixed;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:0;
                width:52px;height:52px;padding:0;border-radius:50%;
                z-index:2147483645;touch-action:none;user-select:none;overflow:hidden;
                transition:transform .12s ease, box-shadow .12s ease, filter .12s ease
            }
            .ks6-fab:active{transform:scale(.98)}
            .ks6-fab .ks6-fab-label{display:block;line-height:1;pointer-events:none}
            .ks6-fab .ks6-fab-crown-mark{display:none;line-height:1;pointer-events:none}

            .ks6-fab[data-style='simple']{
                border:1px solid #c89d4b;background:radial-gradient(circle at 30% 28%, #3e331e 0%, #201811 62%, #0f0c09 100%)!important;
                color:#f5dd9b!important;font:800 14px/1 Georgia,serif!important;letter-spacing:.4px;text-shadow:0 1px 1px rgba(0,0,0,.65)!important;
                box-shadow:0 4px 12px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,227,160,.25), 0 0 0 2px rgba(120,84,26,.34)
            }
            .ks6-fab[data-style='crest']{
                border:2px solid #d4ab58;background:radial-gradient(circle at 50% 22%, #6a4f19 0%, #3d2a11 30%, #19120d 68%, #0d0907 100%)!important;
                color:#f8e1a6!important;font:800 15px/1 Georgia,serif!important;letter-spacing:.5px;text-shadow:0 1px 1px rgba(0,0,0,.75), 0 0 8px rgba(212,171,88,.2)!important;
                box-shadow:0 6px 14px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,235,180,.32), inset 0 -8px 14px rgba(0,0,0,.35), 0 0 0 1px rgba(92,64,20,.55)
            }
            .ks6-fab[data-style='royal']{
                border:2px solid #d9b05c;background:radial-gradient(circle at 50% 18%, #7a5a1b 0%, #442f12 32%, #1a1410 70%, #0d0907 100%)!important;
                color:#f8e8ba!important;font:800 14px/1 Georgia,serif!important;letter-spacing:.45px;text-shadow:0 1px 1px rgba(0,0,0,.75)!important;
                box-shadow:0 6px 14px rgba(0,0,0,.52), inset 0 1px 0 rgba(255,236,192,.35), inset 0 -8px 14px rgba(0,0,0,.35), 0 0 0 1px rgba(92,64,20,.55)
            }
            .ks6-fab[data-style='royal'] .ks6-fab-crown-mark{
                display:block;margin-top:2px;margin-bottom:1px;font-size:9px;color:#f4d17a;text-shadow:0 0 6px rgba(244,209,122,.3)
            }
            .ks6-fab[data-style='royal'] .ks6-fab-label{font-size:13px}

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
            .ks6-panel input[type=password],.ks6-panel select{
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
                --ks6-row-tint:rgba(102,102,102,.18);
                position:relative!important
            }
            .ks6-colored-row,
            .ks6-colored-row > *,
            .ks6-colored-row [class*='table-cell'],
            .ks6-colored-row [class*='cell___']{
                background-color:var(--ks6-row-tint)!important
            }
            .ks6-name-host{position:relative!important;overflow:visible!important}
            .ks6-badge{
                position:absolute!important;right:2px;bottom:1px;display:inline-flex!important;
                align-items:center;justify-content:center;max-width:98px;padding:1px 4px;
                border:1px solid var(--ks6-row-color,#666)!important;border-radius:3px;
                background:rgba(0,0,0,.78)!important;color:#fff!important;
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
            entry.anchor?.closest?.(".honor-text-wrap") ||
            entry.anchor?.parentElement ||
            entry.row.querySelector(".member") ||
            entry.row;

        host?.classList.add("ks6-name-host");
        return host;
    }

    function getPlayerDisplayName(entry) {
        const candidates = [
            entry.resolvedName,
            normalizedText(entry.anchor),
            entry.anchor?.getAttribute?.("title"),
            entry.anchor?.getAttribute?.("aria-label"),
            entry.anchor?.querySelector?.("img[alt]")?.getAttribute("alt"),
            entry.anchor?.querySelector?.("img[title]")?.getAttribute("title")
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
        const resolved = resolveEstimate(ffsData);
        const profileEstimate = getProfileEstimate(entry.id);
        const bs = compactParts(manual?.battleStats || resolved.battleStats);
        const playerName = getPlayerDisplayName(entry);
        const age = estimateAge(resolved.lastUpdated);
        const source = sourceLabel(resolved.source);

        const ffSummary = resolved.fairFight
            ? `${resolved.fairFight.toFixed(2)} · ${source}${age.label ? ` · ${age.label}` : ""}`
            : "No FF score";

        const estimateHuman =
            resolved.battleStatsHuman ||
            (resolved.battleStats ? formatCompact(resolved.battleStats) : "") ||
            profileEstimate?.human ||
            "No estimate";

        const estimateSource = resolved.battleStats || resolved.battleStatsHuman
            ? source
            : profileEstimate
                ? sourceLabel(profileEstimate.source)
                : "";

        const modal = document.createElement("div");
        modal.className = "ks6-modal";
        modal.innerHTML = `
            <div class="ks6-card">
                <div class="ks6-card-head">
                    <strong>${escapeHtml(playerName)}</strong>
                    <button type="button" class="ks6-close" data-x="close" aria-label="Close">×</button>
                </div>

                <div style="color:#c9cbd0;margin-top:5px">
                    FF Scouter: ${escapeHtml(ffSummary)}
                </div>
                <div style="color:#c9cbd0;margin-top:3px">
                    Estimated stats: ${escapeHtml(estimateHuman)}${estimateSource ? ` · ${escapeHtml(estimateSource)}` : ""}
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
        row.classList.remove("ks6-colored-row");
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
        const resolved = resolveEstimate(data);
        const profileEstimate = getProfileEstimate(entry.id);
        const manualFF = positiveNumber(manual?.ff);
        const activeFF = manualFF ?? resolved.fairFight;
        const hasManualFF = Boolean(manualFF);

        const apiEstimateHuman =
            resolved.battleStatsHuman ||
            (resolved.battleStats ? formatCompact(resolved.battleStats) : "");
        const manualEstimateHuman = manual?.battleStats ? formatCompact(manual.battleStats) : "";
        const fallbackEstimate =
            manualEstimateHuman ||
            apiEstimateHuman ||
            profileEstimate?.human ||
            "";

        let color = "#666";
        let tint = "rgba(102,102,102,.10)";
        let title = "";
        let colorRow = false;

        if (activeFF) {
            const style = ffStyle(activeFF);
            const age = estimateAge(hasManualFF ? null : resolved.lastUpdated);
            color = style.color;
            tint = hexToRgba(style.color, 0.34);
            colorRow = true;
            badge.textContent = hasManualFF
                ? `MAN ${activeFF.toFixed(2)}`
                : `FF ${activeFF.toFixed(2)}${age.old ? "?" : ""}`;

            title = [
                `${hasManualFF ? "Manual" : "FF Scouter"} FF ${activeFF.toFixed(2)}`,
                hasManualFF ? "MANUAL" : sourceLabel(resolved.source),
                age.label,
                fallbackEstimate ? `Estimated stats ${fallbackEstimate}` : "",
                manual?.note || ""
            ].filter(Boolean).join(" · ");
        } else if (fallbackEstimate) {
            // A real estimate is useful, but it is not a Fair Fight score.
            // Keep the row neutral so it cannot be mistaken for the FF color scale.
            badge.textContent = `EST ${fallbackEstimate}`;
            color = "#7d8c99";
            tint = "rgba(125,140,153,.14)";
            colorRow = true;
            title = [
                `Estimated stats ${fallbackEstimate}`,
                manualEstimateHuman ? "MANUAL" : apiEstimateHuman ? sourceLabel(resolved.source) : profileEstimate ? sourceLabel(profileEstimate.source) : "",
                manual?.note || ""
            ].filter(Boolean).join(" · ");
        } else {
            if (!settings.showUnknown) {
                clearRowVisuals(entry.row);
                return true;
            }
            badge.textContent = "N/A";
            title = manual?.note || "No FF score or estimated stats";
        }

        if (colorRow) {
            entry.row.classList.add("ks6-colored-row");
            entry.row.style.setProperty("--ks6-row-color", color);
            entry.row.style.setProperty("--ks6-row-tint", tint);
        } else {
            entry.row.classList.remove("ks6-colored-row");
            entry.row.style.removeProperty("--ks6-row-tint");
        }

        host.style.setProperty("--ks6-row-color", color);
        badge.title = title;
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

    function applyButtonTheme(button, theme = settings.buttonStyle || "crest") {
        if (!button) return;

        const style = ["simple", "crest", "royal"].includes(theme) ? theme : "crest";
        button.dataset.style = style;
        button.innerHTML = style === "royal"
            ? '<span class="ks6-fab-crown-mark">♛</span><span class="ks6-fab-label">KS</span>'
            : '<span class="ks6-fab-label">KS</span>';
    }

    function ensurePanel() {
        if (!/\/factions\.php\/?$/i.test(location.pathname)) return;
        if (document.querySelector(".ks6-fab")) return;

        const button = document.createElement("button");
        button.className = "ks6-fab";
        button.title = NAME;
        applyButtonTheme(button);

        const pos = buttonPosition();
        button.style.left = `${pos.x}px`;
        button.style.top = `${pos.y}px`;

        const panel = document.createElement("div");
        panel.className = "ks6-panel";
        panel.hidden = true;
        panel.innerHTML = `
            <div class="ks6-panel-head">
                <strong>${NAME} ${VERSION}</strong>
                <button type="button" class="ks6-close" data-ksp="close" aria-label="Close">×</button>
            </div>
            <div class="ks6-status" data-ksp="status">Waiting for faction scan…</div>

            <label>FF Scouter API key
                <input data-ksp="key" type="password" value="${escapeHtml(getApiKey())}">
            </label>

            <label>Show players with no FF or estimate
                <input data-ksp="unknown" type="checkbox" ${settings.showUnknown ? "checked" : ""}>
            </label>

            <label>KS button style
                <select data-ksp="style">
                    <option value="simple" ${settings.buttonStyle === "simple" ? "selected" : ""}>Style A · Simple gold</option>
                    <option value="crest" ${settings.buttonStyle === "crest" ? "selected" : ""}>Style B · Crest</option>
                    <option value="royal" ${settings.buttonStyle === "royal" ? "selected" : ""}>Style C · Crown</option>
                </select>
            </label>

            <div class="ks6-help">
                FF scores use the full FF color scale. When no FF score exists, a verified battle-stat estimate is shown as EST on a neutral row. Tap any label for details or manual values.
            </div>

            <button type="button" data-ksp="rescan">Rescan faction member list</button>
            <button type="button" data-ksp="reset">Reset KS button position</button>
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

        const persistPanelSettings = () => {
            const previousKey = getApiKey();
            const previousUnknown = settings.showUnknown;
            const previousStyle = settings.buttonStyle || "crest";

            const nextKey = panel.querySelector('[data-ksp="key"]').value.trim();
            const nextUnknown = panel.querySelector('[data-ksp="unknown"]').checked;
            const nextStyle = panel.querySelector('[data-ksp="style"]').value || "crest";

            setApiKey(nextKey);
            if (previousKey !== nextKey) factionDirectoryCache.clear();
            settings.showUnknown = nextUnknown;
            settings.buttonStyle = ["simple", "crest", "royal"].includes(nextStyle) ? nextStyle : "crest";
            saveSettings();
            applyButtonTheme(button, settings.buttonStyle);

            return previousKey !== nextKey || previousUnknown !== nextUnknown || previousStyle !== settings.buttonStyle;
        };

        const closePanel = () => {
            const changed = persistPanelSettings();
            panel.hidden = true;
            if (changed) {
                clearRendered();
                scheduleScan(0);
            }
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

        panel.querySelector('[data-ksp="style"]').onchange = event => {
            applyButtonTheme(button, event.target.value || "crest");
        };

        panel.querySelector('[data-ksp="close"]').onclick = closePanel;

        panel.querySelector('[data-ksp="rescan"]').onclick = () => {
            persistPanelSettings();
            memoryCache.clear();
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
        if (scanRunning) {
            rescanRequested = true;
            return;
        }
        scanRunning = true;

        try {
            captureProfileEstimate();

            if (!/\/factions\.php\/?$/i.test(location.pathname)) {
                clearRendered();
                removePanel();
                return;
            }

            ensurePanel();

            const result = await findRows();
            const rows = result.rows;

            if (!result.memberLists) {
                updatePanelStatus("Torn member-list container not loaded yet.");
            } else {
                updatePanelStatus(`${rows.size}/${result.candidateRows} members mapped · ${result.directIds} XID · ${result.nameIds} name`);
            }

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
                    const rendered = render(entry, data.get(entry.id));
                    if (rendered) entry.row.dataset.ks6Applied = VERSION;
                    else entry.row.removeAttribute("data-ks6-applied");
                    entry.row.removeAttribute("data-ks6-pending");
                }
                updatePanelStatus(`${rows.size}/${result.candidateRows} members · FF/EST data loaded`);
            } catch (error) {
                for (const entry of fresh) {
                    entry.row.removeAttribute("data-ks6-applied");
                    entry.row.removeAttribute("data-ks6-pending");
                }
                updatePanelStatus(`${rows.size} member rows · FF request failed`);
                showToast(error instanceof Error ? error.message : String(error));
            }
        } finally {
            scanRunning = false;
            if (rescanRequested) {
                rescanRequested = false;
                scheduleScan(80);
            }
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
