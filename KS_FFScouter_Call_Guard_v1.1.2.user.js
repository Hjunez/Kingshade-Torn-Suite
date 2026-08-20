// ==UserScript==
// @name         KS FFScouter Call Guard
// @namespace    https://kingshade.tools/
// @version      1.1.2
// @downloadURL  https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_FFScouter_Call_Guard.user.js
// @updateURL    https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_FFScouter_Call_Guard.user.js
// @description  FFScouter War Room shared DIBS using official Hit Calling claim/release API; first queue position wins.
// @author       Kingshade
// @match        https://ffscouter.com/*
// @match        https://www.ffscouter.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * KS FFScouter Call Guard v1.1.2 COMPLIANCE RELEASE
 * Live Hospital ≤2:00 + FF 2.00-5.00. Shared DIBS/TAKEN/RELEASE.
 * Deterministic no-flicker button rendering retained.
 */

(() => {
  "use strict";

  const SCRIPT = Object.freeze({
    name: "KS FFScouter Call Guard",
    version: "1.1.2",
    status: "RELEASE",
    instanceKey: "__ksFFScouterCallGuardV112",
    rowHostPrefix: "ks-ffcg-dibs-v112-",
    legacyLocalDibsStorageKey: "ks_ffscouter_call_guard_active_dibs_v1",
    ownSharedClaimStorageKey: "ks_ffscouter_call_guard_own_shared_claim_v1",
    factionIdStorageKey: "ks_ffscouter_call_guard_last_faction_id_v1",
    legacySharedApiKeyStorageKey: "ks_ffscouter_call_guard_ffscouter_api_key_v1",
    secureVaultDbName: "KSFFScouterCallGuardSecure",
    secureVaultStoreName: "vault",
    secureVaultCryptoKeyId: "sharedApiCryptoKey",
    secureVaultCipherId: "sharedApiCipher",
    sharedPanelId: "ks-ffcg-shared-v112",
    ffscouterHomeUrl: "https://ffscouter.com/",
    ffscouterPrivacyUrl: "https://ffscouter.com/privacy"
  });

  const GATE_SECONDS = 120;
  const MIN_FAIR_FIGHT = 2.0;
  const MAX_FAIR_FIGHT = 5.0;
  const SCAN_INTERVAL_MS = 2000;
  const ROUTE_INTERVAL_MS = 300;
  const SHARED_POLL_MS = 2500;
  const DIRECT_INTERACTION_IDLE_MS = 60000;

  if (window[SCRIPT.instanceKey]) return;
  window[SCRIPT.instanceKey] = true;

  let ownSharedClaim = loadOwnSharedClaim();
  let sharedWriteBusy = false;
  let pendingTargetId = "";
  let ownClaimMissingReads = 0;
  let warRoomMounted = false;
  let scanTimerId = null;
  let routeTimerId = null;
  let sharedPollTimerId = null;
  let warRoomObserver = null;
  let observerScanQueued = false;
  let sharedApiKey = "";
  let sharedSyncing = false;
  let sharedReadAbortController = null;
  let sharedClaims = new Map();
  let sharedStatus = {
    state: "loading-key",
    message: "Shared: loading saved key…",
    count: 0
  };
  let sharedBackoffUntil = 0;
  let runtimeForeground = !document.hidden;
  let directInteractionIdleTimerId = null;

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function isValidClaimId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalizeText(value)
    );
  }

  function loadOwnSharedClaim() {
    try {
      localStorage.removeItem(SCRIPT.legacyLocalDibsStorageKey);

      const raw = localStorage.getItem(SCRIPT.ownSharedClaimStorageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const claimId = normalizeText(parsed?.claimId);
      const targetId = String(parsed?.targetId ?? "").trim();
      const claimerPlayerId = String(parsed?.claimerPlayerId ?? "").trim();
      const claimerName = normalizeText(parsed?.claimerName);
      const expiresAt = Number(parsed?.expiresAt);
      const cleanupRequired = parsed?.cleanupRequired === true;

      if (!isValidClaimId(claimId) || !/^\d+$/.test(targetId)) return null;
      if (claimerPlayerId && !/^\d+$/.test(claimerPlayerId)) return null;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) {
        localStorage.removeItem(SCRIPT.ownSharedClaimStorageKey);
        return null;
      }

      return {
        claimId,
        targetId,
        claimerPlayerId,
        claimerName: claimerName || "You",
        expiresAt,
        cleanupRequired
      };
    } catch {
      return null;
    }
  }

  function saveOwnSharedClaim(value) {
    ownSharedClaim = value;
    try {
      if (value) {
        localStorage.setItem(SCRIPT.ownSharedClaimStorageKey, JSON.stringify(value));
      } else {
        localStorage.removeItem(SCRIPT.ownSharedClaimStorageKey);
      }
    } catch {}
  }

  function currentOwnSharedClaim() {
    if (!ownSharedClaim) return null;
    if (Number(ownSharedClaim.expiresAt) <= Date.now() / 1000) {
      saveOwnSharedClaim(null);
      return null;
    }
    return ownSharedClaim;
  }

  function validateFfscouterKey(value) {
    const key = normalizeText(value);
    return /^[A-Za-z0-9]{16}$/.test(key) ? key : "";
  }

  function openSecureVault() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window) || !crypto?.subtle) {
        reject(new Error("Secure browser storage unavailable"));
        return;
      }

      const request = indexedDB.open(SCRIPT.secureVaultDbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SCRIPT.secureVaultStoreName)) {
          db.createObjectStore(SCRIPT.secureVaultStoreName);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Secure storage open failed"));
      request.onblocked = () => reject(new Error("Secure storage upgrade blocked"));
    });
  }

  function vaultGet(db, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SCRIPT.secureVaultStoreName, "readonly");
      const request = tx.objectStore(SCRIPT.secureVaultStoreName).get(id);
      let result;

      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error || new Error("Secure storage read failed"));
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("Secure storage transaction aborted"));
    });
  }

  function vaultPut(db, id, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SCRIPT.secureVaultStoreName, "readwrite");

      try {
        tx.objectStore(SCRIPT.secureVaultStoreName).put(value, id);
      } catch (error) {
        reject(error);
        return;
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Secure storage write failed"));
      tx.onabort = () => reject(tx.error || new Error("Secure storage transaction aborted"));
    });
  }

  function vaultDelete(db, ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SCRIPT.secureVaultStoreName, "readwrite");
      const store = tx.objectStore(SCRIPT.secureVaultStoreName);

      try {
        for (const id of list) store.delete(id);
      } catch (error) {
        reject(error);
        return;
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Secure storage delete failed"));
      tx.onabort = () => reject(tx.error || new Error("Secure storage transaction aborted"));
    });
  }

  async function getOrCreateVaultCryptoKey(db) {
    const existing = await vaultGet(db, SCRIPT.secureVaultCryptoKeyId);

    if (typeof CryptoKey !== "undefined" && existing instanceof CryptoKey) return existing;

    const cryptoKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );

    await vaultPut(db, SCRIPT.secureVaultCryptoKeyId, cryptoKey);

    return cryptoKey;
  }

  async function encryptSharedApiKey(db, value) {
    const key = validateFfscouterKey(value);
    if (!key) throw new Error("Invalid FFScouter key");

    const cryptoKey = await getOrCreateVaultCryptoKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(key);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      plaintext
    );

    await vaultPut(
      db,
      SCRIPT.secureVaultCipherId,
      {
        v: 1,
        iv: Array.from(iv),
        ciphertext
      }
    );
  }

  async function decryptSharedApiKey(db) {
    const payload = await vaultGet(db, SCRIPT.secureVaultCipherId);

    if (!payload || payload.v !== 1 || !Array.isArray(payload.iv) || !payload.ciphertext) {
      return "";
    }

    const cryptoKey = await vaultGet(db, SCRIPT.secureVaultCryptoKeyId);
    if (typeof CryptoKey === "undefined" || !(cryptoKey instanceof CryptoKey)) return "";

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(payload.iv) },
        cryptoKey,
        payload.ciphertext
      );
      return validateFfscouterKey(new TextDecoder().decode(plaintext));
    } catch {
      return "";
    }
  }

  function readLegacyPlaintextSharedApiKey() {
    try {
      return validateFfscouterKey(
        localStorage.getItem(SCRIPT.legacySharedApiKeyStorageKey)
      );
    } catch {
      return "";
    }
  }

  function removeLegacyPlaintextSharedApiKey() {
    try {
      localStorage.removeItem(SCRIPT.legacySharedApiKeyStorageKey);
    } catch {}
  }

  async function loadSecureSharedApiKey() {
    const db = await openSecureVault();
    try {
      const saved = await decryptSharedApiKey(db);
      if (saved) {
        removeLegacyPlaintextSharedApiKey();
        return saved;
      }

      const legacy = readLegacyPlaintextSharedApiKey();
      if (!legacy) return "";

      await encryptSharedApiKey(db, legacy);
      removeLegacyPlaintextSharedApiKey();
      return legacy;
    } finally {
      db.close();
    }
  }

  async function saveSecureSharedApiKey(value) {
    const key = validateFfscouterKey(value);
    if (!key) return false;

    const db = await openSecureVault();
    try {
      await encryptSharedApiKey(db, key);
      removeLegacyPlaintextSharedApiKey();
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  async function deleteSecureSharedApiKey() {
    const db = await openSecureVault();
    try {
      await vaultDelete(db, [
        SCRIPT.secureVaultCipherId,
        SCRIPT.secureVaultCryptoKeyId
      ]);
      removeLegacyPlaintextSharedApiKey();
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  async function initializeSharedApiKeyStorage() {
    try {
      sharedApiKey = await loadSecureSharedApiKey();

      if (sharedApiKey) {
        setSharedStatus("ready", "Shared: saved key loaded", 0);
        if (runtimeForeground && !document.hidden && isWarRoomRoute()) {
          void fetchSharedClaims();
        }
      } else {
        setSharedStatus("key-required", "Shared: key required", 0);
      }
    } catch {
      sharedApiKey = "";
      setSharedStatus("error", "Shared: secure key storage unavailable", 0);
    }

    updateSharedPanel();
    scanWarRoom();
  }

  const HIT_API = Object.freeze({
    claims: "/api/v1/hit-calling/claims",
    claim: "/api/v1/hit-calling/claim",
    unclaim: "/api/v1/hit-calling/unclaim"
  });

  function validTargetId(value) {
    return /^\d{1,10}$/.test(String(value ?? "").trim()) && Number(value) > 0;
  }

  async function hitApiRequest(path, { method = "GET", body = null, signal = null } = {}) {
    if (!Object.values(HIT_API).includes(path)) {
      throw new Error("Blocked non-allowlisted FFScouter endpoint");
    }
    if (!sharedApiKey) throw new Error("FFScouter key required");

    const url = new URL(path, location.origin);
    url.searchParams.set("key", sharedApiKey);

    const options = {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "accept": "application/json" }
    };

    if (signal) options.signal = signal;

    if (body !== null) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url.toString(), options);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: { error: normalizeText(error?.message) || "Network request failed" }
      };
    }

    let responseBody = {};
    try {
      responseBody = await response.json();
    } catch {
      responseBody = { error: "Invalid JSON response" };
    }

    return { ok: response.ok, status: response.status, body: responseBody };
  }

  function retryDelayMs(result) {
    const code = Number(result?.body?.code);
    const seconds = Number(result?.body?.retry_after_seconds);
    if (result?.status !== 409 || code !== 24) return 0;
    if (!Number.isFinite(seconds)) return 1000;
    return Math.max(250, Math.min(2500, seconds * 1000));
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

  function normalizeSharedClaims(payload) {
    const faction = payload?.claims?.faction;
    const result = new Map();

    if (!faction || typeof faction !== "object" || Array.isArray(faction)) {
      return result;
    }

    for (const [rawTargetId, rawQueue] of Object.entries(faction)) {
      const targetId = String(rawTargetId || "").trim();
      if (!/^\d+$/.test(targetId) || !Array.isArray(rawQueue) || rawQueue.length === 0) continue;

      const queue = rawQueue
        .map((claim, index) => {
          const claimerId = String(claim?.claimer?.player_id ?? "").trim();
          const claimerName = normalizeText(claim?.claimer?.name);
          const claimId = normalizeText(claim?.claim_id);
          const createdAt = Number(claim?.created_at);
          const expiresAt = Number(claim?.expires_at);

          if (!/^\d+$/.test(claimerId) || !claimerName || !claimId) return null;
          if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) return null;

          return {
            claimId,
            position: index + 1,
            createdAt,
            expiresAt,
            claimer: { playerId: claimerId, name: claimerName }
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.createdAt - b.createdAt || a.position - b.position);

      if (queue.length) result.set(targetId, queue);
    }

    return result;
  }

  function findSharedClaimById(claimId) {
    if (!isValidClaimId(claimId)) return null;

    for (const [targetId, queue] of sharedClaims.entries()) {
      if (!Array.isArray(queue)) continue;
      const claim = queue.find(item => item?.claimId === claimId);
      if (claim) return { targetId, claim, queue };
    }

    return null;
  }

  function reconcileOwnSharedClaim() {
    const own = currentOwnSharedClaim();
    if (!own) {
      ownClaimMissingReads = 0;
      return;
    }

    const found = findSharedClaimById(own.claimId);
    if (!found) {
      ownClaimMissingReads += 1;
      if (ownClaimMissingReads >= 2 && sharedStatus.state === "online") {
        saveOwnSharedClaim(null);
        ownClaimMissingReads = 0;
      }
      return;
    }

    ownClaimMissingReads = 0;
    saveOwnSharedClaim({
      claimId: found.claim.claimId,
      targetId: found.targetId,
      claimerPlayerId: found.claim.claimer.playerId,
      claimerName: found.claim.claimer.name,
      expiresAt: found.claim.expiresAt,
      cleanupRequired: own.cleanupRequired === true
    });
  }

  function upsertImmediateSharedClaim(targetId, claim, position = 1) {
    const normalizedTargetId = String(targetId || "");
    if (!validTargetId(normalizedTargetId) || !claim) return;

    const entry = {
      claimId: normalizeText(claim.claim_id),
      position: Number.isInteger(position) && position > 0 ? position : 1,
      createdAt: Number(claim.created_at),
      expiresAt: Number(claim.expires_at),
      claimer: {
        playerId: String(claim?.claimer?.player_id ?? ""),
        name: normalizeText(claim?.claimer?.name)
      }
    };

    if (
      !isValidClaimId(entry.claimId) ||
      !/^\d+$/.test(entry.claimer.playerId) ||
      !entry.claimer.name ||
      !Number.isFinite(entry.createdAt) ||
      !Number.isFinite(entry.expiresAt)
    ) return;

    const queue = Array.isArray(sharedClaims.get(normalizedTargetId))
      ? [...sharedClaims.get(normalizedTargetId)]
      : [];

    if (!queue.some(item => item.claimId === entry.claimId)) queue.push(entry);
    queue.sort((a, b) => a.createdAt - b.createdAt || a.position - b.position);
    sharedClaims.set(normalizedTargetId, queue);
  }

  function removeImmediateSharedClaim(claimId) {
    if (!isValidClaimId(claimId)) return;

    for (const [targetId, queue] of [...sharedClaims.entries()]) {
      const next = queue.filter(item => item.claimId !== claimId);
      if (next.length) sharedClaims.set(targetId, next);
      else sharedClaims.delete(targetId);
    }
  }

  function sharedClaimForTarget(playerId) {
    const queue = sharedClaims.get(String(playerId || ""));
    if (!Array.isArray(queue) || !queue.length) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const active = queue.filter(claim => claim.expiresAt > nowSeconds);
    return active.length ? { first: active[0], queue: active } : null;
  }

  function setSharedStatus(state, message, count = sharedClaims.size) {
    sharedStatus = {
      state: String(state || "unknown"),
      message: normalizeText(message) || "Shared: unknown",
      count: Number.isInteger(count) && count >= 0 ? count : 0
    };
    updateSharedPanel();
  }

  async function fetchSharedClaims() {
    if (!runtimeForeground || document.hidden || !sharedApiKey || sharedSyncing || Date.now() < sharedBackoffUntil || !isWarRoomRoute()) return;

    const controller = new AbortController();
    sharedReadAbortController = controller;
    sharedSyncing = true;
    setSharedStatus("syncing", "Shared: syncing…");

    try {
      const result = await hitApiRequest(HIT_API.claims, {
        method: "GET",
        signal: controller.signal
      });

      if (controller.signal.aborted || !runtimeForeground || document.hidden || !isWarRoomRoute()) return;

      const body = result.body || {};

      if (!result.ok) {
        const retryAfterSeconds = Number(body?.retry_after_seconds);
        if ((result.status === 429 || result.status === 409) && Number.isFinite(retryAfterSeconds)) {
          sharedBackoffUntil = Date.now() + Math.max(1, retryAfterSeconds) * 1000;
        }
        throw new Error(normalizeText(body?.error) || `HTTP ${result.status}`);
      }

      sharedClaims = normalizeSharedClaims(body);
      sharedBackoffUntil = 0;
      setSharedStatus("online", `Shared: online · ${sharedClaims.size} targets`, sharedClaims.size);
      reconcileOwnSharedClaim();
      scanWarRoom();
    } catch (error) {
      setSharedStatus("offline", `Shared: offline · ${normalizeText(error?.message) || "request failed"}`);
    } finally {
      if (sharedReadAbortController === controller) sharedReadAbortController = null;
      sharedSyncing = false;
    }
  }

  function abortSharedRead() {
    if (!sharedReadAbortController) return;
    sharedReadAbortController.abort();
    sharedReadAbortController = null;
  }

  async function promptForSharedKey() {
    const value = window.prompt(
      "KS Call Guard key policy:\n" +
      "Data storage: API key encrypted locally until you use Forget key; own claim metadata is local until release/expiry; shared claim lists are memory-only.\n" +
      "Data sharing: DIBS claim/release data is sent to FFScouter Hit Calling and shared with your faction through FFScouter.\n" +
      "Purpose: faction-war hit coordination and duplicate-call prevention.\n" +
      "Key handling: the key is sent only to FFScouter by KS, never to Kingshade, and KS makes no direct Torn API requests.\n" +
      "Key access: KS requests no additional Torn permissions; the key must satisfy FFScouter War Room / Hit Calling requirements.\n\n" +
      "Paste your 16-character FFScouter API key.",
      ""
    );
    if (value === null) return;

    const key = validateFfscouterKey(value);
    if (!key) {
      setSharedStatus("error", "Shared: invalid key format");
      return;
    }

    setSharedStatus("ready", "Shared: saving key securely…");

    if (!(await saveSecureSharedApiKey(key))) {
      setSharedStatus("error", "Shared: key could not be stored securely");
      return;
    }

    sharedApiKey = key;
    sharedBackoffUntil = 0;
    setSharedStatus("ready", "Shared: key saved securely · syncing…");
    void fetchSharedClaims();
  }

  async function forgetSharedKey() {
    if (!sharedApiKey) return;

    if (ownSharedClaim) {
      window.alert("Release your active DIBS before forgetting the FFScouter key.");
      return;
    }

    if (!window.confirm("Forget the saved FFScouter key on this device?")) return;

    abortSharedRead();
    sharedSyncing = false;

    if (!(await deleteSecureSharedApiKey())) {
      setSharedStatus("error", "Shared: saved key could not be removed");
      return;
    }

    sharedApiKey = "";
    sharedClaims = new Map();
    sharedBackoffUntil = 0;
    setSharedStatus("key-required", "Shared: key required", 0);
    scanWarRoom();
  }

  function findSharedPanelAnchor() {
    const factionInput = document.getElementById("factionId");
    if (!(factionInput instanceof HTMLInputElement)) return null;

    let current = factionInput;
    for (let depth = 0; current && depth < 7; depth += 1) {
      const text = normalizeText(current.textContent);
      if (/Select Enemy Faction/i.test(text)) return current;
      current = current.parentElement;
    }

    return factionInput.parentElement;
  }

  function positionSharedPanel(host) {
    if (!(host instanceof HTMLElement)) return false;
    const anchor = findSharedPanelAnchor();
    if (!anchor?.parentElement) return false;

    if (host.nextElementSibling !== anchor || host.parentElement !== anchor.parentElement) {
      anchor.parentElement.insertBefore(host, anchor);
    }

    return true;
  }

  function ensureSharedPanel() {
    if (!isWarRoomRoute() || !document.body) return null;

    let host = document.getElementById(SCRIPT.sharedPanelId);
    if (host) {
      positionSharedPanel(host);
      return host;
    }

    host = document.createElement("div");
    host.id = SCRIPT.sharedPanelId;
    host.style.display = "block";
    host.style.width = "100%";
    host.style.boxSizing = "border-box";
    host.style.margin = "10px 0";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          box-sizing: border-box;
          width: 100%;
          padding: 8px 11px 7px;
          border: 0;
          border-left: 2px solid rgba(45,212,191,.62);
          background: rgba(51,57,68,.58);
          color: #f1f5f9;
          font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        .title {
          display: flex;
          align-items: baseline;
          gap: 7px;
          min-width: 0;
          margin-bottom: 5px;
          white-space: nowrap;
        }
        .brand {
          color: #d7f7f3;
          font: 800 10px/1.15 system-ui,sans-serif;
          letter-spacing: .035em;
          text-transform: uppercase;
        }
        .author {
          color: #9aa7b8;
          font: 650 8.5px/1.15 system-ui,sans-serif;
        }
        .status-row {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .status-wrap {
          min-width: 0;
          flex: 1 1 auto;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex: 0 0 auto;
          background: #94a3b8;
        }
        .panel[data-state="online"] .dot { background: #4ade80; }
        .panel[data-state="syncing"] .dot,
        .panel[data-state="writing"] .dot,
        .panel[data-state="ready"] .dot { background: #38bdf8; }
        .panel[data-state="offline"] .dot,
        .panel[data-state="error"] .dot { background: #fb7185; }
        .panel[data-state="key-required"] .dot,
        .panel[data-state="loading-key"] .dot { background: #fbbf24; }
        .status {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #e5e7eb;
          font: 720 9.5px/1.25 system-ui,sans-serif;
        }
        .text-action,
        .controls a,
        .controls button {
          min-height: 0;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          color: #b9c7d8;
          font: 700 8.5px/1.25 system-ui,sans-serif;
          text-decoration: none;
          touch-action: manipulation;
          cursor: pointer;
        }
        .text-action:hover,
        .controls a:hover,
        .controls button:hover {
          color: #f8fafc;
          text-decoration: underline;
          background: transparent;
        }
        .sync {
          flex: 0 0 auto;
          color: #d7f7f3;
        }
        .controls {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 5px;
          color: #667386;
        }
        .sep {
          color: #667386;
          font: 700 8px/1 system-ui,sans-serif;
          user-select: none;
        }
        .disclosure {
          margin-top: 5px;
          color: #8390a0;
          font: 600 7.5px/1.25 system-ui,sans-serif;
        }
        .policy {
          display: none;
          margin-top: 7px;
          padding-top: 7px;
          border-top: 1px solid rgba(148,163,184,.16);
          color: #aab5c3;
          font: 600 7.5px/1.35 system-ui,sans-serif;
        }
        .policy.open { display: block; }
        .policy-row { margin: 2px 0; }
        .policy strong { color: #d6dee8; font-weight: 750; }
        button:disabled {
          opacity: .38;
          cursor: default;
          text-decoration: none;
        }
        @media (max-width: 520px) {
          .panel { padding: 8px 10px 7px; }
          .status { font-size: 9px; }
          .controls { gap: 3px; }
          .disclosure { font-size: 7px; }
        }
      </style>
      <div class="panel" data-role="panel" data-state="key-required">
        <div class="title">
          <span class="brand">KS Call Guard</span>
          <span class="author">by Kingshade</span>
        </div>
        <div class="status-row">
          <span class="status-wrap">
            <span class="dot" aria-hidden="true"></span>
            <span class="status" data-role="status">Shared: key required</span>
          </span>
          <button class="text-action sync" type="button" data-role="sync">Sync</button>
        </div>
        <div class="controls">
          <button type="button" data-role="key">Set key</button>
          <span class="sep">·</span>
          <a data-role="create-key" target="_blank" rel="noopener noreferrer" title="Open FFScouter's official custom-key generator">Create custom API key</a>
          <span class="sep">·</span>
          <button type="button" data-role="policy-toggle">Policy</button>
          <span class="sep">·</span>
          <a data-role="terms" target="_blank" rel="noopener noreferrer">FFScouter terms</a>
          <span class="sep">·</span>
          <a data-role="privacy" target="_blank" rel="noopener noreferrer">Privacy</a>
          <span class="sep">·</span>
          <button type="button" data-role="forget">Forget key</button>
        </div>
        <div class="disclosure">Encrypted locally · Hospital ≤2:00 · FF 2.00–5.00 · shared DIBS via FFScouter Hit Calling</div>
        <div class="policy" data-role="policy">
          <div class="policy-row"><strong>Data storage:</strong> key encrypted locally until forgotten; own claim metadata local until release/expiry; shared claim list memory-only.</div>
          <div class="policy-row"><strong>Data sharing:</strong> DIBS target IDs and claim/release data are sent to FFScouter and shared with your faction through Hit Calling.</div>
          <div class="policy-row"><strong>Purpose:</strong> faction-war hit coordination and duplicate-call prevention.</div>
          <div class="policy-row"><strong>Key storage & sharing:</strong> encrypted locally by KS and sent only to FFScouter. KS Call Guard makes no direct Torn API requests.</div>
          <div class="policy-row"><strong>Key access:</strong> use a registered FFScouter API key that satisfies FFScouter War Room / Hit Calling requirements; FFScouter’s own terms and data policy apply.</div>
        </div>
      </div>
    `;

    const createKeyLink = shadow.querySelector("[data-role='create-key']");
    const termsLink = shadow.querySelector("[data-role='terms']");
    const privacyLink = shadow.querySelector("[data-role='privacy']");
    if (createKeyLink) createKeyLink.href = SCRIPT.ffscouterHomeUrl;
    if (termsLink) termsLink.href = SCRIPT.ffscouterHomeUrl;
    if (privacyLink) privacyLink.href = SCRIPT.ffscouterPrivacyUrl;

    shadow.querySelector("[data-role='key']").addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void promptForSharedKey();
    });

    shadow.querySelector("[data-role='sync']").addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void fetchSharedClaims();
    });

    shadow.querySelector("[data-role='policy-toggle']").addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      shadow.querySelector("[data-role='policy']")?.classList.toggle("open");
    });

    shadow.querySelector("[data-role='forget']").addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void forgetSharedKey();
    });

    if (!positionSharedPanel(host)) document.body.appendChild(host);
    updateSharedPanel();
    return host;
  }

  function updateSharedPanel() {
    const host = document.getElementById(SCRIPT.sharedPanelId);
    const panel = host?.shadowRoot?.querySelector("[data-role='panel']");
    const status = host?.shadowRoot?.querySelector("[data-role='status']");
    const keyButton = host?.shadowRoot?.querySelector("[data-role='key']");
    const forgetButton = host?.shadowRoot?.querySelector("[data-role='forget']");
    if (!panel || !status || !keyButton || !forgetButton) return;

    panel.dataset.state = sharedStatus.state;
    status.textContent = sharedStatus.message;
    status.title = sharedStatus.message;
    keyButton.textContent = sharedApiKey ? "Change key" : "Set key";
    forgetButton.disabled = !sharedApiKey;
  }

  function removeSharedPanel() {
    document.getElementById(SCRIPT.sharedPanelId)?.remove();
  }

  function parseHospitalSeconds(row, statusCell) {
    const sources = [
      row?.cells?.[0]?.textContent,
      statusCell?.textContent,
      row?.textContent
    ].map(normalizeText);

    for (const text of sources) {
      if (!text) continue;

      const compact = text.match(/\b(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)\b/i);
      if (compact?.[0]) {
        const total =
          Number(compact[1] || 0) * 86400 +
          Number(compact[2] || 0) * 3600 +
          Number(compact[3] || 0) * 60 +
          Number(compact[4] || 0);
        if (Number.isFinite(total) && total >= 0) return total;
      }

      const verbose = text.match(/\b(?:(\d+)\s*days?\s*)?(?:(\d+)\s*hours?\s*)?(?:(\d+)\s*minutes?\s*)?(?:(\d+)\s*seconds?)\b/i);
      if (verbose?.[0]) {
        const total =
          Number(verbose[1] || 0) * 86400 +
          Number(verbose[2] || 0) * 3600 +
          Number(verbose[3] || 0) * 60 +
          Number(verbose[4] || 0);
        if (Number.isFinite(total) && total >= 0) return total;
      }
    }

    return null;
  }

  function formatCountdown(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
    const seconds = Math.floor(totalSeconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return hours > 0
      ? `${hours}h ${minutes}m`
      : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function fairFightForWarRoomRow(row) {
    if (!(row instanceof HTMLTableRowElement)) return null;

    const cells = Array.from(row.querySelectorAll(":scope > td"));
    const table = row.closest("table");
    const headers = Array.from(table?.querySelectorAll("thead th") || []);

    const parseFairFightText = value => {
      const text = normalizeText(value);
      if (!text) return null;

      const direct = text.match(/(?:^|[^0-9])([0-9]+(?:\.[0-9]+)?)(?=$|[^0-9])/);
      if (!direct) return null;

      const ff = Number(direct[1]);
      return Number.isFinite(ff) && ff > 0 && ff <= 100 ? ff : null;
    };

    // Prefer the actual FF/Fair Fight column so row order/layout changes cannot
    // silently bind some unrelated numeric column as Fair Fight.
    const ffIndex = headers.findIndex(header => {
      const text = normalizeText(header.textContent);
      return /\bfair\s*fight\b/i.test(text) || /^ff$/i.test(text);
    });

    if (ffIndex >= 0 && ffIndex < cells.length) {
      const exact = parseFairFightText(cells[ffIndex]?.textContent);
      if (Number.isFinite(exact)) return exact;
    }

    // FFScouter War Room currently places FF among the early data columns.
    // Fallback remains deliberately narrow and accepts only plausible FF values.
    for (let index = 2; index < Math.min(cells.length, 7); index += 1) {
      const value = parseFairFightText(cells[index]?.textContent);
      if (Number.isFinite(value) && value >= 1 && value <= 8) return value;
    }

    return null;
  }

  function classifyTargetState(input) {
    const playerId = String(input?.playerId || "");
    const activePlayerId = String(input?.activePlayerId || "");
    const statusText = normalizeText(input?.statusText);
    const hospitalSeconds = Number.isFinite(input?.hospitalSeconds)
      ? Number(input.hospitalSeconds)
      : null;
    const fairFight = Number.isFinite(input?.fairFight)
      ? Number(input.fairFight)
      : null;

    if (activePlayerId) {
      if (activePlayerId === playerId) {
        return { state: "claimed", seconds: hospitalSeconds, fairFight, reason: "active-own-dibs" };
      }
      return { state: "blocked", seconds: hospitalSeconds, fairFight, reason: "another-active-dibs" };
    }

    if (/\bhospital\b/i.test(statusText)) {
      if (hospitalSeconds === null) {
        return { state: "unknown", seconds: null, fairFight, reason: "hospital-timer-unverifiable" };
      }
      if (hospitalSeconds > GATE_SECONDS) {
        return { state: "locked", seconds: hospitalSeconds, fairFight, reason: "hospital-too-early" };
      }

      if (fairFight === null) {
        return { state: "unknown", seconds: hospitalSeconds, fairFight: null, reason: "fair-fight-unverifiable" };
      }
      if (fairFight < MIN_FAIR_FIGHT) {
        return { state: "locked", seconds: hospitalSeconds, fairFight, reason: "fair-fight-too-low" };
      }
      if (fairFight > MAX_FAIR_FIGHT) {
        return { state: "locked", seconds: hospitalSeconds, fairFight, reason: "fair-fight-too-high" };
      }

      return { state: "ready", seconds: hospitalSeconds, fairFight, reason: "hospital-window-and-fair-fight-open" };
    }

    if (/\bok(?:ay)?\b/i.test(statusText)) {
      return { state: "unavailable", seconds: null, fairFight, reason: "okay-not-hospital-window" };
    }

    return { state: "unavailable", seconds: null, fairFight, reason: statusText || "status-unavailable" };
  }

  function getPlayerName(row, playerId) {
    const profile = row?.cells?.[0]?.querySelector('a[href*="profiles.php?XID="]');
    const text = normalizeText(profile?.textContent || row?.cells?.[0]?.textContent);
    return text.replace(/\s*\[\d+\].*$/, "").trim() || `Player ${playerId}`;
  }

  function firstOtherClaimName(resultBody) {
    const claims = Array.isArray(resultBody?.other_claims_for_target)
      ? resultBody.other_claims_for_target
      : [];
    const first = claims
      .filter(item => Number(item?.position) === 1)
      .sort((a, b) => Number(a?.created_at) - Number(b?.created_at))[0];
    return normalizeText(first?.claimer?.name) || "another member";
  }

  async function claimSharedTarget(playerId, playerName) {
    const targetId = String(playerId || "");
    if (
      sharedWriteBusy ||
      !sharedApiKey ||
      !validTargetId(targetId) ||
      currentOwnSharedClaim() ||
      sharedClaimForTarget(targetId)
    ) return;

    sharedWriteBusy = true;
    pendingTargetId = targetId;
    setSharedStatus("writing", `Shared: claiming ${normalizeText(playerName) || targetId}…`);
    scanWarRoom();

    let createdClaim = null;

    try {
      const result = await hitApiWriteWithBusyRetry(HIT_API.claim, {
        target_player_id: Number(targetId)
      });

      const claim = result?.body?.claim;
      const claimId = normalizeText(claim?.claim_id);
      const position = Number(result?.body?.position);

      if (result?.ok && isValidClaimId(claimId)) createdClaim = claim;

      if (
        !result?.ok ||
        !isValidClaimId(claimId) ||
        !Number.isInteger(position) ||
        position < 1
      ) {
        throw new Error(
          normalizeText(result?.body?.error) ||
          `Claim failed (HTTP ${result?.status ?? 0})`
        );
      }

      upsertImmediateSharedClaim(targetId, claim, position);

      const ownRecord = {
        claimId,
        targetId,
        claimerPlayerId: String(claim?.claimer?.player_id ?? ""),
        claimerName: normalizeText(claim?.claimer?.name) || "You",
        expiresAt: Number(claim?.expires_at),
        cleanupRequired: false
      };

      if (position === 1) {
        ownClaimMissingReads = 0;
        saveOwnSharedClaim(ownRecord);
        setSharedStatus("online", `Shared: DIBS ✓ ${ownRecord.claimerName}`, sharedClaims.size);
        return;
      }

      const winnerName = firstOtherClaimName(result.body);
      const cleanup = await hitApiWriteWithBusyRetry(HIT_API.unclaim, {
        claim_id: claimId
      });

      if (cleanup?.ok && cleanup?.body?.released === true) {
        removeImmediateSharedClaim(claimId);
        saveOwnSharedClaim(null);
        setSharedStatus("online", `Shared: lost DIBS · ${winnerName} was first`, sharedClaims.size);
        return;
      }

      saveOwnSharedClaim({
        ...ownRecord,
        cleanupRequired: true
      });
      setSharedStatus(
        "error",
        `Shared: queued behind ${winnerName} · RELEASE required`,
        sharedClaims.size
      );
    } catch (error) {
      if (createdClaim && isValidClaimId(createdClaim?.claim_id)) {
        saveOwnSharedClaim({
          claimId: normalizeText(createdClaim.claim_id),
          targetId,
          claimerPlayerId: String(createdClaim?.claimer?.player_id ?? ""),
          claimerName: normalizeText(createdClaim?.claimer?.name) || "You",
          expiresAt: Number(createdClaim?.expires_at) || (Date.now() / 1000 + 900),
          cleanupRequired: true
        });
      }
      setSharedStatus("error", `Shared: claim failed · ${normalizeText(error?.message) || "request failed"}`);
    } finally {
      sharedWriteBusy = false;
      pendingTargetId = "";
      scanWarRoom();
      void fetchSharedClaims();
    }
  }

  async function releaseOwnSharedTarget() {
    const own = currentOwnSharedClaim();
    if (sharedWriteBusy || !sharedApiKey || !own || !isValidClaimId(own.claimId)) return;

    sharedWriteBusy = true;
    pendingTargetId = own.targetId;
    setSharedStatus("writing", `Shared: releasing ${own.claimerName || "DIBS"}…`);
    scanWarRoom();

    try {
      const result = await hitApiWriteWithBusyRetry(HIT_API.unclaim, {
        claim_id: own.claimId
      });

      if (!result?.ok || result?.body?.released !== true) {
        throw new Error(
          normalizeText(result?.body?.error) ||
          `Release failed (HTTP ${result?.status ?? 0})`
        );
      }

      removeImmediateSharedClaim(own.claimId);
      saveOwnSharedClaim(null);
      ownClaimMissingReads = 0;
      setSharedStatus("online", "Shared: released", sharedClaims.size);
    } catch (error) {
      setSharedStatus("error", `Shared: release failed · ${normalizeText(error?.message) || "request failed"}`);
    } finally {
      sharedWriteBusy = false;
      pendingTargetId = "";
      scanWarRoom();
      void fetchSharedClaims();
    }
  }

  function ensureDibsControl(row, playerId, actionCell) {
    const hostId = `${SCRIPT.rowHostPrefix}${playerId}`;
    let host = document.getElementById(hostId);

    if (!host) {
      host = document.createElement("span");
      host.id = hostId;
      host.dataset.ksFfcgPlayerId = playerId;
      host.style.display = "inline-flex";
      host.style.verticalAlign = "middle";
      host.style.marginLeft = "8px";

      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host { all: initial; display: inline-flex; }
          button {
            box-sizing: border-box;
            min-width: 62px;
            min-height: 32px;
            padding: 5px 8px;
            border: 1px solid #718096;
            border-radius: 9px;
            background: #1a202c;
            color: #e2e8f0;
            font: 900 11px/1 Arial, sans-serif;
            touch-action: manipulation;
          }
          button.ready { border-color:#38a169; background:#22543d; color:#f0fff4; }
          button.locked { border-color:#975a16; background:#744210; color:#fefcbf; }
          button.unknown { border-color:#9b2c2c; background:#742a2a; color:#fff5f5; }
          button.unavailable { border-color:#4a5568; background:#2d3748; color:#cbd5e0; }
          button.claimed { border-color:#3182ce; background:#2a4365; color:#ebf8ff; }
          button.blocked { border-color:#4a5568; background:#171923; color:#718096; }
          button.shared { border-color:#805ad5; background:#44337a; color:#faf5ff; }
          button.working { border-color:#0ea5e9; background:#0c4a6e; color:#e0f2fe; }
          button.cleanup { border-color:#dc2626; background:#7f1d1d; color:#fff1f2; }
          .sub {
            display:block;
            margin-top:3px;
            max-width:76px;
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
            font-size:8px;
            font-weight:800;
            opacity:.9;
          }
        </style>
        <button type="button" disabled>
          <span class="label">DIBS</span>
          <span class="sub">LOADING</span>
        </button>
      `;

      shadow.querySelector("button").addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();

        const button = event.currentTarget;
        const state = button.dataset.state;
        const own = currentOwnSharedClaim();

        if ((state === "claimed" || state === "cleanup") && own?.targetId === playerId) {
          void releaseOwnSharedTarget();
          return;
        }

        if (
          button.disabled ||
          button.dataset.ready !== "true" ||
          own ||
          sharedWriteBusy ||
          !sharedApiKey
        ) return;

        const currentRow = host.closest("tr[data-player-id]");
        const playerName = getPlayerName(currentRow, playerId);
        void claimSharedTarget(playerId, playerName);
      });

      actionCell.appendChild(host);
    } else if (host.parentElement !== actionCell) {
      actionCell.appendChild(host);
    }

    return host;
  }

  function applyButtonRender(button, label, sub, render) {
    const signature = JSON.stringify({
      className: render.className || "",
      state: render.state || "",
      ready: render.ready || "false",
      disabled: !!render.disabled,
      label: render.label || "",
      sub: render.sub || "",
      aria: render.aria || ""
    });

    if (button.dataset.ksRenderSignature === signature) return false;

    button.dataset.ksRenderSignature = signature;
    button.className = render.className || "";
    button.dataset.state = render.state || "";
    button.dataset.ready = render.ready || "false";
    button.disabled = !!render.disabled;
    label.textContent = render.label || "";
    sub.textContent = render.sub || "";
    if (render.aria) button.setAttribute("aria-label", render.aria);
    else button.removeAttribute("aria-label");
    return true;
  }

  function updateDibsControl(host, decision, statusText, sharedClaim = null) {
    const button = host?.shadowRoot?.querySelector("button");
    const label = host?.shadowRoot?.querySelector(".label");
    const sub = host?.shadowRoot?.querySelector(".sub");
    if (!button || !label || !sub) return;

    const playerId = String(host?.dataset?.ksFfcgPlayerId || "");
    const own = currentOwnSharedClaim();
    const state = decision.state;

    if (pendingTargetId === playerId) {
      applyButtonRender(button, label, sub, {
        className: "working",
        state: "working",
        ready: "false",
        disabled: true,
        label: own?.targetId === playerId ? "RELEASING" : "CLAIMING",
        sub: "WAIT",
        aria: `${own?.targetId === playerId ? "RELEASING" : "CLAIMING"} in progress`
      });
      return;
    }

    if (own?.targetId === playerId) {
      const cleanup = own.cleanupRequired === true;
      applyButtonRender(button, label, sub, {
        className: cleanup ? "cleanup" : "claimed",
        state: cleanup ? "cleanup" : "claimed",
        ready: "false",
        disabled: !sharedApiKey || sharedWriteBusy,
        label: cleanup ? "QUEUED" : "DIBBED",
        sub: "RELEASE",
        aria: cleanup
          ? "Queued claim requires manual release"
          : "Active shared DIBS. Tap to release"
      });
      return;
    }

    if (sharedClaim) {
      const firstName = normalizeText(sharedClaim.first?.claimer?.name) || "UNKNOWN";
      const extraCount = Math.max(0, sharedClaim.queue.length - 1);
      applyButtonRender(button, label, sub, {
        className: "shared",
        state: "shared",
        ready: "false",
        disabled: true,
        label: "TAKEN",
        sub: extraCount > 0 ? `${firstName} +${extraCount}` : firstName,
        aria: `Shared DIBS held by ${firstName}${extraCount > 0 ? ` with ${extraCount} queued behind` : ""}`
      });
      return;
    }

    if (state === "blocked") {
      applyButtonRender(button, label, sub, {
        className: "blocked",
        state,
        ready: "false",
        disabled: true,
        label: "BLOCKED",
        sub: own?.claimerName || "ACTIVE",
        aria: "Blocked by your active shared DIBS on another target"
      });
      return;
    }

    if (state === "ready") {
      if (!sharedApiKey) {
        applyButtonRender(button, label, sub, {
          className: "ready",
          state,
          ready: "false",
          disabled: true,
          label: "DIBS",
          sub: "SET KEY",
          aria: "Set FFScouter key before claiming DIBS"
        });
        return;
      }

      applyButtonRender(button, label, sub, {
        className: "ready",
        state,
        ready: sharedWriteBusy ? "false" : "true",
        disabled: sharedWriteBusy,
        label: "DIBS",
        sub: Number.isFinite(decision.seconds)
          ? `${formatCountdown(decision.seconds)} · FF ${Number(decision.fairFight).toFixed(2)}`
          : `FF ${Number(decision.fairFight).toFixed(2)}`,
        aria: "Claim shared DIBS"
      });
      return;
    }

    if (state === "locked") {
      const ffLocked =
        decision.reason === "fair-fight-too-low" ||
        decision.reason === "fair-fight-too-high";

      applyButtonRender(button, label, sub, {
        className: "locked",
        state,
        ready: "false",
        disabled: true,
        label: "DIBS",
        sub: ffLocked && Number.isFinite(decision.fairFight)
          ? `FF ${decision.fairFight.toFixed(2)}`
          : (formatCountdown(decision.seconds) || "LOCKED"),
        aria: ffLocked && Number.isFinite(decision.fairFight)
          ? `DIBS locked because Fair Fight ${decision.fairFight.toFixed(2)} is outside 2.00 to 5.00`
          : "DIBS locked until 2 minutes remain"
      });
      return;
    }

    if (state === "unknown") {
      applyButtonRender(button, label, sub, {
        className: "unknown",
        state,
        ready: "false",
        disabled: true,
        label: "DIBS",
        sub: "UNKNOWN",
        aria: "Hospital timer could not be verified"
      });
      return;
    }

    applyButtonRender(button, label, sub, {
      className: "unavailable",
      state: "unavailable",
      ready: "false",
      disabled: true,
      label: "DIBS",
      sub: normalizeText(statusText).slice(0, 12).toUpperCase() || "UNAVAILABLE",
      aria: `DIBS unavailable while status is ${normalizeText(statusText) || "unknown"}`
    });
  }


  function sanitizeFactionId(value) {
    const text = String(value ?? "").trim();
    return /^\d{1,10}$/.test(text) ? text : "";
  }

  function loadRememberedFactionId() {
    try {
      return sanitizeFactionId(localStorage.getItem(SCRIPT.factionIdStorageKey));
    } catch {
      return "";
    }
  }

  function saveRememberedFactionId(value) {
    const factionId = sanitizeFactionId(value);
    if (!factionId) return false;

    try {
      localStorage.setItem(SCRIPT.factionIdStorageKey, factionId);
      return true;
    } catch {
      return false;
    }
  }

  function findFactionIdInput() {
    const candidates = Array.from(document.querySelectorAll("input"));
    return candidates.find(input => {
      const placeholder = normalizeText(input.getAttribute("placeholder"));
      const ariaLabel = normalizeText(input.getAttribute("aria-label"));
      const name = normalizeText(input.getAttribute("name"));
      const id = normalizeText(input.id);

      return /enter\s+faction\s+id/i.test(placeholder) ||
        /faction\s+id/i.test(ariaLabel) ||
        /faction.*id|id.*faction/i.test(name) ||
        /faction.*id|id.*faction/i.test(id);
    }) || null;
  }

  function setInputValueForFramework(input, value) {
    if (!(input instanceof HTMLInputElement)) return false;
    if (input.value === value) return true;

    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    );

    if (descriptor?.set) descriptor.set.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value === value;
  }

  function rememberFactionIdFromEvent(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;

    const current = findFactionIdInput();
    if (input !== current) return;

    saveRememberedFactionId(input.value);
  }

  function restoreFactionIdIfNeeded() {
    const input = findFactionIdInput();
    if (!input) return;

    const currentValue = sanitizeFactionId(input.value);
    if (currentValue) {
      saveRememberedFactionId(currentValue);
      return;
    }

    const remembered = loadRememberedFactionId();
    if (!remembered) return;

    setInputValueForFramework(input, remembered);
  }

  function scanWarRoom() {
    if (!runtimeForeground || document.hidden || !isWarRoomRoute()) return;
    restoreFactionIdIfNeeded();
    ensureSharedPanel();

    const rows = Array.from(document.querySelectorAll("tr[data-player-id]"));
    const currentIds = new Set();

    for (const row of rows) {
      const playerId = String(row.getAttribute("data-player-id") || "").trim();
      if (!/^\d+$/.test(playerId)) continue;

      const cells = Array.from(row.querySelectorAll(":scope > td"));
      if (cells.length < 4) continue;

      const actionCell = cells[1];
      const statusCell = cells[3];
      if (!actionCell || !statusCell) continue;

      currentIds.add(playerId);

      const statusText = normalizeText(statusCell.textContent);
      const hospitalSeconds = /\bhospital\b/i.test(statusText)
        ? parseHospitalSeconds(row, statusCell)
        : null;
      const fairFight = fairFightForWarRoomRow(row);

      const decision = classifyTargetState({
        playerId,
        activePlayerId: currentOwnSharedClaim()?.targetId || "",
        statusText,
        hospitalSeconds,
        fairFight
      });

      const host = ensureDibsControl(row, playerId, actionCell);
      const sharedClaim = sharedClaimForTarget(playerId);
      updateDibsControl(host, decision, statusText, sharedClaim);
    }

    document.querySelectorAll(`[id^="${SCRIPT.rowHostPrefix}"]`).forEach(host => {
      const id = String(host.dataset.ksFfcgPlayerId || "");
      if (!currentIds.has(id)) host.remove();
    });
  }

  function isWarRoomRoute() {
    return /^\/war-room\/?$/i.test(location.pathname);
  }

  function removeOwnUi() {
    document.querySelectorAll(`[id^="${SCRIPT.rowHostPrefix}"]`).forEach(host => host.remove());
  }

  function mutationTouchesWarRoomRows(records) {
    for (const record of records) {
      if (record.type === "characterData") {
        const parent = record.target?.parentElement;
        if (parent?.closest?.("tr[data-player-id]")) return true;
        continue;
      }

      if (record.type !== "childList") continue;

      if (record.target instanceof Element && record.target.closest?.("tr[data-player-id]")) {
        return true;
      }

      const nodes = [...record.addedNodes, ...record.removedNodes];
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.("tr[data-player-id]") || node.querySelector?.("tr[data-player-id]")) {
          return true;
        }

        const row = node.closest?.("tr[data-player-id]");
        if (row) return true;
      }
    }
    return false;
  }

  function queueObserverScan() {
    if (observerScanQueued) return;
    observerScanQueued = true;

    queueMicrotask(() => {
      observerScanQueued = false;
      if (runtimeForeground && !document.hidden && isWarRoomRoute()) scanWarRoom();
    });
  }

  function startWarRoomObserver() {
    if (warRoomObserver) return;

    warRoomObserver = new MutationObserver(records => {
      if (!runtimeForeground || document.hidden || !isWarRoomRoute() || !mutationTouchesWarRoomRows(records)) return;
      queueObserverScan();
    });

    warRoomObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  function stopWarRoomObserver() {
    if (!warRoomObserver) return;
    warRoomObserver.disconnect();
    warRoomObserver = null;
    observerScanQueued = false;
  }

  function mountWarRoom() {
    if (!runtimeForeground || document.hidden || warRoomMounted) return;
    warRoomMounted = true;
    ensureSharedPanel();
    startWarRoomObserver();
    scanWarRoom();

    if (sharedApiKey) void fetchSharedClaims();
    sharedPollTimerId = window.setInterval(() => {
      if (runtimeForeground && !document.hidden && isWarRoomRoute() && sharedApiKey) void fetchSharedClaims();
    }, SHARED_POLL_MS);

    scanTimerId = window.setInterval(() => {
      if (runtimeForeground && !document.hidden && isWarRoomRoute()) scanWarRoom();
    }, SCAN_INTERVAL_MS);
  }

  function unmountWarRoom() {
    abortSharedRead();
    if (!warRoomMounted) return;
    warRoomMounted = false;
    stopWarRoomObserver();

    if (scanTimerId !== null) {
      window.clearInterval(scanTimerId);
      scanTimerId = null;
    }

    if (sharedPollTimerId !== null) {
      window.clearInterval(sharedPollTimerId);
      sharedPollTimerId = null;
    }

    removeOwnUi();
    removeSharedPanel();
  }

  function reconcileRoute() {
    if (!runtimeForeground || document.hidden) {
      unmountWarRoom();
      return;
    }

    if (isWarRoomRoute()) mountWarRoom();
    else unmountWarRoom();
  }

  function clearTimer(timerId) {
    if (timerId !== null) window.clearInterval(timerId);
    return null;
  }

  function clearDirectInteractionIdleTimer() {
    if (directInteractionIdleTimerId !== null) {
      window.clearTimeout(directInteractionIdleTimerId);
      directInteractionIdleTimerId = null;
    }
  }

  function scheduleDirectInteractionIdlePause() {
    clearDirectInteractionIdleTimer();
    if (!runtimeForeground || document.hidden) return;

    directInteractionIdleTimerId = window.setTimeout(() => {
      directInteractionIdleTimerId = null;
      suspendRuntime();
    }, DIRECT_INTERACTION_IDLE_MS);
  }

  function suspendRuntime() {
    runtimeForeground = false;
    clearDirectInteractionIdleTimer();
    abortSharedRead();
    stopWarRoomObserver();
    scanTimerId = clearTimer(scanTimerId);
    routeTimerId = clearTimer(routeTimerId);
    sharedPollTimerId = clearTimer(sharedPollTimerId);
    warRoomMounted = false;
    removeOwnUi();
    removeSharedPanel();
  }

  function ensureRouteLoop() {
    if (!runtimeForeground || document.hidden) return;
    if (routeTimerId === null) {
      routeTimerId = window.setInterval(reconcileRoute, ROUTE_INTERVAL_MS);
    }
  }

  function resumeRuntime() {
    if (document.hidden) return;

    runtimeForeground = true;
    window[SCRIPT.instanceKey] = true;
    reconcileRoute();
    ensureRouteLoop();
    scheduleDirectInteractionIdlePause();

    if (isWarRoomRoute()) {
      scanWarRoom();
      if (sharedApiKey) void fetchSharedClaims();
    }
  }

  function handleDirectInteraction(event) {
    if (!event.isTrusted || document.hidden) return;

    if (!runtimeForeground) {
      resumeRuntime();
      return;
    }

    scheduleDirectInteractionIdlePause();
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      suspendRuntime();
      return;
    }

    resumeRuntime();
  }

  document.addEventListener("pointerdown", handleDirectInteraction, true);
  document.addEventListener("touchstart", handleDirectInteraction, { capture: true, passive: true });
  document.addEventListener("keydown", handleDirectInteraction, true);
  document.addEventListener("wheel", handleDirectInteraction, { capture: true, passive: true });
  document.addEventListener("visibilitychange", handleVisibilityChange);

  window.addEventListener("blur", () => {
    suspendRuntime();
  });

  window.addEventListener("focus", () => {
    resumeRuntime();
  });

  window.addEventListener("freeze", () => {
    suspendRuntime();
  });

  window.addEventListener("resume", () => {
    resumeRuntime();
  });

  window.addEventListener("popstate", () => {
    if (runtimeForeground && !document.hidden) window.setTimeout(resumeRuntime, 0);
  });

  window.addEventListener("pageshow", () => {
    if (!document.hidden) resumeRuntime();
  });

  document.addEventListener("input", rememberFactionIdFromEvent, true);
  document.addEventListener("change", rememberFactionIdFromEvent, true);

  window.addEventListener("pagehide", event => {
    suspendRuntime();

    if (!event.persisted) {
      sharedApiKey = "";
      sharedClaims = new Map();
      delete window[SCRIPT.instanceKey];
    }
  });

  void initializeSharedApiKeyStorage();

  if (runtimeForeground) {
    reconcileRoute();
    ensureRouteLoop();
    scheduleDirectInteractionIdlePause();
  }
})();
