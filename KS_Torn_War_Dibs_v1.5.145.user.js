// ==UserScript==
// @name         KS Torn War Dibs
// @namespace    kingshade.torn
// @version      1.5.145
// @downloadURL  https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_Torn_War_Dibs.user.js
// @updateURL    https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_Torn_War_Dibs.user.js
// @description  PDA-safe DIBS with strict shared-claim authority and foreground lifecycle controls.
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
 * KS Torn War Dibs PDA v1.5.145 RELEASE
 * FF / Est separator, Hospital countdown, FF 2.00-5.00 gate and shared DIBS retained.
 * Hospital countdown uses v1.5.135 FFScouter-aligned second-boundary semantics.
 * PREWAR remains locked until a fresh own-faction /v2/faction/wars response confirms LIVE.
 * TIME: Torn-synchronized getCurrentTimestamp() remains available for Torn-specific timing.
 * PARITY: Hospital epoch countdown uses FFScouter-compatible client clock plus FFScouter-aligned +1 second semantics.
 * Country eligibility remains internal; country labels are not shown in DIBS buttons.
 */

(() => {
  "use strict";

  const SCRIPT = Object.freeze({
    name: "KS Torn War Dibs",
    version: "1.5.145",
    instanceKey: "__ksTornWarDibsPdaV15145",
    layerId: "ks-twd-pda-layer",
    rowHostPrefix: "ks-twd-pda-row-",
    panelId: "ks-twd-pda-panel",
    ownClaimStorageKey: "ks_torn_war_dibs_bridge_own_claim_v1",
    claimQuarantineStorageKey: "ks_torn_war_dibs_bridge_claim_quarantine_v1",
    claimStorageProbeKey: "ks_torn_war_dibs_pda_claim_storage_probe_v1",
    secureVaultDbName: "KSTornWarDibsBridgeSecure",
    secureVaultStoreName: "vault",
    secureVaultCryptoKeyId: "sharedApiCryptoKey",
    secureVaultCipherId: "sharedApiCipher",
    secureVaultRollbackCipherId: "sharedApiRollbackCipherPdaV1",
    tornApiCipherId: "tornApiCipherV1",
    sharedApiChangeJournalKey: "ks_torn_war_dibs_pda_ff_change_journal_v1",
    ffscouterOrigin: "https://ffscouter.com",
    ffscouterWarRoomUrl: "https://ffscouter.com/war-room",
    ffscouterTermsUrl: "https://ffscouter.com/",
    ffscouterPrivacyUrl: "https://ffscouter.com/privacy",
    tornApiOrigin: "https://api.torn.com",
    tornKeyInfoPath: "/v2/key/info",
    tornOwnWarsPath: "/v2/faction/wars",
    tornCustomKeyUrl: "https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=KS%20Torn%20War%20Dibs%20PDA&faction=members,wars&user=basic"
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
    opponentMembersMaxAgeMs: 30000,
    ownWarsWriteMaxAgeMs: 5000,
    targetBasicWriteMaxAgeMs: 120000,
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
  let routeObserver = null;
  let observerScanQueued = false;
  let routeReconcileQueued = false;
  const nativeHistoryPushState = history.pushState;
  const nativeHistoryReplaceState = history.replaceState;
  let wrappedHistoryPushState = null;
  let wrappedHistoryReplaceState = null;

  let sharedApiKey = "";
  let storedTornApiKey = "";
  let pdaTornApiKeyRejected = false;
  let sharedSyncing = false;
  let sharedWriteBusy = false;
  let sharedWriteOperationSerial = 0;
  let sharedAuthorityEpoch = 0;
  let sharedRequestSerial = 0;
  let sharedClaimsVerifiedAt = 0;
  let ambiguousOwnServerClaims = false;
  let sharedBackoffUntil = 0;
  let sharedTransportFailureStreak = 0;
  let sharedCredentialRejected = false;
  let sharedClaims = new Map();
  let ffCredentialChangeSerial = 0;
  let ffCredentialMutationInProgress = false;
  let fairFightStats = new Map();
  let fairFightSyncing = false;
  let fairFightRequestSerial = 0;
  let fairFightLastFetchAt = 0;
  let fairFightBackoffUntil = 0;
  let tornStatusSyncing = false;
  let tornStatusBackoffUntil = 0;
  let selfPlayerId = "";
  let selfPlayerName = "";
  let selfFactionId = "";
  let opponentFactionId = "";
  let selfIdentitySyncing = false;
  let selfIdentityRequestSerial = 0;
  let tornUserBasicCapability = "unknown"; // unknown | supported | unsupported
  let selfIdentityLastAttemptAt = 0;
  let tornCredentialEpoch = 0;
  let tornCredentialObservationSerial = 0;
  let lastTornKeyValidityObservationSerial = 0;
  let lastTornCapabilityAuthoritySerial = 0;
  let tornCredentialChangeSerial = 0;
  let tornCredentialMutationInProgress = false;
  let storedTornCredentialRejected = false;
  let storedTornCapabilityRejected = false;
  let keyScopeReady = false;
  let apiKeyStorageReady = false;
  let ffCredentialStorageUnresolved = false;
  let tornCredentialStorageUnresolved = false;
  let claimAuthorityStorageUnresolved = false;
  let claimAuthorityEvidenceUnresolved = false;
  let tornTransportFailureStreak = 0;
  let tornStatusRequestSerial = 0;
  let opponentMembersState = { factionId: "", members: new Map(), fetchedAt: 0 };
  let ownWarsState = {
    phase: RW_PHASE.UNKNOWN,
    live: false,
    start: 0,
    warId: "",
    opponentFactionId: "",
    selfFactionId: "",
    surfaceWarId: "",
    surfaceOpponentFactionId: "",
    surfaceSerial: 0,
    fetchedAt: 0
  };
  let ownWarsRequestSerial = 0;
  let currentWarSurface = null;
  let warSurfaceSerial = 0;
  let prewarObservation = null;
  const lockedPrewarWarIds = new Set();
  let ownLocationState = { country: "", traveling: false, checkedAt: 0 };
  const publicBasicStatusCache = new Map();
  const publicBasicStatusPending = new Map();
  let publicBasicRequestSerial = 0;
  let lastPublicBasicFetchAt = 0;
  let tornClockOffsetsMs = [];
  let pendingTargetId = "";
  let ownClaimLastConfirmedAt = 0;
  let claimFlowState = CLAIM_FLOW_STATE.IDLE;
  let fairFightEverSucceeded = false;
  let quarantinedClaimAcknowledgement = null;

  let sharedStatus = { state: "loading-key", message: "Shared: loading saved key…", count: 0 };
  let tornStatusState = { state: "loading-key", message: "Torn: loading key…", count: 0 };


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

  function isPlainRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isInt32(value, { positive = false, nonNegative = false } = {}) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) return false;
    if (positive && value <= 0) return false;
    if (nonNegative && value < 0) return false;
    return true;
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
    if (tornCredentialMutationInProgress) return "";
    return injectedPdaTornApiKey() || validateTornApiKey(storedTornApiKey);
  }

  function emptyOwnWarsState(fetchedAt = 0, surface = null) {
    return {
      phase: RW_PHASE.UNKNOWN,
      live: false,
      start: 0,
      warId: "",
      opponentFactionId: normalizeText(surface?.opponentFactionId),
      selfFactionId: normalizeText(surface?.selfFactionId),
      surfaceWarId: normalizeText(surface?.warId),
      surfaceOpponentFactionId: normalizeText(surface?.opponentFactionId),
      surfaceSerial: Number(surface?.surfaceSerial) || 0,
      fetchedAt: Number(fetchedAt) || 0
    };
  }

  function invalidateOwnWarsState() {
    ownWarsRequestSerial += 1;
    ownWarsState = emptyOwnWarsState();
  }

  function invalidateSharedReads() {
    sharedAuthorityEpoch += 1;
    sharedRequestSerial += 1;
    sharedSyncing = false;
    sharedClaimsVerifiedAt = 0;
  }

  function invalidateTornCredentialRequests() {
    tornCredentialEpoch += 1;
    publicBasicRequestSerial += 1;
    selfIdentityRequestSerial += 1;
    tornStatusRequestSerial += 1;
    selfIdentitySyncing = false;
    tornStatusSyncing = false;
    invalidateOwnWarsState();
    keyScopeReady = false;
    selfPlayerId = "";
    selfPlayerName = "";
    selfFactionId = "";
    opponentFactionId = "";
    tornUserBasicCapability = "unknown";
    selfIdentityLastAttemptAt = 0;
    tornStatusBackoffUntil = 0;
    tornTransportFailureStreak = 0;
    opponentMembersState = { factionId: "", members: new Map(), fetchedAt: 0 };
    currentWarSurface = null;
    prewarObservation = null;
    ownLocationState = { country: "", traveling: false, checkedAt: 0 };
    publicBasicStatusPending.clear();
    publicBasicStatusCache.clear();
  }

  function isPdaTornKeyRejectedError(body) {
    const code = Number(body?.error?.code ?? body?.code);
    const message = normalizeText(body?.error?.error ?? body?.error ?? "");
    return code === 2 || /^incorrect key$/i.test(message);
  }

  function isTornCapabilityRejectedError(body) {
    return Number(body?.error?.code ?? body?.code) === 16;
  }

  function nowMs() { return Date.now(); }
  function nowSeconds() { return Math.floor(getTornNowMs() / 1000); }
  function wait(ms) { return new Promise(resolve => window.setTimeout(resolve, ms)); }

  function median(values) {
    const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!nums.length) return null;
    const middle = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[middle] : (nums[middle - 1] + nums[middle]) / 2;
  }

  function getTornNowMs() {
    if (typeof window.getCurrentTimestamp === "function") {
      try {
        const value = window.getCurrentTimestamp();
        if (Number.isFinite(value)) return value;
      } catch {}
    }
    const offset = median(tornClockOffsetsMs);
    if (Number.isFinite(offset)) return nowMs() + offset;
    return nowMs();
  }

  function getFfscouterParityNowMs() {
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

  function isRankedWarRoute(value = location.href) {
    try {
      const url = new URL(value, location.href);
      const hashPath = String(url.hash || "")
        .slice(1)
        .split("?", 1)[0]
        .replace(/\/+$/, "");
      return (
        /\/factions\.php$/i.test(url.pathname) &&
        url.searchParams.get("step") === "your" &&
        url.searchParams.get("type") === "1" &&
        hashPath === "/war/rank"
      );
    } catch { return false; }
  }

  function isRuntimeContextEligible() {
    return !destroyed && isPageVisible() && windowFocused && isRankedWarRoute();
  }

  function isRuntimeEligible() {
    return isRuntimeContextEligible() && Boolean(canonicalPdaRankedWarSurface());
  }

  function isWarPanelPresent() {
    return Boolean(canonicalPdaRankedWarSurface());
  }

  function registerTrustedInteraction(event = null) {
    if (event && event.isTrusted !== true) return;
    lastTrustedInteractionAt = nowMs();
    if (!windowFocused && initialFocusState() && hasRecentTrustedInteraction()) windowFocused = true;
    if (!runtimeActive) reconcileLifecycle({ structural: true });
  }

  // ---------------------------------------------------------------------------
  // Own claim persistence.
  // ---------------------------------------------------------------------------

  function sanitizeOwnClaim(raw, { allowExpired = false } = {}) {
    const claimId = normalizeText(raw?.claimId);
    const targetId = String(raw?.targetId ?? "").trim();
    const claimerPlayerId = String(raw?.claimerPlayerId ?? "").trim();
    const claimerName = normalizeText(raw?.claimerName) || "You";
    const expiresAt = Number(raw?.expiresAt);
    const cleanupRequired = raw?.cleanupRequired === true;
    const createdLocalAt = Number(raw?.createdLocalAt) || 0;
    if (!isValidClaimId(claimId) || !validTargetId(targetId)) return null;
    if (claimerPlayerId && !/^\d+$/.test(claimerPlayerId)) return null;
    if (!Number.isFinite(expiresAt) || (!allowExpired && expiresAt <= nowSeconds())) return null;
    return { claimId, targetId, claimerPlayerId, claimerName, expiresAt, cleanupRequired, createdLocalAt };
  }

  function loadOwnClaimState() {
    try {
      const raw = localStorage.getItem(SCRIPT.ownClaimStorageKey);
      if (raw === null) return { ready: true, value: null };
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return { ready: false, value: null }; }
      const value = sanitizeOwnClaim(parsed);
      if (value) return { ready: true, value };
      const expired = sanitizeOwnClaim(parsed, { allowExpired: true });
      if (expired && typeof parsed?.expiresAt === "number" && expired.expiresAt <= nowSeconds()) {
        localStorage.removeItem(SCRIPT.ownClaimStorageKey);
        return {
          ready: localStorage.getItem(SCRIPT.ownClaimStorageKey) === null,
          value: null
        };
      }
      return { ready: false, value: null };
    } catch {
      return { ready: false, value: null };
    }
  }

  const ownClaimLoadState = loadOwnClaimState();
  let ownSharedClaim = ownClaimLoadState.value;

  function saveOwnClaim(value) {
    const explicitDelete = value === null;
    const nextClaim = explicitDelete ? null : sanitizeOwnClaim(value);
    if (!explicitDelete && !nextClaim) {
      claimAuthorityStorageUnresolved = true;
      claimAuthorityEvidenceUnresolved = true;
      enforceFfCredentialLock();
      return false;
    }
    ownSharedClaim = nextClaim;
    let persisted = false;
    try {
      if (ownSharedClaim) {
        const serialized = JSON.stringify(ownSharedClaim);
        localStorage.setItem(SCRIPT.ownClaimStorageKey, serialized);
        persisted = localStorage.getItem(SCRIPT.ownClaimStorageKey) === serialized;
      } else {
        localStorage.removeItem(SCRIPT.ownClaimStorageKey);
        persisted = localStorage.getItem(SCRIPT.ownClaimStorageKey) === null;
      }
    } catch {}
    if (!persisted) {
      claimAuthorityStorageUnresolved = true;
      claimAuthorityEvidenceUnresolved = true;
    }
    if (ownSharedClaim || claimAuthorityStorageUnresolved) enforceFfCredentialLock();
    return persisted;
  }

  function claimAuthorityStorageWritable() {
    const probe = `${nowMs()}:${Math.random().toString(36).slice(2)}`;
    try {
      localStorage.setItem(SCRIPT.claimStorageProbeKey, probe);
      const written = localStorage.getItem(SCRIPT.claimStorageProbeKey) === probe;
      localStorage.removeItem(SCRIPT.claimStorageProbeKey);
      const writable = written && localStorage.getItem(SCRIPT.claimStorageProbeKey) === null;
      if (!writable) claimAuthorityStorageUnresolved = true;
      return writable;
    } catch {
      try { localStorage.removeItem(SCRIPT.claimStorageProbeKey); } catch {}
      claimAuthorityStorageUnresolved = true;
      return false;
    }
  }

  function currentOwnClaim() {
    if (!ownSharedClaim) return null;
    if (Number(ownSharedClaim.expiresAt) <= nowSeconds()) {
      saveOwnClaim(null);
      ownClaimLastConfirmedAt = 0;
      return null;
    }
    return ownSharedClaim;
  }

  function sanitizeClaimQuarantine(raw, { allowExpired = false } = {}) {
    const targetId = String(raw?.targetId ?? "").trim();
    const claimId = normalizeText(raw?.claimId);
    const expectedSelfPlayerId = String(raw?.expectedSelfPlayerId ?? "").trim();
    const expiresAt = raw?.expiresAt == null ? null : Number(raw.expiresAt);
    const createdLocalAt = Number(raw?.createdLocalAt) || 0;
    if (!validTargetId(targetId) || !validTargetId(expectedSelfPlayerId)) return null;
    if (claimId && !isValidClaimId(claimId)) return null;
    if (
      expiresAt !== null &&
      (!Number.isFinite(expiresAt) || (!allowExpired && expiresAt <= nowSeconds()))
    ) return null;
    return { targetId, claimId, expectedSelfPlayerId, expiresAt, createdLocalAt };
  }

  function loadClaimQuarantineState() {
    try {
      const raw = localStorage.getItem(SCRIPT.claimQuarantineStorageKey);
      if (raw === null) return { ready: true, value: null };
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return { ready: false, value: null }; }
      const value = sanitizeClaimQuarantine(parsed);
      if (value) return { ready: true, value };
      const expired = sanitizeClaimQuarantine(parsed, { allowExpired: true });
      if (expired && typeof parsed?.expiresAt === "number" && expired.expiresAt <= nowSeconds()) {
        localStorage.removeItem(SCRIPT.claimQuarantineStorageKey);
        return {
          ready: localStorage.getItem(SCRIPT.claimQuarantineStorageKey) === null,
          value: null
        };
      }
      return { ready: false, value: null };
    } catch {
      return { ready: false, value: null };
    }
  }

  function saveClaimQuarantine(value) {
    const explicitDelete = value === null;
    const nextQuarantine = explicitDelete ? null : sanitizeClaimQuarantine(value);
    if (!explicitDelete && !nextQuarantine) {
      claimAuthorityStorageUnresolved = true;
      claimAuthorityEvidenceUnresolved = true;
      enforceFfCredentialLock();
      return false;
    }
    quarantinedClaimAcknowledgement = nextQuarantine;
    let persisted = false;
    try {
      if (quarantinedClaimAcknowledgement) {
        const serialized = JSON.stringify(quarantinedClaimAcknowledgement);
        localStorage.setItem(SCRIPT.claimQuarantineStorageKey, serialized);
        persisted = localStorage.getItem(SCRIPT.claimQuarantineStorageKey) === serialized;
      } else {
        localStorage.removeItem(SCRIPT.claimQuarantineStorageKey);
        persisted = localStorage.getItem(SCRIPT.claimQuarantineStorageKey) === null;
      }
    } catch {}
    if (!persisted) {
      claimAuthorityStorageUnresolved = true;
      claimAuthorityEvidenceUnresolved = true;
    }
    if (quarantinedClaimAcknowledgement || claimAuthorityStorageUnresolved) enforceFfCredentialLock();
    return persisted;
  }

  function currentClaimQuarantine() {
    const value = quarantinedClaimAcknowledgement;
    if (!value) return null;
    if (
      typeof value.expiresAt === "number" &&
      Number.isFinite(value.expiresAt) &&
      value.expiresAt <= nowSeconds()
    ) {
      saveClaimQuarantine(null);
      return null;
    }
    return value;
  }

  function captureCredentialRecoveryEvidence() {
    const own = currentOwnClaim();
    const quarantine = currentClaimQuarantine();
    return {
      own: own ? {
        claimId: own.claimId,
        targetId: own.targetId,
        claimerPlayerId: own.claimerPlayerId,
        claimerName: own.claimerName,
        expiresAt: own.expiresAt,
        cleanupRequired: own.cleanupRequired,
        createdLocalAt: own.createdLocalAt
      } : null,
      quarantine: quarantine ? {
        targetId: quarantine.targetId,
        claimId: quarantine.claimId,
        expectedSelfPlayerId: quarantine.expectedSelfPlayerId,
        expiresAt: quarantine.expiresAt,
        createdLocalAt: quarantine.createdLocalAt
      } : null
    };
  }

  function credentialRecoveryEvidenceFingerprint(evidence = captureCredentialRecoveryEvidence()) {
    return JSON.stringify(evidence);
  }

  function credentialRecoveryEvidenceActive(evidence = captureCredentialRecoveryEvidence()) {
    return Boolean(evidence.own || evidence.quarantine);
  }

  function credentialRecoveryExpectedPlayerId(evidence) {
    const ids = [];
    if (evidence?.own) {
      if (!validTargetId(evidence.own.claimerPlayerId)) return null;
      ids.push(String(evidence.own.claimerPlayerId));
    }
    if (evidence?.quarantine) {
      if (!validTargetId(evidence.quarantine.expectedSelfPlayerId)) return null;
      ids.push(String(evidence.quarantine.expectedSelfPlayerId));
    }
    if (!ids.length) return "";
    return new Set(ids).size === 1 ? ids[0] : null;
  }

  function credentialRecoveryChangeAvailable() {
    const evidence = captureCredentialRecoveryEvidence();
    return Boolean(
      (evidence.own || evidence.quarantine) &&
      credentialRecoveryExpectedPlayerId(evidence) &&
      !claimAuthorityEvidenceUnresolved &&
      !sharedWriteBusy &&
      !ffCredentialMutationInProgress &&
      !tornCredentialMutationInProgress
    );
  }

  const claimQuarantineLoadState = loadClaimQuarantineState();
  quarantinedClaimAcknowledgement = claimQuarantineLoadState.value;
  claimAuthorityEvidenceUnresolved =
    !ownClaimLoadState.ready || !claimQuarantineLoadState.ready;
  claimAuthorityStorageUnresolved =
    claimAuthorityEvidenceUnresolved || !claimAuthorityStorageWritable();

  function ffCredentialChangeBusy() {
    return ffCredentialMutationInProgress;
  }

  function ffCredentialClaimLockActive() {
    return Boolean(currentOwnClaim()) || Boolean(currentClaimQuarantine()) ||
      claimAuthorityStorageUnresolved || ambiguousOwnServerClaims || sharedWriteBusy;
  }

  function ffCredentialOwnershipProofCurrent() {
    if (!sharedApiKey) return true;
    return validTargetId(selfPlayerId) && sharedClaimsVerifiedAt > 0 &&
      nowMs() - sharedClaimsVerifiedAt <= CONFIG.sharedPollMs * 2 &&
      activeSharedClaimsForClaimer(selfPlayerId).length === 0;
  }

  function newClaimStorageAuthorityReady() {
    return apiKeyStorageReady && !ffCredentialStorageUnresolved &&
      !tornCredentialStorageUnresolved && !claimAuthorityStorageUnresolved;
  }

  function ffCredentialExternalLockActive() {
    if (!apiKeyStorageReady || ffCredentialStorageUnresolved || claimAuthorityStorageUnresolved) return true;
    if (sharedWriteBusy || ambiguousOwnServerClaims || tornCredentialMutationInProgress) return true;
    const recoveryEvidence = captureCredentialRecoveryEvidence();
    if (credentialRecoveryEvidenceActive(recoveryEvidence)) return true;
    if (!sharedApiKey) return false;
    return !sharedCredentialRejected && !ffCredentialOwnershipProofCurrent();
  }

  function tornCredentialExternalLockActive() {
    if (!apiKeyStorageReady || tornCredentialStorageUnresolved) return true;
    if (sharedWriteBusy || ffCredentialMutationInProgress) return true;
    if (claimAuthorityEvidenceUnresolved) return true;
    const recoveryEvidence = captureCredentialRecoveryEvidence();
    if (recoveryEvidence.own?.cleanupRequired === true) return true;
    if (credentialRecoveryEvidenceActive(recoveryEvidence)) {
      return !credentialRecoveryChangeAvailable();
    }
    if (ffCredentialStorageUnresolved || claimAuthorityStorageUnresolved) return true;
    if (ambiguousOwnServerClaims) return true;
    const currentKey = effectiveTornApiKey();
    if (!currentKey) return false;
    const rejectedStoredKey =
      (storedTornCredentialRejected || storedTornCapabilityRejected) &&
      currentKey === validateTornApiKey(storedTornApiKey);
    if (rejectedStoredKey) return false;
    if (!sharedApiKey) return true;
    return !ffCredentialOwnershipProofCurrent();
  }

  function ffCredentialForgetLockActive() {
    return ffCredentialExternalLockActive() || ffCredentialClaimLockActive() ||
      credentialRecoveryEvidenceActive();
  }

  function tornCredentialForgetLockActive() {
    return !apiKeyStorageReady || tornCredentialStorageUnresolved ||
      ffCredentialStorageUnresolved || claimAuthorityStorageUnresolved ||
      claimAuthorityEvidenceUnresolved || sharedWriteBusy ||
      ffCredentialMutationInProgress || tornCredentialMutationInProgress ||
      ffCredentialClaimLockActive() || credentialRecoveryEvidenceActive() ||
      !sharedApiKey || !ffCredentialOwnershipProofCurrent();
  }

  function closeFfCredentialEditor() {
    presentationShadow()?.querySelector("[data-role='key-editor']")?.classList.remove("open");
  }

  function enforceFfCredentialLock() {
    if (!ffCredentialExternalLockActive()) return false;
    closeFfCredentialEditor();
    updatePanel();
    return true;
  }

  function beginFfCredentialEdit() {
    registerTrustedInteraction();
    if (ffCredentialChangeBusy() || ffCredentialExternalLockActive()) {
      closeFfCredentialEditor();
      setSharedStatus("error", "Shared: key change locked while DIBS ownership is active or unresolved");
      return false;
    }
    presentationShadow()?.querySelector("[data-role='key-editor']")?.classList.add("open");
    updatePanel();
    return true;
  }

  function closeTornCredentialEditor() {
    presentationShadow()?.querySelector("[data-role='torn-key-editor']")?.classList.remove("open");
  }

  function beginTornCredentialEdit() {
    registerTrustedInteraction();
    if (injectedPdaTornApiKey() || tornCredentialMutationInProgress || tornCredentialExternalLockActive()) {
      closeTornCredentialEditor();
      if (!injectedPdaTornApiKey()) {
        setTornStatusState("error", "Torn: key change locked while DIBS ownership is active or unresolved");
      }
      return false;
    }
    presentationShadow()?.querySelector("[data-role='torn-key-editor']")?.classList.add("open");
    updatePanel();
    return true;
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
    let db = null;
    try {
      db = await openSecureVault();
      const cryptoKey = await getOrCreateVaultCryptoKey(db);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(value);
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext);
      await vaultPut(db, id, { v: 1, iv: Array.from(iv), ciphertext });
      return true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  async function loadCipher(id, validator) {
    let db = null;
    try {
      db = await openSecureVault();
      const payload = await vaultGet(db, id);
      const key = await vaultGet(db, SCRIPT.secureVaultCryptoKeyId);
      if (!payload || payload.v !== 1 || !Array.isArray(payload.iv) || !payload.ciphertext) return "";
      if (typeof CryptoKey === "undefined" || !(key instanceof CryptoKey)) return "";
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(payload.iv) }, key, payload.ciphertext);
      return validator(new TextDecoder().decode(plaintext));
    } catch {
      return "";
    } finally {
      db?.close();
    }
  }

  async function loadCipherState(id, validator) {
    let db = null;
    try {
      db = await openSecureVault();
      const payload = await vaultGet(db, id);
      if (payload === undefined || payload === null) return { ready: true, key: "" };
      const cryptoKey = await vaultGet(db, SCRIPT.secureVaultCryptoKeyId);
      if (
        !payload || payload.v !== 1 || !Array.isArray(payload.iv) || !payload.ciphertext ||
        typeof CryptoKey === "undefined" || !(cryptoKey instanceof CryptoKey)
      ) return { ready: false, key: "" };
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(payload.iv) },
        cryptoKey,
        payload.ciphertext
      );
      const key = validator(new TextDecoder().decode(plaintext));
      return key ? { ready: true, key } : { ready: false, key: "" };
    } catch {
      return { ready: false, key: "" };
    } finally {
      db?.close();
    }
  }

  async function deleteCipher(id) {
    let db = null;
    try {
      db = await openSecureVault();
      return await vaultDelete(db, [id]);
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  const saveSecureApiKey = key => saveCipher(SCRIPT.secureVaultCipherId, validateFfscouterKey(key));
  const deleteSecureApiKey = () => deleteCipher(SCRIPT.secureVaultCipherId);
  const saveSecureApiKeyRollback = key => saveCipher(SCRIPT.secureVaultRollbackCipherId, validateFfscouterKey(key));
  const loadSecureApiKeyRollback = () => loadCipher(SCRIPT.secureVaultRollbackCipherId, validateFfscouterKey);
  const deleteSecureApiKeyRollback = () => deleteCipher(SCRIPT.secureVaultRollbackCipherId);

  function readSharedApiChangeJournal() {
    try {
      const raw = localStorage.getItem(SCRIPT.sharedApiChangeJournalKey);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && typeof parsed.oldPresent === "boolean") {
        return { valid: true, oldPresent: parsed.oldPresent };
      }
      return { valid: false, oldPresent: false };
    } catch {
      return { valid: false, oldPresent: false };
    }
  }

  function writeSharedApiChangeJournal(oldPresent) {
    try {
      const value = JSON.stringify({ version: 1, oldPresent: oldPresent === true });
      localStorage.setItem(SCRIPT.sharedApiChangeJournalKey, value);
      return localStorage.getItem(SCRIPT.sharedApiChangeJournalKey) === value;
    } catch {
      return false;
    }
  }

  function clearSharedApiChangeJournal() {
    try {
      localStorage.removeItem(SCRIPT.sharedApiChangeJournalKey);
      return localStorage.getItem(SCRIPT.sharedApiChangeJournalKey) === null;
    } catch {
      return false;
    }
  }

  async function prepareSharedApiChangeJournal(oldKey, isCurrent) {
    if (!isCurrent()) {
      const cleaned = await deleteSecureApiKeyRollback();
      if (!cleaned) ffCredentialStorageUnresolved = true;
      return false;
    }
    const rollbackReady = oldKey
      ? await saveSecureApiKeyRollback(oldKey)
      : await deleteSecureApiKeyRollback();
    if (!rollbackReady) {
      ffCredentialStorageUnresolved = true;
      return false;
    }
    if (!isCurrent()) {
      const cleaned = await deleteSecureApiKeyRollback();
      if (!cleaned) ffCredentialStorageUnresolved = true;
      return false;
    }
    const written = writeSharedApiChangeJournal(Boolean(oldKey));
    if (!written) {
      const cleaned = await deleteSecureApiKeyRollback();
      ffCredentialStorageUnresolved = true;
      if (!cleaned) enforceFfCredentialLock();
      return false;
    }
    return true;
  }

  async function restoreSharedApiChangeJournal() {
    const journal = readSharedApiChangeJournal();
    if (journal === null) {
      const cleaned = await deleteSecureApiKeyRollback();
      if (!cleaned) ffCredentialStorageUnresolved = true;
      return cleaned;
    }
    if (!journal.valid) {
      ffCredentialStorageUnresolved = true;
      return false;
    }
    if (journal.oldPresent) {
      const oldKey = await loadSecureApiKeyRollback();
      if (!oldKey || !(await saveSecureApiKey(oldKey))) {
        ffCredentialStorageUnresolved = true;
        return false;
      }
    } else if (!(await deleteSecureApiKey())) {
      ffCredentialStorageUnresolved = true;
      return false;
    }
    if (!clearSharedApiChangeJournal()) {
      ffCredentialStorageUnresolved = true;
      return false;
    }
    const cleaned = await deleteSecureApiKeyRollback();
    if (!cleaned) ffCredentialStorageUnresolved = true;
    return true;
  }

  async function restoreSharedApiChangeToKnownKey(oldKey) {
    const restored = oldKey
      ? await saveSecureApiKey(oldKey)
      : await deleteSecureApiKey();
    if (!restored) {
      ffCredentialStorageUnresolved = true;
      return false;
    }
    if (!clearSharedApiChangeJournal()) {
      ffCredentialStorageUnresolved = true;
      return false;
    }
    const cleaned = await deleteSecureApiKeyRollback();
    if (!cleaned) ffCredentialStorageUnresolved = true;
    return cleaned;
  }

  async function commitSharedApiChangeJournal() {
    if (!clearSharedApiChangeJournal()) return false;
    const cleaned = await deleteSecureApiKeyRollback();
    return cleaned;
  }

  async function loadSecureApiKey() {
    const journal = readSharedApiChangeJournal();
    if (journal === null) {
      const loaded = await loadCipherState(SCRIPT.secureVaultCipherId, validateFfscouterKey);
      if (!loaded.ready) return loaded;
      const cleaned = await deleteSecureApiKeyRollback();
      return { ready: cleaned, key: loaded.key };
    }
    if (!journal.valid) return { ready: false, key: "" };
    if (!journal.oldPresent) {
      if (!(await deleteSecureApiKey()) || !clearSharedApiChangeJournal()) {
        return { ready: false, key: "" };
      }
      const cleaned = await deleteSecureApiKeyRollback();
      return { ready: cleaned, key: "" };
    }
    const rollback = await loadCipherState(
      SCRIPT.secureVaultRollbackCipherId,
      validateFfscouterKey
    );
    if (!rollback.ready || !rollback.key) return { ready: false, key: "" };
    if (!(await saveSecureApiKey(rollback.key)) || !clearSharedApiChangeJournal()) {
      return { ready: false, key: rollback.key };
    }
    const cleaned = await deleteSecureApiKeyRollback();
    return { ready: cleaned, key: rollback.key };
  }

  const saveSecureTornApiKey = key => saveCipher(SCRIPT.tornApiCipherId, validateTornApiKey(key));
  const loadSecureTornApiKey = () => loadCipherState(SCRIPT.tornApiCipherId, validateTornApiKey);
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

  async function hitApiRequest(path, { method = "GET", body = null, apiKey = sharedApiKey } = {}) {
    if (!Object.values(HIT_API).includes(path)) throw new Error("Blocked non-allowlisted FFScouter endpoint");
    const requestApiKey = validateFfscouterKey(apiKey);
    if (!requestApiKey) throw new Error("FFScouter key required");
    const url = new URL(path, SCRIPT.ffscouterOrigin);
    url.searchParams.set("key", requestApiKey);
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

  function isExplicitFfCredentialRejection(result) {
    const status = Number(result?.status);
    return status === 401 || status === 403;
  }

  async function hitApiWriteWithBusyRetry(path, body, isCurrent = () => true, apiKey = sharedApiKey) {
    let lastResult = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!isCurrent()) return lastResult;
      lastResult = await hitApiRequest(path, { method: "POST", body, apiKey });
      if (!isCurrent()) return lastResult;
      if (lastResult.ok) return lastResult;
      const delay = retryDelayMs(lastResult);
      if (!delay || attempt === 1) return lastResult;
      await wait(delay);
      if (!isCurrent()) return lastResult;
    }
    return lastResult;
  }

  async function fairFightStatsRequest(targetIds, { initial = false, isCurrent = () => true, apiKey = sharedApiKey } = {}) {
    const ids = [...new Set(targetIds.map(String).filter(validTargetId))]
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, CONFIG.fairFightMaxTargets);
    if (!ids.length) return { ok: true, status: 200, body: { stats: [] } };
    const requestApiKey = validateFfscouterKey(apiKey);
    if (!requestApiKey) return { ok: false, status: 0, body: { error: "FFScouter key required" } };
    const url = new URL(STATS_API.getStats, SCRIPT.ffscouterOrigin);
    url.searchParams.set("key", requestApiKey);
    url.searchParams.set("targets", ids.join(","));
    const maxAttempts = initial ? CONFIG.fairFightInitialTransportRetryAttempts : CONFIG.sharedTransportRetryAttempts;
    const requestTimeout = initial ? CONFIG.fairFightInitialRequestTimeoutMs : CONFIG.requestTimeoutMs;
    let result = null;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      if (!isCurrent()) return result;
      result = await gmXhr({ method: "GET", url: url.toString(), headers: { Accept: "application/json" }, timeout: requestTimeout });
      if (!isCurrent()) return result;
      if (result.ok || result.status !== 0 || attempt >= maxAttempts) break;
      await wait(CONFIG.sharedTransportRetryDelayMs * (attempt + 1));
      if (!isCurrent()) return result;
    }
    return { ...result, body: parseJsonSafe(result?.responseText) };
  }

  function handleRejectedInjectedTornKey(key, body) {
    const injectedKey = validateTornApiKey(rawInjectedPdaTornApiKey());
    if (!injectedKey || key !== injectedKey || pdaTornApiKeyRejected || !isPdaTornKeyRejectedError(body)) {
      return false;
    }
    pdaTornApiKeyRejected = true;
    if (validateTornApiKey(storedTornApiKey) === injectedKey) storedTornApiKey = "";
    invalidateTornCredentialRequests();
    const fallback = validateTornApiKey(storedTornApiKey);
    if (fallback) {
      setTornStatusState("identity", "Torn: PDA key rejected; checking saved key", 0);
      window.setTimeout(() => {
        if (runtimeActive && isRuntimeEligible() && effectiveTornApiKey() === fallback) {
          void fetchTornStatuses({ force: true });
        }
      }, 0);
    } else {
      setTornStatusState("key-required", "Torn: PDA key rejected; API key required", 0);
    }
    return true;
  }

  async function tornApiRequest(path, key, { cacheBust = false, trackCredentialState = true } = {}) {
    const isUserBasic = /^\/v2\/user\/\d+\/basic$/.test(path);
    const isOwnFactionWars = path === SCRIPT.tornOwnWarsPath;
    const isOpponentMembers = /^\/v2\/faction\/\d+\/members$/.test(path);
    if (path !== SCRIPT.tornKeyInfoPath && !isUserBasic && !isOwnFactionWars && !isOpponentMembers) {
      throw new Error("Blocked non-allowlisted Torn API endpoint");
    }
    const apiKey = validateTornApiKey(key);
    if (!apiKey) return { ok: false, status: 0, body: { error: { error: "API key required" } } };
    const observationSerial = trackCredentialState ? ++tornCredentialObservationSerial : 0;
    const credentialEpochAtRequest = tornCredentialEpoch;
    const storedKeyAtRequest = validateTornApiKey(storedTornApiKey);
    const injectedKeyAtRequest = validateTornApiKey(rawInjectedPdaTornApiKey());
    const storedKeyRequest = Boolean(storedKeyAtRequest) && apiKey === storedKeyAtRequest;
    const injectedKeyRequest = Boolean(injectedKeyAtRequest) && apiKey === injectedKeyAtRequest;
    const url = new URL(path, SCRIPT.tornApiOrigin);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("comment", "KS_Torn_War_Dibs_PDA_v15145");
    if (cacheBust) url.searchParams.set("timestamp", String(nowMs()));
    const headers = cacheBust
      ? { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" }
      : { Accept: "application/json" };
    const result = await gmXhr({ method: "GET", url: url.toString(), headers });
    const body = parseJsonSafe(result.responseText);
    const rejected = isPdaTornKeyRejectedError(body);
    const capabilityRejected = isTornCapabilityRejectedError(body);
    const successfulObservation = result.ok && !body?.error;
    const successfulCredentialObservation =
      successfulObservation && path === SCRIPT.tornKeyInfoPath;
    const storedObservationCurrent = storedKeyRequest &&
      validateTornApiKey(storedTornApiKey) === storedKeyAtRequest;
    const injectedObservationCurrent = injectedKeyRequest &&
      validateTornApiKey(rawInjectedPdaTornApiKey()) === injectedKeyAtRequest;
    const epochCurrent = credentialEpochAtRequest === tornCredentialEpoch;
    const keyValidityObservationCurrent =
      trackCredentialState && epochCurrent &&
      (storedObservationCurrent || injectedObservationCurrent) &&
      (rejected || capabilityRejected || successfulCredentialObservation) &&
      observationSerial > lastTornKeyValidityObservationSerial;
    if (keyValidityObservationCurrent) {
      lastTornKeyValidityObservationSerial = observationSerial;
      if (storedObservationCurrent) {
        if (rejected) storedTornCredentialRejected = true;
        else if (successfulCredentialObservation || capabilityRejected) storedTornCredentialRejected = false;
      }
      if (injectedObservationCurrent && rejected) handleRejectedInjectedTornKey(apiKey, body);
    }
    if (
      trackCredentialState && epochCurrent && storedObservationCurrent &&
      (rejected || capabilityRejected) &&
      observationSerial > lastTornCapabilityAuthoritySerial
    ) {
      lastTornCapabilityAuthoritySerial = observationSerial;
      storedTornCapabilityRejected = capabilityRejected;
    }
    return {
      ...result,
      body,
      credentialObservation: trackCredentialState
        ? { serial: observationSerial, epoch: credentialEpochAtRequest, storedKeyRequest }
        : null
    };
  }

  function normalizeSelfIdentity(payload) {
    if (!isPlainRecord(payload) || payload.error || !isPlainRecord(payload.info)) return null;
    const user = payload.info.user;
    if (!isPlainRecord(user)) return null;
    if (
      !Object.prototype.hasOwnProperty.call(user, "id") ||
      !Object.prototype.hasOwnProperty.call(user, "faction_id") ||
      !Object.prototype.hasOwnProperty.call(user, "company_id") ||
      !isInt32(user.id, { positive: true }) ||
      !isInt32(user.faction_id, { positive: true }) ||
      (user.company_id !== null && !isInt32(user.company_id, { positive: true }))
    ) return null;
    const factionId = String(user.faction_id);
    for (const source of [user.faction, payload.info.faction]) {
      if (source === undefined) continue;
      if (!isPlainRecord(source) || !isInt32(source.id, { positive: true }) || String(source.id) !== factionId) return null;
    }
    return {
      playerId: String(user.id),
      playerName: normalizeText(user.name),
      factionId
    };
  }

  function tornErrorMessage(result, fallback) {
    const detail = result?.body?.error;
    const apiCode = Number(detail && typeof detail === "object" && !Array.isArray(detail) ? detail.code : NaN);
    if (Number.isSafeInteger(apiCode) && apiCode >= 0) return `${fallback} (API ${apiCode})`;
    const status = Number(result?.status);
    return Number.isInteger(status) && status > 0 ? `${fallback} (HTTP ${status})` : fallback;
  }

  function normalizeSelfBasicCapability(payload, expectedPlayerId) {
    if (!isPlainRecord(payload) || payload.error || !isPlainRecord(payload.profile)) return false;
    return Boolean(isInt32(payload.profile.id, { positive: true }) && String(payload.profile.id) === String(expectedPlayerId));
  }

  function commitStoredTornCapabilitySuccess(key, result, authorityWatermark) {
    const observation = result?.credentialObservation;
    if (
      !observation?.storedKeyRequest ||
      observation.epoch !== tornCredentialEpoch ||
      validateTornApiKey(key) !== validateTornApiKey(storedTornApiKey) ||
      observation.serial <= authorityWatermark ||
      lastTornCapabilityAuthoritySerial !== authorityWatermark
    ) return false;
    lastTornCapabilityAuthoritySerial = observation.serial;
    storedTornCapabilityRejected = false;
    return true;
  }

  async function verifyTornOperationalCapabilities({ key, identity, force, isCurrent, trackCredentialState = true }) {
    const surface = operationalWarSurfaceForFaction(identity.factionId);
    if (!surface) throw new Error("Ranked War opponent unavailable for capability check");
    const capabilityAuthorityWatermark = lastTornCapabilityAuthoritySerial;
    const operationCurrent = () => {
      if (!isCurrent()) return false;
      if (!operationalWarSurfaceMatches(surface)) throw new Error("Ranked War surface changed during capability check");
      return true;
    };
    const readCapability = async (path, label) => {
      if (!operationCurrent()) return null;
      const result = await tornApiRequest(path, key, { cacheBust: force, trackCredentialState });
      if (!operationCurrent()) return null;
      if (!result?.ok || result.body?.error) {
        throw new Error(tornErrorMessage(result, `${label} capability unavailable`));
      }
      return result;
    };

    const warsResult = await readCapability(SCRIPT.tornOwnWarsPath, "faction wars");
    if (!warsResult) return null;
    const warsFetchedAt = Number(warsResult.endedAt) || nowMs();
    if (!normalizeOwnWars(warsResult.body, warsFetchedAt, surface)) {
      throw new Error("faction wars capability response malformed");
    }
    const membersResult = await readCapability(`/v2/faction/${surface.opponentFactionId}/members`, "opponent members");
    if (!membersResult) return null;
    const members = normalizeTornMembers(membersResult.body);
    if (!(members instanceof Map)) throw new Error("opponent members capability response malformed");
    const basicResult = await readCapability(`/v2/user/${identity.playerId}/basic`, "user basic");
    if (!basicResult) return null;
    if (!normalizeSelfBasicCapability(basicResult.body, identity.playerId)) {
      throw new Error("user basic capability response malformed");
    }
    if (
      trackCredentialState &&
      !commitStoredTornCapabilitySuccess(key, basicResult, capabilityAuthorityWatermark)
    ) {
      throw new Error("Torn capability authority changed during verification");
    }
    return {
      surface,
      warsResult,
      warsFetchedAt,
      members,
      membersFetchedAt: Number(membersResult.endedAt) || nowMs()
    };
  }

  async function tornCandidateKeyProvesRecovery(key, evidence, isCurrent) {
    if (!isCurrent()) return false;
    try {
      const identityResult = await tornApiRequest(SCRIPT.tornKeyInfoPath, key, {
        cacheBust: true,
        trackCredentialState: false
      });
      if (!isCurrent() || !identityResult?.ok || identityResult.body?.error) return false;
      const identity = normalizeSelfIdentity(identityResult.body);
      if (!identity) return false;
      const expectedPlayerId = credentialRecoveryExpectedPlayerId(evidence);
      if (expectedPlayerId === null) return false;
      if (credentialRecoveryEvidenceActive(evidence) && !expectedPlayerId) return false;
      if (expectedPlayerId && identity.playerId !== expectedPlayerId) return false;
      const operational = await verifyTornOperationalCapabilities({
        key,
        identity,
        force: true,
        isCurrent,
        trackCredentialState: false
      });
      return Boolean(isCurrent() && operational);
    } catch {
      return false;
    }
  }

  async function fetchSelfIdentity({ force = false } = {}) {
    const key = effectiveTornApiKey();
    if (!key || selfIdentitySyncing) return false;
    if (!force && validTargetId(selfPlayerId) && validTargetId(selfFactionId) && keyScopeReady) return true;
    if (!force && selfIdentityLastAttemptAt > 0 && nowMs() - selfIdentityLastAttemptAt < 30000) return false;
    setTornStatusState("identity", "Torn: checking key identity…");

    const generation = runtimeGeneration;
    const credentialEpoch = tornCredentialEpoch;
    const requestSerial = ++selfIdentityRequestSerial;
    let verifiedIdentity = null;
    selfIdentitySyncing = true;
    selfIdentityLastAttemptAt = nowMs();
    const isCurrentRequest = () => (
      requestSerial === selfIdentityRequestSerial &&
      credentialEpoch === tornCredentialEpoch &&
      generation === runtimeGeneration &&
      key === effectiveTornApiKey() &&
      runtimeActive &&
      isRuntimeEligible()
    );
    try {
      const identityResult = await tornApiRequest(SCRIPT.tornKeyInfoPath, key, { cacheBust: force });
      if (!isCurrentRequest()) return false;
      if (!identityResult?.ok || identityResult.body?.error) {
        throw new Error(tornErrorMessage(identityResult, "Key identity unavailable"));
      }
      const identity = normalizeSelfIdentity(identityResult.body);
      if (!identity) throw new Error("Key identity response malformed");
      verifiedIdentity = identity;
      const operational = await verifyTornOperationalCapabilities({ key, identity, force, isCurrent: isCurrentRequest });
      if (!isCurrentRequest() || !operational) return false;
      const identityChanged = selfPlayerId !== identity.playerId || selfFactionId !== identity.factionId;
      if (identityChanged) {
        invalidateOwnWarsState();
        opponentMembersState = { factionId: "", members: new Map(), fetchedAt: 0 };
      }
      selfPlayerId = identity.playerId;
      selfPlayerName = identity.playerName;
      selfFactionId = identity.factionId;
      refreshCurrentWarSurface({ structural: true });
      const committedSurface = captureCurrentWarSurface();
      if (
        !committedSurface ||
        committedSurface.card !== operational.surface.card ||
        committedSurface.warId !== operational.surface.warId ||
        committedSurface.opponentFactionId !== operational.surface.opponentFactionId ||
        committedSurface.selfFactionId !== operational.surface.selfFactionId
      ) throw new Error("Ranked War surface changed during capability check");
      const committedWars = normalizeOwnWars(operational.warsResult.body, operational.warsFetchedAt, committedSurface);
      if (!committedWars) throw new Error("faction wars capability response malformed");
      recordTornClockOffset(operational.warsResult, operational.warsResult.body);
      ownWarsState = committedWars;
      opponentMembersState = {
        factionId: committedSurface.opponentFactionId,
        members: operational.members,
        fetchedAt: operational.membersFetchedAt
      };
      keyScopeReady = true;
      void fetchPublicBasicStatus(selfPlayerId);
      reconcileOwnClaimFromShared();
      scanWarRows();
      updatePanel();
      return true;
    } catch (error) {
      if (isCurrentRequest()) {
        const retainVerifiedIdentity = Boolean(
          verifiedIdentity && !storedTornCredentialRejected
        );
        keyScopeReady = false;
        selfPlayerId = retainVerifiedIdentity ? verifiedIdentity.playerId : "";
        selfPlayerName = retainVerifiedIdentity ? verifiedIdentity.playerName : "";
        selfFactionId = retainVerifiedIdentity ? verifiedIdentity.factionId : "";
        opponentFactionId = "";
        invalidateOwnWarsState();
        opponentMembersState = { factionId: "", members: new Map(), fetchedAt: 0 };
        currentWarSurface = null;
        ownLocationState = { country: "", traveling: false, checkedAt: 0 };
        publicBasicStatusCache.clear();
        if (retainVerifiedIdentity) reconcileOwnClaimFromShared();
        setTornStatusState("error", `Torn: ${normalizeText(error?.message) || "key validation failed"}`, 0);
        scanWarRows();
        updatePanel();
      }
      return false;
    } finally {
      if (requestSerial === selfIdentityRequestSerial && credentialEpoch === tornCredentialEpoch && key === effectiveTornApiKey()) {
        selfIdentitySyncing = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shared FFScouter queue
  // ---------------------------------------------------------------------------

  function normalizeSharedClaims(payload) {
    const faction = payload?.claims?.faction;
    const result = new Map();
    const seenClaimIds = new Set();
    if (Array.isArray(faction)) return faction.length === 0 ? result : null;
    if (!isPlainRecord(faction)) return null;
    for (const [rawTargetId, rawQueue] of Object.entries(faction)) {
      const targetId = String(rawTargetId || "").trim();
      if (targetId !== String(Number(targetId)) || !validTargetId(targetId) || !Array.isArray(rawQueue) || !rawQueue.length) return null;
      const queue = rawQueue.map((claim, index) => {
        if (!isPlainRecord(claim) || !isPlainRecord(claim.claimer)) return null;
        const claimId = normalizeText(claim?.claim_id);
        const claimerId = String(claim?.claimer?.player_id ?? "").trim();
        const claimerName = normalizeText(claim?.claimer?.name);
        const createdAt = Number(claim?.created_at);
        const expiresAt = Number(claim?.expires_at);
        if (
          !isValidClaimId(claimId) || seenClaimIds.has(claimId) ||
          claimerId !== String(Number(claimerId)) || !validTargetId(claimerId) || !claimerName ||
          !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt
        ) return null;
        seenClaimIds.add(claimId);
        return { claimId, position: index + 1, createdAt, expiresAt, claimer: { playerId: claimerId, name: claimerName } };
      });
      if (queue.some(item => item === null)) return null;
      result.set(targetId, queue);
    }
    return result;
  }

  async function ffCandidateKeyIsOperational(key, isCurrent) {
    if (!isCurrent()) return false;
    const result = await hitApiRequest(HIT_API.claims, { method: "GET", apiKey: key });
    if (!isCurrent() || !result?.ok) return false;
    const claims = normalizeSharedClaims(result.body);
    return Boolean(isCurrent() && claims instanceof Map);
  }

  function findSharedClaimById(claimId) {
    if (!isValidClaimId(claimId)) return null;
    for (const [targetId, queue] of sharedClaims.entries()) {
      const claim = Array.isArray(queue) ? queue.find(item => item?.claimId === claimId) : null;
      if (claim) return { targetId, claim, queue };
    }
    return null;
  }

  function exactSharedProofForOwnClaim(own = currentOwnClaim()) {
    if (
      !own || !validTargetId(selfPlayerId) ||
      own.claimerPlayerId !== String(selfPlayerId)
    ) return null;
    const found = findSharedClaimById(own.claimId);
    if (
      !found || found.targetId !== own.targetId ||
      found.claim.claimer.playerId !== String(selfPlayerId)
    ) return null;
    return found;
  }

  function quarantineAllowsExactOwnRelease(
    own,
    quarantine = currentClaimQuarantine()
  ) {
    if (!quarantine) return true;
    if (
      !own || !validTargetId(selfPlayerId) ||
      own.claimerPlayerId !== String(selfPlayerId)
    ) return false;
    return quarantine.targetId === own.targetId &&
      quarantine.expectedSelfPlayerId === String(selfPlayerId) &&
      (!quarantine.claimId || quarantine.claimId === own.claimId);
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
    queue.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
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
    if (
      sharedClaimsVerifiedAt <= 0 ||
      currentOwnClaim() ||
      currentClaimQuarantine() ||
      !validTargetId(selfPlayerId)
    ) return false;
    const matches = activeSharedClaimsForClaimer(selfPlayerId);
    ambiguousOwnServerClaims = matches.length > 1;
    if (matches.length !== 1) return false;
    const { targetId, claim } = matches[0];
    if (!validTargetId(targetId) || !isValidClaimId(claim?.claimId)) return false;
    saveOwnClaim({
      claimId: claim.claimId,
      targetId,
      claimerPlayerId: selfPlayerId,
      claimerName: normalizeText(claim?.claimer?.name) || selfPlayerName || "You",
      expiresAt: claim.expiresAt,
      cleanupRequired: Number(claim.position) > 1,
      createdLocalAt: nowMs()
    });
    ownClaimLastConfirmedAt = sharedClaimsVerifiedAt;
    return true;
  }

  function reconcileClaimQuarantineFromShared() {
    if (sharedClaimsVerifiedAt <= 0) return;
    const quarantine = currentClaimQuarantine();
    if (!quarantine || !validTargetId(selfPlayerId)) return;
    if (String(selfPlayerId) !== quarantine.expectedSelfPlayerId) return;
    let proven = null;
    if (isValidClaimId(quarantine.claimId)) {
      const found = findSharedClaimById(quarantine.claimId);
      if (found && found.claim.claimer.playerId === selfPlayerId) {
        if (found.claim.expiresAt <= nowSeconds()) {
          saveClaimQuarantine(null);
          return;
        }
        proven = found;
      }
    } else {
      const matches = activeSharedClaimsForClaimer(selfPlayerId)
        .filter(item => item.targetId === quarantine.targetId);
      if (matches.length === 1) proven = { ...matches[0], queue: sharedClaims.get(matches[0].targetId) };
      if (matches.length > 1) ambiguousOwnServerClaims = true;
    }
    if (!proven) return;
    const existingOwn = currentOwnClaim();
    if (existingOwn) {
      if (
        existingOwn.claimId === proven.claim.claimId &&
        (!existingOwn.claimerPlayerId || existingOwn.claimerPlayerId === String(selfPlayerId))
      ) {
        const persisted = saveOwnClaim({
          ...existingOwn,
          targetId: proven.targetId,
          claimerPlayerId: selfPlayerId,
          claimerName: proven.claim.claimer.name || selfPlayerName || "You",
          expiresAt: proven.claim.expiresAt,
          cleanupRequired: Number(proven.claim.position) > 1
        });
        const committed = currentOwnClaim();
        if (
          persisted &&
          committed?.claimId === proven.claim.claimId &&
          committed.targetId === proven.targetId &&
          committed.claimerPlayerId === String(selfPlayerId)
        ) saveClaimQuarantine(null);
      }
      return;
    }
    const persisted = saveOwnClaim({
      claimId: proven.claim.claimId,
      targetId: proven.targetId,
      claimerPlayerId: selfPlayerId,
      claimerName: proven.claim.claimer.name || selfPlayerName || "You",
      expiresAt: proven.claim.expiresAt,
      cleanupRequired: Number(proven.claim.position) > 1,
      createdLocalAt: nowMs()
    });
    ownClaimLastConfirmedAt = sharedClaimsVerifiedAt;
    if (persisted && currentOwnClaim()?.claimId === proven.claim.claimId) {
      saveClaimQuarantine(null);
    }
  }

  function reconcileOwnClaimFromShared() {
    if (sharedClaimsVerifiedAt <= 0) return;
    ambiguousOwnServerClaims = activeSharedClaimsForClaimer(selfPlayerId).length > 1;
    reconcileClaimQuarantineFromShared();
    if (currentClaimQuarantine()) {
      ownClaimLastConfirmedAt = 0;
      return;
    }
    let own = currentOwnClaim();
    if (!own) {
      adoptSingleOwnServerClaim();
      own = currentOwnClaim();
    }
    if (!own) { ownClaimLastConfirmedAt = 0; return; }
    const found = findSharedClaimById(own.claimId);
    if (found) {
      if (!validTargetId(selfPlayerId)) {
        ambiguousOwnServerClaims = true;
        return;
      }
      if (found.claim.claimer.playerId !== selfPlayerId) {
        saveOwnClaim(null);
        ownClaimLastConfirmedAt = 0;
        return;
      }
      ownClaimLastConfirmedAt = sharedClaimsVerifiedAt;
      saveOwnClaim({
        ...own,
        targetId: found.targetId,
        claimerPlayerId: found.claim.claimer.playerId,
        claimerName: found.claim.claimer.name,
        expiresAt: found.claim.expiresAt,
        cleanupRequired: Number(found.claim.position) > 1
      });
      return;
    }
    ambiguousOwnServerClaims = true;
  }

  function setSharedStatus(state, message, count = sharedClaims.size) {
    sharedStatus = { state: String(state || "unknown"), message: normalizeText(message) || "Shared: unknown", count: Number.isInteger(count) && count >= 0 ? count : 0 };
    updatePanel();
  }

  async function fetchSharedClaims({ allowDuringWrite = false } = {}) {
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return false;
    if (ffCredentialChangeBusy() || tornCredentialMutationInProgress || (sharedWriteBusy && !allowDuringWrite)) return false;
    if (!sharedApiKey || sharedSyncing || nowMs() < sharedBackoffUntil) return false;
    const generation = runtimeGeneration;
    const authorityEpoch = sharedAuthorityEpoch;
    const requestKey = sharedApiKey;
    const requestRoot = canonicalPdaRankedWarSurface()?.root || null;
    const requestSerial = ++sharedRequestSerial;
    sharedSyncing = true;
    const isCurrentRequest = () => (
      generation === runtimeGeneration &&
      authorityEpoch === sharedAuthorityEpoch &&
      requestSerial === sharedRequestSerial &&
      requestKey === sharedApiKey &&
      requestRoot === (canonicalPdaRankedWarSurface()?.root || null) &&
      !tornCredentialMutationInProgress &&
      runtimeActive &&
      isRuntimeEligible() &&
      isWarPanelPresent()
    );
    setSharedStatus("syncing", sharedTransportFailureStreak > 0 ? "Shared: reconnecting…" : "Shared: syncing…");
    try {
      let result = null;
      for (let attempt = 0; attempt <= CONFIG.sharedTransportRetryAttempts; attempt += 1) {
        if (!isCurrentRequest()) return false;
        result = await hitApiRequest(HIT_API.claims, { method: "GET", apiKey: requestKey });
        if (!isCurrentRequest()) return false;
        if (result.ok || result.status !== 0 || attempt >= CONFIG.sharedTransportRetryAttempts) break;
        await wait(CONFIG.sharedTransportRetryDelayMs * (attempt + 1));
        if (!isCurrentRequest()) return false;
      }
      const body = result?.body || {};
      if (!result?.ok) {
        if (isExplicitFfCredentialRejection(result)) sharedCredentialRejected = true;
        const retryAfterSeconds = Number(body?.retry_after_seconds);
        if ((result?.status === 429 || result?.status === 409) && Number.isFinite(retryAfterSeconds)) sharedBackoffUntil = nowMs() + Math.max(1, retryAfterSeconds) * 1000;
        if (Number(result?.status) === 0) sharedTransportFailureStreak += 1; else sharedTransportFailureStreak = 0;
        throw new Error(normalizeText(body?.error) || `HTTP ${result?.status ?? 0}`);
      }
      sharedTransportFailureStreak = 0;
      const normalizedClaims = normalizeSharedClaims(body);
      if (!(normalizedClaims instanceof Map)) throw new Error("malformed claims response");
      sharedCredentialRejected = false;
      sharedClaims = normalizedClaims;
      sharedClaimsVerifiedAt = nowMs();
      sharedBackoffUntil = 0;
      reconcileOwnClaimFromShared();
      if (ambiguousOwnServerClaims) {
        setSharedStatus("error", "Shared: multiple own claims require manual review", sharedClaims.size);
      } else if (currentClaimQuarantine()) {
        setSharedStatus("error", "Shared: claim acknowledgement awaiting verification", sharedClaims.size);
      } else {
        setSharedStatus("online", `Shared: online · ${sharedClaims.size} targets`, sharedClaims.size);
      }
      scanWarRows();
      return true;
    } catch (error) {
      if (isCurrentRequest()) {
        sharedClaimsVerifiedAt = 0;
        setSharedStatus("offline", `Shared: offline · ${normalizeText(error?.message) || "request failed"}`);
      }
      return false;
    } finally {
      if (
        authorityEpoch === sharedAuthorityEpoch &&
        requestSerial === sharedRequestSerial &&
        requestKey === sharedApiKey
      ) sharedSyncing = false;
    }
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
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return false;
    if (ffCredentialChangeBusy() || !sharedApiKey || fairFightSyncing || nowMs() < fairFightBackoffUntil) return false;
    if (!force && fairFightLastFetchAt > 0 && nowMs() - fairFightLastFetchAt < CONFIG.fairFightRefreshMs) return false;
    const targetIds = [...new Set(getEnemyRows().map(row => row.id).filter(validTargetId))]
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, CONFIG.fairFightMaxTargets);
    if (!targetIds.length) return false;
    const generation = runtimeGeneration;
    const requestKey = sharedApiKey;
    const requestRoot = canonicalPdaRankedWarSurface()?.root || null;
    const requestSerial = ++fairFightRequestSerial;
    const isCurrentRequest = () => (
      generation === runtimeGeneration &&
      requestSerial === fairFightRequestSerial &&
      requestKey === sharedApiKey &&
      requestRoot === (canonicalPdaRankedWarSurface()?.root || null) &&
      runtimeActive &&
      isRuntimeEligible() &&
      bridgeMounted &&
      isWarPanelPresent()
    );
    fairFightSyncing = true;
    try {
      const initial = !fairFightEverSucceeded;
      const result = await fairFightStatsRequest(targetIds, { initial, isCurrent: isCurrentRequest, apiKey: requestKey });
      if (!isCurrentRequest() || !result) return false;
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
      return true;
    } catch {
      if (isCurrentRequest()) {
        fairFightStats = new Map();
        fairFightLastFetchAt = 0;
        scanWarRows();
      }
      return false;
    } finally {
      if (requestSerial === fairFightRequestSerial && requestKey === sharedApiKey) fairFightSyncing = false;
    }
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
    const generation = runtimeGeneration;
    const credentialEpoch = tornCredentialEpoch;
    const requestToken = ++publicBasicRequestSerial;
    const requestCurrent = () => (
      generation === runtimeGeneration &&
      credentialEpoch === tornCredentialEpoch &&
      key === effectiveTornApiKey() &&
      publicBasicStatusPending.get(id) === requestToken &&
      runtimeActive &&
      isRuntimeEligible()
    );

    publicBasicStatusPending.set(id, requestToken);
    lastPublicBasicFetchAt = nowMs();

    try {
      const result = await tornApiRequest(`/v2/user/${id}/basic`, key);
      if (!requestCurrent()) return;
      const body = result?.body || {};
      const profile = body?.profile;
      const status = profile?.status;

      if (!result?.ok || body?.error || !isPlainRecord(profile) || !isInt32(profile.id, { positive: true }) || String(profile.id) !== id || !isPlainRecord(status)) {
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
      if (requestCurrent()) publicBasicStatusCache.set(id, { status: null, expiresAt: nowMs() + 10000 });
    } finally {
      if (publicBasicStatusPending.get(id) === requestToken) publicBasicStatusPending.delete(id);
    }
  }

  function refreshOwnLocationFromBasic() {
    const id = String(selfPlayerId || "");

    // Transient SPA/key-info gaps are not evidence that the previously verified
    // country became unknown. Preserve the last verified state and self-heal.
    if (!validTargetId(id)) {
      if (effectiveTornApiKey() && !selfIdentitySyncing) void fetchTornStatuses();
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


  function setTornStatusState(state, message, count = 0) {
    tornStatusState = { state: String(state || "unknown"), message: normalizeText(message) || "Torn: unknown", count: Number.isInteger(count) && count >= 0 ? count : 0 };
    updatePanel();
  }

  function normalizeRankedWarParticipants(factions) {
    if (!Array.isArray(factions) || factions.length !== 2) return null;
    const participants = new Map();
    for (const faction of factions) {
      if (!isPlainRecord(faction)) return null;
      if (
        !Object.prototype.hasOwnProperty.call(faction, "id") ||
        !Object.prototype.hasOwnProperty.call(faction, "name") ||
        !Object.prototype.hasOwnProperty.call(faction, "score") ||
        !Object.prototype.hasOwnProperty.call(faction, "chain") ||
        !isInt32(faction.id, { positive: true }) ||
        typeof faction.name !== "string" ||
        !normalizeText(faction.name) ||
        !isInt32(faction.score, { nonNegative: true }) ||
        !isInt32(faction.chain, { nonNegative: true })
      ) return null;
      const id = String(faction.id);
      if (participants.has(id)) return null;
      participants.set(id, { id, name: normalizeText(faction.name), score: faction.score, chain: faction.chain });
    }
    return participants;
  }

  function normalizeOwnWars(payload, fetchedAt = nowMs(), surface = null) {
    if (!isPlainRecord(payload) || payload.error) return null;
    if (
      !surface ||
      !validTargetId(surface.warId) ||
      !validTargetId(surface.opponentFactionId) ||
      !validTargetId(surface.selfFactionId) ||
      !Number.isInteger(surface.surfaceSerial) ||
      surface.surfaceSerial <= 0
    ) return null;
    const wars = payload.wars;
    if (!isPlainRecord(wars) || !Object.prototype.hasOwnProperty.call(wars, "ranked")) return null;
    const ranked = wars.ranked;
    if (ranked === null) return emptyOwnWarsState(fetchedAt, surface);
    if (!isPlainRecord(ranked)) return null;
    for (const field of ["war_id", "start", "end", "target", "winner", "factions"]) {
      if (!Object.prototype.hasOwnProperty.call(ranked, field)) return null;
    }
    if (!isInt32(ranked.war_id, { positive: true }) || !isInt32(ranked.start, { positive: true }) || !isInt32(ranked.target, { positive: true })) return null;
    if (ranked.end !== null && !isInt32(ranked.end, { positive: true })) return null;
    if (ranked.end !== null && ranked.end <= ranked.start) return null;
    const participants = normalizeRankedWarParticipants(ranked.factions);
    const selfId = String(Number(surface.selfFactionId));
    const opponentId = String(Number(surface.opponentFactionId));
    if (!participants || !participants.has(selfId) || !participants.has(opponentId)) return null;
    if (ranked.winner !== null && (!isInt32(ranked.winner, { positive: true }) || !participants.has(String(ranked.winner)))) return null;
    if (ranked.winner !== null && ranked.end === null) return null;
    const warId = String(ranked.war_id);
    if (warId !== String(Number(surface.warId))) return null;
    const responseTimestamp = Number(payload.timestamp);
    const authoritativeNow = Number.isSafeInteger(responseTimestamp) && responseTimestamp > 0
      ? responseTimestamp
      : Math.floor(getTornNowMs() / 1000);
    const unfinished = ranked.winner === null && (ranked.end === null || authoritativeNow < ranked.end);
    const phase = unfinished && authoritativeNow < ranked.start
      ? RW_PHASE.PREWAR
      : (unfinished && authoritativeNow >= ranked.start ? RW_PHASE.LIVE : RW_PHASE.UNKNOWN);
    return {
      phase,
      live: phase === RW_PHASE.LIVE,
      start: ranked.start,
      warId,
      opponentFactionId: opponentId,
      selfFactionId: selfId,
      surfaceWarId: String(Number(surface.warId)),
      surfaceOpponentFactionId: opponentId,
      surfaceSerial: surface.surfaceSerial,
      fetchedAt
    };
  }

  function normalizeTornMembers(payload) {
    if (!isPlainRecord(payload) || payload.error) return null;
    const source = payload.members;
    const entries = Array.isArray(source)
      ? source.map(member => ["", member])
      : (isPlainRecord(source) ? Object.entries(source) : null);
    if (!entries) return null;
    const members = new Map();
    for (const [key, member] of entries) {
      if (!isPlainRecord(member) || !isPlainRecord(member.status)) continue;
      const rawId = String(member.id ?? member.player_id ?? key ?? "").trim();
      const id = validTargetId(rawId) ? String(Number(rawId)) : "";
      const status = member.status;
      const rawUntil = status.until;
      const until = rawUntil === null || rawUntil === undefined || rawUntil === "" ? 0 : Number(rawUntil);
      if (!id || !Number.isSafeInteger(until) || until < 0) continue;
      members.set(id, {
        state: normalizeText(status?.state),
        description: normalizeText(status?.description),
        details: normalizeText(status?.details),
        until
      });
    }
    return members;
  }

  function recordTornClockOffset(result, body) {
    const timestamp = Number(body?.timestamp);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      const midpoint = (Number(result.startedAt) + Number(result.endedAt)) / 2;
      tornClockOffsetsMs.push(timestamp * 1000 - midpoint);
      if (tornClockOffsetsMs.length > CONFIG.tornClockMaxSamples) tornClockOffsetsMs.splice(0, tornClockOffsetsMs.length - CONFIG.tornClockMaxSamples);
    }
  }

  function tornPageUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      return /^(?:www\.)?torn\.com$/i.test(url.hostname) ? url : null;
    } catch { return null; }
  }

  function factionIdFromLink(link) {
    if (!(link instanceof HTMLAnchorElement)) return "";
    const url = tornPageUrl(link.getAttribute("href") || link.href);
    if (!url || !/\/factions\.php$/i.test(url.pathname)) return "";
    for (const name of ["ID", "id"]) {
      const id = String(url.searchParams.get(name) || "").trim();
      if (validTargetId(id)) return String(Number(id));
    }
    return "";
  }

  function isRenderedRouteSurfaceElement(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    for (let current = element; current instanceof HTMLElement; current = current.parentElement) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(current);
      const opacity = Number.parseFloat(style.opacity || "1");
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.pointerEvents === "none" || (Number.isFinite(opacity) && opacity <= 0)) return false;
    }
    const rect = element.getBoundingClientRect();
    return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
  }

  function warCardFactionIds(card) {
    if (!(card instanceof HTMLElement)) return [];
    return [...new Set([...card.querySelectorAll("a[href]")].map(factionIdFromLink).filter(validTargetId))];
  }

  function canonicalPdaRankedWarSurface() {
    if (!isRankedWarRoute()) return null;
    const roots = [...document.querySelectorAll("#faction_war_list_id")]
      .filter(root => root instanceof HTMLElement && isRenderedRouteSurfaceElement(root));
    if (roots.length !== 1) return null;
    const root = roots[0];
    const enemySurface = root.matches(".enemy-faction")
      ? root
      : (root.closest(".enemy-faction") || root.querySelector(".enemy-faction"));
    if (!(enemySurface instanceof HTMLElement) || !isRenderedRouteSurfaceElement(enemySurface)) return null;
    const scopes = [root, root.parentElement, root.closest(".faction-war"), root.closest("main")].filter(Boolean);
    const cards = new Set();
    for (const scope of scopes) {
      if (scope instanceof HTMLElement && scope.matches("[data-warid]")) cards.add(scope);
      for (const card of scope?.querySelectorAll?.("[data-warid]") || []) {
        if (card.contains(root) || root.contains(card)) cards.add(card);
      }
    }
    const candidates = [...cards].filter(card => (
      card instanceof HTMLElement &&
      isRenderedRouteSurfaceElement(card) &&
      validTargetId(card.dataset.warid) &&
      warCardFactionIds(card).length === 2
    ));
    if (candidates.length !== 1) return null;
    const card = candidates[0];
    const factionIds = warCardFactionIds(card);
    if (factionIds.length !== 2) return null;
    return {
      card,
      root,
      enemySurface,
      warId: String(Number(card.dataset.warid)),
      factionIds,
      countdownSeconds: readRankedWarCountdownSeconds(card)
    };
  }

  function operationalWarSurfaceForFaction(factionId) {
    if (!validTargetId(factionId)) return null;
    const canonical = canonicalPdaRankedWarSurface();
    if (!canonical) return null;
    const selfId = String(Number(factionId));
    const factionIds = canonical.factionIds;
    if (!factionIds.includes(selfId)) return null;
    const opponentId = factionIds.find(id => id !== selfId) || "";
    if (!validTargetId(opponentId)) return null;
    return {
      card: canonical.card,
      root: canonical.root,
      warId: canonical.warId,
      countdownSeconds: canonical.countdownSeconds,
      opponentFactionId: String(Number(opponentId)),
      selfFactionId: selfId,
      surfaceSerial: 1
    };
  }

  function operationalWarSurfaceMatches(expected) {
    const current = operationalWarSurfaceForFaction(expected?.selfFactionId);
    return Boolean(current && current.card === expected.card && current.root === expected.root && current.warId === expected.warId && current.opponentFactionId === expected.opponentFactionId && current.selfFactionId === expected.selfFactionId);
  }

  function refreshCurrentWarSurface({ structural = false } = {}) {
    const selected = operationalWarSurfaceForFaction(selfFactionId);
    if (!selected) {
      if (currentWarSurface || opponentFactionId) {
        warSurfaceSerial += 1;
        invalidateOwnWarsState();
      }
      prewarObservation = null;
      currentWarSurface = null;
      opponentFactionId = "";
      opponentMembersState = { factionId: "", members: new Map(), fetchedAt: 0 };
      return null;
    }
    const changed = structural || currentWarSurface?.card !== selected.card || currentWarSurface?.root !== selected.root || currentWarSurface?.warId !== selected.warId || currentWarSurface?.opponentFactionId !== selected.opponentFactionId;
    const previousOpponent = opponentFactionId;
    opponentFactionId = selected.opponentFactionId;
    if (previousOpponent !== opponentFactionId) opponentMembersState = { factionId: opponentFactionId, members: new Map(), fetchedAt: 0 };
    const previousSurface = currentWarSurface;
    if (changed) {
      warSurfaceSerial += 1;
      invalidateOwnWarsState();
      prewarObservation = null;
    }
    const shouldReadPrewarSurface = changed || structural || !previousSurface;
    currentWarSurface = {
      ...selected,
      surfaceSerial: warSurfaceSerial || 1,
      noWarMarker: shouldReadPrewarSurface
        ? pageHasExplicitNoWarMarker()
        : previousSurface.noWarMarker
    };
    if (!warSurfaceSerial) warSurfaceSerial = 1;
    currentWarSurface.surfaceSerial = warSurfaceSerial;

    if (
      !ownWarsFreshLive() &&
      currentWarSurface.noWarMarker &&
      Number.isFinite(currentWarSurface.countdownSeconds) &&
      currentWarSurface.countdownSeconds > 0 &&
      !lockedPrewarWarIds.has(currentWarSurface.warId) &&
      prewarObservation?.warId !== currentWarSurface.warId
    ) {
      prewarObservation = {
        warId: currentWarSurface.warId,
        startAtSeconds: Math.floor(getTornNowMs() / 1000) + currentWarSurface.countdownSeconds
      };
    }
    return currentWarSurface;
  }

  function captureCurrentWarSurface() {
    const surface = refreshCurrentWarSurface();
    if (!surface?.card?.isConnected || !validTargetId(surface.warId) || !validTargetId(surface.opponentFactionId) || !validTargetId(selfFactionId)) return null;
    return {
      card: surface.card,
      root: surface.root,
      warId: String(Number(surface.warId)),
      opponentFactionId: String(Number(surface.opponentFactionId)),
      selfFactionId: String(Number(selfFactionId)),
      surfaceSerial: surface.surfaceSerial
    };
  }

  function currentWarSurfaceMatchesSnapshot(surface) {
    return Boolean(surface && currentWarSurface?.card === surface.card && currentWarSurface?.root === surface.root && currentWarSurface?.card?.isConnected && currentWarSurface?.surfaceSerial === surface.surfaceSerial && currentWarSurface?.warId === surface.warId && currentWarSurface?.opponentFactionId === surface.opponentFactionId && selfFactionId === surface.selfFactionId && operationalWarSurfaceMatches(surface));
  }

  function ownWarsStateMatchesSurface(surface = currentWarSurface) {
    return Boolean(surface && ownWarsState.surfaceSerial === surface.surfaceSerial && ownWarsState.surfaceWarId === String(surface.warId || "") && ownWarsState.surfaceOpponentFactionId === String(surface.opponentFactionId || "") && ownWarsState.opponentFactionId === String(surface.opponentFactionId || "") && ownWarsState.selfFactionId === selfFactionId);
  }

  function ownWarsFreshLive(maxAgeMs = CONFIG.tornStatusMaxAgeMs) {
    return Boolean(ownWarsState.live === true && ownWarsState.phase === RW_PHASE.LIVE && ownWarsState.warId === currentWarSurface?.warId && ownWarsStateMatchesSurface() && nowMs() - ownWarsState.fetchedAt <= maxAgeMs);
  }

  async function tornReadWithTransportRetry(path, key, { cacheBust = false, isCurrent = () => true } = {}) {
    let result = null;
    for (let attempt = 0; attempt <= CONFIG.tornTransportRetryAttempts; attempt += 1) {
      if (!isCurrent()) return result;
      result = await tornApiRequest(path, key, { cacheBust });
      if (!isCurrent()) return result;
      if (result.ok || result.status !== 0 || attempt >= CONFIG.tornTransportRetryAttempts) break;
      await wait(CONFIG.tornTransportRetryDelayMs * (attempt + 1));
    }
    return result;
  }

  async function fetchOwnWars({ force = false } = {}) {
    const key = effectiveTornApiKey();
    if (!key || !keyScopeReady || !validTargetId(selfFactionId) || !runtimeActive || !isRuntimeEligible()) return false;
    const surface = captureCurrentWarSurface();
    if (!surface) return false;
    if (!force && ownWarsStateMatchesSurface(surface) && nowMs() - ownWarsState.fetchedAt < CONFIG.tornStatusPollMs) return true;
    const generation = runtimeGeneration;
    const credentialEpoch = tornCredentialEpoch;
    const requestSerial = ++ownWarsRequestSerial;
    const isCurrentRequest = () => generation === runtimeGeneration && credentialEpoch === tornCredentialEpoch && requestSerial === ownWarsRequestSerial && key === effectiveTornApiKey() && runtimeActive && isRuntimeEligible() && currentWarSurfaceMatchesSnapshot(surface);
    try {
      const result = await tornReadWithTransportRetry(SCRIPT.tornOwnWarsPath, key, { cacheBust: force, isCurrent: isCurrentRequest });
      if (!isCurrentRequest() || !result?.ok || result.body?.error) return false;
      const fetchedAt = Number(result.endedAt) || nowMs();
      recordTornClockOffset(result, result.body);
      const next = normalizeOwnWars(result.body, fetchedAt, surface);
      if (!next) {
        ownWarsState = emptyOwnWarsState(fetchedAt, surface);
        return false;
      }
      ownWarsState = next;
      return true;
    } catch { return false; }
  }

  async function fetchOpponentMembers({ force = false } = {}) {
    refreshCurrentWarSurface();
    const key = effectiveTornApiKey();
    const factionId = opponentFactionId;
    if (!key || !keyScopeReady || !validTargetId(factionId) || !runtimeActive || !isRuntimeEligible()) return false;
    if (!force && opponentMembersState.factionId === factionId && nowMs() - opponentMembersState.fetchedAt < CONFIG.opponentMembersMaxAgeMs) return true;
    const generation = runtimeGeneration;
    const credentialEpoch = tornCredentialEpoch;
    const surface = captureCurrentWarSurface();
    const isCurrentRequest = () => generation === runtimeGeneration && credentialEpoch === tornCredentialEpoch && key === effectiveTornApiKey() && factionId === opponentFactionId && runtimeActive && isRuntimeEligible() && currentWarSurfaceMatchesSnapshot(surface);
    try {
      const result = await tornReadWithTransportRetry(`/v2/faction/${factionId}/members`, key, { cacheBust: force, isCurrent: isCurrentRequest });
      if (!isCurrentRequest() || !result?.ok || result.body?.error) return false;
      const members = normalizeTornMembers(result.body);
      if (!(members instanceof Map)) return false;
      opponentMembersState = { factionId, members, fetchedAt: Number(result.endedAt) || nowMs() };
      return true;
    } catch { return false; }
  }

  async function fetchTornStatuses({ force = false } = {}) {
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return false;
    const key = effectiveTornApiKey();
    if (!key || tornStatusSyncing || (!force && nowMs() < tornStatusBackoffUntil)) return false;
    if (!validTargetId(selfPlayerId) || !validTargetId(selfFactionId) || !keyScopeReady) {
      const identityReady = await fetchSelfIdentity({ force });
      return identityReady ? fetchTornStatuses({ force: false }) : false;
    }
    refreshOwnLocationFromBasic();
    const generation = runtimeGeneration;
    const credentialEpoch = tornCredentialEpoch;
    const requestSerial = ++tornStatusRequestSerial;
    tornStatusSyncing = true;
    setTornStatusState("syncing", "Torn: syncing…");
    const isCurrentRequest = () => requestSerial === tornStatusRequestSerial && credentialEpoch === tornCredentialEpoch && generation === runtimeGeneration && key === effectiveTornApiKey() && runtimeActive && isRuntimeEligible();
    try {
      const warsReady = await fetchOwnWars({ force });
      if (!isCurrentRequest() || !warsReady) throw new Error("own faction wars unavailable");
      const membersReady = await fetchOpponentMembers({ force });
      if (!isCurrentRequest()) return false;
      if (!membersReady) throw new Error("opponent members unavailable");
      tornStatusBackoffUntil = 0;
      tornTransportFailureStreak = 0;
      const memberCount = membersReady && opponentMembersState.factionId === opponentFactionId ? opponentMembersState.members.size : 0;
      const rwLabel = ownWarsState.live ? "LIVE" : (ownWarsState.phase === RW_PHASE.PREWAR ? "PREWAR" : "not confirmed");
      setTornStatusState(membersReady ? "ready" : "error", `Torn: own RW ${rwLabel} · ${memberCount} members`, memberCount);
      scanWarRows();
      return true;
    } catch (error) {
      if (isCurrentRequest()) {
        tornTransportFailureStreak += 1;
        tornStatusBackoffUntil = nowMs() + CONFIG.tornStatusErrorBackoffMs;
        invalidateOwnWarsState();
        opponentMembersState = { factionId: opponentFactionId, members: new Map(), fetchedAt: 0 };
        setTornStatusState("error", `Torn: ${normalizeText(error?.message) || "offline"}`, 0);
        scanWarRows();
      }
      return false;
    } finally {
      if (requestSerial === tornStatusRequestSerial && credentialEpoch === tornCredentialEpoch && key === effectiveTornApiKey()) tornStatusSyncing = false;
    }
  }

  function tornStatusForTarget(targetId) {
    if (!validTargetId(opponentFactionId) || opponentMembersState.factionId !== opponentFactionId || nowMs() - opponentMembersState.fetchedAt > CONFIG.opponentMembersMaxAgeMs) return null;
    return opponentMembersState.members.get(String(targetId || "")) || null;
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
    const root = canonicalPdaRankedWarSurface()?.root || null;
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

  function hospitalRemainingSeconds(until) {
    const timestamp = Number(until);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    const remaining = Math.ceil(timestamp - getFfscouterParityNowMs() / 1000) + 1;
    return Number.isFinite(remaining) && remaining >= 0 && remaining < CONFIG.maxHospitalSeconds
      ? remaining
      : null;
  }

  function visibleHospitalEvidence(row) {
    const li = row?.li;
    const statusCell = row?.statusDiv;
    if (!(li instanceof HTMLElement) || !(statusCell instanceof HTMLElement)) {
      return { isHospital: false, seconds: null, source: "dom" };
    }
    const isHospital =
      statusCell.classList.contains("hospital") ||
      isHospitalStatusValue(statusCell.textContent);
    if (!isHospital) return { isHospital: false, seconds: null, source: "dom" };
    const untilNodes = [statusCell, li, ...li.querySelectorAll("[data-until]")];
    for (const node of untilNodes) {
      const remaining = hospitalRemainingSeconds(node.getAttribute?.("data-until"));
      if (Number.isFinite(remaining)) {
        return { isHospital: true, seconds: remaining, source: "dom-until" };
      }
    }
    return {
      isHospital: true,
      seconds: parseHospitalSecondsFromText(statusCell.textContent || li.textContent),
      source: "dom-text"
    };
  }

  function computeHospitalSeconds(row) {
    const apiStatus = tornStatusForTarget(row.id);
    if (apiStatus) {
      const hospital =
        isHospitalStatusValue(apiStatus.state) ||
        isHospitalStatusValue(apiStatus.description) ||
        isHospitalStatusValue(apiStatus.details);
      if (!hospital) return { isHospital: false, seconds: null, source: "torn-api" };
      const remaining = hospitalRemainingSeconds(apiStatus.until);
      if (Number.isFinite(remaining)) return { isHospital: true, seconds: remaining, source: "torn-api" };
      const fallback = visibleHospitalEvidence(row);
      if (fallback.isHospital && Number.isFinite(fallback.seconds)) return fallback;
      return { isHospital: true, seconds: null, source: "torn-api" };
    }
    return visibleHospitalEvidence(row);
  }

  function pageHasExplicitNoWarMarker() {
    const scope = document.querySelector("main") || document.body;
    if (!(scope instanceof HTMLElement)) return false;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let visited = 0;
    while (walker.nextNode() && visited < 6000) {
      visited += 1;
      const parent = walker.currentNode.parentElement;
      if (!parent || !isRenderedRouteSurfaceElement(parent)) continue;
      if (normalizeText(walker.currentNode.nodeValue).toUpperCase() === "YOUR FACTION IS NOT IN A WAR") return true;
    }
    return false;
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
    try { return stripGeneratedContent(getComputedStyle(element, pseudo).content); }
    catch { return ""; }
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
    for (let index = 0; index + 1 < childTexts.length; index += 1) {
      const day = childTexts[index].match(/^\d{1,3}:?$/)?.[0]?.replace(/:$/, "") || "";
      const childClock = threePartClock(childTexts[index + 1]);
      if (day && childClock) add(`${day}:${childClock}`);
    }
    if (childTexts.length >= 4) {
      for (let index = 0; index + 3 < childTexts.length; index += 1) {
        const parts = childTexts.slice(index, index + 4).map(value => value.match(/^\d{1,3}$/)?.[0] || "");
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

  function currentRwPhase({ refresh = true } = {}) {
    const surface = refresh ? refreshCurrentWarSurface() : currentWarSurface;
    if (!surface) {
      return { phase: RW_PHASE.UNKNOWN, runwaySeconds: null, warId: surface?.warId || "" };
    }
    const now = Math.floor(getTornNowMs() / 1000);
    if (ownWarsFreshLive()) {
      lockedPrewarWarIds.add(surface.warId);
      if (prewarObservation?.warId === surface.warId) prewarObservation = null;
      return { phase: RW_PHASE.LIVE, runwaySeconds: 0, warId: ownWarsState.warId };
    }
    const freshMatchingWars =
      ownWarsStateMatchesSurface(surface) &&
      nowMs() - ownWarsState.fetchedAt <= CONFIG.tornStatusMaxAgeMs;
    if (freshMatchingWars && ownWarsState.phase === RW_PHASE.PREWAR) {
      const runwaySeconds = ownWarsState.start - now;
      if (runwaySeconds > 0) {
        return { phase: RW_PHASE.PREWAR, runwaySeconds, warId: ownWarsState.warId };
      }
      lockedPrewarWarIds.add(surface.warId);
    }
    if (prewarObservation?.warId === surface.warId) {
      const runwaySeconds = prewarObservation.startAtSeconds - now;
      if (runwaySeconds > 0 && !lockedPrewarWarIds.has(surface.warId)) {
        return { phase: RW_PHASE.PREWAR, runwaySeconds, warId: surface.warId };
      }
      lockedPrewarWarIds.add(surface.warId);
      prewarObservation = null;
    }
    return { phase: RW_PHASE.UNKNOWN, runwaySeconds: null, warId: surface.warId };
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
        seconds,
        fairFight: ff,
        reason: rwPhase?.phase === RW_PHASE.PREWAR ? "rw-not-started" : "rw-phase-unverifiable",
        mode: "prewar",
        prewarHospital: isHospital,
        rwPhase
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

  function classifyTargetState({ playerId, ownClaim, isHospital, seconds, fairFight, countryEligibility, rwPhase, ownershipUnresolved = false }) {
    if (ownClaim) {
      if (ownClaim.targetId === playerId) {
        return { state: TARGET_STATE.CLAIMED, seconds, fairFight, reason: "active-own-dibs", mode: "live" };
      }
      return { state: TARGET_STATE.BLOCKED, seconds, fairFight, reason: "another-active-dibs", mode: "live" };
    }
    if (ownershipUnresolved) {
      return { state: TARGET_STATE.BLOCKED, seconds, fairFight, reason: "shared-ownership-unresolved", mode: "live" };
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
      rwPhase: currentRwPhase(),
      ownershipUnresolved: Boolean(
        !newClaimStorageAuthorityReady() ||
        (sharedApiKey && sharedClaimsVerifiedAt <= 0) ||
        tornCredentialMutationInProgress ||
        currentClaimQuarantine() ||
        ambiguousOwnServerClaims
      )
    });
  }

  // ---------------------------------------------------------------------------
  // Claim / release.
  // ---------------------------------------------------------------------------

  async function verifyFreshTargetBasicForClaim(targetId, isCurrent = () => true) {
    const key = effectiveTornApiKey();
    if (!key || !validTargetId(targetId) || !isCurrent()) return null;
    const result = await tornApiRequest(`/v2/user/${targetId}/basic`, key, { cacheBust: true });
    if (!isCurrent() || key !== effectiveTornApiKey()) return null;
    const body = result?.body || {};
    const profile = body?.profile;
    const status = profile?.status;
    const fetchedAt = Number(result?.endedAt) || 0;
    if (
      !result?.ok || body?.error || !isPlainRecord(profile) ||
      !isInt32(profile.id, { positive: true }) || String(profile.id) !== String(targetId) ||
      !isPlainRecord(status) || !fetchedAt || nowMs() - fetchedAt > CONFIG.targetBasicWriteMaxAgeMs
    ) return null;
    recordTornClockOffset(result, body);
    const hospital =
      isHospitalStatusValue(status.state) ||
      isHospitalStatusValue(status.description) ||
      isHospitalStatusValue(status.details);
    const seconds = hospitalRemainingSeconds(status.until);
    const country = countryFromStatusText(status);
    if (!hospital || !Number.isFinite(seconds) || seconds > CONFIG.gateSeconds || !country) return null;
    return { targetId: String(targetId), status, seconds, country, fetchedAt };
  }

  function normalizeClaimAcknowledgement(payload) {
    if (!isPlainRecord(payload) || !isPlainRecord(payload.claim) || !isPlainRecord(payload.claim.claimer)) return null;
    const claim = payload.claim;
    const claimId = normalizeText(claim.claim_id);
    const position = Number(payload.position);
    const createdAt = Number(claim.created_at);
    const expiresAt = Number(claim.expires_at);
    const claimerPlayerId = String(claim.claimer.player_id ?? "").trim();
    const claimerName = normalizeText(claim.claimer.name);
    if (
      !isValidClaimId(claimId) || !Number.isInteger(position) || position < 1 ||
      !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) ||
      expiresAt <= createdAt || expiresAt <= nowSeconds() ||
      claimerPlayerId !== String(Number(claimerPlayerId)) || !validTargetId(claimerPlayerId) ||
      !claimerName
    ) return null;
    return { claimId, position, createdAt, expiresAt, claimerPlayerId, claimerName, raw: claim };
  }

  function quarantineClaimAcknowledgement(targetId, rawClaim, expectedSelfPlayerId = selfPlayerId) {
    const rawClaimId = normalizeText(rawClaim?.claim_id);
    const rawExpiresAt = Number(rawClaim?.expires_at);
    return saveClaimQuarantine({
      targetId,
      claimId: isValidClaimId(rawClaimId) ? rawClaimId : "",
      expectedSelfPlayerId,
      expiresAt: Number.isFinite(rawExpiresAt) && rawExpiresAt > nowSeconds()
        ? rawExpiresAt
        : null,
      createdLocalAt: nowMs()
    });
  }

  async function exactCleanupCreatedClaim(own, isCurrent, ownsWrite, writeKey) {
    if (
      !own || !isValidClaimId(own.claimId) ||
      own.claimerPlayerId !== String(selfPlayerId) ||
      currentOwnClaim()?.claimId !== own.claimId || !isCurrent()
    ) return false;
    invalidateSharedReads();
    const cleanup = await hitApiWriteWithBusyRetry(
      HIT_API.unclaim,
      { claim_id: own.claimId },
      isCurrent,
      writeKey
    );
    const localOwn = currentOwnClaim();
    const bookkeepingCurrent = Boolean(
      ownsWrite() &&
      writeKey === sharedApiKey &&
      localOwn?.claimId === own.claimId &&
      localOwn.targetId === own.targetId
    );
    if (cleanup?.ok && cleanup?.body?.released === true && bookkeepingCurrent) {
      invalidateSharedReads();
      removeImmediateSharedClaim(own.claimId);
      if (currentOwnClaim()?.claimId === own.claimId) saveOwnClaim(null);
      return true;
    }
    if (!isCurrent()) return false;
    return false;
  }

  async function exactCleanupQuarantinedAcknowledgement(
    targetId,
    rawClaim,
    expectedSelfPlayerId,
    isCurrent,
    ownsWrite,
    writeKey
  ) {
    const claimId = normalizeText(rawClaim?.claim_id);
    const claimerPlayerId = String(rawClaim?.claimer?.player_id ?? "").trim();
    if (
      !validTargetId(targetId) || !isValidClaimId(claimId) ||
      claimerPlayerId !== String(expectedSelfPlayerId) || !isCurrent()
    ) return false;
    invalidateSharedReads();
    const cleanup = await hitApiWriteWithBusyRetry(
      HIT_API.unclaim,
      { claim_id: claimId },
      isCurrent,
      writeKey
    );
    const localQuarantine = currentClaimQuarantine();
    const bookkeepingCurrent = Boolean(
      ownsWrite() &&
      writeKey === sharedApiKey &&
      localQuarantine?.claimId === claimId &&
      localQuarantine.targetId === String(targetId) &&
      localQuarantine.expectedSelfPlayerId === String(expectedSelfPlayerId)
    );
    if (cleanup?.ok && cleanup?.body?.released === true && bookkeepingCurrent) {
      invalidateSharedReads();
      removeImmediateSharedClaim(claimId);
      if (currentOwnClaim()?.claimId === claimId) saveOwnClaim(null);
      if (currentClaimQuarantine()?.claimId === claimId) saveClaimQuarantine(null);
      ownClaimLastConfirmedAt = 0;
      return true;
    }
    if (!isCurrent()) return false;
    return false;
  }

  async function claimSharedTarget(playerId, playerName) {
    const targetId = String(playerId || "");
    if (
      !runtimeActive || !isRuntimeEligible() || sharedWriteBusy || ffCredentialChangeBusy() ||
      tornCredentialMutationInProgress ||
      !newClaimStorageAuthorityReady() ||
      !sharedApiKey || !validTargetId(targetId)
    ) return;
    if (
      currentOwnClaim() || currentClaimQuarantine() || ambiguousOwnServerClaims ||
      sharedClaimForTarget(targetId)
    ) return;
    const clickedBinding = xidBindings.get(targetId);
    const clickedResolved = currentResolvedBinding(clickedBinding);
    const clickedSurface = captureCurrentWarSurface();
    const clickedOpponentId = opponentFactionId;
    if (!clickedResolved || !bindingTargetIsUnique(clickedBinding, clickedResolved) || !clickedSurface || clickedSurface.opponentFactionId !== clickedOpponentId) return;
    const eligibility = currentDecisionForTarget(targetId);
    if (!eligibility || eligibility.state !== TARGET_STATE.READY) { scanWarRows(); return; }

    const generation = runtimeGeneration;
    const operationSerial = ++sharedWriteOperationSerial;
    const writeKey = sharedApiKey;
    const credentialEpoch = tornCredentialEpoch;
    const tornKey = effectiveTornApiKey();
    const selfAtStart = selfPlayerId;
    const ownsWrite = () => operationSerial === sharedWriteOperationSerial;
    const operationRuntimeCurrent = () => (
      ownsWrite() &&
      generation === runtimeGeneration &&
      credentialEpoch === tornCredentialEpoch &&
      tornKey === effectiveTornApiKey() &&
      writeKey === sharedApiKey &&
      selfAtStart === selfPlayerId &&
      runtimeActive &&
      isRuntimeEligible()
    );
    const claimCreationCurrent = () => (
      operationRuntimeCurrent() && newClaimStorageAuthorityReady()
    );
    sharedWriteBusy = true;
    claimFlowState = CLAIM_FLOW_STATE.CLAIMING;
    pendingTargetId = targetId;
    setSharedStatus("writing", `Shared: claiming ${normalizeText(playerName) || targetId}…`);
    scanWarRows();

    try {
      invalidateSharedReads();
      if (!(await fetchSharedClaims({ allowDuringWrite: true }))) {
        throw new Error("fresh shared claims snapshot failed");
      }
      if (!claimCreationCurrent()) return;
      if (
        currentOwnClaim() || currentClaimQuarantine() || ambiguousOwnServerClaims ||
        sharedClaimForTarget(targetId)
      ) throw new Error("target already claimed or ownership unresolved");
      if (!(await fetchOwnWars({ force: true })) || !ownWarsFreshLive(CONFIG.ownWarsWriteMaxAgeMs)) {
        throw new Error("fresh own faction wars did not confirm LIVE");
      }
      const targetProof = await verifyFreshTargetBasicForClaim(targetId, claimCreationCurrent);
      if (!targetProof) throw new Error("fresh target basic verification failed");
      if (!claimCreationCurrent()) return;
      const finalSurface = captureCurrentWarSurface();
      const finalBinding = xidBindings.get(targetId);
      const finalResolved = currentResolvedBinding(finalBinding);
      if (
        finalBinding !== clickedBinding ||
        !finalResolved ||
        !bindingTargetIsUnique(finalBinding, finalResolved) ||
        !finalSurface ||
        !currentWarSurfaceMatchesSnapshot(clickedSurface) ||
        finalSurface.opponentFactionId !== clickedOpponentId
      ) throw new Error("target identity or opponent relation changed");
      const ownCountryFresh =
        ownLocationState.checkedAt > 0 &&
        nowMs() - ownLocationState.checkedAt <= CONFIG.targetBasicWriteMaxAgeMs &&
        !ownLocationState.traveling &&
        Boolean(ownLocationState.country);
      const countryEligibility = {
        known: ownCountryFresh && Boolean(targetProof.country),
        same: ownCountryFresh && targetProof.country === ownLocationState.country,
        reason: ownCountryFresh && targetProof.country !== ownLocationState.country
          ? "different-country"
          : "country-unverifiable"
      };
      const finalEligibility = classifyTargetState({
        playerId: targetId,
        ownClaim: currentOwnClaim(),
        isHospital: true,
        seconds: targetProof.seconds,
        fairFight: fairFightForTarget(targetId),
        countryEligibility,
        rwPhase: currentRwPhase()
      });
      if (
        !newClaimStorageAuthorityReady() ||
        currentOwnClaim() || currentClaimQuarantine() || ambiguousOwnServerClaims ||
        sharedClaimForTarget(targetId) ||
        !ownWarsFreshLive(CONFIG.ownWarsWriteMaxAgeMs) ||
        nowMs() - targetProof.fetchedAt > CONFIG.targetBasicWriteMaxAgeMs ||
        !finalEligibility || finalEligibility.state !== TARGET_STATE.READY
      ) throw new Error("target eligibility changed");
      if (!claimAuthorityStorageWritable()) {
        throw new Error("claim authority storage is not durably writable");
      }
      invalidateSharedReads();
      const result = await hitApiRequest(HIT_API.claim, {
        method: "POST",
        body: { target_player_id: Number(targetId) },
        apiKey: writeKey
      });
      if (!claimCreationCurrent()) return;
      const claim = result?.body?.claim;
      const acknowledgement = result?.ok ? normalizeClaimAcknowledgement(result.body) : null;
      if (result?.ok) invalidateSharedReads();
      if (!result?.ok) {
        throw new Error(normalizeText(result?.body?.error) || `Claim failed (HTTP ${result?.status ?? 0})`);
      }
      if (!acknowledgement || acknowledgement.claimerPlayerId !== String(selfAtStart)) {
        const quarantined = quarantineClaimAcknowledgement(targetId, claim, selfAtStart);
        const cleaned = await exactCleanupQuarantinedAcknowledgement(
          targetId,
          claim,
          selfAtStart,
          operationRuntimeCurrent,
          ownsWrite,
          writeKey
        );
        if (operationRuntimeCurrent()) {
          setSharedStatus(
            cleaned ? "online" : "error",
            cleaned
              ? "Shared: unverified acknowledgement cleaned exactly"
              : (quarantined
                ? "Shared: claim acknowledgement quarantined · verifying ownership"
                : "Shared: claim acknowledgement locked in memory · storage failed")
          );
        }
        return;
      }

      const ownRecord = {
        claimId: acknowledgement.claimId,
        targetId,
        claimerPlayerId: acknowledgement.claimerPlayerId,
        claimerName: acknowledgement.claimerName,
        expiresAt: acknowledgement.expiresAt,
        cleanupRequired: acknowledgement.position > 1,
        createdLocalAt: nowMs()
      };
      const ownPersisted = saveOwnClaim(ownRecord);
      ownClaimLastConfirmedAt = 0;
      const committedOwn = currentOwnClaim();
      const durableOwn = Boolean(
        ownPersisted && committedOwn?.claimId === ownRecord.claimId &&
        committedOwn.targetId === ownRecord.targetId &&
        committedOwn.claimerPlayerId === ownRecord.claimerPlayerId
      );
      if (!durableOwn) {
        claimFlowState = CLAIM_FLOW_STATE.CLEANUP_REQUIRED;
        setSharedStatus("error", "Shared: claim storage failed · cleaning exact own claim…");
        if (await exactCleanupCreatedClaim(ownRecord, operationRuntimeCurrent, ownsWrite, writeKey)) {
          if (operationRuntimeCurrent()) {
            setSharedStatus("online", "Shared: undurable claim cleaned exactly", sharedClaims.size);
          }
          return;
        }
        if (operationRuntimeCurrent()) {
          setSharedStatus("error", "Shared: claim storage failed · RELEASE required", sharedClaims.size);
        }
        return;
      }
      upsertImmediateSharedClaim(targetId, acknowledgement.raw, acknowledgement.position);
      if (!operationRuntimeCurrent()) return;

      if (acknowledgement.position === 1) {
        setSharedStatus("online", `Shared: DIBS ✓ ${ownRecord.claimerName}`, sharedClaims.size);
        return;
      }

      const others = Array.isArray(result?.body?.other_claims_for_target) ? result.body.other_claims_for_target : [];
      const winner = others.find(item => Number(item?.position) === 1);
      const winnerName = normalizeText(winner?.claimer?.name) || "another member";
      claimFlowState = CLAIM_FLOW_STATE.CLEANUP_REQUIRED;
      if (operationRuntimeCurrent()) {
        setSharedStatus("error", `Shared: queued behind ${winnerName} · RELEASE required`, sharedClaims.size);
      }
    } catch (error) {
      if (operationRuntimeCurrent()) {
        setSharedStatus("error", `Shared: claim failed · ${normalizeText(error?.message) || "request failed"}`);
      }
    } finally {
      if (ownsWrite()) {
        sharedWriteBusy = false;
        claimFlowState = currentOwnClaim() || currentClaimQuarantine()
          ? CLAIM_FLOW_STATE.CLEANUP_REQUIRED
          : CLAIM_FLOW_STATE.IDLE;
        pendingTargetId = "";
        if (operationRuntimeCurrent()) { scanWarRows(); void fetchSharedClaims(); }
      }
    }
  }

  async function releaseOwnSharedTarget() {
    const own = currentOwnClaim();
    const quarantine = currentClaimQuarantine();
    if (
      !runtimeActive || !isRuntimeEligible() || sharedWriteBusy || ffCredentialChangeBusy() ||
      tornCredentialMutationInProgress ||
      !sharedApiKey || !own || !isValidClaimId(own.claimId) ||
      !quarantineAllowsExactOwnRelease(own, quarantine) ||
      !exactSharedProofForOwnClaim(own)
    ) return;
    const generation = runtimeGeneration;
    const operationSerial = ++sharedWriteOperationSerial;
    const writeKey = sharedApiKey;
    const selfAtStart = selfPlayerId;
    const ownsWrite = () => operationSerial === sharedWriteOperationSerial;
    const writeRuntimeCurrent = () => (
      ownsWrite() &&
      generation === runtimeGeneration &&
      runtimeActive &&
      isRuntimeEligible() &&
      writeKey === sharedApiKey &&
      selfAtStart === selfPlayerId &&
      currentOwnClaim()?.claimId === own.claimId &&
      quarantineAllowsExactOwnRelease(currentOwnClaim())
    );
    sharedWriteBusy = true;
    claimFlowState = CLAIM_FLOW_STATE.RELEASING;
    pendingTargetId = own.targetId;
    setSharedStatus("writing", `Shared: releasing ${own.claimerName || "DIBS"}…`);
    scanWarRows();
    try {
      invalidateSharedReads();
      if (!(await fetchSharedClaims({ allowDuringWrite: true }))) {
        throw new Error("fresh shared claims snapshot failed");
      }
      if (!writeRuntimeCurrent()) return;
      const verifiedOwn = currentOwnClaim();
      const found = findSharedClaimById(own.claimId);
      if (
        !verifiedOwn || verifiedOwn.targetId !== own.targetId ||
        ownClaimLastConfirmedAt !== sharedClaimsVerifiedAt ||
        !found || found.targetId !== own.targetId ||
        found.claim.claimer.playerId !== selfAtStart
      ) throw new Error("server ownership proof did not match this exact claim");
      invalidateSharedReads();
      const result = await hitApiWriteWithBusyRetry(
        HIT_API.unclaim,
        { claim_id: own.claimId },
        writeRuntimeCurrent,
        writeKey
      );
      if (result?.ok && result?.body?.released === true) {
        invalidateSharedReads();
        removeImmediateSharedClaim(own.claimId);
        if (currentOwnClaim()?.claimId === own.claimId) saveOwnClaim(null);
        if (currentClaimQuarantine()) saveClaimQuarantine(null);
        ownClaimLastConfirmedAt = 0;
        if (writeRuntimeCurrent()) setSharedStatus("online", "Shared: released", sharedClaims.size);
        return;
      }
      if (!writeRuntimeCurrent()) return;
      throw new Error(normalizeText(result?.body?.error) || `Release failed (HTTP ${result?.status ?? 0})`);
    } catch (error) {
      if (writeRuntimeCurrent()) {
        setSharedStatus("error", `Shared: release failed · ${normalizeText(error?.message) || "request failed"}`);
      }
    } finally {
      if (ownsWrite()) {
        sharedWriteBusy = false;
        claimFlowState = currentOwnClaim()?.cleanupRequired ? CLAIM_FLOW_STATE.CLEANUP_REQUIRED : CLAIM_FLOW_STATE.IDLE;
        pendingTargetId = "";
        if (writeRuntimeCurrent()) { scanWarRows(); void fetchSharedClaims(); }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PDA-owned presentation. Torn's Ranked War DOM is read-only.
  // ---------------------------------------------------------------------------

  const SCOUT_PALETTE = Object.freeze([
    "#3057e1", "#3274ff", "#29a9ff", "#27d7f2", "#28d8b8",
    "#35d96f", "#85dd28", "#d9df24", "#f3b326", "#f57c1f", "#ef3340"
  ]);

  const rowBindings = new Map();
  const xidBindings = new Map();
  const hostBindings = new WeakMap();
  const ownedPresentationLayers = new WeakSet();
  let ownedPresentationLayer = null;
  let presentationRoot = null;
  let presentationRootEpoch = 0;
  let presentationResizeObserver = null;

  function presentationLayer() {
    const layer = ownedPresentationLayer;
    return layer instanceof HTMLElement &&
      layer.parentElement === document.body &&
      layer.id === SCRIPT.layerId && ownedPresentationLayers.has(layer)
      ? layer
      : null;
  }

  function presentationShadow() {
    return presentationLayer()?.shadowRoot || null;
  }

  const ROW_IDENTITY_ATTRIBUTES = Object.freeze([
    "data-profile",
    "data-profile-id",
    "data-user-id",
    "data-player-id",
    "data-target-id",
    "data-xid",
    "data-user2-id",
    "data-user2id"
  ]);

  function profileIdFromHref(href) {
    try {
      const url = new URL(String(href || ""), location.href);
      if (url.origin !== location.origin || !/\/profiles(?:\.php)?$/i.test(url.pathname)) return "";
      for (const name of ["XID", "xid", "user2ID", "user2id"]) {
        const id = String(url.searchParams.get(name) || "").trim();
        if (validTargetId(id)) return String(Number(id));
      }
      return "";
    } catch { return ""; }
  }

  function normalizedTargetId(value) {
    const id = String(value || "").trim();
    return validTargetId(id) ? String(Number(id)) : "";
  }

  function rowDatasetIdentityMatches(row, targetId) {
    for (const attribute of ROW_IDENTITY_ATTRIBUTES) {
      if (!row.hasAttribute(attribute)) continue;
      if (normalizedTargetId(row.getAttribute(attribute)) !== targetId) return false;
    }
    return true;
  }

  function rowFactionIdentityMatches(row) {
    if (!validTargetId(opponentFactionId)) return true;
    for (const link of row.querySelectorAll("a[href]")) {
      const factionId = factionIdFromLink(link);
      if (validTargetId(factionId) && factionId !== opponentFactionId) return false;
    }
    return true;
  }

  function nativeAttackIdentityMatches(attackCell, targetId) {
    if (!(attackCell instanceof HTMLElement)) return false;
    const nodes = [...attackCell.childNodes];
    const links = nodes.filter(node => node instanceof HTMLAnchorElement && node.matches("a[href]"));
    if (links.length > 0) {
      const ids = new Set();
      for (const link of links) {
        let url;
        try { url = new URL(link.getAttribute("href") || "", location.href); }
        catch { return false; }
        if (url.origin !== location.origin || normalizeText(url.searchParams.get("sid")).toLowerCase() !== "attack") return false;
        const attackId = normalizedTargetId(url.searchParams.get("user2ID") || url.searchParams.get("user2id"));
        if (!attackId) return false;
        ids.add(attackId);
      }
      return ids.size === 1 && ids.has(targetId);
    }
    return nodes.some(node => node instanceof HTMLSpanElement && normalizeText(node.textContent).toLowerCase() === "attack");
  }

  function directCell(row, selectors) {
    for (const selector of selectors) {
      const cell = row.querySelector(`:scope > ${selector}`);
      if (cell instanceof HTMLElement) return cell;
    }
    return null;
  }

  function currentRosterRoot() {
    const root = canonicalPdaRankedWarSurface()?.root || null;
    return root instanceof HTMLElement ? root : null;
  }

  function resolveLivePdaRow(row, expectedRoot = currentRosterRoot()) {
    if (!(row instanceof HTMLElement) || !(expectedRoot instanceof HTMLElement)) return null;
    if (!row.isConnected || !expectedRoot.isConnected || !expectedRoot.contains(row) || !row.matches("li.enemy")) return null;

    const profileAnchors = [...row.querySelectorAll("a[href]")]
      .filter(anchor => Boolean(profileIdFromHref(anchor.getAttribute("href"))));
    const profileIds = new Set(profileAnchors.map(anchor => profileIdFromHref(anchor.getAttribute("href"))));
    if (profileIds.size !== 1) return null;
    const targetId = normalizedTargetId([...profileIds][0]);
    if (!targetId || !rowDatasetIdentityMatches(row, targetId) || !rowFactionIdentityMatches(row)) return null;

    const member = directCell(row, [".member", "[class*='member__']"]);
    const level = directCell(row, [".level", "[class*='level__']"]);
    const status = directCell(row, [".status", "[class*='status__']"]);
    const attack = directCell(row, [".attack", "[class*='attack__']"]);
    if (!(member instanceof HTMLElement) || !nativeAttackIdentityMatches(attack, targetId)) return null;

    const honor = member.querySelector("[class*='honor'], [class*='honour']");
    return {
      row,
      li: row,
      statusDiv: status instanceof HTMLElement ? status : row,
      id: targetId,
      profile: profileAnchors[0],
      anchors: {
        member,
        honor: honor instanceof HTMLElement ? honor : member,
        level,
        status,
        attack
      }
    };
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

  function ensurePresentationLayer() {
    if (!document.body || !isWarPanelPresent()) return null;
    let layer = presentationLayer();
    if (layer?.shadowRoot) return layer;
    const idCollision = document.getElementById(SCRIPT.layerId);
    if (idCollision && !ownedPresentationLayers.has(idCollision)) return null;
    retireAllBindings();
    presentationResizeObserver?.disconnect();
    presentationResizeObserver = null;
    presentationRoot = null;
    presentationRootEpoch += 1;
    idCollision?.remove();

    layer = document.createElement("div");
    layer.id = SCRIPT.layerId;
    Object.assign(layer.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "100%",
      height: "0",
      overflow: "visible",
      pointerEvents: "none",
      zIndex: "2147482000"
    });
    ownedPresentationLayers.add(layer);
    ownedPresentationLayer = layer;
    document.body.appendChild(layer);
    const shadow = layer.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:absolute; inset:0 auto auto 0; width:100%; height:0; overflow:visible; pointer-events:none; }
        *,*::before,*::after { box-sizing:border-box; }
        [data-role='row-surface'] { position:absolute; left:0; top:0; width:100%; height:0; overflow:visible; pointer-events:none; }
        [data-role='row-host'] { position:absolute; display:block; overflow:visible; pointer-events:none; contain:layout style; font-family:Arial,sans-serif; }
        .presenter { position:absolute; display:none; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; pointer-events:none; text-align:center; }
        .ff,.est,.hospital { border:1px solid rgba(15,23,42,.55); border-radius:4px; color:#fff; background:rgba(15,23,42,.88); text-shadow:0 1px 1px #000; font-weight:900; line-height:14px; }
        .ff { font-size:7px; }
        .est { font-size:7px; }
        .hospital { color:#ffe2e2; background:rgba(127,29,29,.88); border-color:rgba(248,113,113,.75); font-size:7px; }
        button[data-role='dibs'] { position:absolute; display:none; min-width:34px; min-height:30px; margin:0; padding:2px; border:1px solid #718096; border-radius:6px; background:rgba(26,32,44,.96); color:#e2e8f0; font:900 8px/1.05 Arial,sans-serif; text-align:center; touch-action:manipulation; -webkit-tap-highlight-color:transparent; pointer-events:auto; overflow:hidden; }
        button[data-role='dibs'].ready { border-color:#38a169; background:#22543d; color:#f0fff4; }
        button[data-role='dibs'].locked,button[data-role='dibs'].prewar { border-color:#975a16; background:#744210; color:#fefcbf; }
        button[data-role='dibs'].unknown { border-color:#9b2c2c; background:#742a2a; color:#fff5f5; }
        button[data-role='dibs'].unavailable,button[data-role='dibs'].blocked { border-color:#4a5568; background:#171923; color:#94a3b8; }
        button[data-role='dibs'].claimed { border-color:#3182ce; background:#2a4365; color:#ebf8ff; }
        button[data-role='dibs'].shared { border-color:#805ad5; background:#44337a; color:#faf5ff; }
        button[data-role='dibs'].working { border-color:#0ea5e9; background:#0c4a6e; color:#e0f2fe; }
        button[data-role='dibs'].cleanup { border-color:#dc2626; background:#7f1d1d; color:#fff1f2; }
        button[data-role='dibs']:disabled { opacity:.7; }
        .label,.sub { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .sub { margin-top:1px; font-size:6.5px; opacity:.94; }
        [data-role='panel'] { position:fixed; right:max(6px,env(safe-area-inset-right)); bottom:max(6px,env(safe-area-inset-bottom)); width:min(270px,calc(100vw - 12px)); pointer-events:auto; color:#dbe5f1; font-family:system-ui,sans-serif; }
        details { border:1px solid rgba(100,116,139,.58); border-radius:8px; background:rgba(15,23,42,.96); box-shadow:0 3px 12px rgba(0,0,0,.3); }
        summary { padding:6px 9px; cursor:pointer; list-style:none; color:#f8fafc; font:850 10px/1.2 system-ui,sans-serif; touch-action:manipulation; }
        summary::-webkit-details-marker { display:none; }
        .version { float:right; color:#8fa0b4; font-size:8px; }
        .panel-body { padding:0 8px 7px; }
        .status-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; }
        .status-item { min-width:0; padding:3px 4px; border:1px solid rgba(100,116,139,.25); border-radius:5px; background:rgba(2,6,23,.45); }
        .status { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#cbd5e1; font:700 7.5px/1.2 system-ui,sans-serif; }
        .controls { display:flex; flex-wrap:wrap; gap:3px; margin-top:5px; }
        .controls button,.editor button { min-height:28px; border:1px solid #475569; border-radius:5px; background:#1e293b; color:#e2e8f0; padding:3px 6px; font:750 8px/1 system-ui,sans-serif; touch-action:manipulation; }
        .editor { display:none; gap:4px; margin-top:5px; }
        .editor.open { display:flex; }
        input { min-width:0; flex:1; border:1px solid #475569; border-radius:5px; background:#020617; color:#e2e8f0; padding:5px; font:8px/1.2 monospace; }
        .note { margin-top:5px; color:#94a3b8; font:7px/1.25 system-ui,sans-serif; }
        .links { margin-top:4px; font:7px/1.2 system-ui,sans-serif; }
        .links a { color:#7dd3fc; margin-right:7px; }
      </style>
      <div data-role="row-surface"></div>
      <aside data-role="panel" id="${SCRIPT.panelId}">
        <details>
          <summary>KS War Dibs PDA <span class="version">v${SCRIPT.version} RELEASE</span></summary>
          <div class="panel-body">
            <div class="status-grid">
              <div class="status-item" data-role="shared-item"><span class="status" data-role="status">Shared: loading</span></div>
              <div class="status-item" data-role="torn-item"><span class="status" data-role="torn-status">Torn: loading</span></div>
              <div class="status-item" data-role="rw-item"><span class="status" data-role="rw-status">RW: checking</span></div>
              <div class="status-item" data-role="country-item"><span class="status" data-role="country-status">Country: checking</span></div>
            </div>
            <div class="controls">
              <button type="button" data-role="key">Set FFScouter key</button>
              <button type="button" data-role="torn-key">Set Torn key</button>
              <button type="button" data-role="sync">Sync</button>
              <button type="button" data-role="forget-ff">Forget FF</button>
              <button type="button" data-role="forget-torn">Forget Torn</button>
            </div>
            <div class="editor" data-role="key-editor"><input data-role="key-input" type="password" autocomplete="off"><button type="button" data-role="key-save">Save</button><button type="button" data-role="key-cancel">Cancel</button></div>
            <div class="editor" data-role="torn-key-editor"><input data-role="torn-key-input" type="password" autocomplete="off"><button type="button" data-role="torn-key-save">Save</button><button type="button" data-role="torn-key-cancel">Cancel</button></div>
            <div class="note" data-role="note"></div>
            <div class="links"><a data-role="create-torn-key" target="_blank" rel="noopener noreferrer">Create minimal Torn key</a><a data-role="ff-war-room" target="_blank" rel="noopener noreferrer">War Room</a><a data-role="ff-terms" target="_blank" rel="noopener noreferrer">Terms</a><a data-role="ff-privacy" target="_blank" rel="noopener noreferrer">Privacy</a></div>
          </div>
        </details>
      </aside>
    `;

    const byRole = role => shadow.querySelector(`[data-role='${role}']`);
    byRole("ff-war-room").href = SCRIPT.ffscouterWarRoomUrl;
    byRole("ff-terms").href = SCRIPT.ffscouterTermsUrl;
    byRole("ff-privacy").href = SCRIPT.ffscouterPrivacyUrl;
    byRole("create-torn-key").href = SCRIPT.tornCustomKeyUrl;
    byRole("key")?.addEventListener("click", () => { beginFfCredentialEdit(); });
    byRole("torn-key")?.addEventListener("click", () => { beginTornCredentialEdit(); });
    byRole("key-cancel")?.addEventListener("click", () => byRole("key-editor")?.classList.remove("open"));
    byRole("torn-key-cancel")?.addEventListener("click", () => byRole("torn-key-editor")?.classList.remove("open"));
    byRole("key-save")?.addEventListener("click", () => void runFfCredentialMutation(saveSharedKeyFromEditor));
    byRole("torn-key-save")?.addEventListener("click", () => void runTornCredentialMutation(saveTornKeyFromEditor));
    byRole("sync")?.addEventListener("click", event => {
      event.preventDefault(); registerTrustedInteraction();
      if (sharedApiKey) { void fetchSharedClaims(); void fetchFairFightStats({ force: true }); }
      if (effectiveTornApiKey()) void fetchTornStatuses({ force: true });
      scanWarRows();
    });
    byRole("forget-ff")?.addEventListener("click", () => void runFfCredentialMutation(forgetSharedKey));
    byRole("forget-torn")?.addEventListener("click", () => void runTornCredentialMutation(forgetTornKey));
    startPresentationResizeObserver();
    updatePanel();
    return layer;
  }

  function startPresentationResizeObserver() {
    presentationResizeObserver?.disconnect();
    if (typeof ResizeObserver !== "function") return;
    presentationResizeObserver = new ResizeObserver(() => {
      if (runtimeActive && bridgeMounted && isRuntimeEligible()) layoutRowBindings();
    });
    const root = currentRosterRoot();
    if (root) presentationResizeObserver.observe(root);
    for (const binding of rowBindings.values()) observeBindingGeometry(binding);
  }

  function observeBindingGeometry(binding) {
    if (!presentationResizeObserver || !binding) return;
    for (const node of [binding.row, ...Object.values(binding.anchors)]) {
      if (node instanceof Element) presentationResizeObserver.observe(node);
    }
  }

  function retireBinding(binding) {
    if (!binding) return;
    for (const node of [binding.row, ...Object.values(binding.anchors || {})]) {
      if (node instanceof Element) presentationResizeObserver?.unobserve(node);
    }
    if (rowBindings.get(binding.row) === binding) rowBindings.delete(binding.row);
    if (xidBindings.get(binding.targetId) === binding) xidBindings.delete(binding.targetId);
    binding.host?.remove();
  }

  function retireAllBindings() {
    for (const binding of [...rowBindings.values()]) retireBinding(binding);
    rowBindings.clear();
    xidBindings.clear();
  }

  function removePresentationLayer() {
    retireAllBindings();
    presentationResizeObserver?.disconnect();
    presentationResizeObserver = null;
    presentationRoot = null;
    presentationRootEpoch += 1;
    const layer = ownedPresentationLayer;
    ownedPresentationLayer = null;
    if (layer instanceof HTMLElement && ownedPresentationLayers.has(layer)) layer.remove();
  }

  function sameResolvedBinding(binding, resolved) {
    return Boolean(
      binding && resolved &&
      binding.host?.isConnected &&
      binding.host.getRootNode() === presentationShadow() &&
      binding.host.parentElement === presentationShadow()?.querySelector("[data-role='row-surface']") &&
      binding.rootEpoch === presentationRootEpoch &&
      binding.row === resolved.row &&
      binding.targetId === resolved.id &&
      binding.profile === resolved.profile &&
      binding.anchors.member === resolved.anchors.member &&
      binding.anchors.level === resolved.anchors.level &&
      binding.anchors.status === resolved.anchors.status &&
      binding.anchors.attack === resolved.anchors.attack &&
      xidBindings.get(binding.targetId) === binding
    );
  }

  function currentResolvedBinding(binding) {
    if (!binding || presentationRoot !== currentRosterRoot()) return null;
    const resolved = resolveLivePdaRow(binding.row, presentationRoot);
    return sameResolvedBinding(binding, resolved) ? resolved : null;
  }

  function bindingTargetIsUnique(binding, resolved) {
    const root = presentationRoot;
    if (!binding || !resolved || !(root instanceof HTMLElement) || root !== currentRosterRoot()) return false;
    let matches = 0;
    for (const row of root.querySelectorAll("li.enemy")) {
      const candidate = resolveLivePdaRow(row, root);
      if (candidate?.id !== resolved.id) continue;
      matches += 1;
      if (candidate.row !== binding.row || matches > 1) return false;
    }
    return matches === 1;
  }

  function handleDibsClick(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.isTrusted !== true) return;
    registerTrustedInteraction();
    const button = event.currentTarget;
    const host = button?.closest?.("[data-role='row-host']");
    const binding = hostBindings.get(host);
    const resolved = currentResolvedBinding(binding);
    if (!resolved || !bindingTargetIsUnique(binding, resolved)) {
      if (binding) retireBinding(binding);
      queueObserverScan();
      return;
    }
    const own = currentOwnClaim();
    const state = button.dataset.state;
    if ((state === "claimed" || state === "cleanup") && own?.targetId === resolved.id) {
      void releaseOwnSharedTarget();
      return;
    }
    if (button.disabled || button.dataset.ready !== "true") return;
    if (
      own || sharedWriteBusy || ffCredentialChangeBusy() ||
      tornCredentialMutationInProgress || !newClaimStorageAuthorityReady() || !sharedApiKey
    ) return;
    void claimSharedTarget(resolved.id, getPlayerName(resolved));
  }

  function createBinding(resolved) {
    const surface = presentationShadow()?.querySelector(`[data-role='row-surface']`);
    if (!(surface instanceof HTMLElement)) return null;
    const host = document.createElement("div");
    host.id = `${SCRIPT.rowHostPrefix}${resolved.id}`;
    host.dataset.role = "row-host";
    host.dataset.xid = resolved.id;
    host.innerHTML = `
      <span class="presenter ff" data-role="ff"></span>
      <span class="presenter est" data-role="est"></span>
      <span class="presenter hospital" data-role="hospital"></span>
      <button type="button" data-role="dibs" disabled data-state="loading" data-ready="false"><span class="label">DIBS</span><span class="sub">LOADING</span></button>
    `;
    surface.appendChild(host);
    const binding = {
      rootEpoch: presentationRootEpoch,
      row: resolved.row,
      targetId: resolved.id,
      profile: resolved.profile,
      anchors: resolved.anchors,
      host
    };
    rowBindings.set(resolved.row, binding);
    xidBindings.set(resolved.id, binding);
    hostBindings.set(host, binding);
    host.querySelector(`[data-role='dibs']`)?.addEventListener("click", handleDibsClick);
    observeBindingGeometry(binding);
    return binding;
  }

  function setOwnGeometry(element, rect, rowRect, options = {}) {
    if (!(element instanceof HTMLElement) || !rect || rect.width <= 0 || rect.height <= 0) {
      if (element instanceof HTMLElement) element.style.display = "none";
      return false;
    }
    const inset = Number(options.inset || 0);
    const left = rect.left - rowRect.left + inset;
    const top = rect.top - rowRect.top + inset;
    const width = Math.max(0, rect.width - inset * 2);
    const height = Math.max(0, rect.height - inset * 2);
    if (![left, top, width, height].every(Number.isFinite) || width < 2 || height < 2) {
      element.style.display = "none";
      return false;
    }
    Object.assign(element.style, {
      display: "block",
      left: `${left.toFixed(2)}px`,
      top: `${top.toFixed(2)}px`,
      width: `${width.toFixed(2)}px`,
      height: `${height.toFixed(2)}px`
    });
    return true;
  }

  function layoutRowBinding(binding, layerRect) {
    const resolved = currentResolvedBinding(binding);
    if (!resolved) { retireBinding(binding); return; }
    const rowRect = resolved.row.getBoundingClientRect();
    if (rowRect.width <= 0 || rowRect.height <= 0) { binding.host.style.display = "none"; return; }
    Object.assign(binding.host.style, {
      display: "block",
      left: `${(rowRect.left - layerRect.left).toFixed(2)}px`,
      top: `${(rowRect.top - layerRect.top).toFixed(2)}px`,
      width: `${rowRect.width.toFixed(2)}px`,
      height: `${rowRect.height.toFixed(2)}px`
    });

    const ff = binding.host.querySelector(`[data-role='ff']`);
    const est = binding.host.querySelector(`[data-role='est']`);
    const hospital = binding.host.querySelector(`[data-role='hospital']`);
    const dibs = binding.host.querySelector(`[data-role='dibs']`);
    const memberRect = resolved.anchors.honor?.getBoundingClientRect();
    if (memberRect && ff instanceof HTMLElement) {
      const pillWidth = Math.min(52, Math.max(30, memberRect.width * .38));
      const pillRect = {
        left: memberRect.right - pillWidth - 2,
        top: memberRect.bottom - Math.min(15, memberRect.height) - 1,
        width: pillWidth,
        height: Math.min(15, memberRect.height)
      };
      setOwnGeometry(ff, pillRect, rowRect);
    } else if (ff instanceof HTMLElement) ff.style.display = "none";
    setOwnGeometry(est, resolved.anchors.level?.getBoundingClientRect(), rowRect, { inset: 1 });
    setOwnGeometry(hospital, resolved.anchors.status?.getBoundingClientRect(), rowRect, { inset: 1 });
    const dibsPlaced = setOwnGeometry(dibs, resolved.anchors.attack?.getBoundingClientRect(), rowRect, { inset: 1 });
    if (!dibsPlaced && dibs instanceof HTMLButtonElement) { dibs.disabled = true; dibs.dataset.ready = "false"; }
  }

  function layoutRowBindings() {
    if (!runtimeActive || !bridgeMounted || !isRuntimeEligible()) return;
    const layer = presentationLayer();
    if (!layer) return;
    const layerRect = layer.getBoundingClientRect();
    for (const binding of [...rowBindings.values()]) layoutRowBinding(binding, layerRect);
  }

  function updateDibsControl(host, decision, sharedClaim) {
    const button = host?.querySelector?.(`[data-role='dibs']`);
    const label = button?.querySelector?.(".label");
    const sub = button?.querySelector?.(".sub");
    if (!(button instanceof HTMLButtonElement) || !label || !sub || !decision) return;
    const playerId = String(host.dataset.xid || "");
    const own = currentOwnClaim();
    const exactOwnProof = exactSharedProofForOwnClaim(own);
    button.dataset.ready = "false";
    button.removeAttribute("title");

    if (pendingTargetId === playerId) {
      button.className = "working"; button.dataset.state = "working"; button.disabled = true;
      label.textContent = claimFlowState === CLAIM_FLOW_STATE.RELEASING ? "RELEASING" : "CLAIMING"; sub.textContent = "WAIT"; return;
    }
    if (
      own?.targetId === playerId && exactOwnProof &&
      quarantineAllowsExactOwnRelease(own)
    ) {
      const cleanup = own.cleanupRequired === true;
      button.className = cleanup ? "cleanup" : "claimed"; button.dataset.state = cleanup ? "cleanup" : "claimed"; button.disabled = !sharedApiKey || sharedWriteBusy;
      label.textContent = cleanup ? "QUEUED" : "DIBBED"; sub.textContent = "RELEASE"; return;
    }
    if (sharedClaim) {
      const firstName = normalizeText(sharedClaim.first?.claimer?.name) || "UNKNOWN";
      const extraCount = Math.max(0, sharedClaim.queue.length - 1);
      button.className = "shared"; button.dataset.state = "shared"; button.disabled = true; label.textContent = "TAKEN"; sub.textContent = extraCount > 0 ? `${firstName} +${extraCount}` : firstName; return;
    }
    if (own?.targetId === playerId) {
      button.className = "blocked"; button.dataset.state = "blocked"; button.disabled = true;
      label.textContent = "BLOCKED"; sub.textContent = "VERIFYING"; return;
    }

    button.className = decision.reason === "rw-not-started" || decision.reason === "rw-phase-unverifiable" ? "prewar" : decision.state;
    button.dataset.state = decision.state;
    label.textContent = "DIBS";
    if (decision.state === TARGET_STATE.READY) {
      button.disabled = !sharedApiKey || sharedWriteBusy;
      button.dataset.ready = button.disabled ? "false" : "true";
      sub.textContent = `${Number.isFinite(decision.seconds) ? formatCountdown(decision.seconds) : "READY"} · FF${Number(decision.fairFight).toFixed(1)}`;
      return;
    }
    button.disabled = true;
    if (decision.state === TARGET_STATE.BLOCKED) { label.textContent = "BLOCKED"; sub.textContent = own?.claimerName || "ACTIVE"; return; }
    if (decision.reason === "rw-not-started") { sub.textContent = "PREWAR"; return; }
    if (decision.state === TARGET_STATE.UNKNOWN) { sub.textContent = "UNKNOWN"; return; }
    if (decision.state === TARGET_STATE.UNAVAILABLE) { sub.textContent = ""; return; }
    sub.textContent = Number.isFinite(decision.seconds) ? formatCountdown(decision.seconds) : "LOCKED";
  }

  function renderRowBinding(binding, resolved, rwPhase) {
    const host = binding.host;
    const stats = scoutStatsForTarget(resolved.id);
    const ffValue = Number(stats?.fairFight);
    const ff = host.querySelector(`[data-role='ff']`);
    const est = host.querySelector(`[data-role='est']`);
    const hospital = host.querySelector(`[data-role='hospital']`);
    if (ff) {
      ff.textContent = Number.isFinite(ffValue) && ffValue > 0 ? `FF ${ffValue.toFixed(2)}` : "FF -";
      ff.style.background = Number.isFinite(ffValue) && ffValue > 0 ? scoutColorForFairFight(ffValue) : "rgba(15,23,42,.88)";
    }
    if (est) est.textContent = `Est ${formatBattleStatsEstimate(stats)}`;
    const hospitalState = computeHospitalSeconds(resolved);
    if (hospital) hospital.textContent = hospitalState.isHospital ? `Hosp ${formatCountdown(hospitalState.seconds) || "0:00"}` : "";

    const decision = classifyTargetState({
      playerId: resolved.id,
      ownClaim: currentOwnClaim(),
      isHospital: hospitalState.isHospital,
      seconds: hospitalState.seconds,
      fairFight: fairFightForTarget(resolved.id),
      countryEligibility: sameCountryForTarget(resolved.id, hospitalState.isHospital),
      rwPhase,
      ownershipUnresolved: Boolean(
        !newClaimStorageAuthorityReady() ||
        (sharedApiKey && sharedClaimsVerifiedAt <= 0) ||
        tornCredentialMutationInProgress ||
        currentClaimQuarantine() ||
        ambiguousOwnServerClaims
      )
    });
    updateDibsControl(host, decision, sharedClaimForTarget(resolved.id));
  }

  function scanWarRows() {
    if (!runtimeActive || !bridgeMounted || !isRuntimeEligible() || !isWarPanelPresent()) return;
    refreshCurrentWarSurface();
    const rwPhase = currentRwPhase({ refresh: false });
    const layer = ensurePresentationLayer();
    const root = currentRosterRoot();
    if (!layer || !root) return;
    if (presentationRoot !== root) {
      retireAllBindings();
      presentationRoot = root;
      presentationRootEpoch += 1;
      startPresentationResizeObserver();
    }

    const resolvedRows = [...root.querySelectorAll("li.enemy")]
      .map(row => resolveLivePdaRow(row, root))
      .filter(Boolean);
    const counts = new Map();
    for (const resolved of resolvedRows) counts.set(resolved.id, (counts.get(resolved.id) || 0) + 1);
    const accepted = resolvedRows.filter(resolved => counts.get(resolved.id) === 1);
    const acceptedRows = new Set(accepted.map(resolved => resolved.row));
    for (const binding of [...rowBindings.values()]) {
      if (!acceptedRows.has(binding.row)) retireBinding(binding);
    }

    for (const resolved of accepted) {
      let binding = rowBindings.get(resolved.row);
      if (!sameResolvedBinding(binding, resolved)) {
        if (binding) retireBinding(binding);
        const conflicting = xidBindings.get(resolved.id);
        if (conflicting) retireBinding(conflicting);
        binding = createBinding(resolved);
      }
      if (binding) renderRowBinding(binding, resolved, rwPhase);
    }
    layoutRowBindings();
    updatePanel();
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
    const shadow = presentationShadow();
    if (!shadow) return;
    const $ = role => shadow.querySelector(`[data-role='${role}']`);
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
        $("rw-status").textContent = "RW: LIVE";
        $("rw-status").title = "Fresh matching own-faction /v2/faction/wars confirms LIVE";
      } else if (rwState.phase === RW_PHASE.PREWAR) {
        $("rw-status").textContent = `RW: PREWAR ${formatRwRunway(rwState.runwaySeconds)}`;
        $("rw-status").title = "PREWAR is locked; a disappearing DOM countdown cannot unlock DIBS";
      } else {
        $("rw-status").textContent = "RW: VERIFYING";
        $("rw-status").title = "DIBS stays locked until own-faction wars confirms this visible war LIVE";
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
    const ffExternalLock = ffCredentialExternalLockActive();
    const ffChangeBusy = ffCredentialChangeBusy();
    if (ffExternalLock) $("key-editor")?.classList.remove("open");
    if ($("key")) {
      $("key").textContent = sharedApiKey ? "Change FF key" : "Set FFScouter key";
      $("key").disabled = ffExternalLock || ffChangeBusy;
    }
    if ($("forget-ff")) $("forget-ff").disabled =
      !sharedApiKey || ffCredentialForgetLockActive() || ffChangeBusy;
    if ($("key-input")) $("key-input").disabled = ffExternalLock || ffChangeBusy;
    if ($("key-save")) $("key-save").disabled = ffExternalLock || ffChangeBusy;
    if ($("key-cancel")) $("key-cancel").disabled = ffChangeBusy;
    const tornExternalLock = tornCredentialExternalLockActive();
    const tornChangeBusy = tornCredentialMutationInProgress;
    if (tornExternalLock) $("torn-key-editor")?.classList.remove("open");
    if ($("torn-key")) {
      if (injectedPdaTornApiKey()) { $("torn-key").textContent = "Torn key: PDA"; $("torn-key").disabled = true; }
      else {
        $("torn-key").textContent = storedTornApiKey ? "Change Torn key" : "Set Torn key";
        $("torn-key").disabled = tornExternalLock || tornChangeBusy;
      }
    }
    if ($("forget-torn")) $("forget-torn").disabled =
      !!injectedPdaTornApiKey() || !storedTornApiKey || tornCredentialForgetLockActive() || tornChangeBusy;
    if ($("torn-key-input")) $("torn-key-input").disabled = tornExternalLock || tornChangeBusy;
    if ($("torn-key-save")) $("torn-key-save").disabled = tornExternalLock || tornChangeBusy;
    if ($("torn-key-cancel")) $("torn-key-cancel").disabled = tornChangeBusy;
    const note = $("note");
    if (note) note.textContent = "API-confirmed LIVE + Hospital ≤2:00 + FF 2.00–5.00. PREWAR and unverifiable wars stay locked.";
  }

  async function runFfCredentialMutation(mutation) {
    try {
      await mutation();
    } catch {
      let recovered = !ffCredentialMutationInProgress;
      if (ffCredentialMutationInProgress) {
        try { recovered = await restoreSharedApiChangeJournal(); } catch { recovered = false; }
      }
      if (!recovered) ffCredentialStorageUnresolved = true;
      if (runtimeActive && isRuntimeEligible()) {
        setSharedStatus(
          "error",
          recovered
            ? "Shared: credential change failed; original state recovered"
            : "Shared: credential change failed; secure recovery unresolved",
          sharedClaims.size
        );
      }
    } finally {
      if (ffCredentialMutationInProgress) {
        ffCredentialMutationInProgress = false;
        enforceFfCredentialLock();
        updatePanel();
      }
    }
  }

  async function runTornCredentialMutation(mutation) {
    try {
      await mutation();
    } catch {
      if (tornCredentialMutationInProgress) tornCredentialStorageUnresolved = true;
      if (runtimeActive && isRuntimeEligible()) {
        setTornStatusState("error", "Torn: credential change failed; secure state unresolved", 0);
      }
    } finally {
      if (tornCredentialMutationInProgress) {
        tornCredentialMutationInProgress = false;
        closeTornCredentialEditor();
        updatePanel();
      }
      if (runtimeActive && isRuntimeEligible()) scanWarRows();
    }
  }

  async function saveSharedKeyFromEditor() {
    const shadow = presentationShadow();
    const input = shadow?.querySelector("[data-role='key-input']");
    const key = validateFfscouterKey(input?.value);
    if (!key) { setSharedStatus("error", "Shared: invalid key format"); return; }
    if (ffCredentialChangeBusy() || ffCredentialExternalLockActive()) {
      enforceFfCredentialLock();
      setSharedStatus("error", "Shared: key change locked while DIBS ownership is active or unresolved");
      return;
    }
    const recoveryEvidence = captureCredentialRecoveryEvidence();
    const recoveryFingerprint = credentialRecoveryEvidenceFingerprint(recoveryEvidence);
    if (credentialRecoveryEvidenceActive(recoveryEvidence)) {
      closeFfCredentialEditor();
      setSharedStatus("error", "Shared: active DIBS must be released or expire before key replacement");
      return;
    }
    const oldKey = sharedApiKey;
    const selfAtStart = selfPlayerId;
    const ownershipProofVerifiedAt = sharedClaimsVerifiedAt;
    const credentialRejectedAtStart = sharedCredentialRejected;
    const operationSerial = ++ffCredentialChangeSerial;
    const generation = runtimeGeneration;
    let operationAuthorityEpoch = -1;
    const operationOwns = () => operationSerial === ffCredentialChangeSerial && ffCredentialMutationInProgress;
    const operationEvidenceCurrent = () =>
      credentialRecoveryEvidenceFingerprint() === recoveryFingerprint;
    const operationAuthorityCurrent = () => {
      if (
        !operationEvidenceCurrent() || sharedWriteBusy || ambiguousOwnServerClaims ||
        claimAuthorityStorageUnresolved
      ) return false;
      if (!oldKey || credentialRejectedAtStart) return true;
      return selfAtStart === selfPlayerId && validTargetId(selfAtStart) &&
        ownershipProofVerifiedAt > 0 &&
        nowMs() - ownershipProofVerifiedAt <= CONFIG.sharedPollMs * 2 &&
        activeSharedClaimsForClaimer(selfAtStart).length === 0;
    };
    const operationForegroundCurrent = () => (
      operationOwns() && apiKeyStorageReady && generation === runtimeGeneration && runtimeActive && isRuntimeEligible() &&
      sharedApiKey === oldKey && sharedAuthorityEpoch === operationAuthorityEpoch &&
      input instanceof HTMLInputElement && input.isConnected && validateFfscouterKey(input.value) === key &&
      operationAuthorityCurrent()
    );
    ffCredentialMutationInProgress = true;
    invalidateSharedReads();
    operationAuthorityEpoch = sharedAuthorityEpoch;
    fairFightRequestSerial += 1;
    fairFightSyncing = false;
    updatePanel();
    const candidateOperational = await ffCandidateKeyIsOperational(key, operationForegroundCurrent);
    if (!candidateOperational || !operationForegroundCurrent()) {
      if (operationOwns()) ffCredentialMutationInProgress = false;
      if (runtimeActive && isRuntimeEligible()) {
        setSharedStatus("error", "Shared: candidate key validation failed; key unchanged");
        if (oldKey) void fetchSharedClaims();
      }
      return;
    }
    const journalReady = await prepareSharedApiChangeJournal(oldKey, operationForegroundCurrent);
    if (!journalReady) {
      if (operationOwns()) ffCredentialMutationInProgress = false;
      if (runtimeActive && isRuntimeEligible()) {
        setSharedStatus("error", "Shared: existing key could not be secured for replacement");
        if (oldKey) void fetchSharedClaims();
      }
      return;
    }
    const stored = await saveSecureApiKey(key);
    const accepted = stored && operationForegroundCurrent()
      ? await commitSharedApiChangeJournal()
      : false;
    if (!accepted) {
      const recovered = await restoreSharedApiChangeToKnownKey(oldKey);
      if (!recovered) ffCredentialStorageUnresolved = true;
      if (operationOwns()) ffCredentialMutationInProgress = false;
      if (runtimeActive && isRuntimeEligible()) {
        setSharedStatus(
          "error",
          recovered
            ? (stored ? "Shared: key change cancelled by a new DIBS lock" : "Shared: key could not be stored securely")
            : "Shared: key change cancelled; original key recovery pending"
        );
        if (oldKey) void fetchSharedClaims();
      }
      return;
    }
    sharedApiKey = key;
    sharedCredentialRejected = false;
    ffCredentialMutationInProgress = false;
    invalidateSharedReads();
    sharedClaims = new Map();
    sharedBackoffUntil = 0;
    sharedTransportFailureStreak = 0;
    fairFightStats = new Map();
    fairFightLastFetchAt = 0;
    fairFightEverSucceeded = false;
    if (input instanceof HTMLInputElement && input.isConnected) input.value = "";
    closeFfCredentialEditor();
    setSharedStatus(
      ffCredentialStorageUnresolved ? "error" : "ready",
      ffCredentialStorageUnresolved
        ? "Shared: key saved; secure cleanup unresolved"
        : "Shared: key saved securely · syncing…",
      0
    );
    if (runtimeActive && isRuntimeEligible()) {
      void fetchSharedClaims();
      void fetchFairFightStats({ force: true });
    }
  }

  async function saveTornKeyFromEditor() {
    const shadow = presentationShadow();
    const input = shadow?.querySelector("[data-role='torn-key-input']");
    const key = validateTornApiKey(input?.value);
    if (!key) { setTornStatusState("error", "Torn: invalid key format"); return; }
    if (tornCredentialMutationInProgress || tornCredentialExternalLockActive()) {
      closeTornCredentialEditor();
      setTornStatusState("error", "Torn: key change locked while DIBS ownership is active or unresolved");
      return;
    }
    const recoveryEvidence = captureCredentialRecoveryEvidence();
    const recoveryFingerprint = credentialRecoveryEvidenceFingerprint(recoveryEvidence);
    const recoveryMode = credentialRecoveryEvidenceActive(recoveryEvidence);
    const recoveryExpectedPlayerId = credentialRecoveryExpectedPlayerId(recoveryEvidence);
    if (recoveryMode && !recoveryExpectedPlayerId) {
      closeTornCredentialEditor();
      setTornStatusState("error", "Torn: recovery identity is ambiguous; key unchanged");
      return;
    }
    const oldKey = validateTornApiKey(storedTornApiKey);
    const effectiveKeyAtStart = effectiveTornApiKey();
    const sharedKeyAtStart = sharedApiKey;
    const selfAtStart = selfPlayerId;
    const ownershipProofVerifiedAt = sharedClaimsVerifiedAt;
    const credentialRejectedAtStart = storedTornCredentialRejected || storedTornCapabilityRejected;
    const operationSerial = ++tornCredentialChangeSerial;
    const generation = runtimeGeneration;
    let operationTornEpoch = -1;
    let operationSharedEpoch = -1;
    const operationOwns = () =>
      operationSerial === tornCredentialChangeSerial && tornCredentialMutationInProgress;
    const operationEvidenceCurrent = () =>
      credentialRecoveryEvidenceFingerprint() === recoveryFingerprint;
    const operationAuthorityCurrent = () => {
      if (
        !operationEvidenceCurrent() || sharedWriteBusy || ffCredentialMutationInProgress ||
        claimAuthorityEvidenceUnresolved
      ) return false;
      if (recoveryMode) {
        return credentialRecoveryExpectedPlayerId(captureCredentialRecoveryEvidence()) ===
          recoveryExpectedPlayerId;
      }
      if (claimAuthorityStorageUnresolved || ambiguousOwnServerClaims) return false;
      if (!effectiveKeyAtStart || credentialRejectedAtStart) return true;
      if (!sharedKeyAtStart) return false;
      return validTargetId(selfAtStart) && ownershipProofVerifiedAt > 0 &&
        nowMs() - ownershipProofVerifiedAt <= CONFIG.sharedPollMs * 2 &&
        activeSharedClaimsForClaimer(selfAtStart).length === 0;
    };
    const operationForegroundCurrent = () => (
      operationOwns() && apiKeyStorageReady && generation === runtimeGeneration &&
      runtimeActive && isRuntimeEligible() && storedTornApiKey === oldKey &&
      sharedApiKey === sharedKeyAtStart && tornCredentialEpoch === operationTornEpoch &&
      sharedAuthorityEpoch === operationSharedEpoch && input instanceof HTMLInputElement &&
      input.isConnected && validateTornApiKey(input.value) === key && operationAuthorityCurrent()
    );
    tornCredentialMutationInProgress = true;
    invalidateTornCredentialRequests();
    operationTornEpoch = tornCredentialEpoch;
    invalidateSharedReads();
    operationSharedEpoch = sharedAuthorityEpoch;
    updatePanel();
    const candidateOperational = await tornCandidateKeyProvesRecovery(
      key,
      recoveryEvidence,
      operationForegroundCurrent
    );
    if (!candidateOperational || !operationForegroundCurrent()) {
      if (operationOwns()) tornCredentialMutationInProgress = false;
      if (runtimeActive && isRuntimeEligible()) {
        setTornStatusState("error", "Torn: candidate identity or capabilities failed; key unchanged", 0);
        if (sharedApiKey) void fetchSharedClaims();
        if (effectiveTornApiKey()) void fetchTornStatuses({ force: true });
      }
      return;
    }
    const stored = await saveSecureTornApiKey(key);
    const accepted = stored && operationForegroundCurrent();
    if (!accepted) {
      let recovered = false;
      if (operationOwns()) {
        recovered = oldKey ? await saveSecureTornApiKey(oldKey) : await deleteSecureTornApiKey();
        if (!recovered) tornCredentialStorageUnresolved = true;
        tornCredentialMutationInProgress = false;
      }
      if (runtimeActive && isRuntimeEligible()) {
        setTornStatusState(
          "error",
          recovered
            ? (stored ? "Torn: key change cancelled by a new DIBS lock" : "Torn: key could not be stored securely")
            : "Torn: key change cancelled; original key recovery pending"
        );
        if (sharedApiKey) void fetchSharedClaims();
        if (effectiveTornApiKey()) void fetchTornStatuses({ force: true });
      }
      return;
    }
    storedTornApiKey = key;
    storedTornCredentialRejected = false;
    storedTornCapabilityRejected = false;
    tornCredentialMutationInProgress = false;
    apiKeyStorageReady = true;
    invalidateTornCredentialRequests();
    invalidateSharedReads();
    keyScopeReady = false;
    selfPlayerId = ""; selfPlayerName = ""; selfFactionId = ""; opponentFactionId = ""; tornUserBasicCapability = "unknown"; selfIdentityLastAttemptAt = 0;
    ownLocationState = { country: "", traveling: false, checkedAt: 0 };
    publicBasicStatusCache.clear();
    if (input instanceof HTMLInputElement && input.isConnected) input.value = "";
    closeTornCredentialEditor();
    opponentMembersState = { factionId: "", members: new Map(), fetchedAt: 0 };
    currentWarSurface = null;
    setTornStatusState("ready", "Torn: key saved · syncing…", 0);
    if (runtimeActive && isRuntimeEligible()) {
      if (sharedApiKey) void fetchSharedClaims();
      void fetchTornStatuses({ force: true });
    }
  }

  async function forgetSharedKey() {
    if (!sharedApiKey) return;
    if (ffCredentialChangeBusy() || ffCredentialForgetLockActive()) {
      enforceFfCredentialLock();
      window.alert("Resolve active or unverified DIBS before forgetting the FFScouter key.");
      return;
    }
    if (!window.confirm("Forget the saved FFScouter key on this device?")) return;
    registerTrustedInteraction();
    const oldKey = sharedApiKey;
    const selfAtStart = selfPlayerId;
    const ownershipProofVerifiedAt = sharedClaimsVerifiedAt;
    const credentialRejectedAtStart = sharedCredentialRejected;
    const operationSerial = ++ffCredentialChangeSerial;
    const generation = runtimeGeneration;
    let operationAuthorityEpoch = -1;
    const operationOwns = () => operationSerial === ffCredentialChangeSerial && ffCredentialMutationInProgress;
    const operationForegroundCurrent = () => (
      operationOwns() && apiKeyStorageReady && generation === runtimeGeneration && runtimeActive && isRuntimeEligible() &&
      sharedApiKey === oldKey && sharedAuthorityEpoch === operationAuthorityEpoch &&
      !ffCredentialClaimLockActive() && (
        (credentialRejectedAtStart && sharedCredentialRejected) || (
          selfAtStart === selfPlayerId && validTargetId(selfAtStart) && ownershipProofVerifiedAt > 0 &&
          nowMs() - ownershipProofVerifiedAt <= CONFIG.sharedPollMs * 2
        )
      )
    );
    ffCredentialMutationInProgress = true;
    invalidateSharedReads();
    operationAuthorityEpoch = sharedAuthorityEpoch;
    fairFightRequestSerial += 1;
    fairFightSyncing = false;
    updatePanel();
    const journalReady = await prepareSharedApiChangeJournal(oldKey, operationForegroundCurrent);
    if (!journalReady) {
      if (operationOwns()) ffCredentialMutationInProgress = false;
      if (runtimeActive && isRuntimeEligible()) {
        setSharedStatus("error", "Shared: existing key could not be secured before forget");
        void fetchSharedClaims();
      }
      return;
    }
    const removed = await deleteSecureApiKey();
    const accepted = removed && operationForegroundCurrent()
      ? await commitSharedApiChangeJournal()
      : false;
    if (!accepted) {
      const recovered = await restoreSharedApiChangeToKnownKey(oldKey);
      if (!recovered) ffCredentialStorageUnresolved = true;
      if (operationOwns()) ffCredentialMutationInProgress = false;
      if (runtimeActive && isRuntimeEligible()) {
        setSharedStatus(
          "error",
          recovered
            ? (removed ? "Shared: forget cancelled by a new DIBS lock" : "Shared: saved key could not be removed")
            : "Shared: forget cancelled; original key recovery pending"
        );
        void fetchSharedClaims();
      }
      return;
    }
    sharedApiKey = "";
    sharedCredentialRejected = false;
    ffCredentialMutationInProgress = false;
    invalidateSharedReads();
    sharedClaims = new Map();
    sharedBackoffUntil = 0;
    sharedTransportFailureStreak = 0;
    fairFightStats = new Map();
    fairFightLastFetchAt = 0;
    fairFightEverSucceeded = false;
    setSharedStatus(
      ffCredentialStorageUnresolved ? "error" : "key-required",
      ffCredentialStorageUnresolved
        ? "Shared: key removed; secure cleanup unresolved"
        : "Shared: key required",
      0
    );
    scanWarRows();
  }

  async function forgetTornKey() {
    if (injectedPdaTornApiKey()) { setTornStatusState("ready", "Torn: PDA API key is managed by Torn PDA", opponentMembersState.members.size); return; }
    if (!storedTornApiKey) return;
    if (tornCredentialMutationInProgress || tornCredentialForgetLockActive()) {
      closeTornCredentialEditor();
      window.alert("Resolve active or unverified DIBS before forgetting the Torn API key.");
      return;
    }
    if (!window.confirm("Forget the saved Torn API key on this device?")) return;
    registerTrustedInteraction();
    const oldKey = validateTornApiKey(storedTornApiKey);
    const sharedKeyAtStart = sharedApiKey;
    const selfAtStart = selfPlayerId;
    const ownershipProofVerifiedAt = sharedClaimsVerifiedAt;
    const operationSerial = ++tornCredentialChangeSerial;
    const generation = runtimeGeneration;
    let operationTornEpoch = -1;
    let operationSharedEpoch = -1;
    const operationOwns = () =>
      operationSerial === tornCredentialChangeSerial && tornCredentialMutationInProgress;
    const operationForegroundCurrent = () => (
      operationOwns() && apiKeyStorageReady && generation === runtimeGeneration &&
      runtimeActive && isRuntimeEligible() && storedTornApiKey === oldKey &&
      sharedApiKey === sharedKeyAtStart && tornCredentialEpoch === operationTornEpoch &&
      sharedAuthorityEpoch === operationSharedEpoch && !sharedWriteBusy &&
      !ffCredentialStorageUnresolved && !tornCredentialStorageUnresolved &&
      !claimAuthorityEvidenceUnresolved && !ffCredentialClaimLockActive() &&
      Boolean(sharedKeyAtStart) && validTargetId(selfAtStart) &&
      ownershipProofVerifiedAt > 0 &&
      nowMs() - ownershipProofVerifiedAt <= CONFIG.sharedPollMs * 2 &&
      activeSharedClaimsForClaimer(selfAtStart).length === 0
    );
    tornCredentialMutationInProgress = true;
    invalidateTornCredentialRequests();
    operationTornEpoch = tornCredentialEpoch;
    invalidateSharedReads();
    operationSharedEpoch = sharedAuthorityEpoch;
    updatePanel();
    const removed = await deleteSecureTornApiKey();
    const accepted = removed && operationForegroundCurrent();
    if (!accepted) {
      let recovered = false;
      if (operationOwns()) {
        recovered = Boolean(oldKey) && await saveSecureTornApiKey(oldKey);
        if (!recovered) tornCredentialStorageUnresolved = true;
        tornCredentialMutationInProgress = false;
      }
      if (runtimeActive && isRuntimeEligible()) {
        setTornStatusState(
          "error",
          recovered
            ? (removed ? "Torn: forget cancelled by a new DIBS lock" : "Torn: saved key could not be removed")
            : "Torn: forget cancelled; original key recovery pending"
        );
        if (sharedApiKey) void fetchSharedClaims();
        if (effectiveTornApiKey()) void fetchTornStatuses({ force: true });
      }
      return;
    }
    storedTornApiKey = "";
    storedTornCredentialRejected = false;
    storedTornCapabilityRejected = false;
    tornCredentialMutationInProgress = false;
    apiKeyStorageReady = true;
    invalidateTornCredentialRequests();
    invalidateSharedReads();
    keyScopeReady = false; opponentMembersState = { factionId: "", members: new Map(), fetchedAt: 0 }; currentWarSurface = null;
    selfPlayerId = ""; selfPlayerName = ""; selfFactionId = ""; opponentFactionId = ""; tornUserBasicCapability = "unknown"; selfIdentityLastAttemptAt = 0;
    ownLocationState = { country: "", traveling: false, checkedAt: 0 };
    publicBasicStatusCache.clear();
    setTornStatusState("key-required", "Torn: API key required", 0); scanWarRows();
  }

  async function initializeApiKeyStorage() {
    const tornOperationSerial = tornCredentialChangeSerial;
    const sharedOperationSerial = ffCredentialChangeSerial;
    let sharedLoad = { ready: false, key: "" };
    let tornLoad = { ready: false, key: "" };
    try { [sharedLoad, tornLoad] = await Promise.all([loadSecureApiKey(), loadSecureTornApiKey()]); }
    catch { sharedLoad = { ready: false, key: "" }; tornLoad = { ready: false, key: "" }; }

    if (sharedOperationSerial === ffCredentialChangeSerial && !ffCredentialMutationInProgress) {
      sharedApiKey = sharedLoad.key;
      ffCredentialStorageUnresolved = !sharedLoad.ready;
    }
    if (tornOperationSerial === tornCredentialChangeSerial && !tornCredentialMutationInProgress) {
      storedTornApiKey = tornLoad.key;
      tornCredentialStorageUnresolved = !tornLoad.ready;
    }
    apiKeyStorageReady = true;

    if (claimAuthorityStorageUnresolved) {
      setSharedStatus("error", "Shared: claim authority storage unresolved", 0);
    } else if (ffCredentialStorageUnresolved) {
      setSharedStatus("error", "Shared: secure storage recovery unresolved", 0);
    } else if (sharedApiKey) setSharedStatus("ready", "Shared: saved key loaded", 0);
    else setSharedStatus("key-required", "Shared: key required", 0);
    if (tornCredentialStorageUnresolved) {
      setTornStatusState("error", "Torn: secure storage unavailable", 0);
    } else if (effectiveTornApiKey()) {
      setTornStatusState("ready", injectedPdaTornApiKey() ? "Torn: PDA key loaded" : "Torn: saved key loaded", 0);
    } else setTornStatusState("key-required", "Torn: API key required", 0);
    updatePanel();

    if (runtimeActive) {
      if (sharedApiKey) { void fetchSharedClaims(); void fetchFairFightStats({ force: true }); }
      if (effectiveTornApiKey()) {
        void fetchTornStatuses({ force: true });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SPA lifecycle / foreground-only runtime
  // ---------------------------------------------------------------------------

  function mutationTouchesWarRows(records) {
    for (const record of records) {
      const element = record.target instanceof Element ? record.target : record.target?.parentElement;
      if (element?.closest?.("#faction_war_list_id")) return true;
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
    bodyObserver.observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true, attributeFilter: ["href", "class", "data-player-id", "data-user-id", "data-profile", "data-until", "data-warid", "title"] });
  }

  function stopBodyObserver() {
    bodyObserver?.disconnect(); bodyObserver = null; observerScanQueued = false;
  }

  function mutationTouchesRouteSurface(records) {
    const routeSurfaceSelector =
      "[data-warid], #faction_war_list_id, .enemy-faction, a[href*='factions.php']";
    for (const record of records) {
      const element = record.target instanceof Element ? record.target : record.target?.parentElement;
      if (
        record.type === "attributes" && element instanceof Element &&
        (
          element.matches(routeSurfaceSelector) ||
          Boolean(element.closest(routeSurfaceSelector)) ||
          Boolean(element.querySelector(routeSurfaceSelector))
        )
      ) return true;
      if (
        record.type === "characterData" &&
        normalizeText(record.target?.nodeValue).toUpperCase() === "YOUR FACTION IS NOT IN A WAR"
      ) return true;
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof Element)) continue;
        if (
          node.matches("[data-warid], #faction_war_list_id, .enemy-faction") ||
          node.querySelector("[data-warid], #faction_war_list_id, .enemy-faction")
        ) return true;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (normalizeText(walker.currentNode.nodeValue).toUpperCase() === "YOUR FACTION IS NOT IN A WAR") return true;
        }
      }
    }
    return false;
  }

  function queueRouteReconcile(records) {
    if (
      destroyed || !isRuntimeContextEligible() || !mutationTouchesRouteSurface(records) ||
      routeReconcileQueued
    ) return;
    routeReconcileQueued = true;
    queueMicrotask(() => {
      routeReconcileQueued = false;
      if (!destroyed && isRuntimeContextEligible()) reconcileLifecycle({ structural: true });
    });
  }

  function startRouteObserver() {
    if (routeObserver || !isRuntimeContextEligible() || !(document.body instanceof HTMLElement)) return;
    routeObserver = new MutationObserver(queueRouteReconcile);
    routeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-hidden", "class", "data-warid", "hidden", "href", "style"],
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function stopRouteObserver() {
    routeObserver?.disconnect();
    routeObserver = null;
    routeReconcileQueued = false;
  }

  function reconcileRoute({ structural = false } = {}) {
    if (!runtimeActive || !isRuntimeContextEligible()) return false;
    const canonical = canonicalPdaRankedWarSurface();
    if (!canonical) {
      suspendRuntime();
      if (isRuntimeContextEligible()) startRouteObserver();
      return false;
    }
    if (!bridgeMounted) mountBridge();
    if (!bridgeMounted) return false;
    refreshCurrentWarSurface({ structural });
    ensurePresentationLayer();
    startBodyObserver();
    scanWarRows();
    return true;
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
    removePresentationLayer();
  }

  function mountBridge() {
    if (bridgeMounted || !runtimeActive || !isRuntimeEligible() || !isWarPanelPresent()) return;
    bridgeMounted = true;
    ensurePresentationLayer(); startBodyObserver(); scanWarRows();
    kickInitialFairFightLoad();
    mountPrimeTimer = window.setTimeout(() => primeMountedBridge(0), CONFIG.mountPrimeDelayMs);
  }

  function unmountBridge() {
    bridgeMounted = false;
    stopBodyObserver();
    removeOwnUi();
  }

  function primeMountedBridge(attempt) {
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return;
    const rows = getEnemyRows();
    if (!rows.length && attempt < CONFIG.mountPrimeMaxAttempts) {
      mountPrimeTimer = window.setTimeout(() => primeMountedBridge(attempt + 1), CONFIG.mountPrimeRetryMs);
      return;
    }
    scanWarRows();
  }

  function reconcileLifecycle({ structural = false } = {}) {
    if (destroyed) return false;
    if (!isRuntimeContextEligible()) {
      if (runtimeActive) suspendRuntime();
      else { stopRouteObserver(); unmountBridge(); }
      return false;
    }
    if (!canonicalPdaRankedWarSurface()) {
      if (runtimeActive) suspendRuntime();
      else unmountBridge();
      startRouteObserver();
      return false;
    }
    if (!runtimeActive) {
      resumeRuntime();
      return runtimeActive;
    }
    return reconcileRoute({ structural });
  }

  function startRuntimeTimers() {
    clearTimers();
    rowRefreshTimer = window.setInterval(() => { if (runtimeActive && isRuntimeEligible()) scanWarRows(); }, CONFIG.rowRefreshMs);
    sharedPollTimer = window.setInterval(() => { if (sharedApiKey && runtimeActive && isRuntimeEligible()) void fetchSharedClaims(); }, CONFIG.sharedPollMs);
    fairFightTimer = window.setInterval(() => { if (sharedApiKey && runtimeActive && isRuntimeEligible()) void fetchFairFightStats(); }, CONFIG.fairFightRefreshMs);
    tornStatusTimer = window.setInterval(() => {
      if (!effectiveTornApiKey() || !runtimeActive || !isRuntimeEligible()) return;
      void fetchTornStatuses();
      if (selfPlayerId) {
        refreshOwnLocationFromBasic();
        void fetchPublicBasicStatus(selfPlayerId);
      }
    }, CONFIG.tornStatusPollMs);
    routeHeartbeatTimer = window.setInterval(() => {
      if (runtimeActive) reconcileLifecycle();
    }, CONFIG.routeHeartbeatMs);
  }

  function suspendRuntime() {
    if (!runtimeActive) return;
    const observedPrewarWarId = ownWarsState.phase === RW_PHASE.PREWAR
      ? ownWarsState.warId
      : prewarObservation?.warId;
    if (validTargetId(observedPrewarWarId)) lockedPrewarWarIds.add(String(observedPrewarWarId));
    runtimeActive = false;
    runtimeGeneration += 1;
    invalidateSharedReads();
    sharedClaims = new Map();
    ambiguousOwnServerClaims = false;
    fairFightRequestSerial += 1;
    fairFightSyncing = false;
    fairFightStats = new Map();
    fairFightLastFetchAt = 0;
    invalidateTornCredentialRequests();
    ownWarsState = emptyOwnWarsState();
    opponentMembersState = { factionId: "", members: new Map(), fetchedAt: 0 };
    currentWarSurface = null;
    prewarObservation = null;
    opponentFactionId = "";
    clearTimers();
    stopRouteObserver();
    unmountBridge();
  }

  function resumeRuntime() {
    if (destroyed || runtimeActive || !isRuntimeContextEligible() || !canonicalPdaRankedWarSurface()) return;
    runtimeActive = true;
    runtimeGeneration += 1;
    mountBridge();
    if (!bridgeMounted) { runtimeActive = false; return; }
    startRouteObserver();
    startRuntimeTimers();

    if (apiKeyStorageReady) {
      if (sharedApiKey) { void fetchSharedClaims(); void fetchFairFightStats({ force: true }); }
      if (effectiveTornApiKey()) void fetchTornStatuses({ force: true });
    }
  }

  function handleViewportGeometryChange() {
    if (destroyed) return;
    if (!runtimeActive) {
      if (isRuntimeContextEligible()) reconcileLifecycle({ structural: true });
      return;
    }
    if (!bridgeMounted) return;
    if (!isRuntimeEligible()) {
      reconcileLifecycle();
      return;
    }
    scanWarRows();
  }

  function destroy() {
    if (destroyed) return;
    if (runtimeActive) suspendRuntime();
    destroyed = true;
    runtimeActive = false;
    runtimeGeneration += 1;
    clearTimers();
    stopRouteObserver();
    unmountBridge();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("hashchange", onRouteLocationChange);
    window.removeEventListener("popstate", onRouteLocationChange);
    window.removeEventListener("online", onOnline);
    for (const eventName of ["pointerdown", "touchstart", "wheel", "keydown"]) {
      document.removeEventListener(eventName, onTrustedActivity, true);
    }
    window.removeEventListener("resize", handleViewportGeometryChange);
    window.removeEventListener("orientationchange", handleViewportGeometryChange);
    window.visualViewport?.removeEventListener("resize", handleViewportGeometryChange);
    window.visualViewport?.removeEventListener("scroll", handleViewportGeometryChange);
    window.removeEventListener("DOMContentLoaded", boot);
    if (wrappedHistoryPushState && history.pushState === wrappedHistoryPushState) history.pushState = nativeHistoryPushState;
    if (wrappedHistoryReplaceState && history.replaceState === wrappedHistoryReplaceState) history.replaceState = nativeHistoryReplaceState;
    delete window[SCRIPT.instanceKey];
  }

  function onVisibilityChange() {
    if (!isPageVisible()) {
      suspendRuntime();
      return;
    }
    windowFocused = initialFocusState();
    if (windowFocused) reconcileLifecycle({ structural: true });
  }

  function onWindowFocus() {
    windowFocused = true;
    if (isPageVisible()) reconcileLifecycle({ structural: true });
  }

  function onWindowBlur() {
    windowFocused = false;
    suspendRuntime();
  }

  function onRouteLocationChange() {
    if (!destroyed) reconcileLifecycle({ structural: true });
  }

  function onTrustedActivity(event) {
    registerTrustedInteraction(event);
  }

  function onPageHide(event) {
    if (event.persisted) suspendRuntime();
    else destroy();
  }

  function onPageShow() {
    if (destroyed || !isPageVisible()) return;
    windowFocused = initialFocusState();
    if (windowFocused) reconcileLifecycle({ structural: true });
  }

  function onOnline() {
    if (!runtimeActive || !isRuntimeEligible()) return;
    sharedBackoffUntil = 0;
    fairFightBackoffUntil = 0;
    tornStatusBackoffUntil = 0;
    if (sharedApiKey) { void fetchSharedClaims(); void fetchFairFightStats({ force: true }); }
    if (effectiveTornApiKey()) void fetchTornStatuses({ force: true });
  }

  function installHistoryLifecycleHooks() {
    wrappedHistoryPushState = function (...args) {
      const result = Reflect.apply(nativeHistoryPushState, this, args);
      onRouteLocationChange();
      return result;
    };
    wrappedHistoryReplaceState = function (...args) {
      const result = Reflect.apply(nativeHistoryReplaceState, this, args);
      onRouteLocationChange();
      return result;
    };
    history.pushState = wrappedHistoryPushState;
    history.replaceState = wrappedHistoryReplaceState;
  }

  function boot() {
    if (destroyed) return;
    windowFocused = initialFocusState();
    if (windowFocused && isPageVisible()) reconcileLifecycle({ structural: true });
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("hashchange", onRouteLocationChange);
  window.addEventListener("popstate", onRouteLocationChange);
  window.addEventListener("online", onOnline);
  for (const eventName of ["pointerdown", "touchstart", "wheel", "keydown"]) {
    document.addEventListener(eventName, onTrustedActivity, { capture: true, passive: true });
  }
  window.addEventListener("resize", handleViewportGeometryChange, { passive: true });
  window.addEventListener("orientationchange", handleViewportGeometryChange, { passive: true });
  window.visualViewport?.addEventListener("resize", handleViewportGeometryChange, { passive: true });
  window.visualViewport?.addEventListener("scroll", handleViewportGeometryChange, { passive: true });
  installHistoryLifecycleHooks();

  void initializeApiKeyStorage();
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
