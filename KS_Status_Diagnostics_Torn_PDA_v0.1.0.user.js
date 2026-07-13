// ==UserScript==
// @name         KS Status Diagnostics for Torn PDA
// @namespace    https://kingshade.tools/
// @version      0.1.0
// @description  Temporary read-only diagnostic tool for verifying Torn faction status and end-time fields.
// @author       Kingshade
// @match        https://www.torn.com/*
// @connect      api.torn.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==
//
// Temporary diagnostic companion for Kingshade Scout PDA and KS War Tools.
// - Makes one official Torn API faction/basic request only when "Run diagnostic" is pressed.
// - Reads the API key already stored by Kingshade Scout PDA.
// - Never includes the API key, cookies, authorization headers, or other secrets in the report.
// - Does not click, attack, travel, buy, sort, filter, or alter Torn faction rows.
//

(() => {
    "use strict";

    const INSTANCE_KEY = "__ksStatusDiagnosticsActive";
    if (window[INSTANCE_KEY]) {
        try { window[INSTANCE_KEY].destroy?.(); } catch {}
    }

    const VERSION = "0.1.0";
    const SCOUT_KEY_STORAGE = "kingshade-scout:ff-api-key";
    const API_BASE = "https://api.torn.com";
    const ROOT_ID = "ks-status-diagnostics-root";
    const STYLE_ID = "ks-status-diagnostics-styles";

    let destroyed = false;

    function isFactionPage() {
        return /\/factions\.php\/?$/i.test(location.pathname);
    }

    function getScoutApiKey() {
        try {
            return String(localStorage.getItem(SCOUT_KEY_STORAGE) || "").trim();
        } catch {
            return "";
        }
    }

    function normalizeResponse(response) {
        if (!response) return { status: 0, responseText: "" };
        if (typeof response === "string") return { status: 200, responseText: response };
        return {
            status: Number(response.status ?? response.statusCode ?? 200),
            responseText: String(response.responseText ?? response.body ?? response.response ?? "")
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
                    onerror: error => reject(error instanceof Error ? error : new Error("Network request failed")),
                    ontimeout: () => reject(new Error("Request timed out"))
                });
            });
        }

        const response = await fetch(url, { credentials: "omit" });
        return { status: response.status, responseText: await response.text() };
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

    function extractPlayerId(rawHref) {
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

    function sensitiveKey(key) {
        return /(?:^|_)(?:key|api[_-]?key|token|secret|password|cookie|authorization|session)(?:$|_)/i.test(String(key || ""));
    }

    function sanitize(value, depth = 0, seen = new WeakSet()) {
        if (depth > 10) return "[max depth]";
        if (value === null || value === undefined) return value;

        const type = typeof value;
        if (type === "string" || type === "number" || type === "boolean") return value;
        if (type !== "object") return String(value);

        if (seen.has(value)) return "[circular]";
        seen.add(value);

        if (Array.isArray(value)) {
            return value.slice(0, 250).map(item => sanitize(item, depth + 1, seen));
        }

        const output = {};
        for (const [key, item] of Object.entries(value)) {
            if (sensitiveKey(key)) {
                output[key] = "[removed]";
                continue;
            }
            output[key] = sanitize(item, depth + 1, seen);
        }
        return output;
    }

    function normalizeText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function safeClassName(element) {
        if (!element) return "";
        if (typeof element.className === "string") return element.className;
        return String(element.getAttribute?.("class") || "");
    }

    function collectElementAttributes(element) {
        const attrs = {};
        for (const attribute of Array.from(element?.attributes || [])) {
            const name = String(attribute.name || "");
            if (
                name === "title" ||
                name === "aria-label" ||
                name === "datetime" ||
                name === "href" ||
                name.startsWith("data-")
            ) {
                const value = String(attribute.value || "");
                attrs[name] = name === "href"
                    ? value.replace(/([?&](?:key|api_key|token)=)[^&#]+/gi, "$1[removed]")
                    : value;
            }
        }
        return attrs;
    }

    function elementLooksTimeRelevant(element) {
        const className = safeClassName(element);
        const id = String(element?.id || "");
        const text = normalizeText(element?.textContent || "");
        const attrNames = Array.from(element?.attributes || []).map(attr => attr.name).join(" ");

        return /status|time|timer|count|hospital|travel|abroad|jail|until|end/i.test(
            `${className} ${id} ${attrNames} ${text}`
        );
    }

    function collectRowDiagnostics(row, index) {
        const links = Array.from(row.querySelectorAll("a[href]")).map(anchor => ({
            href: String(anchor.getAttribute("href") || "").replace(/([?&](?:key|api_key|token)=)[^&#]+/gi, "$1[removed]"),
            playerId: extractPlayerId(anchor.getAttribute("href") || anchor.href),
            text: normalizeText(anchor.textContent)
        })).filter(link => link.playerId || link.text);

        const relevantElements = [];
        const all = [row, ...Array.from(row.querySelectorAll("*"))];
        for (const element of all) {
            if (!elementLooksTimeRelevant(element)) continue;
            relevantElements.push({
                tag: String(element.tagName || "").toLowerCase(),
                className: safeClassName(element),
                id: String(element.id || ""),
                text: normalizeText(element.textContent).slice(0, 500),
                attributes: collectElementAttributes(element)
            });
            if (relevantElements.length >= 60) break;
        }

        return {
            rowIndex: index,
            rowClassName: safeClassName(row),
            rowText: normalizeText(row.textContent).slice(0, 1200),
            rowAttributes: collectElementAttributes(row),
            playerLinks: links,
            relevantElements
        };
    }

    function collectVisibleRows() {
        const selectors = [
            ".members-list .table-body > .table-row",
            ".members-list .enemy",
            ".members-list .your"
        ];

        const rows = [];
        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(row => {
                if (!rows.includes(row)) rows.push(row);
            });
        }

        return rows.slice(0, 150).map((row, index) => collectRowDiagnostics(row, index));
    }

    function memberEntries(payload) {
        if (!payload?.members) return [];
        if (Array.isArray(payload.members)) {
            return payload.members.map(member => [member?.id ?? member?.player_id, member]);
        }
        return Object.entries(payload.members);
    }

    function relevantMemberFields(rawId, member) {
        const result = {
            id: Number(member?.id ?? member?.player_id ?? rawId) || rawId,
            name: String(member?.name ?? member?.player_name ?? ""),
            level: member?.level,
            position: member?.position,
            days_in_faction: member?.days_in_faction,
            status: member?.status,
            last_action: member?.last_action
        };

        const relevantKey = /status|state|time|timer|timestamp|until|end|travel|abroad|hospital|jail|federal|cooldown/i;
        for (const [key, value] of Object.entries(member || {})) {
            if (Object.prototype.hasOwnProperty.call(result, key)) continue;
            if (relevantKey.test(key)) result[key] = value;
        }

        return sanitize(result);
    }

    function topLevelWithoutMembers(payload) {
        const result = {};
        for (const [key, value] of Object.entries(payload || {})) {
            if (key === "members") continue;
            result[key] = sanitize(value);
        }
        return result;
    }

    async function buildReport(setStatus) {
        const key = getScoutApiKey();
        if (!key) {
            throw new Error("No API key was found in Kingshade Scout PDA. Open KS and save the key first.");
        }

        const factionId = detectFactionId();
        const path = factionId ? `/faction/${factionId}` : "/faction/";
        const query = new URLSearchParams({
            selections: "basic",
            key,
            comment: "KingshadeStatusDiagnostics"
        });

        setStatus("Requesting fresh faction/basic data from Torn…");
        const response = await httpGet(`${API_BASE}${path}?${query}`);
        if (response.status !== 200) {
            throw new Error(`Torn API returned HTTP ${response.status}.`);
        }

        let payload;
        try {
            payload = JSON.parse(response.responseText || "null");
        } catch {
            throw new Error("Torn API returned data that was not valid JSON.");
        }

        if (!payload) throw new Error("Torn API returned an empty response.");
        if (payload.error) {
            const code = payload.error.code ?? "?";
            const message = payload.error.error ?? payload.error.message ?? "Unknown Torn API error";
            throw new Error(`Torn API error ${code}: ${message}`);
        }

        setStatus("Collecting visible member-row attributes…");
        const members = memberEntries(payload).map(([rawId, member]) => relevantMemberFields(rawId, member));
        const rows = collectVisibleRows();

        const report = {
            reportType: "KS_STATUS_DIAGNOSTICS",
            reportVersion: VERSION,
            generatedAtUtc: new Date().toISOString(),
            page: {
                origin: location.origin,
                pathname: location.pathname,
                searchWithoutSecrets: String(location.search || "").replace(/([?&](?:key|api_key|token)=)[^&#]+/gi, "$1[removed]"),
                hash: String(location.hash || "").slice(0, 1000),
                visibilityState: document.visibilityState
            },
            environment: {
                userAgent: navigator.userAgent,
                language: navigator.language,
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight,
                    devicePixelRatio: window.devicePixelRatio
                },
                scoutDetected: Boolean(window.__kingshadeScoutActive),
                warToolsDetected: Boolean(window.__ksWarToolsActive || window.__kingshadeWarToolsActive)
            },
            request: {
                endpointFamily: "Torn API faction/basic",
                requestedFactionId: factionId,
                httpStatus: response.status,
                apiKeyIncludedInReport: false
            },
            response: {
                topLevelKeys: Object.keys(payload),
                membersContainerType: Array.isArray(payload.members) ? "array" : typeof payload.members,
                memberCount: members.length,
                topLevelWithoutMembers: topLevelWithoutMembers(payload),
                members
            },
            visibleFactionRows: {
                selectorCount: rows.length,
                rows
            }
        };

        return JSON.stringify(report, null, 2);
    }

    async function copyText(text) {
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {}
        }

        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();

        let copied = false;
        try {
            copied = document.execCommand("copy");
        } catch {}
        textarea.remove();
        return copied;
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            #${ROOT_ID}{position:fixed;right:10px;top:78px;z-index:2147483646;font-family:Arial,sans-serif}
            #${ROOT_ID} *{box-sizing:border-box}
            .ksd-open{
                min-width:70px;height:38px;padding:0 10px;border:1px solid #8d7a3d;border-radius:20px;
                background:#241f13!important;color:#f2d77f!important;font:800 12px/36px Arial!important;
                box-shadow:0 3px 12px rgba(0,0,0,.5);text-shadow:none!important
            }
            .ksd-panel{
                position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);
                width:min(94vw,430px);max-height:86vh;overflow:auto;padding:14px;
                border:1px solid #555b62;border-radius:12px;background:#202124!important;color:#fff!important;
                box-shadow:0 8px 30px rgba(0,0,0,.72)
            }
            .ksd-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
            .ksd-head strong{font-size:18px;color:#fff!important}
            .ksd-close{
                width:38px!important;height:38px!important;padding:0!important;border:1px solid #6b7077!important;
                border-radius:50%!important;background:#34383d!important;color:#fff!important;
                font:800 24px/34px Arial!important;text-shadow:none!important
            }
            .ksd-status{
                margin:8px 0;padding:9px;border-radius:6px;background:#303238!important;color:#fff!important;
                font-size:12px;line-height:1.4
            }
            .ksd-help{margin:8px 0;color:#c9cbd0!important;font-size:12px;line-height:1.45}
            .ksd-panel button.ksd-action{
                width:100%;margin-top:9px;padding:11px;border:1px solid #686d73;border-radius:7px;
                background:#3b3f44!important;color:#fff!important;font-weight:800!important;text-shadow:none!important
            }
            .ksd-panel button.ksd-primary{background:#286b3b!important}
            .ksd-panel textarea{
                width:100%;height:230px;margin-top:10px;padding:8px;border:1px solid #777;border-radius:6px;
                background:#111!important;color:#eee!important;font:11px/1.35 monospace!important;resize:vertical
            }
            .ksd-overlay{
                position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2147483645
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function removeUi() {
        document.getElementById(ROOT_ID)?.remove();
        document.querySelector(".ksd-overlay")?.remove();
    }

    function openPanel(root) {
        if (root.querySelector(".ksd-panel")) return;

        const overlay = document.createElement("div");
        overlay.className = "ksd-overlay";

        const panel = document.createElement("div");
        panel.className = "ksd-panel";
        panel.innerHTML = `
            <div class="ksd-head">
                <strong>KS Status Diagnostics ${VERSION}</strong>
                <button type="button" class="ksd-close" aria-label="Close">×</button>
            </div>
            <div class="ksd-status">Ready. Open a faction containing Hospital and Traveling/Abroad members, then run the diagnostic.</div>
            <div class="ksd-help">
                The report contains raw Torn status objects plus status/time-related attributes from the visible member rows.
                API keys, cookies, authorization data, and other secrets are removed.
            </div>
            <button type="button" class="ksd-action ksd-primary" data-action="run">Run diagnostic</button>
            <button type="button" class="ksd-action" data-action="copy" disabled>Copy report</button>
            <textarea readonly spellcheck="false" placeholder="The diagnostic report will appear here."></textarea>
        `;

        const status = panel.querySelector(".ksd-status");
        const runButton = panel.querySelector('[data-action="run"]');
        const copyButton = panel.querySelector('[data-action="copy"]');
        const textarea = panel.querySelector("textarea");

        const close = () => {
            panel.remove();
            overlay.remove();
        };

        panel.querySelector(".ksd-close").onclick = close;
        overlay.onclick = close;

        runButton.onclick = async () => {
            runButton.disabled = true;
            copyButton.disabled = true;
            textarea.value = "";

            try {
                const report = await buildReport(text => { status.textContent = text; });
                textarea.value = report;
                status.textContent = `Report ready · ${report.length.toLocaleString()} characters. Copy it and paste it into the chat.`;
                copyButton.disabled = false;
            } catch (error) {
                status.textContent = error instanceof Error ? error.message : String(error);
            } finally {
                runButton.disabled = false;
            }
        };

        copyButton.onclick = async () => {
            const copied = await copyText(textarea.value);
            status.textContent = copied
                ? "Report copied. Paste it into the chat."
                : "Automatic copy failed. Tap the report, select all, and copy it manually.";
            if (!copied) {
                textarea.focus();
                textarea.select();
            }
        };

        document.body.append(overlay);
        root.appendChild(panel);
    }

    function ensureUi() {
        if (destroyed || !document.body) return;

        if (!isFactionPage()) {
            removeUi();
            return;
        }

        ensureStyles();

        let root = document.getElementById(ROOT_ID);
        if (!root) {
            root = document.createElement("div");
            root.id = ROOT_ID;

            const button = document.createElement("button");
            button.type = "button";
            button.className = "ksd-open";
            button.textContent = "KS DIAG";
            button.onclick = () => openPanel(root);

            root.appendChild(button);
            document.body.appendChild(root);
        }
    }

    function onRouteChange() {
        setTimeout(ensureUi, 150);
    }

    function init() {
        if (!document.body) {
            setTimeout(init, 100);
            return;
        }

        ensureUi();
        window.addEventListener("hashchange", onRouteChange);
        window.addEventListener("popstate", onRouteChange);
        window.navigation?.addEventListener?.("currententrychange", onRouteChange);

        window[INSTANCE_KEY] = {
            destroy() {
                destroyed = true;
                window.removeEventListener("hashchange", onRouteChange);
                window.removeEventListener("popstate", onRouteChange);
                window.navigation?.removeEventListener?.("currententrychange", onRouteChange);
                removeUi();
                document.getElementById(STYLE_ID)?.remove();
            }
        };
    }

    init();
})();
