// ==UserScript==
// @name         KS Torn War Dibs
// @namespace    kingshade.torn
// @version      1.5.133
// @downloadURL  https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_Torn_War_Dibs.user.js
// @updateURL    https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_Torn_War_Dibs.user.js
// @description  Shared Ranked War DIBS with live Hospital countdown, FF 2.00-5.00 gating, Est/FF display and synchronized claims.
// @author       Kingshade
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @connect      ffscouter.com
// @connect      api.torn.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * KS Torn War Dibs v1.5.133 PATCH RELEASE
 * FF / Est separator, Hospital countdown, FF 2.00-5.00 gate and shared DIBS retained.
 * Country eligibility remains internal; country labels are not shown in DIBS buttons.
 */

(() => {
  "use strict";

  const SCRIPT = Object.freeze({
    name: "KS Torn War Dibs",
    version: "1.5.133",
    instanceKey: "__ksTornWarDibsV1517",
    rowHostPrefix: "ks-twd-v1517-row-",
    panelId: "ks-twd-v1517-panel",
    headerLabelAttr: "data-ks-twd-v1511-header",
    hiddenAttr: "data-ks-twd-v1517-hidden",
    layoutStyleId: "ks-twd-v1517-layout-style",
    layoutRootAttr: "data-ks-twd-v1517-layout",
    estValueAttr: "data-ks-twd-v1517-est",
    ffGaugeAttr: "data-ks-twd-v1517-ff-gauge",
    ffValueAttr: "data-ks-twd-v1563-ff-value",
    ffPlayerAttr: "data-ks-twd-v1567-player-id",
    dibsOverlayRowAttr: "data-ks-twd-v1538-dibs-overlay-row",
    ownClaimStorageKey: "ks_torn_war_dibs_bridge_own_claim_v1",
    secureVaultDbName: "KSTornWarDibsBridgeSecure",
    secureVaultStoreName: "vault",
    secureVaultCryptoKeyId: "sharedApiCryptoKey",
    secureVaultCipherId: "sharedApiCipher",
    tornApiCipherId: "tornApiCipherV1",
    ffscouterOrigin: "https://ffscouter.com",
    ffscouterWarRoomUrl: "https://ffscouter.com/war-room",
    ffscouterTermsUrl: "https://ffscouter.com/",
    ffscouterPrivacyUrl: "https://ffscouter.com/privacy",
    tornApiOrigin: "https://api.torn.com",
    tornApiPath: "/v2/faction/50271",
    tornKeyInfoPath: "/v2/key/info",
    tornCustomKeyUrl: "https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=KS%20Torn%20War%20Dibs&faction=members&user=basic"
  });

  const CONFIG = Object.freeze({
    gateSeconds: 120,
    minFairFight: 2.0,
    maxFairFight: 5.0,
    fairFightRefreshMs: 60000,
    fairFightMaxAgeMs: 360000,
    fairFightErrorBackoffMs: 60000,
    fairFightTransportRecoveryMs: 1800,
    fairFightInitialRequestTimeoutMs: 6000,
    fairFightInitialTransportRetryAttempts: 1,
    fairFightMaxTargets: 205,
    tornStatusPollMs: 10000,
    tornStatusMaxAgeMs: 30000,
    tornStatusErrorBackoffMs: 15000,
    tornTransportRetryDelayMs: 450,
    tornTransportRetryAttempts: 2,
    tornTransportOfflineThreshold: 2,
    tornTransportRecoveryDelayMs: 1800,
    tornClockMaxSamples: 5,
    rowRefreshMs: 1000,
    sharedPollMs: 2500,
    sharedTransportRetryDelayMs: 450,
    sharedTransportRetryAttempts: 2,
    sharedTransportOfflineThreshold: 2,
    mountPrimeDelayMs: 250,
    mountPrimeRetryMs: 400,
    mountPrimeMaxAttempts: 10,
    routeHeartbeatMs: 1000,
    directInteractionIdleMs: 30000,
    requestTimeoutMs: 15000,
    ownClaimMissingReadThreshold: 2,
    ownClaimMissingGraceMs: 500,
    maxHospitalSeconds: 172800
  });

  const TARGET_STATE = Object.freeze({
    CLAIMED: "claimed",
    BLOCKED: "blocked",
    UNAVAILABLE: "unavailable",
    UNKNOWN: "unknown",
    LOCKED: "locked",
    READY: "ready"
  });

  const RW_PHASE = Object.freeze({
    UNKNOWN: "unknown",
    PREWAR: "prewar",
    LIVE: "live"
  });

  const CLAIM_FLOW_STATE = Object.freeze({
    IDLE: "idle",
    CLAIMING: "claiming",
    RELEASING: "releasing",
    CLEANUP_REQUIRED: "cleanup-required"
  });

  const HIT_API = Object.freeze({
    claims: "/api/v1/hit-calling/claims",
    claim: "/api/v1/hit-calling/claim",
    unclaim: "/api/v1/hit-calling/unclaim"
  });

  const STATS_API = Object.freeze({ getStats: "/api/v1/get-stats" });

  if (window[SCRIPT.instanceKey]) return;
  window[SCRIPT.instanceKey] = true;

  let destroyed = false;
  let runtimeActive = false;
  let bridgeMounted = false;
  let runtimeGeneration = 0;
  let lastTrustedInteractionAt = 0;
  let windowFocused = false;

  let rowRefreshTimer = null;
  let sharedPollTimer = null;
  let fairFightTimer = null;
  let fairFightRetryTimer = null;
  let tornStatusTimer = null;
  let routeHeartbeatTimer = null;
  let sharedRetryTimer = null;
  let tornRetryTimer = null;
  let mountPrimeTimer = null;
  let bodyObserver = null;
  let observerScanQueued = false;

  let sharedApiKey = "";
  let storedTornApiKey = "";
  let pdaTornApiKeyRejected = false;
  let sharedSyncing = false;
  let sharedWriteBusy = false;
  let sharedBackoffUntil = 0;
  let sharedTransportFailureStreak = 0;
  let sharedClaims = new Map();
  let fairFightStats = new Map();
  let fairFightSyncing = false;
  let fairFightLastFetchAt = 0;
  let fairFightBackoffUntil = 0;
  let tornStatusSyncing = false;
  let tornStatusBackoffUntil = 0;
  let selfPlayerId = "";
  let selfPlayerName = "";
  let selfIdentitySyncing = false;
  let tornUserBasicCapability = "unknown"; // unknown | supported | unsupported
  let selfIdentityLastAttemptAt = 0;
  let apiKeyStorageReady = false;
  let tornStatusLastFetchAt = 0;
  let tornTransportFailureStreak = 0;
  let tornMemberStatus = new Map();
  let ownLocationState = { country: "", traveling: false, checkedAt: 0 };
  const publicBasicStatusCache = new Map();
  const publicBasicStatusPending = new Set();
  let lastPublicBasicFetchAt = 0;
  let lastObservedRwStartAtSeconds = 0;
  let rwLiveConfirmSince = 0;
  let tornClockOffsetsMs = [];
  let pendingTargetId = "";
  let ownClaimMissingReads = 0;
  let ownClaimLastConfirmedAt = 0;
  let claimFlowState = CLAIM_FLOW_STATE.IDLE;
  let fairFightEverSucceeded = false;

  let sharedStatus = { state: "loading-key", message: "Shared: loading saved key…", count: 0 };
  let tornStatusState = { state: "loading-key", message: "Torn: loading key…", count: 0 };

  const hiddenNativeElements = new Map();
  let dibsSlotWidthPx = 0;

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function validTargetId(value) {
    const text = String(value ?? "").trim();
    return /^\d{1,10}$/.test(text) && Number(text) > 0;
  }

  function isValidClaimId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeText(value));
  }

  function validateFfscouterKey(value) {
    const key = normalizeText(value);
    return /^[A-Za-z0-9]{16}$/.test(key) ? key : "";
  }

  function validateTornApiKey(value) {
    const key = normalizeText(value);
    return /^[A-Za-z0-9]{16}$/.test(key) ? key : "";
  }

  function rawInjectedPdaTornApiKey() {
    return "";
  }

  function injectedPdaTornApiKey() {
    return pdaTornApiKeyRejected ? "" : rawInjectedPdaTornApiKey();
  }

  function effectiveTornApiKey() {
    return injectedPdaTornApiKey() || validateTornApiKey(storedTornApiKey);
  }

  function isPdaTornKeyRejectedError(body) {
    const code = Number(body?.error?.code ?? body?.code);
    const message = normalizeText(body?.error?.error ?? body?.error ?? "");
    return code === 2 || /^incorrect key$/i.test(message);
  }

  function nowMs() { return Date.now(); }
  function nowSeconds() { return Math.floor(nowMs() / 1000); }
  function wait(ms) { return new Promise(resolve => window.setTimeout(resolve, ms)); }

  function median(values) {
    const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!nums.length) return null;
    const middle = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[middle] : (nums[middle - 1] + nums[middle]) / 2;
  }

  function getTornNowMs() {
    const offset = median(tornClockOffsetsMs);
    if (Number.isFinite(offset)) return nowMs() + offset;
    if (typeof window.getCurrentTimestamp === "function") {
      try {
        const value = window.getCurrentTimestamp();
        if (Number.isFinite(value)) return value;
      } catch {}
    }
    return nowMs();
  }

  function formatCountdown(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function isPageVisible() {
    return !document.hidden && document.visibilityState === "visible";
  }

  function hasRecentTrustedInteraction() {
    return nowMs() - lastTrustedInteractionAt <= CONFIG.directInteractionIdleMs;
  }

  function initialFocusState() {
    if (!isPageVisible()) return false;
    try { if (typeof document.hasFocus === "function" && document.hasFocus()) return true; } catch {}
    try { return !!window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches; } catch { return false; }
  }

  function isRuntimeEligible() {
    return !destroyed && isPageVisible() && windowFocused && hasRecentTrustedInteraction();
  }

  function isWarPanelPresent() {
    return !!document.getElementById("faction_war_list_id");
  }

  function registerTrustedInteraction() {
    lastTrustedInteractionAt = nowMs();
    if (!runtimeActive && isPageVisible() && windowFocused && isWarPanelPresent()) resumeRuntime();
  }

  // ---------------------------------------------------------------------------
  // Own claim persistence.
  // ---------------------------------------------------------------------------

  function sanitizeOwnClaim(raw) {
    const claimId = normalizeText(raw?.claimId);
    const targetId = String(raw?.targetId ?? "").trim();
    const claimerPlayerId = String(raw?.claimerPlayerId ?? "").trim();
    const claimerName = normalizeText(raw?.claimerName) || "You";
    const expiresAt = Number(raw?.expiresAt);
    const cleanupRequired = raw?.cleanupRequired === true;
    const createdLocalAt = Number(raw?.createdLocalAt) || 0;
    if (!isValidClaimId(claimId) || !validTargetId(targetId)) return null;
    if (claimerPlayerId && !/^\d+$/.test(claimerPlayerId)) return null;
    if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds()) return null;
    return { claimId, targetId, claimerPlayerId, claimerName, expiresAt, cleanupRequired, createdLocalAt };
  }

  function loadOwnClaim() {
    try {
      const raw = localStorage.getItem(SCRIPT.ownClaimStorageKey);
      if (!raw) return null;
      const claim = sanitizeOwnClaim(JSON.parse(raw));
      if (!claim) localStorage.removeItem(SCRIPT.ownClaimStorageKey);
      return claim;
    } catch { return null; }
  }

  let ownSharedClaim = loadOwnClaim();

  function saveOwnClaim(value) {
    ownSharedClaim = value ? sanitizeOwnClaim(value) : null;
    try {
      if (ownSharedClaim) localStorage.setItem(SCRIPT.ownClaimStorageKey, JSON.stringify(ownSharedClaim));
      else localStorage.removeItem(SCRIPT.ownClaimStorageKey);
    } catch {}
  }

  function currentOwnClaim() {
    if (!ownSharedClaim) return null;
    if (Number(ownSharedClaim.expiresAt) <= nowSeconds()) {
      saveOwnClaim(null);
      ownClaimMissingReads = 0;
      ownClaimLastConfirmedAt = 0;
      return null;
    }
    return ownSharedClaim;
  }

  // ---------------------------------------------------------------------------
  // Secure key vault
  // ---------------------------------------------------------------------------

  function openSecureVault() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window) || !window.crypto?.subtle) return reject(new Error("Secure browser storage unavailable"));
      const request = indexedDB.open(SCRIPT.secureVaultDbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SCRIPT.secureVaultStoreName)) request.result.createObjectStore(SCRIPT.secureVaultStoreName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Secure storage open failed"));
      request.onblocked = () => reject(new Error("Secure storage upgrade blocked"));
    });
  }

  function vaultGet(db, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SCRIPT.secureVaultStoreName, "readonly");
      const req = tx.objectStore(SCRIPT.secureVaultStoreName).get(id);
      let value;
      req.onsuccess = () => { value = req.result; };
      req.onerror = () => reject(req.error || new Error("Secure storage read failed"));
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error || new Error("Secure storage aborted"));
    });
  }

  function vaultPut(db, id, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SCRIPT.secureVaultStoreName, "readwrite");
      try { tx.objectStore(SCRIPT.secureVaultStoreName).put(value, id); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("Secure storage write failed"));
      tx.onabort = () => reject(tx.error || new Error("Secure storage aborted"));
    });
  }

  function vaultDelete(db, ids) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SCRIPT.secureVaultStoreName, "readwrite");
      const store = tx.objectStore(SCRIPT.secureVaultStoreName);
      try { for (const id of (Array.isArray(ids) ? ids : [ids])) store.delete(id); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("Secure storage delete failed"));
      tx.onabort = () => reject(tx.error || new Error("Secure storage aborted"));
    });
  }

  async function getOrCreateVaultCryptoKey(db) {
    const existing = await vaultGet(db, SCRIPT.secureVaultCryptoKeyId);
    if (typeof CryptoKey !== "undefined" && existing instanceof CryptoKey) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await vaultPut(db, SCRIPT.secureVaultCryptoKeyId, key);
    return key;
  }

  async function saveCipher(id, value) {
    const db = await openSecureVault();
    try {
      const cryptoKey = await getOrCreateVaultCryptoKey(db);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(value);
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext);
      await vaultPut(db, id, { v: 1, iv: Array.from(iv), ciphertext });
      return true;
    } catch { return false; } finally { db.close(); }
  }

  async function loadCipher(id, validator) {
    const db = await openSecureVault();
    try {
      const payload = await vaultGet(db, id);
      const key = await vaultGet(db, SCRIPT.secureVaultCryptoKeyId);
      if (!payload || payload.v !== 1 || !Array.isArray(payload.iv) || !payload.ciphertext) return "";
      if (typeof CryptoKey === "undefined" || !(key instanceof CryptoKey)) return "";
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(payload.iv) }, key, payload.ciphertext);
      return validator(new TextDecoder().decode(plaintext));
    } catch { return ""; } finally { db.close(); }
  }

  async function deleteCipher(id) {
    const db = await openSecureVault();
    try { return await vaultDelete(db, [id]); } catch { return false; } finally { db.close(); }
  }

  const saveSecureApiKey = key => saveCipher(SCRIPT.secureVaultCipherId, validateFfscouterKey(key));
  const loadSecureApiKey = () => loadCipher(SCRIPT.secureVaultCipherId, validateFfscouterKey);
  const deleteSecureApiKey = () => deleteCipher(SCRIPT.secureVaultCipherId);
  const saveSecureTornApiKey = key => saveCipher(SCRIPT.tornApiCipherId, validateTornApiKey(key));
  const loadSecureTornApiKey = () => loadCipher(SCRIPT.tornApiCipherId, validateTornApiKey);
  const deleteSecureTornApiKey = () => deleteCipher(SCRIPT.tornApiCipherId);

  // ---------------------------------------------------------------------------
  // Network transport / explicit allowlists
  // ---------------------------------------------------------------------------

  function gmXhr(options) {
    return new Promise(resolve => {
      let settled = false;
      const startedAt = nowMs();
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve({ ...result, startedAt, endedAt: nowMs() });
      };
      try {
        GM_xmlhttpRequest({
          method: options.method || "GET",
          url: options.url,
          headers: options.headers || {},
          data: options.data,
          timeout: Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : CONFIG.requestTimeoutMs,
          onload: response => finish({ ok: response.status >= 200 && response.status < 300, status: response.status, responseText: response.responseText || "", headers: response.responseHeaders || "" }),
          onerror: () => finish({ ok: false, status: 0, responseText: "", headers: "" }),
          ontimeout: () => finish({ ok: false, status: 0, responseText: "", headers: "" }),
          onabort: () => finish({ ok: false, status: 0, responseText: "", headers: "" })
        });
      } catch { finish({ ok: false, status: 0, responseText: "", headers: "" }); }
    });
  }

  function parseJsonSafe(text) {
    try { return JSON.parse(text || "{}"); } catch { return {}; }
  }

  async function hitApiRequest(path, { method = "GET", body = null } = {}) {
    if (!Object.values(HIT_API).includes(path)) throw new Error("Blocked non-allowlisted FFScouter endpoint");
    if (!sharedApiKey) throw new Error("FFScouter key required");
    const url = new URL(path, SCRIPT.ffscouterOrigin);
    url.searchParams.set("key", sharedApiKey);
    const result = await gmXhr({
      method,
      url: url.toString(),
      headers: body === null ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      data: body === null ? undefined : JSON.stringify(body)
    });
    return { ...result, body: parseJsonSafe(result.responseText) };
  }

  function retryDelayMs(result) {
    const code = Number(result?.body?.code);
    const seconds = Number(result?.body?.retry_after_seconds);
    if (result?.status !== 409 || code !== 24) return 0;
    return Number.isFinite(seconds) ? Math.max(250, Math.min(2500, seconds * 1000)) : 1000;
  }

  async function hitApiWriteWithBusyRetry(path, body) {
    let lastResult = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      lastResult = await hitApiRequest(path, { method: "POST", body });
      if (lastResult.ok) return lastResult;
      const delay = retryDelayMs(lastResult);
      if (!delay || attempt === 1) return lastResult;
      await wait(delay);
    }
    return lastResult;
  }

  async function fairFightStatsRequest(targetIds, { initial = false } = {}) {
    const ids = [...new Set(targetIds.map(String).filter(validTargetId))]
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, CONFIG.fairFightMaxTargets);
    if (!ids.length) return { ok: true, status: 200, body: { stats: [] } };
    const url = new URL(STATS_API.getStats, SCRIPT.ffscouterOrigin);
    url.searchParams.set("key", sharedApiKey);
    url.searchParams.set("targets", ids.join(","));
    const maxAttempts = initial ? CONFIG.fairFightInitialTransportRetryAttempts : CONFIG.sharedTransportRetryAttempts;
    const requestTimeout = initial ? CONFIG.fairFightInitialRequestTimeoutMs : CONFIG.requestTimeoutMs;
    let result = null;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      result = await gmXhr({ method: "GET", url: url.toString(), headers: { Accept: "application/json" }, timeout: requestTimeout });
      if (result.ok || result.status !== 0 || attempt >= maxAttempts) break;
      await wait(CONFIG.sharedTransportRetryDelayMs * (attempt + 1));
    }
    return { ...result, body: parseJsonSafe(result?.responseText) };
  }

  async function tornApiRequest(path, key) {
    const isPublicUserBasic = /^\/v2\/user\/\d+\/basic$/.test(path);
    if (path !== SCRIPT.tornApiPath && path !== SCRIPT.tornKeyInfoPath && !isPublicUserBasic) {
      throw new Error("Blocked non-allowlisted Torn API endpoint");
    }
    const apiKey = validateTornApiKey(key);
    if (!apiKey) return { ok: false, status: 0, body: { error: { error: "API key required" } } };
    const url = new URL(path, SCRIPT.tornApiOrigin);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("comment", "KS_Torn_War_Dibs_v1517");
    if (path === SCRIPT.tornApiPath) url.searchParams.set("selections", "members");
    const result = await gmXhr({ method: "GET", url: url.toString(), headers: { Accept: "application/json" } });
    return { ...result, body: parseJsonSafe(result.responseText) };
  }

  function normalizeSelfIdentity(payload) {
    const info = payload?.info && typeof payload.info === "object" ? payload.info : null;
    const id = String(info?.user?.id ?? "").trim();
    if (!/^\d+$/.test(id)) return null;

    return {
      playerId: id,
      playerName: ""
    };
  }

  async function fetchSelfIdentity({ force = false } = {}) {
    const key = effectiveTornApiKey();
    if (!key || selfIdentitySyncing) return;
    if (!force && selfPlayerId) return;
    if (!force && selfIdentityLastAttemptAt > 0 && nowMs() - selfIdentityLastAttemptAt < 30000) return;

    const generation = runtimeGeneration;
    selfIdentitySyncing = true;
    selfIdentityLastAttemptAt = nowMs();
    try {
      const result = await tornApiRequest(SCRIPT.tornKeyInfoPath, key);
      if (generation !== runtimeGeneration || !runtimeActive || !isRuntimeEligible()) return;
      if (!result?.ok) return;
      const identity = normalizeSelfIdentity(result.body);
      if (!identity) return;
      selfPlayerId = identity.playerId;
      selfPlayerName = identity.playerName;
      void fetchPublicBasicStatus(selfPlayerId);
      reconcileOwnClaimFromShared();
      scanWarRows();
      updatePanel();
    } catch {} finally {
      selfIdentitySyncing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Shared FFScouter queue
  // ---------------------------------------------------------------------------

  function normalizeSharedClaims(payload) {
    const faction = payload?.claims?.faction;
    const result = new Map();
    if (!faction || typeof faction !== "object" || Array.isArray(faction)) return result;
    for (const [rawTargetId, rawQueue] of Object.entries(faction)) {
      const targetId = String(rawTargetId || "").trim();
      if (!validTargetId(targetId) || !Array.isArray(rawQueue) || !rawQueue.length) continue;
      const queue = rawQueue.map((claim, index) => {
        const claimId = normalizeText(claim?.claim_id);
        const claimerId = String(claim?.claimer?.player_id ?? "").trim();
        const claimerName = normalizeText(claim?.claimer?.name);
        const createdAt = Number(claim?.created_at);
        const expiresAt = Number(claim?.expires_at);
        if (!isValidClaimId(claimId) || !/^\d+$/.test(claimerId) || !claimerName || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) return null;
        return { claimId, position: index + 1, createdAt, expiresAt, claimer: { playerId: claimerId, name: claimerName } };
      }).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt || a.position - b.position);
      if (queue.length) result.set(targetId, queue);
    }
    return result;
  }

  function findSharedClaimById(claimId) {
    if (!isValidClaimId(claimId)) return null;
    for (const [targetId, queue] of sharedClaims.entries()) {
      const claim = Array.isArray(queue) ? queue.find(item => item?.claimId === claimId) : null;
      if (claim) return { targetId, claim, queue };
    }
    return null;
  }

  function sharedClaimForTarget(playerId) {
    const queue = sharedClaims.get(String(playerId || ""));
    if (!Array.isArray(queue) || !queue.length) return null;
    const active = queue.filter(claim => claim.expiresAt > nowSeconds());
    return active.length ? { first: active[0], queue: active } : null;
  }

  function upsertImmediateSharedClaim(targetId, claim, position = 1) {
    const id = String(targetId || "");
    const entry = {
      claimId: normalizeText(claim?.claim_id),
      position: Number.isInteger(position) && position > 0 ? position : 1,
      createdAt: Number(claim?.created_at),
      expiresAt: Number(claim?.expires_at),
      claimer: { playerId: String(claim?.claimer?.player_id ?? ""), name: normalizeText(claim?.claimer?.name) }
    };
    if (!validTargetId(id) || !isValidClaimId(entry.claimId) || !/^\d+$/.test(entry.claimer.playerId) || !entry.claimer.name || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.expiresAt)) return;
    const queue = Array.isArray(sharedClaims.get(id)) ? [...sharedClaims.get(id)] : [];
    if (!queue.some(item => item.claimId === entry.claimId)) queue.push(entry);
    queue.sort((a, b) => a.createdAt - b.createdAt || a.position - b.position);
    sharedClaims.set(id, queue);
  }

  function removeImmediateSharedClaim(claimId) {
    if (!isValidClaimId(claimId)) return;
    for (const [targetId, queue] of [...sharedClaims.entries()]) {
      const next = queue.filter(item => item.claimId !== claimId);
      if (next.length) sharedClaims.set(targetId, next); else sharedClaims.delete(targetId);
    }
  }

  function activeSharedClaimsForClaimer(playerId) {
    const id = String(playerId || "").trim();
    if (!/^\d+$/.test(id)) return [];
    const matches = [];
    for (const [targetId, queue] of sharedClaims.entries()) {
      if (!Array.isArray(queue)) continue;
      for (const claim of queue) {
        if (claim?.expiresAt <= nowSeconds()) continue;
        if (String(claim?.claimer?.playerId || "") !== id) continue;
        matches.push({ targetId, claim });
      }
    }
    return matches.sort((a, b) => a.claim.createdAt - b.claim.createdAt || a.targetId.localeCompare(b.targetId));
  }

  function adoptSingleOwnServerClaim() {
    if (currentOwnClaim() || !/^\d+$/.test(selfPlayerId)) return false;
    const matches = activeSharedClaimsForClaimer(selfPlayerId);
    if (matches.length !== 1) return false;
    const { targetId, claim } = matches[0];
    if (!validTargetId(targetId) || !isValidClaimId(claim?.claimId)) return false;
    saveOwnClaim({
      claimId: claim.claimId,
      targetId,
      claimerPlayerId: selfPlayerId,
      claimerName: normalizeText(claim?.claimer?.name) || selfPlayerName || "You",
      expiresAt: claim.expiresAt,
      cleanupRequired: false,
      createdLocalAt: nowMs()
    });
    ownClaimMissingReads = 0;
    ownClaimLastConfirmedAt = nowMs();
    return true;
  }

  function reconcileOwnClaimFromShared() {
    let own = currentOwnClaim();
    if (!own) {
      adoptSingleOwnServerClaim();
      own = currentOwnClaim();
    }
    if (!own) { ownClaimMissingReads = 0; ownClaimLastConfirmedAt = 0; return; }
    const found = findSharedClaimById(own.claimId);
    if (found) {
      ownClaimMissingReads = 0;
      ownClaimLastConfirmedAt = nowMs();
      saveOwnClaim({ ...own, targetId: found.targetId, claimerPlayerId: found.claim.claimer.playerId, claimerName: found.claim.claimer.name, expiresAt: found.claim.expiresAt });
      return;
    }
    ownClaimMissingReads += 1;
    const localAgeMs = Math.max(0, nowMs() - Number(own.createdLocalAt || 0));
    const sinceConfirmedMs = ownClaimLastConfirmedAt > 0 ? nowMs() - ownClaimLastConfirmedAt : localAgeMs;
    if (ownClaimMissingReads >= CONFIG.ownClaimMissingReadThreshold && sinceConfirmedMs >= CONFIG.ownClaimMissingGraceMs && sharedStatus.state === "online") {
      saveOwnClaim(null);
      ownClaimMissingReads = 0;
      ownClaimLastConfirmedAt = 0;
    }
  }

  function setSharedStatus(state, message, count = sharedClaims.size) {
    sharedStatus = { state: String(state || "unknown"), message: normalizeText(message) || "Shared: unknown", count: Number.isInteger(count) && count >= 0 ? count : 0 };
    updatePanel();
  }

  async function fetchSharedClaims() {
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return;
    if (!sharedApiKey || sharedSyncing || nowMs() < sharedBackoffUntil) return;
    const generation = runtimeGeneration;
    sharedSyncing = true;
    setSharedStatus("syncing", sharedTransportFailureStreak > 0 ? "Shared: reconnecting…" : "Shared: syncing…");
    try {
      let result = null;
      for (let attempt = 0; attempt <= CONFIG.sharedTransportRetryAttempts; attempt += 1) {
        result = await hitApiRequest(HIT_API.claims, { method: "GET" });
        if (generation !== runtimeGeneration || !runtimeActive || !isRuntimeEligible() || !isWarPanelPresent()) return;
        if (result.ok || result.status !== 0 || attempt >= CONFIG.sharedTransportRetryAttempts) break;
        await wait(CONFIG.sharedTransportRetryDelayMs * (attempt + 1));
      }
      const body = result?.body || {};
      if (!result?.ok) {
        const retryAfterSeconds = Number(body?.retry_after_seconds);
        if ((result?.status === 429 || result?.status === 409) && Number.isFinite(retryAfterSeconds)) sharedBackoffUntil = nowMs() + Math.max(1, retryAfterSeconds) * 1000;
        if (Number(result?.status) === 0) sharedTransportFailureStreak += 1; else sharedTransportFailureStreak = 0;
        throw new Error(normalizeText(body?.error) || `HTTP ${result?.status ?? 0}`);
      }
      sharedTransportFailureStreak = 0;
      sharedClaims = normalizeSharedClaims(body);
      sharedBackoffUntil = 0;
      setSharedStatus("online", `Shared: online · ${sharedClaims.size} targets`, sharedClaims.size);
      reconcileOwnClaimFromShared();
      scanWarRows();
    } catch (error) {
      if (generation === runtimeGeneration && runtimeActive) setSharedStatus("offline", `Shared: offline · ${normalizeText(error?.message) || "request failed"}`);
    } finally { sharedSyncing = false; }
  }

  // ---------------------------------------------------------------------------
  // FF / Est stats — preserve v1.5.11 initial latency policy
  // ---------------------------------------------------------------------------

  function normalizeFairFightStats(payload, targetIds) {
    const fetchedAt = nowMs();
    const requested = [...new Set(targetIds.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))];
    const requestedSet = new Set(requested);
    const result = new Map();

    const rows = Array.isArray(payload) ? payload
      : Array.isArray(payload?.stats) ? payload.stats
      : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.results) ? payload.results
      : [];

    for (const item of rows) {
      const playerId = Number(item?.player_id);
      if (!Number.isInteger(playerId) || playerId <= 0 || !requestedSet.has(playerId)) continue;

      const fairFight = Number(item?.fair_fight);
      const estimate = Number(item?.bs_estimate);
      const complete = Number.isFinite(fairFight) && fairFight > 0 &&
        Number.isFinite(estimate) && estimate > 0 &&
        Boolean(normalizeText(item?.bs_estimate_human));

      if (!complete) {
        result.set(playerId, { noData: true, playerId, fairFight: null, bsEstimate: null, bsEstimateHuman: "", fetchedAt });
        continue;
      }

      result.set(playerId, {
        noData: false,
        playerId,
        fairFight,
        bsEstimate: estimate,
        bsEstimateHuman: normalizeText(item.bs_estimate_human),
        fetchedAt
      });
    }

    for (const playerId of requested) {
      if (!result.has(playerId)) {
        result.set(playerId, { noData: true, playerId, fairFight: null, bsEstimate: null, bsEstimateHuman: "", fetchedAt });
      }
    }
    return result;
  }

  function scoutStatsForTarget(targetId) {
    const playerId = Number(targetId);
    if (!Number.isInteger(playerId) || playerId <= 0) return null;
    const entry = fairFightStats.get(playerId);
    if (!entry || !Number.isFinite(entry.fetchedAt) || nowMs() - entry.fetchedAt > CONFIG.fairFightMaxAgeMs) return null;
    return entry.noData ? null : entry;
  }

  function fairFightForTarget(targetId) {
    const entry = scoutStatsForTarget(targetId);
    return Number.isFinite(entry?.fairFight) ? Number(entry.fairFight) : null;
  }

  function scheduleFairFightRecoveryRetry() {
    if (fairFightRetryTimer !== null || !sharedApiKey) return;
    const generation = runtimeGeneration;
    fairFightRetryTimer = window.setTimeout(() => {
      fairFightRetryTimer = null;
      if (generation === runtimeGeneration && runtimeActive && isRuntimeEligible() && bridgeMounted && isWarPanelPresent() && sharedApiKey) void fetchFairFightStats({ force: true });
    }, CONFIG.fairFightTransportRecoveryMs);
  }

  async function fetchFairFightStats({ force = false } = {}) {
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return;
    if (!sharedApiKey || fairFightSyncing || nowMs() < fairFightBackoffUntil) return;
    if (!force && fairFightLastFetchAt > 0 && nowMs() - fairFightLastFetchAt < CONFIG.fairFightRefreshMs) return;
    const targetIds = [...new Set(getEnemyRows().map(row => row.id).filter(validTargetId))]
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, CONFIG.fairFightMaxTargets);
    if (!targetIds.length) return;
    const generation = runtimeGeneration;
    fairFightSyncing = true;
    try {
      const initial = !fairFightEverSucceeded;
      const result = await fairFightStatsRequest(targetIds, { initial });
      if (generation !== runtimeGeneration || !runtimeActive || !isRuntimeEligible() || !isWarPanelPresent()) return;
      if (!result.ok) {
        if (result.status === 429) fairFightBackoffUntil = nowMs() + CONFIG.fairFightErrorBackoffMs;
        if (result.status === 0) scheduleFairFightRecoveryRetry();
        throw new Error(normalizeText(result?.body?.error) || `HTTP ${result.status}`);
      }
      fairFightStats = normalizeFairFightStats(result.body, targetIds);
      fairFightLastFetchAt = nowMs();
      fairFightBackoffUntil = 0;
      fairFightEverSucceeded = true;
      if (fairFightRetryTimer !== null) { window.clearTimeout(fairFightRetryTimer); fairFightRetryTimer = null; }
      scanWarRows();
    } catch {} finally { fairFightSyncing = false; }
  }

  // ---------------------------------------------------------------------------
  // Torn member status
  // ---------------------------------------------------------------------------

  function normalizeCountryName(value) {
    const text = normalizeText(value).toLowerCase();
    if (!text) return "";

    const aliases = [
      ["mexico", ["mexico", "mexican"]],
      ["hawaii", ["hawaii", "hawaiian"]],
      ["south africa", ["south africa", "south african"]],
      ["japan", ["japan", "japanese"]],
      ["china", ["china", "chinese"]],
      ["argentina", ["argentina", "argentinian"]],
      ["switzerland", ["switzerland", "swiss"]],
      ["canada", ["canada", "canadian"]],
      ["united kingdom", ["united kingdom", "british"]],
      ["uae", ["uae", "united arab emirates", "emirati"]],
      ["cayman islands", ["cayman islands", "cayman"]],
      ["torn", ["torn city", "torn"]]
    ];

    for (const [canonical, variants] of aliases) {
      if (variants.some(variant => text.includes(variant))) return canonical;
    }
    return "";
  }

  function explicitCountryFromStatusText(status) {
    if (!status || typeof status !== "object") return "";
    const combined = normalizeText([
      status.details,
      status.description
    ].filter(Boolean).join(" "));
    return normalizeCountryName(combined);
  }

  function countryFromStatusText(status) {
    if (!status || typeof status !== "object") return "";

    const combined = normalizeText([
      status.details,
      status.description
    ].filter(Boolean).join(" "));

    const explicit = normalizeCountryName(combined);
    if (explicit) return explicit;

    const state = normalizeText(status.state).toLowerCase();

    // Torn's normal city Hospital/Jail/Okay status has no country adjective.
    // Foreign hospitals expose a country adjective/name in public status text.
    if (state === "hospital" || state === "jail" || state === "okay") return "torn";

    return "";
  }

  function publicBasicCachedStatus(playerId) {
    const id = String(playerId || "");
    const cached = publicBasicStatusCache.get(id);
    if (!cached || cached.expiresAt <= nowMs()) return null;
    return cached.status || null;
  }

  async function fetchPublicBasicStatus(playerId) {
    const id = String(playerId || "").trim();
    if (!validTargetId(id)) return;
    if (!runtimeActive || !isRuntimeEligible()) return;

    const cached = publicBasicStatusCache.get(id);
    if (cached?.expiresAt > nowMs()) return;
    if (publicBasicStatusPending.has(id)) return;

    const waitMs = Math.max(0, 1200 - (nowMs() - lastPublicBasicFetchAt));
    if (waitMs > 0) {
      window.setTimeout(() => void fetchPublicBasicStatus(id), waitMs);
      return;
    }

    const key = effectiveTornApiKey();
    if (!key) return;

    publicBasicStatusPending.add(id);
    lastPublicBasicFetchAt = nowMs();

    try {
      const result = await tornApiRequest(`/v2/user/${id}/basic`, key);
      const body = result?.body || {};
      const status = body?.profile?.status;

      if (!result?.ok || body?.error || !status || typeof status !== "object") {
        publicBasicStatusCache.set(id, { status: null, expiresAt: nowMs() + 10000 });
        return;
      }

      tornUserBasicCapability = "supported";

      publicBasicStatusCache.set(id, {
        status: {
          state: normalizeText(status.state),
          description: normalizeText(status.description),
          details: normalizeText(status.details),
          until: Number(status.until) || 0
        },
        expiresAt: nowMs() + 20000
      });

      if (id === String(selfPlayerId || "")) refreshOwnLocationFromBasic();
      scanWarRows();
      updatePanel();
    } catch {
      publicBasicStatusCache.set(id, { status: null, expiresAt: nowMs() + 10000 });
    } finally {
      publicBasicStatusPending.delete(id);
    }
  }

  function refreshOwnLocationFromBasic() {
    const id = String(selfPlayerId || "");

    // Transient SPA/key-info gaps are not evidence that the previously verified
    // country became unknown. Preserve the last verified state and self-heal.
    if (!validTargetId(id)) {
      if (effectiveTornApiKey() && !selfIdentitySyncing) void fetchSelfIdentity();
      return;
    }

    const status = publicBasicCachedStatus(id);
    if (!status) {
      void fetchPublicBasicStatus(id);
      return;
    }

    const nextCountry = countryFromStatusText(status);
    if (!nextCountry) return;

    const state = normalizeText(status.state).toLowerCase();
    ownLocationState = {
      country: nextCountry,
      traveling: state === "traveling",
      checkedAt: nowMs()
    };
  }

  function targetCountryForEligibility(targetId) {
    const id = String(targetId || "");

    const publicStatus = publicBasicCachedStatus(id);
    if (publicStatus) {
      const country = countryFromStatusText(publicStatus);
      if (country) return country;
    }

    const factionStatus = tornStatusForTarget(id);
    const factionState = normalizeText(factionStatus?.state).toLowerCase();

    // If faction status explicitly names a country (e.g. "Hawaiian hospital"),
    // trust that explicit country even while state=Hospital.
    const explicitFactionCountry = explicitCountryFromStatusText(factionStatus);
    if (explicitFactionCountry) return explicitFactionCountry;

    const factionCountry = countryFromStatusText(factionStatus);
    if (factionCountry && factionState !== "hospital") {
      return factionCountry;
    }

    // Generic Hospital without an explicit country is ambiguous; use public basic.
    if (factionState === "hospital") {
      void fetchPublicBasicStatus(id);
    }

    return publicStatus ? countryFromStatusText(publicStatus) : "";
  }

  function displayCountryName(value) {
    const country = normalizeCountryName(value);
    const labels = {
      "torn": "Torn",
      "uae": "UAE",
      "united kingdom": "UK",
      "cayman islands": "Cayman",
      "south africa": "S. Africa",
      "switzerland": "Swiss",
      "argentina": "Argentina",
      "canada": "Canada",
      "china": "China",
      "japan": "Japan",
      "hawaii": "Hawaii",
      "mexico": "Mexico"
    };
    return labels[country] || (country ? country.toUpperCase() : "?");
  }

  function sameCountryForTarget(targetId, isHospital = false) {
    refreshOwnLocationFromBasic();

    const ownCountry = normalizeCountryName(ownLocationState.country);
    let targetCountry = targetCountryForEligibility(targetId);

    // Enemy RW targets are not necessarily present in our faction-member status map.
    // If the actual RW row says Hospital and country is still unknown, explicitly
    // fetch the target's public basic profile status.
    if (!targetCountry && isHospital) {
      void fetchPublicBasicStatus(targetId);
      const refreshed = publicBasicCachedStatus(targetId);
      if (refreshed) targetCountry = countryFromStatusText(refreshed);
    }

    if (ownLocationState.traveling) {
      return { known: true, same: false, reason: "self-traveling", ownCountry, targetCountry };
    }

    if (!ownCountry || !targetCountry) {
      return { known: false, same: false, reason: "country-unverifiable", ownCountry, targetCountry };
    }

    return {
      known: true,
      same: ownCountry === targetCountry,
      reason: ownCountry === targetCountry ? "same-country" : "different-country",
      ownCountry,
      targetCountry
    };
  }


  function setTornStatusState(state, message, count = tornMemberStatus.size) {
    tornStatusState = { state: String(state || "unknown"), message: normalizeText(message) || "Torn: unknown", count: Number.isInteger(count) && count >= 0 ? count : 0 };
    updatePanel();
  }

  function normalizeTornMembers(payload) {
    const members = payload?.members;
    const list = Array.isArray(members) ? members : (members && typeof members === "object" ? Object.values(members) : []);
    const map = new Map();
    for (const member of list) {
      const id = String(member?.id ?? member?.player_id ?? "");
      if (!validTargetId(id)) continue;
      const status = member?.status || {};
      map.set(id, {
        state: normalizeText(status?.state),
        description: normalizeText(status?.description),
        details: normalizeText(status?.details),
        until: Number(status?.until) || 0
      });
    }
    return map;
  }

  function recordTornClockOffset(result, body) {
    const timestamp = Number(body?.timestamp);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      const midpoint = (Number(result.startedAt) + Number(result.endedAt)) / 2;
      tornClockOffsetsMs.push(timestamp * 1000 - midpoint);
      if (tornClockOffsetsMs.length > CONFIG.tornClockMaxSamples) tornClockOffsetsMs.splice(0, tornClockOffsetsMs.length - CONFIG.tornClockMaxSamples);
    }
  }

  async function fetchTornStatuses({ force = false } = {}) {
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return;
    refreshOwnLocationFromBasic();
    const key = effectiveTornApiKey();
    if (!key || tornStatusSyncing || nowMs() < tornStatusBackoffUntil) return;
    if (!force && tornStatusLastFetchAt > 0 && nowMs() - tornStatusLastFetchAt < CONFIG.tornStatusPollMs) return;
    const generation = runtimeGeneration;
    tornStatusSyncing = true;
    setTornStatusState("syncing", "Torn: syncing…");
    try {
      let result = null;
      for (let attempt = 0; attempt <= CONFIG.tornTransportRetryAttempts; attempt += 1) {
        result = await tornApiRequest(SCRIPT.tornApiPath, key);
        if (generation !== runtimeGeneration || !runtimeActive || !isRuntimeEligible()) return;
        if (result.ok || result.status !== 0 || attempt >= CONFIG.tornTransportRetryAttempts) break;
        await wait(CONFIG.tornTransportRetryDelayMs * (attempt + 1));
      }
      const body = result?.body || {};
      if (!result?.ok || body?.error) {
        if (key === rawInjectedPdaTornApiKey() && isPdaTornKeyRejectedError(body)) {
          pdaTornApiKeyRejected = true;
          const fallback = validateTornApiKey(storedTornApiKey);
          if (fallback) { tornStatusSyncing = false; return void fetchTornStatuses({ force: true }); }
        }
        if (result?.status === 0) tornTransportFailureStreak += 1; else tornTransportFailureStreak = 0;
        tornStatusBackoffUntil = nowMs() + CONFIG.tornStatusErrorBackoffMs;
        throw new Error(normalizeText(body?.error?.error ?? body?.error) || `HTTP ${result?.status ?? 0}`);
      }
      recordTornClockOffset(result, body);
      tornMemberStatus = normalizeTornMembers(body);
      tornStatusLastFetchAt = nowMs();
      tornStatusBackoffUntil = 0;
      tornTransportFailureStreak = 0;
      setTornStatusState("ready", `Torn: API live · ${tornMemberStatus.size} members`, tornMemberStatus.size);
      scanWarRows();
    } catch (error) {
      if (generation === runtimeGeneration && runtimeActive) setTornStatusState("error", `Torn: ${normalizeText(error?.message) || "offline"}`, tornMemberStatus.size);
    } finally { tornStatusSyncing = false; }
  }

  function tornStatusForTarget(targetId) {
    if (!Number.isFinite(tornStatusLastFetchAt) || nowMs() - tornStatusLastFetchAt > CONFIG.tornStatusMaxAgeMs) return null;
    return tornMemberStatus.get(String(targetId || "")) || null;
  }

  // ---------------------------------------------------------------------------
  // Torn war rows / hospital state
  // ---------------------------------------------------------------------------

  function parsePlayerId(li) {
    const profile = li?.querySelector?.('a[href^="/profiles"], a[href*="torn.com/profiles"]');
    if (profile) {
      const href = profile.getAttribute("href") || profile.href || "";
      const match = href.match(/[?&](?:XID|user2ID)=(\d+)/i);
      if (match && validTargetId(match[1])) return String(Number(match[1]));
    }

    const direct = li?.dataset?.profile || li?.dataset?.userId || li?.dataset?.playerId;
    if (validTargetId(direct)) return String(Number(direct));
    return "";
  }

  function getEnemyRows() {
    const root = document.getElementById("faction_war_list_id");
    if (!root) return [];
    const candidates = [...root.querySelectorAll("li.enemy")];
    return candidates.map(li => {
      const id = parsePlayerId(li);
      if (!id) return null;
      const directStatus = [...li.children].find(child => {
        if (!(child instanceof HTMLElement)) return false;
        const classes = String(child.className || "");
        return child.classList.contains("status") || /(^|\s|_)status(?:\s|_|-|$)/i.test(classes) || /status/i.test(classes);
      });
      const nestedStatus = li.querySelector(".status, [class*='status__'], [class*='status']");
      let statusDiv = directStatus || nestedStatus || li;
      if (statusDiv !== li && statusDiv.parentElement !== li) {
        let cursor = statusDiv;
        while (cursor.parentElement && cursor.parentElement !== li) cursor = cursor.parentElement;
        if (cursor.parentElement === li) statusDiv = cursor;
      }
      return { id, li, statusDiv };
    }).filter(Boolean);
  }

  function getPlayerName(row) {
    const profile = row?.li?.querySelector(`a[href*="XID=${row.id}"]`) || row?.li?.querySelector("a.user.name, a[class*='user'], a[href*='profiles.php']");
    return normalizeText(profile?.textContent) || row?.id || "target";
  }

  function parseHospitalSecondsFromText(text) {
    const value = normalizeText(text);
    const compact = value.match(/\b(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s\b)?/i);
    if (compact && (compact[1] || compact[2] || compact[3] || compact[4])) {
      const total = Number(compact[1] || 0) * 86400 + Number(compact[2] || 0) * 3600 + Number(compact[3] || 0) * 60 + Number(compact[4] || 0);
      if (Number.isFinite(total) && total >= 0) return total;
    }
    const verbose = value.match(/\b(?:(\d+)\s*days?\s*)?(?:(\d+)\s*hours?\s*)?(?:(\d+)\s*minutes?\s*)?(?:(\d+)\s*seconds?\b)?/i);
    if (verbose && (verbose[1] || verbose[2] || verbose[3] || verbose[4])) {
      const total = Number(verbose[1] || 0) * 86400 + Number(verbose[2] || 0) * 3600 + Number(verbose[3] || 0) * 60 + Number(verbose[4] || 0);
      if (Number.isFinite(total) && total >= 0) return total;
    }
    return null;
  }

  function isHospitalStatusValue(value) { return /hospital/i.test(normalizeText(value)); }

  function computeHospitalSeconds(row) {
    const apiStatus = tornStatusForTarget(row.id);
    if (apiStatus) {
      const hospital = isHospitalStatusValue(apiStatus.state) || isHospitalStatusValue(apiStatus.description);
      if (!hospital) return { isHospital: false, seconds: null, source: "torn-api" };
      if (Number.isFinite(apiStatus.until) && apiStatus.until > 0) {
        const remaining = Math.max(0, Math.round(apiStatus.until - getTornNowMs() / 1000));
        if (remaining < CONFIG.maxHospitalSeconds) return { isHospital: true, seconds: remaining, source: "torn-api" };
      }
      return { isHospital: true, seconds: null, source: "torn-api" };
    }
    const domHospital = row.statusDiv.classList?.contains("hospital") || isHospitalStatusValue(row.statusDiv.textContent);
    if (!domHospital) return { isHospital: false, seconds: null, source: "dom" };
    const untilRaw = row.li.getAttribute("data-until");
    if (untilRaw) {
      const until = Number(untilRaw);
      const remaining = Math.round(until - getTornNowMs() / 1000);
      if (Number.isFinite(remaining) && remaining >= 0 && remaining < CONFIG.maxHospitalSeconds) return { isHospital: true, seconds: remaining, source: "dom-until" };
    }
    return { isHospital: true, seconds: parseHospitalSecondsFromText(row.statusDiv.textContent || row.li.textContent), source: "dom-text" };
  }

  function updateHospitalStatusDisplay(row, hospital) {
    const cell = row?.statusDiv;
    if (!cell || cell === row?.li) return;
    const attr = "data-ks-twd-hospital-timer";
    if (hospital?.isHospital && Number.isFinite(hospital.seconds)) {
      const total = Math.max(0, Math.floor(hospital.seconds));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const timer = hours > 0
        ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      cell.setAttribute(attr, timer);
      cell.title = `Hospital · ${timer}`;
      return;
    }
    cell.removeAttribute(attr);
    if (/^Hospital\s*·/i.test(cell.title || "")) cell.removeAttribute("title");
  }

  // ---------------------------------------------------------------------------
  // Ranked War countdown reader restored from the PDA-verified v1.5.88 baseline.
  // It handles Torn-generated ::before/::after content and split DD:HH:MM:SS nodes.
  function activeRankedWarTab() {
    const root = document.getElementById("faction_war_list_id");
    if (!root) return null;
    for (const child of Array.from(root.children || [])) {
      if (!(child instanceof HTMLElement) || child.tagName !== "LI") continue;
      if (child.classList.contains("act") && child.getAttribute("role") === "button") return child;
    }
    return null;
  }

  function stripGeneratedContent(value) {
    let text = normalizeText(value);
    if (!text || text === "none" || text === "normal") return "";
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1);
    }
    return normalizeText(text.replace(/\\A/gi, " ").replace(/\\(["'\\])/g, "$1"));
  }

  function parsePreWarCountdownSeconds(text) {
    const value = normalizeText(text);
    // Torn's Ranked War pre-start clock is DD:HH:MM:SS. Deliberately do NOT
    // accept HH:MM:SS here: on PDA the day prefix may be generated separately,
    // and accepting the truncated remainder caused a multi-day war to look minutes away.
    const match = value.match(/(?:^|[^\d:])(\d{1,3}):([0-2]\d):([0-5]\d):([0-5]\d)(?![\d:])/);
    if (!match) return null;
    const days = Number(match[1]);
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    const seconds = Number(match[4]);
    if (!Number.isInteger(days) || !Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds)) return null;
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
    const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
    return Number.isFinite(total) && total >= 0 ? total : null;
  }

  function threePartClock(text) {
    const value = normalizeText(text);
    const match = value.match(/(?:^|[^\d:])([0-2]\d):([0-5]\d):([0-5]\d)(?![\d:])/);
    return match ? `${match[1]}:${match[2]}:${match[3]}` : "";
  }

  function simpleDayPrefix(text) {
    const value = stripGeneratedContent(text);
    const match = value.match(/(?:^|[^\d])(\d{1,3}):?(?:[^\d]|$)/);
    return match ? match[1] : "";
  }

  function safePseudoContent(element, pseudo) {
    if (!(element instanceof Element)) return "";
    try {
      return stripGeneratedContent(getComputedStyle(element, pseudo).content);
    } catch {
      return "";
    }
  }

  function candidateCountdownStrings(element) {
    if (!(element instanceof Element)) return [];
    const values = [];
    const add = value => {
      const text = normalizeText(value);
      if (text && !values.includes(text)) values.push(text);
    };

    const text = normalizeText(element.textContent);
    const innerText = element instanceof HTMLElement ? normalizeText(element.innerText) : "";
    const before = safePseudoContent(element, "::before");
    const after = safePseudoContent(element, "::after");

    add(text);
    add(innerText);
    add(`${before}${text}${after}`);
    add(`${before}${innerText}${after}`);
    add(`${before} ${text} ${after}`);

    const clock = threePartClock(text) || threePartClock(innerText);
    const beforeDay = simpleDayPrefix(before);
    const afterDay = simpleDayPrefix(after);
    if (clock && beforeDay) add(`${beforeDay}:${clock}`);
    if (clock && afterDay) add(`${afterDay}:${clock}`);

    const children = Array.from(element.children || []).slice(0, 12);
    const childTexts = children.map(child => normalizeText(child.textContent)).filter(Boolean);
    for (let i = 0; i + 1 < childTexts.length; i += 1) {
      const day = childTexts[i].match(/^\d{1,3}:?$/)?.[0]?.replace(/:$/, "") || "";
      const childClock = threePartClock(childTexts[i + 1]);
      if (day && childClock) add(`${day}:${childClock}`);
    }

    if (childTexts.length >= 4) {
      for (let i = 0; i + 3 < childTexts.length; i += 1) {
        const parts = childTexts.slice(i, i + 4).map(value => value.match(/^\d{1,3}$/)?.[0] || "");
        if (parts.every(Boolean)) add(parts.join(":"));
      }
    }

    return values;
  }

  function readRankedWarCountdownSeconds(active) {
    if (!(active instanceof Element)) return null;
    const nodes = [active, ...Array.from(active.querySelectorAll("*")).slice(0, 220)];
    for (const node of nodes) {
      for (const candidate of candidateCountdownStrings(node)) {
        const seconds = parsePreWarCountdownSeconds(candidate);
        if (Number.isFinite(seconds)) return seconds;
      }
    }
    return null;
  }

  function currentRwPhase() {
    if (!isWarPanelPresent()) {
      rwLiveConfirmSince = 0;
      return { phase: RW_PHASE.UNKNOWN, runwaySeconds: null };
    }

    const active = activeRankedWarTab();
    if (!active) {
      rwLiveConfirmSince = 0;
      return { phase: RW_PHASE.UNKNOWN, runwaySeconds: null };
    }

    const runwaySeconds = readRankedWarCountdownSeconds(active);
    const now = Math.floor(getTornNowMs() / 1000);

    if (Number.isFinite(runwaySeconds) && runwaySeconds > 0) {
      lastObservedRwStartAtSeconds = now + runwaySeconds;
      rwLiveConfirmSince = 0;
      return { phase: RW_PHASE.PREWAR, runwaySeconds };
    }

    // Once a future start was observed, transient SPA/render gaps may never
    // unlock DIBS before that observed start time has actually passed.
    if (lastObservedRwStartAtSeconds > now) {
      rwLiveConfirmSince = 0;
      return {
        phase: RW_PHASE.PREWAR,
        runwaySeconds: Math.max(0, lastObservedRwStartAtSeconds - now)
      };
    }

    // No verified countdown has ever been seen: fail closed.
    if (!lastObservedRwStartAtSeconds) {
      rwLiveConfirmSince = 0;
      return { phase: RW_PHASE.UNKNOWN, runwaySeconds: null };
    }

    // After the observed start, require a short stable no-countdown window
    // before promoting to LIVE to avoid one-frame boundary races.
    if (!rwLiveConfirmSince) rwLiveConfirmSince = nowMs();
    if (nowMs() - rwLiveConfirmSince < 3000) {
      return { phase: RW_PHASE.UNKNOWN, runwaySeconds: 0 };
    }

    return { phase: RW_PHASE.LIVE, runwaySeconds: 0 };
  }

  // Pure target decision engine
  // ---------------------------------------------------------------------------

  function classifyLiveTargetState({ playerId, ownTargetId, isHospital, seconds, fairFight, countryEligibility, rwPhase }) {
    const ff = Number.isFinite(fairFight) ? Number(fairFight) : null;
    if (ownTargetId) {
      if (ownTargetId === playerId) return { state: TARGET_STATE.CLAIMED, seconds, fairFight: ff, reason: "active-own-dibs", mode: "live" };
      return { state: TARGET_STATE.BLOCKED, seconds, fairFight: ff, reason: "another-active-dibs", mode: "live" };
    }
    if (rwPhase?.phase !== RW_PHASE.LIVE) {
      return {
        state: TARGET_STATE.LOCKED,
        seconds: isHospital ? seconds : null,
        fairFight: ff,
        reason: rwPhase?.phase === RW_PHASE.PREWAR ? "rw-not-started" : "rw-phase-unverifiable",
        mode: "live",
        rwPhase,
        prewarHospital: !!isHospital
      };
    }
    if (!isHospital) return { state: TARGET_STATE.UNAVAILABLE, seconds: null, fairFight: ff, reason: "not-hospital", mode: "live" };
    if (seconds === null) return { state: TARGET_STATE.UNKNOWN, seconds: null, fairFight: ff, reason: "hospital-timer-unverifiable", mode: "live" };
    if (seconds > CONFIG.gateSeconds) return { state: TARGET_STATE.LOCKED, seconds, fairFight: ff, reason: "hospital-too-early", mode: "live" };
    if (!countryEligibility?.known) return { state: TARGET_STATE.UNKNOWN, seconds, fairFight: ff, reason: "country-unverifiable", mode: "live", countryEligibility };
    if (!countryEligibility.same) return { state: TARGET_STATE.LOCKED, seconds, fairFight: ff, reason: countryEligibility.reason, mode: "live", countryEligibility };
    if (ff === null) return { state: TARGET_STATE.UNKNOWN, seconds, fairFight: null, reason: "fair-fight-unverifiable", mode: "live", countryEligibility };
    if (ff < CONFIG.minFairFight) return { state: TARGET_STATE.LOCKED, seconds, fairFight: ff, reason: "fair-fight-too-low", mode: "live" };
    if (ff > CONFIG.maxFairFight) return { state: TARGET_STATE.LOCKED, seconds, fairFight: ff, reason: "fair-fight-too-high", mode: "live" };
    return { state: TARGET_STATE.READY, seconds, fairFight: ff, reason: "hospital-window-and-fair-fight-open", mode: "live" };
  }

  function classifyTargetState({ playerId, ownClaim, isHospital, seconds, fairFight, countryEligibility, rwPhase }) {
    if (ownClaim) {
      if (ownClaim.targetId === playerId) {
        return { state: TARGET_STATE.CLAIMED, seconds, fairFight, reason: "active-own-dibs", mode: "live" };
      }
      return { state: TARGET_STATE.BLOCKED, seconds, fairFight, reason: "another-active-dibs", mode: "live" };
    }
    return classifyLiveTargetState({
      playerId,
      ownTargetId: "",
      isHospital,
      seconds,
      fairFight,
      countryEligibility,
      rwPhase
    });
  }

  function currentDecisionForTarget(targetId) {
    const row = getEnemyRows().find(candidate => candidate.id === String(targetId || ""));
    if (!row) return null;
    const hospital = computeHospitalSeconds(row);
    return classifyTargetState({
      playerId: row.id,
      ownClaim: currentOwnClaim(),
      isHospital: hospital.isHospital,
      seconds: hospital.seconds,
      fairFight: fairFightForTarget(row.id),
      countryEligibility: sameCountryForTarget(row.id, hospital.isHospital),
      rwPhase: currentRwPhase()
    });
  }

  // ---------------------------------------------------------------------------
  // Claim / release.
  // ---------------------------------------------------------------------------

  async function exactCleanupCreatedClaim(claimId) {
    if (!isValidClaimId(claimId)) return false;
    const cleanup = await hitApiWriteWithBusyRetry(HIT_API.unclaim, { claim_id: claimId });
    if (cleanup?.ok && cleanup?.body?.released === true) {
      removeImmediateSharedClaim(claimId);
      return true;
    }
    return false;
  }

  async function claimSharedTarget(playerId, playerName) {
    const targetId = String(playerId || "");
    if (!runtimeActive || !isRuntimeEligible() || sharedWriteBusy || !sharedApiKey || !validTargetId(targetId)) return;
    if (currentOwnClaim() || sharedClaimForTarget(targetId)) return;
    const rwPhase = currentRwPhase();
    if (rwPhase.phase !== RW_PHASE.LIVE) { scanWarRows(); return; }

    const eligibility = currentDecisionForTarget(targetId);
    if (!eligibility || eligibility.state !== TARGET_STATE.READY) { scanWarRows(); return; }

    const generation = runtimeGeneration;
    sharedWriteBusy = true;
    claimFlowState = CLAIM_FLOW_STATE.CLAIMING;
    pendingTargetId = targetId;
    setSharedStatus("writing", `Shared: claiming ${normalizeText(playerName) || targetId}…`);
    scanWarRows();
    let createdClaim = null;

    try {
      const result = await hitApiWriteWithBusyRetry(HIT_API.claim, { target_player_id: Number(targetId) });
      const claim = result?.body?.claim;
      const claimId = normalizeText(claim?.claim_id);
      const position = Number(result?.body?.position);
      if (result?.ok && isValidClaimId(claimId)) createdClaim = claim;
      if (!result?.ok || !isValidClaimId(claimId) || !Number.isInteger(position) || position < 1) throw new Error(normalizeText(result?.body?.error) || `Claim failed (HTTP ${result?.status ?? 0})`);
      upsertImmediateSharedClaim(targetId, claim, position);

      const ownRecord = {
        claimId,
        targetId,
        claimerPlayerId: String(claim?.claimer?.player_id ?? ""),
        claimerName: normalizeText(claim?.claimer?.name) || "You",
        expiresAt: Number(claim?.expires_at),
        cleanupRequired: false,
        createdLocalAt: nowMs()
      };



      if (position === 1) {
        ownClaimMissingReads = 0;
        ownClaimLastConfirmedAt = nowMs();
        saveOwnClaim(ownRecord);
        setSharedStatus("online", `Shared: DIBS ✓ ${ownRecord.claimerName}`, sharedClaims.size);
        return;
      }

      const others = Array.isArray(result?.body?.other_claims_for_target) ? result.body.other_claims_for_target : [];
      const winner = others.filter(item => Number(item?.position) === 1).sort((a, b) => Number(a?.created_at) - Number(b?.created_at))[0];
      const winnerName = normalizeText(winner?.claimer?.name) || "another member";
      if (await exactCleanupCreatedClaim(claimId)) {
        saveOwnClaim(null);
        setSharedStatus("online", `Shared: lost DIBS · ${winnerName} was first`, sharedClaims.size);
        return;
      }
      saveOwnClaim({ ...ownRecord, cleanupRequired: true });
      setSharedStatus("error", `Shared: queued behind ${winnerName} · RELEASE required`, sharedClaims.size);
    } catch (error) {
      if (createdClaim && isValidClaimId(createdClaim?.claim_id)) {
        saveOwnClaim({
          claimId: normalizeText(createdClaim.claim_id),
          targetId,
          claimerPlayerId: String(createdClaim?.claimer?.player_id ?? ""),
          claimerName: normalizeText(createdClaim?.claimer?.name) || "You",
          expiresAt: Number(createdClaim?.expires_at) || (nowSeconds() + 900),
          cleanupRequired: true,
          createdLocalAt: nowMs()
        });
      }
      setSharedStatus("error", `Shared: claim failed · ${normalizeText(error?.message) || "request failed"}`);
    } finally {
      sharedWriteBusy = false;
      claimFlowState = currentOwnClaim()?.cleanupRequired ? CLAIM_FLOW_STATE.CLEANUP_REQUIRED : CLAIM_FLOW_STATE.IDLE;
      pendingTargetId = "";
      if (generation === runtimeGeneration && runtimeActive) { scanWarRows(); void fetchSharedClaims(); }
    }
  }

  async function releaseOwnSharedTarget() {
    const own = currentOwnClaim();
    if (!runtimeActive || !isRuntimeEligible() || sharedWriteBusy || !sharedApiKey || !own || !isValidClaimId(own.claimId)) return;
    const generation = runtimeGeneration;
    sharedWriteBusy = true;
    claimFlowState = CLAIM_FLOW_STATE.RELEASING;
    pendingTargetId = own.targetId;
    setSharedStatus("writing", `Shared: releasing ${own.claimerName || "DIBS"}…`);
    scanWarRows();
    try {
      const result = await hitApiWriteWithBusyRetry(HIT_API.unclaim, { claim_id: own.claimId });
      if (!result?.ok || result?.body?.released !== true) throw new Error(normalizeText(result?.body?.error) || `Release failed (HTTP ${result?.status ?? 0})`);
      removeImmediateSharedClaim(own.claimId);
      saveOwnClaim(null);
      ownClaimMissingReads = 0;
      ownClaimLastConfirmedAt = 0;
      setSharedStatus("online", "Shared: released", sharedClaims.size);
    } catch (error) {
      setSharedStatus("error", `Shared: release failed · ${normalizeText(error?.message) || "request failed"}`);
    } finally {
      sharedWriteBusy = false;
      claimFlowState = currentOwnClaim()?.cleanupRequired ? CLAIM_FLOW_STATE.CLEANUP_REQUIRED : CLAIM_FLOW_STATE.IDLE;
      pendingTargetId = "";
      if (generation === runtimeGeneration && runtimeActive) { scanWarRows(); void fetchSharedClaims(); }
    }
  }

  // ---------------------------------------------------------------------------
  // DOM-measured Est / FF layout — restored from v1.5.10 PDA-verified baseline.
  // Native Level cell is Est; native Attack cell is DIBS; no extra row columns.
  // ---------------------------------------------------------------------------

  const SCOUT_PALETTE = Object.freeze([
    "#3057e1", "#3274ff", "#29a9ff", "#27d7f2", "#28d8b8",
    "#35d96f", "#85dd28", "#d9df24", "#f3b326", "#f57c1f", "#ef3340"
  ]);

  function enemyFactionScope() {
    return document.querySelector(".faction-war .enemy-faction") ||
      document.querySelector(".enemy-faction");
  }

  function ensureWarLayoutStyles() {
    let style = document.getElementById(SCRIPT.layoutStyleId);
    if (style) return style;

    style = document.createElement("style");
    style.id = SCRIPT.layoutStyleId;
    style.textContent = `
      [${SCRIPT.layoutRootAttr}="true"] .white-grad > .level,
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .level {
        display:block !important;
        position:relative !important;
        float:left !important;
        font-size:0 !important;
        text-align:center !important;
        overflow:visible !important;
      }
      [${SCRIPT.layoutRootAttr}="true"] .white-grad > .level::after {
        content:"Est";
        display:block;
        width:100%;
        font-size:12px;
        font-weight:700;
        line-height:36px;
        text-align:center;
      }
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .level::after {
        content:attr(${SCRIPT.estValueAttr});
        display:block;
        position:absolute;
        top:7px;
        left:0;
        box-sizing:border-box;
        width:100%;
        height:20px;
        margin-top:0;
        border-radius:3px;
        background:var(--ks-twd-est-bg,#4b5563);
        color:var(--ks-twd-est-fg,#d1d5db);
        font:700 11px/20px Arial,sans-serif;
        text-align:center;
        white-space:pre-line;
        overflow:hidden;
      }
      [${SCRIPT.layoutRootAttr}="true"] .white-grad > .attack {
        font-size:0 !important;
        text-align:center !important;
      }
      [${SCRIPT.layoutRootAttr}="true"] .white-grad > .attack::after {
        content:"Dibs";
        display:block;
        width:100%;
        font-size:12px;
        font-weight:700;
        line-height:36px;
        text-align:center;
      }
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .attack {
        font-size:0 !important;
        overflow:visible !important;
      }
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .attack > a,
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .attack > button {
        display:none !important;
      }
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > [data-ks-twd-hospital-timer] {
        position:relative !important;
        color:transparent !important;
        overflow:visible !important;
      }
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > [data-ks-twd-hospital-timer]::after {
        content:attr(data-ks-twd-hospital-timer);
        position:absolute;
        inset:0;
        display:flex;
        align-items:center;
        justify-content:center;
        color:#ef8a8a;
        font:700 11px/1 Arial,sans-serif;
        white-space:nowrap;
        pointer-events:none;
      }
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy[${SCRIPT.dibsOverlayRowAttr}="true"] {
        position:relative !important;
        overflow:visible !important;
      }
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy[${SCRIPT.ffGaugeAttr}="true"] {
        position:relative !important;
        overflow:visible !important;
      }
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy[${SCRIPT.ffGaugeAttr}="true"]::before {
        content:"";
        position:absolute;
        top:1px;
        left:var(--ks-twd-ff-left-px,52px);
        width:0;
        height:0;
        z-index:12;
        border-left:9px solid transparent;
        border-right:9px solid transparent;
        border-top:10px solid var(--ks-twd-ff-color,#4b5563);
        transform:translateX(-50%);
        filter:drop-shadow(0 1px 1px #000);
        pointer-events:none;
      }
      [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy[${SCRIPT.ffGaugeAttr}="true"][${SCRIPT.ffValueAttr}]::after {
        content:attr(${SCRIPT.ffValueAttr});
        position:absolute;
        top:7px;
        left:var(--ks-twd-ff-left-px,58px);
        transform:translateX(-50%);
        z-index:13;
        width:30px;
        min-width:30px;
        max-width:30px;
        padding:1px 3px;
        border-radius:3px;
        background:rgba(15,23,42,.92);
        color:var(--ks-twd-ff-color,#d1d5db);
        font:700 7px/8px Arial,sans-serif;
        text-align:center;
        white-space:nowrap;
        box-shadow:0 1px 2px rgba(0,0,0,.65);
        pointer-events:none;
      }
      @media (max-width:783px) {
        [${SCRIPT.layoutRootAttr}="true"] .white-grad > .member,
        [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .member {
          width:139px !important;
          min-width:139px !important;
          max-width:139px !important;
          padding-left:6px !important;
          box-sizing:border-box !important;
        }
        [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy .member [class*="factionWrap"] {
          display:none !important;
        }
        [${SCRIPT.layoutRootAttr}="true"] .white-grad > .level,
        [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .level {
          display:none !important;
          width:0 !important;
          min-width:0 !important;
          max-width:0 !important;
          padding:0 !important;
          margin:0 !important;
          border:0 !important;
          overflow:hidden !important;
        }
        [${SCRIPT.layoutRootAttr}="true"] .white-grad > .points,
        [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .points {
          width:53px !important;
          min-width:53px !important;
          max-width:53px !important;
          padding:0 !important;
          box-sizing:border-box !important;
        }
        [${SCRIPT.layoutRootAttr}="true"] .white-grad > .status,
        [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .status {
          width:59px !important;
          min-width:59px !important;
          max-width:59px !important;
          padding:0 !important;
          box-sizing:border-box !important;
          overflow:hidden !important;
        }
        [${SCRIPT.layoutRootAttr}="true"] .white-grad > .attack,
        [${SCRIPT.layoutRootAttr}="true"] ul.members-list > li.enemy > .attack {
          width:69px !important;
          min-width:69px !important;
          max-width:69px !important;
          padding:0 !important;
          box-sizing:border-box !important;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function ensureWarLayout() {
    const scope = enemyFactionScope();
    if (!(scope instanceof HTMLElement)) return null;
    ensureWarLayoutStyles();
    scope.setAttribute(SCRIPT.layoutRootAttr, "true");
    return scope;
  }

  function formatBattleStatsEstimate(entry) {
    const human = normalizeText(entry?.bsEstimateHuman);
    if (human) return human.toLowerCase();
    const value = Number(entry?.bsEstimate);
    if (!Number.isFinite(value) || value <= 0) return "-";
    if (value >= 1e12) return `${(value / 1e12).toFixed(value >= 1e13 ? 0 : 1)}t`;
    if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}b`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e8 ? 0 : 1)}m`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}k`;
    return String(Math.round(value));
  }

  function scoutColorForFairFight(value) {
    const ffValue = Number(value);
    if (!Number.isFinite(ffValue) || ffValue <= 0) return "#4b5563";
    const ff = Math.max(1, Math.min(5, ffValue));
    const index = Math.max(0, Math.min(10, Math.floor(((ff - 1) / 4) * 10)));
    return SCOUT_PALETTE[index];
  }

  function scoutTextColor(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!match) return "#fff";
    const value = Number.parseInt(match[1], 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return r * 0.299 + g * 0.587 + b * 0.114 > 126 ? "#111" : "#fff";
  }

  function scoutGaugePercent(value) {
    const ff = Number(value);
    if (!Number.isFinite(ff) || ff <= 0) return null;
    const bounded = Math.max(1, Math.min(8, ff));
    if (bounded < 2) return ((bounded - 1) / 1) * 33;
    if (bounded < 4) return 33 + ((bounded - 2) / 2) * 33;
    return 66 + ((bounded - 4) / 4) * 34;
  }

  function applyScoutVisuals(row) {
    ensureWarLayout();
    const entry = scoutStatsForTarget(row.id);
    const level = row.li.querySelector(":scope > .level, :scope > [class*='level__']");
    if (level instanceof HTMLElement) {
      const text = formatBattleStatsEstimate(entry);
      const ff = Number(entry?.fairFight);
      const hasFf = Number.isFinite(ff) && ff > 0;
      const bg = hasFf ? scoutColorForFairFight(ff) : "#4b5563";
      level.setAttribute(SCRIPT.estValueAttr, text);
      level.style.setProperty("--ks-twd-est-bg", bg);
      level.style.setProperty("--ks-twd-est-fg", hasFf ? scoutTextColor(bg) : "#d1d5db");
      level.title = hasFf ? `Est ${text} · Fair Fight ${ff.toFixed(2)}` : `Est ${text} · Fair Fight unknown`;
    }

    // v1.5.81: FF decoration belongs to the existing enemy row only.
    // Never mutate Torn's native .member/profile/title/honor subtree.
    const li = row.li;
    if (!(li instanceof HTMLElement)) return;

    if (li.getAttribute(SCRIPT.ffPlayerAttr) !== String(row.id)) {
      li.removeAttribute(SCRIPT.ffGaugeAttr);
      li.removeAttribute(SCRIPT.ffValueAttr);
      li.removeAttribute(SCRIPT.ffPlayerAttr);
      li.style.removeProperty("--ks-twd-ff-left");
      li.style.removeProperty("--ks-twd-ff-left-px");
      li.style.removeProperty("--ks-twd-ff-color");
      li.setAttribute(SCRIPT.ffPlayerAttr, String(row.id));
    }

    const percent = scoutGaugePercent(entry?.fairFight);
    if (!Number.isFinite(percent)) {
      li.removeAttribute(SCRIPT.ffGaugeAttr);
      li.removeAttribute(SCRIPT.ffValueAttr);
      return;
    }

    const ff = Number(entry?.fairFight);
    const clamped = Math.max(33, Math.min(98, percent));
    const leftPx = 6 + (104 * clamped / 100);
    li.setAttribute(SCRIPT.ffGaugeAttr, "true");
    if (Number.isFinite(ff) && ff > 0) {
      const estText = formatBattleStatsEstimate(entry);
      li.setAttribute(SCRIPT.ffValueAttr, estText && estText !== "-" ? `${ff.toFixed(2)} / ${estText}` : ff.toFixed(2));
    } else li.removeAttribute(SCRIPT.ffValueAttr);
    li.style.setProperty("--ks-twd-ff-left-px", `${leftPx.toFixed(2)}px`);
    li.style.setProperty("--ks-twd-ff-color", scoutColorForFairFight(entry.fairFight));
  }

  function clearScoutVisuals() {
    document.querySelectorAll(`[${SCRIPT.layoutRootAttr}='true']`).forEach(scope => scope.removeAttribute(SCRIPT.layoutRootAttr));
    document.querySelectorAll(`[${SCRIPT.estValueAttr}]`).forEach(level => {
      level.removeAttribute(SCRIPT.estValueAttr);
      level.style.removeProperty("--ks-twd-est-bg");
      level.style.removeProperty("--ks-twd-est-fg");
      if (normalizeText(level.title).startsWith("Est ")) level.removeAttribute("title");
    });
    document.querySelectorAll(`[${SCRIPT.ffGaugeAttr}], [${SCRIPT.ffPlayerAttr}]`).forEach(host => {
      host.removeAttribute(SCRIPT.ffGaugeAttr);
      host.removeAttribute(SCRIPT.ffValueAttr);
      host.removeAttribute(SCRIPT.ffPlayerAttr);
      host.style.removeProperty("--ks-twd-ff-left");
      host.style.removeProperty("--ks-twd-ff-left-px");
      host.style.removeProperty("--ks-twd-ff-color");
    });
    document.querySelectorAll(`[${SCRIPT.dibsOverlayRowAttr}="true"]`).forEach(row => row.removeAttribute(SCRIPT.dibsOverlayRowAttr));
    document.getElementById(SCRIPT.layoutStyleId)?.remove();
  }

  function hideNativeElement(element) {
    if (!(element instanceof HTMLElement)) return;
    if (!hiddenNativeElements.has(element)) {
      hiddenNativeElements.set(element, {
        value: element.style.getPropertyValue("display"),
        priority: element.style.getPropertyPriority("display")
      });
    }
    element.setAttribute(SCRIPT.hiddenAttr, "true");
    element.style.setProperty("display", "none", "important");
  }

  function restoreNativeElement(element) {
    if (!(element instanceof HTMLElement)) return;
    const previous = hiddenNativeElements.get(element);
    element.removeAttribute(SCRIPT.hiddenAttr);
    if (previous) {
      if (previous.value) element.style.setProperty("display", previous.value, previous.priority || "");
      else element.style.removeProperty("display");
      hiddenNativeElements.delete(element);
      return;
    }
    element.style.removeProperty("display");
  }

  function restoreAllNativeUi() {
    dibsSlotWidthPx = 0;
    for (const element of [...hiddenNativeElements.keys()]) restoreNativeElement(element);
    document.querySelectorAll(`[${SCRIPT.hiddenAttr}='true']`).forEach(element => restoreNativeElement(element));
    document.querySelectorAll(`[${SCRIPT.headerLabelAttr}='true']`).forEach(element => element.remove());
    clearScoutVisuals();
  }

  function findLeafByExactText(root, regex, exclude = null) {
    for (const element of root.querySelectorAll("*")) {
      if (element.children.length > 0) continue;
      if (element.tagName === "SCRIPT" || element.tagName === "STYLE") continue;
      if (element.id?.startsWith(SCRIPT.rowHostPrefix)) continue;
      if (element.getAttribute(SCRIPT.headerLabelAttr) === "true") continue;
      if (exclude && exclude(element)) continue;
      if (regex.test(normalizeText(element.textContent))) return element;
    }
    return null;
  }

  function findNativeAttackElement(li) {
    const strict = findLeafByExactText(li, /^attack$/i);
    if (strict) return strict;
    for (const element of li.querySelectorAll("a[href], button")) {
      const href = element.getAttribute("href") || "";
      const aria = element.getAttribute("aria-label") || "";
      const title = element.getAttribute("title") || "";
      if (/sid=attack/i.test(href) || /\battack\b/i.test(aria) || /\battack\b/i.test(title)) return element;
    }
    return null;
  }

  function findAttackHeaderCell() {
    const scope = document.getElementById("faction_war_list_id")?.parentElement || document;
    return findLeafByExactText(scope, /^attack$/i, element => element.closest("li.enemy, li.your"));
  }

  function relabelAttackHeader() {
    ensureWarLayout();
  }

  function clearDibsOverlayPlacement(li, host) {
    if (li instanceof HTMLElement) li.removeAttribute(SCRIPT.dibsOverlayRowAttr);
    if (!(host instanceof HTMLElement)) return;
    host.style.removeProperty("position");
    host.style.removeProperty("left");
    host.style.removeProperty("right");
    host.style.removeProperty("top");
    host.style.removeProperty("width");
    host.style.removeProperty("height");
    host.style.removeProperty("z-index");
  }

  function directHeaderCellForAttack() {
    const leaf = findAttackHeaderCell();
    if (!(leaf instanceof HTMLElement)) return null;
    const header = leaf.closest(".white-grad, .table-header");
    if (!(header instanceof HTMLElement)) return null;
    let cell = leaf;
    while (cell.parentElement && cell.parentElement !== header) cell = cell.parentElement;
    return cell.parentElement === header && cell instanceof HTMLElement ? cell : null;
  }

  function resolveDibsSlotWidth() {
    if (Number.isFinite(dibsSlotWidthPx) && dibsSlotWidthPx > 0) return dibsSlotWidthPx;

    const headerCell = directHeaderCellForAttack();
    if (headerCell instanceof HTMLElement) {
      const width = headerCell.getBoundingClientRect().width;
      if (Number.isFinite(width) && width > 0) {
        dibsSlotWidthPx = width;
        return dibsSlotWidthPx;
      }
    }

    const scope = enemyFactionScope();
    if (scope instanceof HTMLElement) {
      const nativeCell = scope.querySelector("ul.members-list > li.enemy > .attack, ul.members-list > li.enemy > [class*='attack__']");
      if (nativeCell instanceof HTMLElement) {
        const width = nativeCell.getBoundingClientRect().width;
        if (Number.isFinite(width) && width > 0) {
          dibsSlotWidthPx = width;
          return dibsSlotWidthPx;
        }
      }
    }

    return 0;
  }

  function placeDibsHost(li, host) {
    ensureWarLayout();
    if (!(li instanceof HTMLElement) || !(host instanceof HTMLElement)) return;

    // Torn omits the native Attack node on some enemy rows. Use the real Torn
    // Attack/Dibs column only as a width reference; player identity is the row.
    const width = resolveDibsSlotWidth();
    if (!(Number.isFinite(width) && width > 0)) {
      clearDibsOverlayPlacement(li, host);
      if (host.parentElement) host.remove();
      return;
    }

    const attackCell = li.querySelector(":scope > .attack, :scope > [class*='attack__']");
    if (attackCell instanceof HTMLElement) {
      for (const child of attackCell.querySelectorAll(":scope > a, :scope > button")) hideNativeElement(child);
    } else {
      const attack = findNativeAttackElement(li);
      if (attack instanceof HTMLElement) hideNativeElement(attack);
    }

    if (host.parentElement !== li) li.appendChild(host);
    li.setAttribute(SCRIPT.dibsOverlayRowAttr, "true");
    host.style.setProperty("position", "absolute");
    host.style.setProperty("right", "0px");
    host.style.removeProperty("left");
    host.style.setProperty("top", "0px");
    host.style.setProperty("width", `${Math.round(width * 10) / 10}px`);
    host.style.setProperty("height", "34px");
    host.style.setProperty("z-index", "20");
  }

  // ---------------------------------------------------------------------------
  // DIBS row control
  // ---------------------------------------------------------------------------

  function ensureDibsControl(row) {
    const hostId = `${SCRIPT.rowHostPrefix}${row.id}`;
    let host = document.getElementById(hostId);
    if (!host) {
      host = document.createElement("span");
      host.id = hostId;
      host.dataset.ksTwdPlayerId = row.id;
      Object.assign(host.style, { display: "block", width: "100%", height: "34px", margin: "0", boxSizing: "border-box" });
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host { all:initial; display:block; width:100%; height:34px; margin:0; box-sizing:border-box; }
          button { box-sizing:border-box; display:block; width:84%; min-width:0; height:28px; min-height:28px; margin:3px auto 0; padding:2px 1px; border:1px solid #718096; border-radius:6px; background:#1a202c; color:#e2e8f0; font:900 7px/1.1 Arial,sans-serif; text-align:center; touch-action:manipulation; overflow:hidden; -webkit-tap-highlight-color:transparent; }
          button.ready { border-color:#38a169; background:#22543d; color:#f0fff4; }
          button.locked { border-color:#975a16; background:#744210; color:#fefcbf; }
          button.prewar { border-color:#5f6875; background:#3b4048; color:#c5ccd5; filter:saturate(.35); }
          button.prewar:disabled { opacity:.72; }
          button.prewar .sub { color:#b8c0ca; }
          button.unknown { border-color:#9b2c2c; background:#742a2a; color:#fff5f5; }
          button.unavailable { border-color:#4a5568; background:#2d3748; color:#cbd5e0; }
          button.claimed { border-color:#3182ce; background:#2a4365; color:#ebf8ff; }
          button.blocked { border-color:#4a5568; background:#171923; color:#718096; }
          button.shared { border-color:#805ad5; background:#44337a; color:#faf5ff; }
          button.working { border-color:#0ea5e9; background:#0c4a6e; color:#e0f2fe; }
          button.cleanup { border-color:#dc2626; background:#7f1d1d; color:#fff1f2; }
          button:disabled { opacity:.55; cursor:default; }
          .label,.sub { display:block; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .sub { margin-top:1px; font-size:6.5px; font-weight:800; opacity:.92; }
        </style>
        <button type="button" disabled data-state="loading" data-ready="false"><span class="label">DIBS</span><span class="sub">LOADING</span></button>
      `;
      shadow.querySelector("button")?.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation(); registerTrustedInteraction();
        const button = event.currentTarget;
        const own = currentOwnClaim();
        const state = button.dataset.state;
        if ((state === "claimed" || state === "cleanup") && own?.targetId === row.id) { void releaseOwnSharedTarget(); return; }
        if (button.disabled || button.dataset.ready !== "true") return;
        if (own || sharedWriteBusy || !sharedApiKey) return;
        void claimSharedTarget(row.id, getPlayerName(row));
      });
    }
    placeDibsHost(row.li, host);
    return host;
  }

  function updateDibsControl(host, decision, sharedClaim) {
    const button = host?.shadowRoot?.querySelector("button");
    const label = host?.shadowRoot?.querySelector(".label");
    const sub = host?.shadowRoot?.querySelector(".sub");
    if (!button || !label || !sub || !decision) return;
    const playerId = String(host.dataset.ksTwdPlayerId || "");
    const own = currentOwnClaim();
    button.dataset.ready = "false";
    button.removeAttribute("title");

    if (pendingTargetId === playerId) {
      button.className = "working"; button.dataset.state = "working"; button.disabled = true;
      label.textContent = claimFlowState === CLAIM_FLOW_STATE.RELEASING ? "RELEASING" : "CLAIMING"; sub.textContent = "WAIT"; return;
    }
    if (own?.targetId === playerId) {
      const cleanup = own.cleanupRequired === true;
      button.className = cleanup ? "cleanup" : "claimed"; button.dataset.state = cleanup ? "cleanup" : "claimed"; button.disabled = !sharedApiKey || sharedWriteBusy;
      label.textContent = cleanup ? "QUEUED" : "DIBBED"; sub.textContent = "RELEASE"; return;
    }
    if (sharedClaim) {
      const firstName = normalizeText(sharedClaim.first?.claimer?.name) || "UNKNOWN";
      const extraCount = Math.max(0, sharedClaim.queue.length - 1);
      button.className = "shared"; button.dataset.state = "shared"; button.disabled = true; label.textContent = "TAKEN"; sub.textContent = extraCount > 0 ? `${firstName} +${extraCount}` : firstName; return;
    }

    button.className =
      decision.reason === "rw-not-started" || decision.reason === "rw-phase-unverifiable"
        ? "prewar"
        : decision.state;
    button.dataset.state = decision.state;
    label.textContent = "DIBS";

    if (decision.state === TARGET_STATE.BLOCKED) { button.disabled = true; label.textContent = "BLOCKED"; sub.textContent = own?.claimerName || "ACTIVE"; return; }
    if (decision.state === TARGET_STATE.READY) {
      if (!sharedApiKey) { button.disabled = true; sub.textContent = "SET KEY"; return; }
      button.disabled = sharedWriteBusy;
      button.dataset.ready = sharedWriteBusy ? "false" : "true";
      const timer = Number.isFinite(decision.seconds) ? formatCountdown(decision.seconds) : "READY";
      sub.textContent = `${timer} · FF${Number(decision.fairFight).toFixed(1)}`;
      button.title = `Fair Fight ${Number(decision.fairFight).toFixed(2)} · allowed ${CONFIG.minFairFight.toFixed(2)}-${CONFIG.maxFairFight.toFixed(2)}`;
      return;
    }

    button.disabled = true;
    if (decision.state === TARGET_STATE.LOCKED) {
      if (decision.reason === "rw-not-started" || decision.reason === "rw-phase-unverifiable") {
        if (decision.prewarHospital && Number.isFinite(decision.seconds)) {
          sub.textContent = formatCountdown(decision.seconds) || "HOSP";
        } else if (!decision.prewarHospital) {
          sub.textContent = "";
        } else {
          sub.textContent = "HOSP";
        }

        const runway = decision.rwPhase?.runwaySeconds;
        button.title = decision.reason === "rw-not-started"
          ? (Number.isFinite(runway)
              ? `DIBS locked until Ranked War starts · ${formatCountdown(runway)} remaining`
              : "DIBS locked until Ranked War starts")
          : "DIBS locked: Ranked War start state cannot be verified";
      } else if (decision.reason === "different-country") {
        sub.textContent = "";
        button.title = "DIBS locked: target is not in the same country";
      } else if (decision.reason === "self-traveling") {
        sub.textContent = "YOU TRAVEL";
        button.title = "DIBS locked while you are traveling";
      } else if (decision.reason === "fair-fight-too-low" || decision.reason === "fair-fight-too-high") {
        sub.textContent = Number.isFinite(decision.fairFight) ? `FF${Number(decision.fairFight).toFixed(1)}` : "LOCKED";
      } else {
        sub.textContent = formatCountdown(decision.seconds) || "LOCKED";
      }
      return;
    }
    if (decision.state === TARGET_STATE.UNKNOWN) {
      sub.textContent = decision.reason === "country-unverifiable" ? "" : "UNKNOWN";
      return;
    }
    if (decision.state === TARGET_STATE.UNAVAILABLE) { sub.textContent = ""; return; }
    sub.textContent = "LOCKED";
  }

  function scanWarRows() {
    relabelAttackHeader();
    if (!runtimeActive || !bridgeMounted || !isWarPanelPresent()) return;
    ensureWarLayout();
    const ids = new Set();
    for (const row of getEnemyRows()) {
      ids.add(row.id);
      applyScoutVisuals(row);
      const host = ensureDibsControl(row);
      const hospital = computeHospitalSeconds(row);
      updateHospitalStatusDisplay(row, hospital);
      const decision = classifyTargetState({
        playerId: row.id,
        ownClaim: currentOwnClaim(),
        isHospital: hospital.isHospital,
        seconds: hospital.seconds,
        fairFight: fairFightForTarget(row.id),
      countryEligibility: sameCountryForTarget(row.id, hospital.isHospital),
      rwPhase: currentRwPhase()
      });
      updateDibsControl(host, decision, sharedClaimForTarget(row.id));
    }
    document.querySelectorAll(`[id^="${SCRIPT.rowHostPrefix}"]`).forEach(host => {
      const id = String(host.dataset.ksTwdPlayerId || "");
      if (!ids.has(id)) host.remove();
    });
  }


  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  function ensurePanel() {
    if (!isWarPanelPresent()) return null;
    let host = document.getElementById(SCRIPT.panelId);
    if (host) { positionPanel(host); return host; }
    host = document.createElement("div");
    host.id = SCRIPT.panelId;
    Object.assign(host.style, { display: "block", width: "100%", boxSizing: "border-box", margin: "6px 0" });
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all:initial; display:block; width:100%; }
        .panel { box-sizing:border-box; width:100%; padding:7px 10px 6px; border:1px solid rgba(100,116,139,.55); border-radius:8px; background:rgba(15,23,42,.96); color:#dbe5f1; font-family:system-ui,sans-serif; }
        .top { display:flex; justify-content:space-between; align-items:center; gap:8px; }
        .brand { font:850 10px/1.2 system-ui,sans-serif; color:#f8fafc; }
        .version { font:750 8px/1.2 system-ui,sans-serif; color:#8fa0b4; }
        .status-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; margin-top:5px; }
        .status-item { min-width:0; display:flex; align-items:center; gap:4px; padding:4px 5px; border:1px solid rgba(100,116,139,.25); border-radius:5px; background:rgba(2,6,23,.45); }
        .dot { flex:0 0 5px; width:5px; height:5px; border-radius:50%; background:#64748b; }
        [data-state='ready'] .dot,[data-state='online'] .dot { background:#22c55e; }
        [data-state='upcoming'] .dot { background:#f59e0b; }
        [data-state='syncing'] .dot,[data-state='writing'] .dot { background:#38bdf8; }
        [data-state='error'] .dot,[data-state='offline'] .dot,[data-state='unknown'] .dot,[data-state='ended'] .dot { background:#ef4444; }
        .status { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#cbd5e1; font:700 7.7px/1.2 system-ui,sans-serif; }
        .controls { display:flex; align-items:center; flex-wrap:wrap; gap:2px; margin-top:5px; }
        button,a { border:0; padding:0; background:none; color:#94a3b8; font:700 8.2px/1.2 system-ui,sans-serif; text-decoration:none; cursor:pointer; }
        button:hover,a:hover { color:#fff; text-decoration:underline; }
        button:disabled { opacity:.4; cursor:default; text-decoration:none; }
        .sep { color:#667386; font:700 8px/1 system-ui,sans-serif; }
        .test-toggle { padding:3px 6px; border:1px solid #92400e; border-radius:5px; color:#fbbf24; text-decoration:none !important; }
        .test-toggle.on { border-color:#f59e0b; background:#78350f; color:#fffbeb; }
        .test-toggle[hidden] { display:none; }
        .editor { display:none; align-items:center; gap:5px; margin-top:5px; }
        .editor.open { display:flex; }
        .editor input { min-width:0; flex:1 1 180px; height:28px; box-sizing:border-box; border:1px solid #64748b; border-radius:5px; background:#111827; color:#f8fafc; padding:4px 7px; font:700 10px/1 system-ui,sans-serif; outline:none; }
        .note { margin-top:4px; color:#8794a5; font:600 7.2px/1.3 system-ui,sans-serif; }
        .api-policy { margin-top:6px; padding-top:6px; border-top:1px solid rgba(148,163,184,.18); color:#9aa9ba; font:600 7px/1.35 system-ui,sans-serif; }
        .api-policy strong { color:#d8e1eb; font-weight:750; }
        .api-policy a { color:#b9d7f2; text-decoration:underline; }
        .warning { color:#fbbf24; }
        @media (max-width:520px) { .status-grid { grid-template-columns:1fr; } .panel { padding-left:8px; padding-right:8px; } }
      </style>
      <div class="panel">
        <div class="top"><span class="brand">KS Torn War Dibs</span><span class="version">v${SCRIPT.version} RELEASE</span></div>
        <div class="status-grid">
          <div class="status-item" data-role="shared-item"><span class="dot"></span><span class="status" data-role="status">Shared: loading…</span></div>
          <div class="status-item" data-role="torn-item"><span class="dot"></span><span class="status" data-role="torn-status">Torn: loading…</span></div>
          <div class="status-item" data-role="rw-item"><span class="dot"></span><span class="status" data-role="rw-status">DIBS: checking RW…</span></div>
          <div class="status-item" data-role="country-item"><span class="dot"></span><span class="status" data-role="country-status">Country: checking…</span></div>
        </div>
        <div class="controls">
          <button type="button" data-role="key">FFScouter key</button><span class="sep">·</span>
          <button type="button" data-role="torn-key">Torn key</button><span class="sep">·</span>
          <a data-role="create-key" target="_blank" rel="noopener noreferrer">Create custom API key</a><span class="sep">·</span>
          <button type="button" data-role="sync">Sync</button><span class="sep">·</span>
          <a data-role="war-room" target="_blank" rel="noopener noreferrer">War Room</a><span class="sep">·</span>
          <button type="button" data-role="forget-ff">Forget FF key</button><span class="sep">·</span>
          <button type="button" data-role="forget-torn">Forget Torn key</button>
        </div>
        <div class="editor" data-role="key-editor"><input data-role="key-input" type="text" maxlength="16" autocomplete="off" placeholder="16-character FFScouter key"><button type="button" data-role="key-save">Save</button><button type="button" data-role="key-cancel">Cancel</button></div>
        <div class="editor" data-role="torn-key-editor"><input data-role="torn-key-input" type="text" maxlength="16" autocomplete="off" placeholder="16-character Torn API key"><button type="button" data-role="torn-key-save">Save</button><button type="button" data-role="torn-key-cancel">Cancel</button></div>
        <div class="note" data-role="note">LIVE: Hospital ≤2:00 + FF 2.00–5.00. First successful DIBS wins; claimant can RELEASE.</div>
        <div class="api-policy">
          <strong>Torn API key:</strong> stored only locally, encrypted in this browser; sent only to api.torn.com. Torn API data is processed locally and is not sent to FFScouter. Purpose: faction member Hospital/status data and key-owner identity for Ranked War DIBS. Access: Custom key requiring faction → members; key → info is used to identify the key owner.
          <br>
          <strong>FFScouter key/integration:</strong> key stored only locally, encrypted in this browser; sent only to FFScouter. Visible target IDs from the actively viewed war page are sent to FFScouter for FF/Est lookup and Hit Calling. Claim/release data is shared with faction members through FFScouter Hit Calling.
          <a data-role="ff-terms" target="_blank" rel="noopener noreferrer">FFScouter terms/data policy</a> · <a data-role="ff-privacy" target="_blank" rel="noopener noreferrer">Privacy</a>.
        </div>
      </div>
    `;
    const byRole = role => shadow.querySelector(`[data-role='${role}']`);
    byRole("create-key").href = SCRIPT.tornCustomKeyUrl;
    byRole("war-room").href = SCRIPT.ffscouterWarRoomUrl;
    byRole("ff-terms").href = SCRIPT.ffscouterTermsUrl;
    byRole("ff-privacy").href = SCRIPT.ffscouterPrivacyUrl;
    byRole("key")?.addEventListener("click", () => { registerTrustedInteraction(); byRole("key-editor")?.classList.add("open"); });
    byRole("torn-key")?.addEventListener("click", () => { registerTrustedInteraction(); if (!injectedPdaTornApiKey()) byRole("torn-key-editor")?.classList.add("open"); });
    byRole("key-cancel")?.addEventListener("click", () => byRole("key-editor")?.classList.remove("open"));
    byRole("torn-key-cancel")?.addEventListener("click", () => byRole("torn-key-editor")?.classList.remove("open"));
    byRole("key-save")?.addEventListener("click", () => void saveSharedKeyFromEditor());
    byRole("torn-key-save")?.addEventListener("click", () => void saveTornKeyFromEditor());
    byRole("sync")?.addEventListener("click", event => {
      event.preventDefault(); registerTrustedInteraction();
      if (sharedApiKey) { void fetchSharedClaims(); void fetchFairFightStats({ force: true }); }
      if (effectiveTornApiKey()) void fetchTornStatuses({ force: true }); scanWarRows();
    });
    byRole("forget-ff")?.addEventListener("click", () => void forgetSharedKey());
    byRole("forget-torn")?.addEventListener("click", () => void forgetTornKey());
    positionPanel(host);
    updatePanel();
    return host;
  }

  function positionPanel(host) {
    const anchor = document.getElementById("faction_war_list_id");
    if (!host || !anchor?.parentElement) return false;
    if (host.parentElement !== anchor.parentElement || host.previousElementSibling !== anchor) anchor.after(host);
    return true;
  }

  function formatRwRunway(totalSeconds) {
    const value = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = value % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  function updatePanel() {
    const host = document.getElementById(SCRIPT.panelId);
    if (!host?.shadowRoot) return;
    const $ = role => host.shadowRoot.querySelector(`[data-role='${role}']`);
    const sharedItem = $("shared-item"); const tornItem = $("torn-item"); const rwItem = $("rw-item"); const countryItem = $("country-item");
    if (sharedItem) sharedItem.dataset.state = sharedStatus.state;
    if (tornItem) tornItem.dataset.state = tornStatusState.state;

    const rwState = currentRwPhase();
    if (rwItem) {
      rwItem.dataset.state = rwState.phase === RW_PHASE.LIVE
        ? "online"
        : (rwState.phase === RW_PHASE.PREWAR ? "idle" : "error");
    }
    if ($("rw-status")) {
      if (rwState.phase === RW_PHASE.LIVE) {
        $("rw-status").textContent = "DIBS: LIVE";
        $("rw-status").title = "Ranked War is live";
      } else if (rwState.phase === RW_PHASE.PREWAR) {
        $("rw-status").textContent = Number.isFinite(rwState.runwaySeconds)
          ? `DIBS: LOCKED · RW ${formatRwRunway(rwState.runwaySeconds)}`
          : "DIBS: LOCKED · PRE-WAR";
        $("rw-status").title = "DIBS remains disabled until Ranked War starts";
      } else {
        $("rw-status").textContent = "DIBS: LOCKED · RW ?";
        $("rw-status").title = "Ranked War start state cannot be verified; DIBS remains disabled";
      }
    }
    if (countryItem) {
      const ownCountry = displayCountryName(ownLocationState.country);
      const verified = ownLocationState.checkedAt > 0 && ownCountry !== "?";
      countryItem.dataset.state = verified ? "online" : "idle";

      if ($("country-status")) {
        if (verified) {
          $("country-status").textContent = ownLocationState.traveling
            ? `Country: traveling → ${ownCountry}`
            : `Country: ${ownCountry}`;
          $("country-status").title = "Verified from Torn /user/{id}/basic status";
        } else {
          $("country-status").textContent = "Country: checking…";
          $("country-status").title = "Waiting for verified Torn /user/{id}/basic status";
        }
      }
    }
    if ($("status")) { $("status").textContent = sharedStatus.message; $("status").title = sharedStatus.message; }
    if ($("torn-status")) { $("torn-status").textContent = tornStatusState.message; $("torn-status").title = tornStatusState.message; }
    if ($("key")) $("key").textContent = sharedApiKey ? "Change FF key" : "Set FFScouter key";
    if ($("forget-ff")) $("forget-ff").disabled = !sharedApiKey;
    if ($("torn-key")) {
      if (injectedPdaTornApiKey()) { $("torn-key").textContent = "Torn key: PDA"; $("torn-key").disabled = true; }
      else { $("torn-key").textContent = storedTornApiKey ? "Change Torn key" : "Set Torn key"; $("torn-key").disabled = false; }
    }
    if ($("forget-torn")) $("forget-torn").disabled = !!injectedPdaTornApiKey() || !storedTornApiKey;
    const note = $("note");
    if (note) note.textContent = "LIVE: Hospital ≤2:00 + FF 2.00–5.00. First successful DIBS wins; claimant can RELEASE.";
  }

  async function saveSharedKeyFromEditor() {
    const host = document.getElementById(SCRIPT.panelId);
    const input = host?.shadowRoot?.querySelector("[data-role='key-input']");
    const key = validateFfscouterKey(input?.value);
    if (!key) { setSharedStatus("error", "Shared: invalid key format"); return; }
    if (!(await saveSecureApiKey(key))) { setSharedStatus("error", "Shared: key could not be stored securely"); return; }
    sharedApiKey = key;
    input.value = "";
    host.shadowRoot.querySelector("[data-role='key-editor']")?.classList.remove("open");
    setSharedStatus("ready", "Shared: key saved securely · syncing…", 0);
    void fetchSharedClaims(); void fetchFairFightStats({ force: true });
  }

  async function saveTornKeyFromEditor() {
    const host = document.getElementById(SCRIPT.panelId);
    const input = host?.shadowRoot?.querySelector("[data-role='torn-key-input']");
    const key = validateTornApiKey(input?.value);
    if (!key) { setTornStatusState("error", "Torn: invalid key format"); return; }
    if (!(await saveSecureTornApiKey(key))) { setTornStatusState("error", "Torn: key could not be stored securely"); return; }
    storedTornApiKey = key;
    selfPlayerId = ""; selfPlayerName = ""; tornUserBasicCapability = "unknown"; selfIdentityLastAttemptAt = 0;
    ownLocationState = { country: "", traveling: false, checkedAt: 0 };
    publicBasicStatusCache.clear();
    input.value = "";
    host.shadowRoot.querySelector("[data-role='torn-key-editor']")?.classList.remove("open");
    tornMemberStatus = new Map(); tornStatusLastFetchAt = 0;
    setTornStatusState("ready", "Torn: key saved · syncing…", 0);
    void fetchTornStatuses({ force: true }); void fetchSelfIdentity({ force: true });
  }

  async function forgetSharedKey() {
    if (!sharedApiKey) return;
    if (currentOwnClaim()) { window.alert("Release your active DIBS before forgetting the FFScouter key."); return; }
    if (!window.confirm("Forget the saved FFScouter key on this device?")) return;
    registerTrustedInteraction();
    if (!(await deleteSecureApiKey())) { setSharedStatus("error", "Shared: saved key could not be removed"); return; }
    sharedApiKey = ""; sharedClaims = new Map(); fairFightStats = new Map(); fairFightLastFetchAt = 0; fairFightEverSucceeded = false; sharedBackoffUntil = 0;
    setSharedStatus("key-required", "Shared: key required", 0); scanWarRows();
  }

  async function forgetTornKey() {
    if (injectedPdaTornApiKey()) { setTornStatusState("ready", "Torn: PDA API key is managed by Torn PDA", tornMemberStatus.size); return; }
    if (!storedTornApiKey || !window.confirm("Forget the saved Torn API key on this device?")) return;
    registerTrustedInteraction();
    if (!(await deleteSecureTornApiKey())) { setTornStatusState("error", "Torn: saved key could not be removed"); return; }
    storedTornApiKey = ""; tornMemberStatus = new Map(); tornStatusLastFetchAt = 0; selfPlayerId = ""; selfPlayerName = ""; tornUserBasicCapability = "unknown"; selfIdentityLastAttemptAt = 0;
    ownLocationState = { country: "", traveling: false, checkedAt: 0 };
    publicBasicStatusCache.clear();
    setTornStatusState("key-required", "Torn: API key required", 0); scanWarRows();
  }

  async function initializeApiKeyStorage() {
    let vaultFailed = false;
    try { [sharedApiKey, storedTornApiKey] = await Promise.all([loadSecureApiKey(), loadSecureTornApiKey()]); }
    catch { sharedApiKey = ""; storedTornApiKey = ""; vaultFailed = true; }

    apiKeyStorageReady = true;

    if (sharedApiKey) setSharedStatus("ready", "Shared: saved key loaded", 0); else setSharedStatus(vaultFailed ? "error" : "key-required", vaultFailed ? "Shared: secure storage unavailable" : "Shared: key required", 0);
    if (effectiveTornApiKey()) setTornStatusState("ready", injectedPdaTornApiKey() ? "Torn: PDA key loaded" : "Torn: saved key loaded", 0); else setTornStatusState(vaultFailed ? "error" : "key-required", vaultFailed ? "Torn: secure storage unavailable" : "Torn: API key required", 0);
    updatePanel();

    if (runtimeActive) {
      if (sharedApiKey) { void fetchSharedClaims(); void fetchFairFightStats({ force: true }); }
      if (effectiveTornApiKey()) {
        void fetchTornStatuses({ force: true });
        void fetchSelfIdentity({ force: true });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SPA lifecycle / foreground-only runtime
  // ---------------------------------------------------------------------------

  function mutationTouchesWarRows(records) {
    for (const record of records) {
      if (record.type === "characterData" && record.target?.parentElement?.closest?.("#faction_war_list_id")) return true;
      if (record.type !== "childList") continue;
      if (record.target instanceof Element && record.target.closest?.("#faction_war_list_id")) return true;
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node instanceof Element && (node.id === "faction_war_list_id" || node.matches?.("li.enemy") || node.querySelector?.("#faction_war_list_id, li.enemy"))) return true;
      }
    }
    return false;
  }

  function kickInitialFairFightLoad() {
    if (fairFightEverSucceeded || fairFightSyncing || !sharedApiKey) return;
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return;
    if (!getEnemyRows().some(row => validTargetId(row.id))) return;
    void fetchFairFightStats({ force: true });
  }

  function queueObserverScan() {
    if (observerScanQueued) return;
    observerScanQueued = true;
    queueMicrotask(() => {
      observerScanQueued = false;
      if (!runtimeActive || !isRuntimeEligible()) return;
      scanWarRows();
      kickInitialFairFightLoad();
    });
  }

  function startBodyObserver() {
    if (bodyObserver || !document.body) return;
    bodyObserver = new MutationObserver(records => { if (runtimeActive && isRuntimeEligible() && mutationTouchesWarRows(records)) queueObserverScan(); });
    bodyObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  function stopBodyObserver() {
    bodyObserver?.disconnect(); bodyObserver = null; observerScanQueued = false;
  }

  function clearTimers() {
    if (rowRefreshTimer !== null) window.clearInterval(rowRefreshTimer);
    if (sharedPollTimer !== null) window.clearInterval(sharedPollTimer);
    if (fairFightTimer !== null) window.clearInterval(fairFightTimer);
    if (fairFightRetryTimer !== null) window.clearTimeout(fairFightRetryTimer);
    if (tornStatusTimer !== null) window.clearInterval(tornStatusTimer);
    if (routeHeartbeatTimer !== null) window.clearInterval(routeHeartbeatTimer);
    if (sharedRetryTimer !== null) window.clearTimeout(sharedRetryTimer);
    if (tornRetryTimer !== null) window.clearTimeout(tornRetryTimer);
    if (mountPrimeTimer !== null) window.clearTimeout(mountPrimeTimer);
    rowRefreshTimer = sharedPollTimer = fairFightTimer = fairFightRetryTimer = null;
    tornStatusTimer = routeHeartbeatTimer = sharedRetryTimer = tornRetryTimer = mountPrimeTimer = null;
  }

  function removeOwnUi() {
    document.querySelectorAll(`[id^="${SCRIPT.rowHostPrefix}"]`).forEach(host => host.remove());
    document.getElementById(SCRIPT.panelId)?.remove();
  }

  function mountBridge() {
    if (bridgeMounted || !runtimeActive || !isWarPanelPresent()) return;
    bridgeMounted = true;
    ensurePanel(); ensureWarLayout(); startBodyObserver(); scanWarRows();
    kickInitialFairFightLoad();
    mountPrimeTimer = window.setTimeout(() => primeMountedBridge(0), CONFIG.mountPrimeDelayMs);
  }

  function unmountBridge() {
    bridgeMounted = false;
    stopBodyObserver();
    removeOwnUi();
    restoreAllNativeUi();
  }

  function primeMountedBridge(attempt) {
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return;
    const rows = getEnemyRows();
    if (!rows.length && attempt < CONFIG.mountPrimeMaxAttempts) {
      mountPrimeTimer = window.setTimeout(() => primeMountedBridge(attempt + 1), CONFIG.mountPrimeRetryMs);
      return;
    }
    if (sharedApiKey) { void fetchSharedClaims(); void fetchFairFightStats({ force: true }); }
    if (effectiveTornApiKey()) { void fetchTornStatuses({ force: true }); void fetchSelfIdentity(); }
  }

  function startRuntimeTimers() {
    rowRefreshTimer = window.setInterval(() => { if (runtimeActive && isRuntimeEligible()) scanWarRows(); }, CONFIG.rowRefreshMs);
    sharedPollTimer = window.setInterval(() => { if (sharedApiKey && runtimeActive && isRuntimeEligible()) void fetchSharedClaims(); }, CONFIG.sharedPollMs);
    fairFightTimer = window.setInterval(() => { if (sharedApiKey && runtimeActive && isRuntimeEligible()) void fetchFairFightStats(); }, CONFIG.fairFightRefreshMs);
    tornStatusTimer = window.setInterval(() => {
      if (!effectiveTornApiKey() || !runtimeActive || !isRuntimeEligible()) return;
      void fetchTornStatuses();
      if (!selfPlayerId) void fetchSelfIdentity();
      else {
        refreshOwnLocationFromBasic();
        void fetchPublicBasicStatus(selfPlayerId);
      }
    }, CONFIG.tornStatusPollMs);
    routeHeartbeatTimer = window.setInterval(() => {
      if (!runtimeActive || !isRuntimeEligible()) return;
      if (isWarPanelPresent()) { if (!bridgeMounted) mountBridge(); else positionPanel(document.getElementById(SCRIPT.panelId)); }
      else if (bridgeMounted) unmountBridge();
    }, CONFIG.routeHeartbeatMs);
  }

  function suspendRuntime() {
    if (!runtimeActive) return;
    runtimeActive = false;
    runtimeGeneration += 1;
    clearTimers();
    unmountBridge();
  }

  function resumeRuntime() {
    if (destroyed || runtimeActive || !isPageVisible() || !windowFocused || !hasRecentTrustedInteraction()) return;
    runtimeActive = true;
    runtimeGeneration += 1;
    if (isWarPanelPresent()) mountBridge();
    startRuntimeTimers();

    if (apiKeyStorageReady && effectiveTornApiKey()) {
      void fetchSelfIdentity({ force: true });
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    suspendRuntime();
    removeOwnUi(); restoreAllNativeUi(); stopBodyObserver();
    delete window[SCRIPT.instanceKey];
  }

  function onVisibilityChange() {
    if (!isPageVisible()) {
      suspendRuntime();
      return;
    }
    windowFocused = initialFocusState();
    resumeRuntime();
  }

  window.addEventListener("focus", () => { windowFocused = true; resumeRuntime(); });
  window.addEventListener("blur", () => { windowFocused = false; suspendRuntime(); });
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("pointerdown", registerTrustedInteraction, { capture: true, passive: true });
  document.addEventListener("touchstart", registerTrustedInteraction, { capture: true, passive: true });
  document.addEventListener("wheel", registerTrustedInteraction, { capture: true, passive: true });
  document.addEventListener("keydown", registerTrustedInteraction, { capture: true, passive: true });

  window.addEventListener("pagehide", event => { if (!event.persisted) destroy(); else suspendRuntime(); });
  window.addEventListener("pageshow", () => {
    if (!destroyed) {
      windowFocused = initialFocusState();
      resumeRuntime();
    }
  });

  windowFocused = initialFocusState();
  void initializeApiKeyStorage();
  if (!document.body) {
    window.addEventListener("DOMContentLoaded", () => {
      windowFocused = initialFocusState();
      resumeRuntime();
    }, { once: true });
  }
})();
