// ==UserScript==
// @name         KS Torn War Dibs PDA
// @namespace    kingshade.torn
// @version      1.5.167
// @description  Roster-local PDA presentation with v1.5.145 authority and shared-claim safety.
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
 * KS Torn War Dibs PDA v1.5.150 PRESENTATION/PERFORMANCE TEST
 * FF / Est separator, Hospital countdown, FF 2.00-5.00 gate and shared DIBS retained.
 * Hospital countdown uses v1.5.135 FFScouter-aligned second-boundary semantics.
 * PREWAR remains locked until a fresh own-faction /v2/faction/wars response confirms LIVE.
 * TIME: Torn-synchronized getCurrentTimestamp() remains available for Torn-specific timing.
 * PARITY: Hospital epoch countdown uses FFScouter-compatible client clock plus FFScouter-aligned +1 second semantics.
 * Country gate removed in 1.5.157: PC never had one, and two clients with
 * different gates cannot say the same thing about the same target.
 * Auto-release added in 1.5.158, ported from PC 1.0.38: a claim is released by
 * the script once the target is back in hospital well above the claim gate.
 * 1.5.161 is 1.5.158 with a new version stamp. The FFScouter interference row
 * tried in 1.5.159/1.5.160 is gone: FFScouter's own userscript does not run in
 * Torn PDA, so there is nothing on the page to read. PDA gets FF and Est from
 * FFScouter's API and draws them itself, which is unaffected.
 * 1.5.162 adds DEMO: a preview of the finished war look on a foreign roster.
 * It changes nothing but pixels, is impossible on the owner's own war route,
 * and sends nothing anywhere.
 * 1.5.163: an unreadable hospital time now reads "Hosp ?" instead of "Hosp
 * 0:00". Zero means attack now; unknown must never be able to say that.
 * 1.5.164: the DIBS button lives on the Status cell and carries the hospital
 * countdown itself. MEASURED 2026-09-05: Torn PDA's roster has no Attack
 * column, its attack cell measures 0x0, and the button was never drawn at all.
 * 1.5.165: Torn's own status text no longer bleeds out from behind the button.
 * The native cell is hidden only while the button covers it, and restored the
 * moment it does not.
 * 1.5.166: the same rule for the Score cell. Est is shown alone when there is
 * an estimate to show; with no estimate the box goes and Torn's own score is
 * back, rather than two numbers stacked in one small cell.
 * 1.5.167: the same rule for the FF pill on the nameplate. It is KS's own
 * element, not a Torn cell, so it drew "FF -" over part of the member name on
 * every row that had no FF value yet (owner Demo-off screenshot 2026-09-05).
 * The pill is now blank and invisible until there is a real value to show.
 */

(() => {
  "use strict";

  const SCRIPT = Object.freeze({
    name: "KS Torn War Dibs",
    version: "1.5.167",
    instanceKey: "__ksTornWarDibsPdaV15167Test",
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
    maxHospitalSeconds: 172800,
    // How long a write result stays on the panel before routine progress may
    // overwrite it. Without it the shared poll that runs straight after a write
    // replaces the message within about 100 ms and nobody sees what happened.
    sharedErrorHoldMs: 6000,
    // A claim can only be taken while the target has gateSeconds or less
    // left, and a hospital timer only grows when the target is put back
    // in. A fresh reading above this is therefore proof of a NEW
    // hospitalisation, not the one the claim was taken during. 180 leaves
    // 60 s of margin over the 120 s gate.
    autoReleaseHospitalSeconds: 180
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
  let observedRosterRoot = null;
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
  // Targets the shared server sent a claim for that could not be read.
  // We do not know whether they are taken, so they are never shown as free.
  let sharedClaimsUnreadable = new Set();
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
  // The merged members batch for the factions on a foreign war card. VIEW only.
  let viewMembersState = { factionIds: [], members: new Map(), fetchedAt: 0 };
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
  const publicBasicStatusCache = new Map();
  const publicBasicStatusPending = new Map();
  let publicBasicRequestSerial = 0;
  let lastPublicBasicFetchAt = 0;
  let tornClockOffsetsMs = [];
  let pendingTargetId = "";
  let ownClaimLastConfirmedAt = 0;
  // Claim id the auto-release has already acted on. One attempt per claim:
  // a failed release must not turn into a request every second.
  let autoReleaseAttemptedClaimId = "";
  let sharedStatusHoldUntil = 0;
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

  // "pda" = Torn PDA's own clock, "api" = offset sampled from Torn API replies,
  // "device" = the phone's clock with no correction at all. Shown in the panel.
  let tornClockSource = "device";

  function getTornNowMs() {
    if (typeof window.getCurrentTimestamp === "function") {
      try {
        const value = window.getCurrentTimestamp();
        if (Number.isFinite(value)) { tornClockSource = "pda"; return value; }
      } catch {}
    }
    const offset = median(tornClockOffsetsMs);
    if (Number.isFinite(offset)) { tornClockSource = "api"; return nowMs() + offset; }
    tornClockSource = "device";
    return nowMs();
  }

  function tornClockSourceLabel() {
    if (tornClockSource === "pda") return "Torn PDA clock";
    if (tornClockSource === "api") return `Torn API offset (${tornClockOffsetsMs.length} samples)`;
    return "device clock — UNSYNCED";
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

  // Another faction's Ranked War, reached from its public profile. Rendering is
  // allowed here so the column can be inspected without an own war -- which is
  // most of the time. Authority is not: viewOnlyMode() gates every write and
  // isViewModePermittedRequest gates every request at the transport.
  //
  // The public faction id of the profile Ranked War page currently open, or "".
  // Every VIEW request is pinned to this value, so VIEW can never be pointed at
  // a faction whose page the user is not actually looking at.
  function viewedFactionIdFromRoute(value = location.href) {
    try {
      const url = new URL(value, location.href);
      const hashPath = String(url.hash || "").slice(1).split("?", 1)[0].replace(/\/+$/, "");
      if (!/\/factions\.php$/i.test(url.pathname)) return "";
      if (url.searchParams.get("step") !== "profile" || hashPath !== "/war/rank") return "";
      const id = String(url.searchParams.get("ID") || "").trim();
      return validTargetId(id) ? String(Number(id)) : "";
    } catch { return ""; }
  }

  function isForeignRankedWarRoute(value = location.href) {
    return Boolean(viewedFactionIdFromRoute(value));
  }

  function isAnyRankedWarRoute(value = location.href) {
    return isRankedWarRoute(value) || isForeignRankedWarRoute(value);
  }

  // Fail closed. Anything that is not the owner's own Ranked War route is
  // read-only, including an unparseable or partially matching route.
  function viewOnlyMode() {
    return !isRankedWarRoute();
  }

  function isRuntimeContextEligible() {
    return !destroyed && isPageVisible() && windowFocused && isAnyRankedWarRoute();
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

  // VIEW mode allowlist. Fail closed: anything that is not exactly the members
  // endpoint for a faction rendered on the war card currently on screen is
  // refused. This sits at the transport, so it also covers any call that does
  // not go through tornApiRequest.
  function viewPermittedFactionIds() {
    const ids = new Set();
    const routeId = viewedFactionIdFromRoute();
    if (validTargetId(routeId)) ids.add(routeId);
    for (const id of canonicalPdaRankedWarSurface()?.factionIds || []) {
      if (validTargetId(id)) ids.add(String(Number(id)));
    }
    return [...ids];
  }

  function isViewModePermittedRequest(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ""));
      if (url.origin !== SCRIPT.tornApiOrigin) return false;
      return viewPermittedFactionIds().some(id => url.pathname === `/v2/faction/${id}/members`);
    } catch { return false; }
  }

  function gmXhr(options) {
    return new Promise(resolve => {
      let settled = false;
      const startedAt = nowMs();
      // Single transport choke point. In VIEW everything is refused except the
      // members batch for a faction on the war card being looked at.
      if (viewOnlyMode() && !isViewModePermittedRequest(options?.url)) {
        resolve({ ok: false, status: 0, responseText: "", headers: "", startedAt, endedAt: nowMs(), viewOnlyBlocked: true });
        return;
      }
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

  // Two kinds of bad response, deliberately handled differently -- the same
  // contract PC 1.0.39 uses, so both clients say the same thing about the same
  // target.
  //
  // The SHAPE being wrong -- no claims.faction object, or a key that is not a
  // Torn ID -- means this is not a claims response, or names a target there is
  // no row to warn on. Rejected whole; the panel goes offline. An empty object
  // would read as "nobody has claimed anything", and acting on that would let
  // the whole faction pile onto targets that are in fact taken.
  //
  // A single ENTRY being unreadable is different. Rejecting the whole roster
  // over one bad entry takes the client offline for the rest of the war. So the
  // entry is skipped -- but its target is remembered in `unreadable`, the row
  // reads DIBS? instead of free, and it cannot be claimed. Skipping silently is
  // the one thing that must never happen: that is how two members hit the same
  // target.
  function normalizeSharedClaims(payload) {
    const faction = payload?.claims?.faction;
    const result = new Map();
    const unreadable = new Set();
    const seenClaimIds = new Set();
    if (Array.isArray(faction)) return faction.length === 0 ? { claims: result, unreadable } : null;
    if (!isPlainRecord(faction)) return null;
    for (const [rawTargetId, rawQueue] of Object.entries(faction)) {
      const targetId = String(rawTargetId || "").trim();
      if (targetId !== String(Number(targetId)) || !validTargetId(targetId)) return null;
      if (!Array.isArray(rawQueue) || !rawQueue.length) { unreadable.add(targetId); continue; }
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
      if (queue.some(item => item === null)) unreadable.add(targetId);
      const normalizedQueue = queue.filter(item => item !== null);
      if (normalizedQueue.length) result.set(targetId, normalizedQueue);
    }
    return { claims: result, unreadable };
  }

  async function ffCandidateKeyIsOperational(key, isCurrent) {
    if (!isCurrent()) return false;
    const result = await hitApiRequest(HIT_API.claims, { method: "GET", apiKey: key });
    if (!isCurrent() || !result?.ok) return false;
    const claims = normalizeSharedClaims(result.body);
    return Boolean(isCurrent() && claims?.claims instanceof Map);
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

  // A write result must stay readable. Without the hold, the shared poll that
  // runs immediately after a write overwrites the message inside a few tens of
  // milliseconds and the outcome is invisible.
  //
  // Only routine progress is suppressed: a newer error always wins, and
  // beginSharedWriteFeedback clears the hold so the owner's next tap reports
  // itself at once.
  function beginSharedWriteFeedback() {
    sharedStatusHoldUntil = 0;
  }

  function holdSharedWriteFailure(message) {
    setSharedStatus("error", message);
    sharedStatusHoldUntil = nowMs() + CONFIG.sharedErrorHoldMs;
  }

  function setSharedStatus(state, message, count = sharedClaims.size) {
    const next = String(state || "unknown");
    if (next !== "error" && nowMs() < sharedStatusHoldUntil) {
      // Keep the held message on screen, but do not lose the target count.
      sharedStatus = { ...sharedStatus, count: Number.isInteger(count) && count >= 0 ? count : sharedStatus.count };
      updatePanel();
      return;
    }
    sharedStatus = { state: next, message: normalizeText(message) || "Shared: unknown", count: Number.isInteger(count) && count >= 0 ? count : 0 };
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
      const normalized = normalizeSharedClaims(body);
      if (!normalized || !(normalized.claims instanceof Map)) throw new Error("malformed claims response");
      sharedCredentialRejected = false;
      sharedClaims = normalized.claims;
      sharedClaimsUnreadable = normalized.unreadable instanceof Set ? normalized.unreadable : new Set();
      sharedClaimsVerifiedAt = nowMs();
      sharedBackoffUntil = 0;
      reconcileOwnClaimFromShared();
      if (ambiguousOwnServerClaims) {
        setSharedStatus("error", "Shared: multiple own claims require manual review", sharedClaims.size);
      } else if (currentClaimQuarantine()) {
        setSharedStatus("error", "Shared: claim acknowledgement awaiting verification", sharedClaims.size);
      } else if (sharedClaimsUnreadable.size) {
        // A partial list that looks complete is worse than an offline one,
        // because it reads as "these targets are free".
        setSharedStatus("degraded", `Shared: online · ${sharedClaims.size} targets · ${sharedClaimsUnreadable.size} unreadable`, sharedClaims.size);
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

  function knownOpponentTargetIds() {
    const ids = new Set();
    if (opponentMembersState.factionId === opponentFactionId) {
      for (const id of opponentMembersState.members.keys()) {
        if (validTargetId(id)) ids.add(String(Number(id)));
      }
    }
    for (const id of targetRows.keys()) {
      if (validTargetId(id)) ids.add(String(Number(id)));
    }
    return [...ids]
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, CONFIG.fairFightMaxTargets);
  }

  async function fetchFairFightStats({ force = false, missingOnly = false } = {}) {
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return false;
    if (ffCredentialChangeBusy() || !sharedApiKey || fairFightSyncing || nowMs() < fairFightBackoffUntil) return false;
    if (!force && fairFightLastFetchAt > 0 && nowMs() - fairFightLastFetchAt < CONFIG.fairFightRefreshMs) return false;
    const knownTargetIds = knownOpponentTargetIds();
    const targetIds = missingOnly
      ? knownTargetIds.filter(id => !fairFightStats.has(Number(id)))
      : knownTargetIds;
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
      const fetchedStats = normalizeFairFightStats(result.body, targetIds);
      fairFightStats = missingOnly
        ? new Map([...fairFightStats, ...fetchedStats])
        : fetchedStats;
      fairFightLastFetchAt = nowMs();
      fairFightBackoffUntil = 0;
      fairFightEverSucceeded = true;
      if (fairFightRetryTimer !== null) { window.clearTimeout(fairFightRetryTimer); fairFightRetryTimer = null; }
      scanWarRows();
      return true;
    } catch {
      if (isCurrentRequest()) {
        if (!missingOnly) {
          fairFightStats = new Map();
          fairFightLastFetchAt = 0;
        }
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
      tornClockOffsetsMs.push((timestamp + 0.5) * 1000 - midpoint);
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
    if (!isAnyRankedWarRoute()) return null;
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
    // In VIEW the owner's own faction is not on this card, so the faction whose
    // page is open takes its place. Nothing is written in VIEW, so this is a
    // presentation identity only -- the authority path still requires
    // isRankedWarRoute() via viewOnlyMode().
    const anchorId = viewOnlyMode() ? viewedFactionIdFromRoute() : factionId;
    if (!validTargetId(anchorId)) return null;
    const canonical = canonicalPdaRankedWarSurface();
    if (!canonical) return null;
    const selfId = String(Number(anchorId));
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
    // Identity is the WAR and the OPPONENT, never the DOM node.
    //
    // Torn re-renders the war card on every score tick once the war is running.
    // Treating a new node as a new war called invalidateOwnWarsState(), which
    // wiped the confirmed LIVE state, so currentRwPhase() fell back to UNKNOWN
    // and every DIBS button locked with rw-phase-unverifiable -- for the rest of
    // the war, because the card keeps being re-rendered. That is the lock the
    // owner hit in the last Ranked War. Reproduced and locked down in
    // tools\war-dibs-pda\phase.mjs.
    //
    // The node reference is still refreshed below; it is just not evidence that
    // the war changed. A real change of war or opponent, and an explicit
    // structural reset, invalidate exactly as before.
    const previousSurface = currentWarSurface;
    const identityChanged =
      structural ||
      !previousSurface ||
      previousSurface.warId !== selected.warId ||
      previousSurface.opponentFactionId !== selected.opponentFactionId;
    const previousOpponent = opponentFactionId;
    opponentFactionId = selected.opponentFactionId;
    if (previousOpponent !== opponentFactionId) opponentMembersState = { factionId: opponentFactionId, members: new Map(), fetchedAt: 0 };
    if (identityChanged) {
      warSurfaceSerial += 1;
      invalidateOwnWarsState();
      prewarObservation = null;
    }
    // The no-war marker only matters while the war is not yet confirmed LIVE.
    // Re-reading it on every repaint of a running war would be DOM work per row
    // per tick on a phone, for a value that cannot change the outcome.
    const shouldReadPrewarSurface = identityChanged || !previousSurface || !ownWarsFreshLive();
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
      const hasMissingScoutStats = [...members.keys()]
        .some(id => !fairFightStats.has(Number(id)));
      if (sharedApiKey && hasMissingScoutStats) {
        queueMicrotask(() => {
          if (runtimeActive && isRuntimeEligible() && sharedApiKey) {
            void fetchFairFightStats({ force: true, missingOnly: true });
          }
        });
      }
      return true;
    } catch { return false; }
  }

  async function fetchViewMembers({ force = false } = {}) {
    if (!viewOnlyMode()) return false;
    const key = effectiveTornApiKey();
    const factionIds = viewPermittedFactionIds();
    if (!key || factionIds.length === 0 || !runtimeActive || !isRuntimeEligible()) return false;
    if (
      !force &&
      viewMembersState.factionIds.length > 0 &&
      factionIds.every(id => viewMembersState.factionIds.includes(id)) &&
      nowMs() - viewMembersState.fetchedAt < CONFIG.opponentMembersMaxAgeMs
    ) return true;
    const generation = runtimeGeneration;
    const credentialEpoch = tornCredentialEpoch;
    const isCurrentRequest = () => (
      generation === runtimeGeneration &&
      credentialEpoch === tornCredentialEpoch &&
      key === effectiveTornApiKey() &&
      runtimeActive &&
      isRuntimeEligible()
    );
    const merged = new Map();
    const readIds = [];
    for (const factionId of factionIds) {
      if (!isCurrentRequest()) return false;
      const result = await tornReadWithTransportRetry(`/v2/faction/${factionId}/members`, key, { cacheBust: force, isCurrent: isCurrentRequest });
      if (!isCurrentRequest()) return false;
      if (!result?.ok || result.body?.error) continue;
      const members = normalizeTornMembers(result.body);
      if (!(members instanceof Map)) continue;
      for (const [id, status] of members) merged.set(id, status);
      readIds.push(factionId);
    }
    if (!readIds.length) return false;
    viewMembersState = { factionIds: readIds, members: merged, fetchedAt: nowMs() };
    return true;
  }

  async function fetchTornStatuses({ force = false } = {}) {
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return false;
    const key = effectiveTornApiKey();
    if (!key || tornStatusSyncing || (!force && nowMs() < tornStatusBackoffUntil)) return false;
    if (viewOnlyMode()) {
      // Read-only preview of somebody else's war. No own identity is needed or
      // obtainable here, and asking for one fails closed at the transport.
      const generation = runtimeGeneration;
      const credentialEpoch = tornCredentialEpoch;
      const requestSerial = ++tornStatusRequestSerial;
      tornStatusSyncing = true;
      setTornStatusState("syncing", "Torn: syncing…");
      const viewCurrent = () => (
        requestSerial === tornStatusRequestSerial &&
        credentialEpoch === tornCredentialEpoch &&
        generation === runtimeGeneration &&
        key === effectiveTornApiKey() &&
        runtimeActive &&
        isRuntimeEligible()
      );
      try {
        const viewReady = await fetchViewMembers({ force });
        if (!viewCurrent()) return false;
        if (!viewReady) throw new Error("members unavailable");
        tornStatusBackoffUntil = 0;
        tornTransportFailureStreak = 0;
        setTornStatusState("ready", `Torn: VIEW · ${viewMembersState.members.size} members · clock: ${tornClockSourceLabel()}`, viewMembersState.members.size);
        scanWarRows();
        return true;
      } catch (error) {
        if (viewCurrent()) {
          tornStatusBackoffUntil = nowMs() + CONFIG.tornStatusErrorBackoffMs;
          setTornStatusState("error", `Torn: ${normalizeText(error?.message) || "offline"}`, 0);
          scanWarRows();
        }
        return false;
      } finally {
        if (requestSerial === tornStatusRequestSerial && credentialEpoch === tornCredentialEpoch) tornStatusSyncing = false;
      }
    }
    if (!validTargetId(selfPlayerId) || !validTargetId(selfFactionId) || !keyScopeReady) {
      const identityReady = await fetchSelfIdentity({ force });
      return identityReady ? fetchTornStatuses({ force: false }) : false;
    }
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
      setTornStatusState(membersReady ? "ready" : "error", `Torn: own RW ${rwLabel} · ${memberCount} members · clock: ${tornClockSourceLabel()}`, memberCount);
      scanWarRows();
      return true;
    } catch (error) {
      if (isCurrentRequest()) {
        tornTransportFailureStreak += 1;
        tornStatusBackoffUntil = nowMs() + CONFIG.tornStatusErrorBackoffMs;
        invalidateOwnWarsState();
        const opponentSnapshotAgeMs = nowMs() - opponentMembersState.fetchedAt;
        if (opponentMembersState.factionId !== opponentFactionId ||
            opponentMembersState.fetchedAt <= 0 ||
            opponentSnapshotAgeMs > CONFIG.opponentMembersMaxAgeMs) {
          opponentMembersState = { factionId: opponentFactionId, members: new Map(), fetchedAt: 0 };
        }
        setTornStatusState("error", `Torn: ${normalizeText(error?.message) || "offline"}`, 0);
        scanWarRows();
      }
      return false;
    } finally {
      if (requestSerial === tornStatusRequestSerial && credentialEpoch === tornCredentialEpoch && key === effectiveTornApiKey()) tornStatusSyncing = false;
    }
  }

  function tornStatusForTarget(targetId) {
    const id = String(targetId || "");
    if (viewOnlyMode()) {
      if (viewMembersState.factionIds.length === 0) return null;
      if (nowMs() - viewMembersState.fetchedAt > CONFIG.opponentMembersMaxAgeMs) return null;
      return viewMembersState.members.get(id) || null;
    }
    if (!validTargetId(opponentFactionId) || opponentMembersState.factionId !== opponentFactionId || nowMs() - opponentMembersState.fetchedAt > CONFIG.opponentMembersMaxAgeMs) return null;
    return opponentMembersState.members.get(id) || null;
  }

  // ---------------------------------------------------------------------------
  // Torn war rows / hospital state
  // ---------------------------------------------------------------------------

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

  // A release time that has passed means the target is out, whatever a cached or
  // lagging status record still says. Returns false when there is no usable
  // timestamp, so a genuinely unknown release time is left alone.
  // Ported from PC 1.0.31: without it a member Torn already shows as Okay keeps
  // reading "Hosp 0:00" until the next members batch, up to 30 s later.
  function hospitalUntilExpired(until) {
    const timestamp = Number(until);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
    return timestamp - getTornNowMs() / 1000 <= 0;
  }

  function hospitalRemainingSeconds(until) {
    const timestamp = Number(until);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    // Ceil only, no added second. Rounding up is deliberate: showing less than
    // the real wait makes a caller attack early and the hit fails.
    const remaining = Math.ceil(timestamp - getTornNowMs() / 1000);
    return Number.isFinite(remaining) && remaining >= 0 && remaining < CONFIG.maxHospitalSeconds
      ? remaining
      : null;
  }

  // An unreadable hospital time is not zero.
  //
  // Owner screenshots 2026-09-05: one target read "Hosp 0:00" at 12:56 and was
  // still reading it at 13:26. The boundary second can only show 0:00 for about
  // one second, so that was this fallback, not a countdown. Torn said hospital
  // but the release time could not be read, and the cell printed 0:00 -- which
  // reads as "attack now", the one direction this must never fail in. The
  // decision engine already classifies seconds === null as UNKNOWN; only the
  // cell was lying.
  function hospitalCountdownText(hospitalState) {
    if (!hospitalState || hospitalState.isHospital !== true) return "";
    return formatCountdown(hospitalState.seconds) || "?";
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
      // The release time has passed: out, regardless of a stale state field.
      if (hospitalUntilExpired(apiStatus.until)) {
        return { isHospital: false, seconds: null, source: "torn-api-expired" };
      }
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
    // VIEW has no authority over any war, so the phase is never LIVE there.
    // Saying so plainly beats letting it read as an unverifiable own war.
    if (viewOnlyMode()) {
      if (refresh) refreshCurrentWarSurface();
      return { phase: RW_PHASE.UNKNOWN, runwaySeconds: null, warId: currentWarSurface?.warId || "", view: true };
    }
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

  function classifyLiveTargetState({ playerId, ownTargetId, isHospital, seconds, fairFight, rwPhase }) {
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
    if (ff === null) return { state: TARGET_STATE.UNKNOWN, seconds, fairFight: null, reason: "fair-fight-unverifiable", mode: "live" };
    if (ff < CONFIG.minFairFight) return { state: TARGET_STATE.LOCKED, seconds, fairFight: ff, reason: "fair-fight-too-low", mode: "live" };
    if (ff > CONFIG.maxFairFight) return { state: TARGET_STATE.LOCKED, seconds, fairFight: ff, reason: "fair-fight-too-high", mode: "live" };
    return { state: TARGET_STATE.READY, seconds, fairFight: ff, reason: "hospital-window-and-fair-fight-open", mode: "live" };
  }

  function classifyTargetState({ playerId, ownClaim, isHospital, seconds, fairFight, rwPhase, ownershipUnresolved = false }) {
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
      rwPhase
    });
  }

  function currentDecisionForTarget(targetId) {
    const id = String(targetId || "");
    const binding = xidBindings.get(id);
    const row = currentResolvedBinding(binding);
    if (!row || !bindingTargetIsUnique(binding, row)) return null;
    const hospital = computeHospitalSeconds(row);
    const rwPhase = currentRwPhase();
    return classifyTargetState({
      playerId: row.id,
      ownClaim: currentOwnClaim(),
      isHospital: hospital.isHospital,
      seconds: hospital.seconds,
      fairFight: fairFightForTarget(row.id),
      rwPhase,
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
    if (!hospital || !Number.isFinite(seconds) || seconds > CONFIG.gateSeconds) return null;
    return { targetId: String(targetId), status, seconds, fetchedAt };
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
      sharedClaimForTarget(targetId) || sharedClaimsUnreadable.has(targetId)
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
        sharedClaimForTarget(targetId) || sharedClaimsUnreadable.has(targetId)
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
      const finalEligibility = classifyTargetState({
        playerId: targetId,
        ownClaim: currentOwnClaim(),
        isHospital: true,
        seconds: targetProof.seconds,
        fairFight: fairFightForTarget(targetId),
        rwPhase: currentRwPhase()
      });
      if (
        !newClaimStorageAuthorityReady() ||
        currentOwnClaim() || currentClaimQuarantine() || ambiguousOwnServerClaims ||
        sharedClaimForTarget(targetId) || sharedClaimsUnreadable.has(targetId) ||
        !ownWarsFreshLive(CONFIG.ownWarsWriteMaxAgeMs) ||
        nowMs() - targetProof.fetchedAt > CONFIG.targetBasicWriteMaxAgeMs ||
        !finalEligibility || finalEligibility.state !== TARGET_STATE.READY
      ) throw new Error("target eligibility changed");
      if (!claimAuthorityStorageWritable()) {
        throw new Error("claim authority storage is not durably writable");
      }
      invalidateSharedReads();
      const result = await hitApiWriteWithBusyRetry(
        HIT_API.claim,
        { target_player_id: Number(targetId) },
        claimCreationCurrent,
        writeKey
      );
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
        holdSharedWriteFailure(`Shared: claim failed · ${normalizeText(error?.message) || "request failed"}`);
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
        holdSharedWriteFailure(`Shared: release failed · ${normalizeText(error?.message) || "request failed"}`);
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

  // Auto-release.
  //
  // Members forget to release a claim after the hit -- it happened right through
  // the previous Ranked War -- and a forgotten claim locks that target for the
  // whole faction until the server-side expiry finally runs out. More of the
  // faction plays on the phone than on the desktop, so this matters more here.
  //
  // The proof that a target has been beaten is arithmetic, not a guess. A claim
  // can only ever be taken while the target has CONFIG.gateSeconds or less left
  // in hospital, and a hospital timer never grows on its own: it moves forward
  // only when the target is hospitalised again. So a FRESH reading well above
  // the gate means the target went back in -- beaten, by us or by someone else.
  // Either way the claim is spent and holding it helps nobody.
  //
  // Fail closed at every step: own war only, fresh Torn status only, never while
  // another write is in flight, and one attempt per claim. No extra request is
  // made -- this reads the opponent members batch the script already polls, and
  // tornStatusForTarget refuses anything older than opponentMembersMaxAgeMs.
  function ownClaimTargetIsBeaten() {
    if (viewOnlyMode()) return false;
    const own = currentOwnClaim();
    if (!own || !validTargetId(own.targetId)) return false;
    const status = tornStatusForTarget(own.targetId);
    if (!status) return false;
    const isHospital =
      isHospitalStatusValue(status.state) ||
      isHospitalStatusValue(status.description) ||
      isHospitalStatusValue(status.details);
    if (!isHospital) return false;
    if (hospitalUntilExpired(status.until)) return false;
    const seconds = hospitalRemainingSeconds(status.until);
    return Number.isFinite(seconds) && seconds > CONFIG.autoReleaseHospitalSeconds;
  }

  async function maybeAutoReleaseBeatenTarget() {
    if (
      !runtimeActive || !isRuntimeEligible() || sharedWriteBusy || ffCredentialChangeBusy() ||
      tornCredentialMutationInProgress
    ) return false;
    const own = currentOwnClaim();
    if (!own || autoReleaseAttemptedClaimId === own.claimId) return false;
    if (!ownClaimTargetIsBeaten()) return false;
    autoReleaseAttemptedClaimId = own.claimId;
    await releaseOwnSharedTarget();
    if (currentOwnClaim()) return false;
    // releaseOwnSharedTarget kicks off a shared poll in its own finally block,
    // and that poll would overwrite the message within about 100 ms. Hold it the
    // same way a write failure is held, so the owner actually sees what happened.
    setSharedStatus("online", "Shared: auto-released \u00b7 target back in hospital", sharedClaims.size);
    sharedStatusHoldUntil = nowMs() + CONFIG.sharedErrorHoldMs;
    return true;
  }

  // ---------------------------------------------------------------------------
  // PDA-owned presentation. Torn's Ranked War DOM is read-only.
  // ---------------------------------------------------------------------------

  const SCOUT_PALETTE = Object.freeze([
    "#3057e1", "#3274ff", "#29a9ff", "#27d7f2", "#28d8b8",
    "#35d96f", "#85dd28", "#d9df24", "#f3b326", "#f57c1f", "#ef3340"
  ]);

  // DEMO.
  //
  // Between wars every row is read-only VIEW, so the owner never gets to see
  // what the column actually looks like when the war is running -- which is
  // the one thing he cannot check afterwards, in the middle of a war.
  //
  // DEMO paints the finished look on somebody else's roster. It is deliberately
  // powerless: it is refused on the owner's own war route, it makes no request,
  // it writes nothing, a tap does nothing, and no real DIBS state is read or
  // altered. The hospital countdowns stay real -- only the DIBS state and the
  // FF/Est values are illustrative, because a foreign roster has neither.
  let demoMode = false;


  function demoActive() {
    // Read-only route AND an actual Ranked War page. Either alone is not
    // enough: viewOnlyMode() is true on any page that is not the owner's own
    // war route, including pages this script does not belong on.
    return demoMode === true && viewOnlyMode() && isAnyRankedWarRoute();
  }

  // Deterministic per target, so a row keeps its example state instead of
  // flickering between them on every repaint.
  const DEMO_STATES = Object.freeze(["ready", "claimed", "shared", "early", "ff-low", "unreadable"]);

  function demoStateForTarget(targetId) {
    const id = Number(targetId);
    if (!Number.isInteger(id) || id <= 0) return "early";
    return DEMO_STATES[id % DEMO_STATES.length];
  }

  // An FF inside the 2.00-5.00 gate for the rows shown as attackable, outside it
  // for the row shown as blocked by FF. Illustrative only.
  function demoFairFightForTarget(targetId) {
    const id = Number(targetId) || 0;
    if (demoStateForTarget(targetId) === "ff-low") return 1.2 + (id % 7) / 10;
    return 2.1 + (id % 28) / 10;
  }

  const rowRegistry = new Map();
  const targetRows = new Map();
  const rowBindings = new Map();
  const xidBindings = new Map();
  const hostBindings = new WeakMap();
  const ownedPresentationLayers = new WeakSet();
  const ownedPanelHosts = new WeakSet();
  const boundPanelHosts = new WeakSet();
  let ownedPresentationLayer = null;
  let inlinePanelHost = null;
  let presentationRoot = null;
  let presentationRootEpoch = 0;
  let presentationResizeObserver = null;
  let presentationIntersectionObserver = null;
  let presentationFrameHandle = null;
  let presentationFrameNeedsLayout = false;
  let presentationFrameNeedsRender = false;
  let presentationFrameRenderAll = false;
  let lastPresentationDataSignature = "";
  let lastPresentationFairFightAt = 0;

  function presentationLayer() {
    const layer = ownedPresentationLayer;
    return layer instanceof HTMLElement &&
      presentationRoot instanceof HTMLElement &&
      layer.parentElement === presentationRoot &&
      layer.id === SCRIPT.layerId && ownedPresentationLayers.has(layer)
      ? layer
      : null;
  }

  function rowPlaneShadow() {
    return presentationLayer()?.shadowRoot || null;
  }

  function presentationShadow() {
    const host = inlinePanelHost;
    return host instanceof HTMLElement &&
      host.id === SCRIPT.panelId && ownedPanelHosts.has(host)
      ? host.shadowRoot
      : null;
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
    const expectedTargetId = normalizedTargetId(targetId);
    if (!expectedTargetId) return false;
    const links = [...attackCell.querySelectorAll("a")];
    if (links.length === 0) return normalizeText(attackCell.textContent).toLowerCase() === "attack";

    const ids = new Set();
    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) return false;
      let url;
      try { url = new URL(href, location.href); }
      catch { return false; }
      if (url.origin !== location.origin) return false;

      const sidValues = [];
      const targetValues = [];
      for (const [name, value] of url.searchParams.entries()) {
        const normalizedName = name.toLowerCase();
        if (normalizedName === "sid") sidValues.push(normalizeText(value).toLowerCase());
        if (normalizedName === "user2id") {
          const attackId = normalizedTargetId(value);
          if (!attackId) return false;
          targetValues.push(attackId);
        }
      }
      if (sidValues.length !== 1 || sidValues[0] !== "attack" || targetValues.length !== 1) return false;
      ids.add(targetValues[0]);
    }
    return ids.size === 1 && ids.has(expectedTargetId);
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
    const score = directCell(row, [
      ".score",
      "[class*='score__']",
      ".points",
      "[class*='points__']"
    ]);
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
        score,
        level,
        est: score instanceof HTMLElement ? score : level,
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

  function ensureInlinePanel(sourceShadow = rowPlaneShadow()) {
    // Anchor on the war card, not the roster, and sit ABOVE it. Below the
    // roster the panel is a long scroll away from the rows it describes; on a
    // phone that means it is never on screen when it matters.
    const surface = canonicalPdaRankedWarSurface();
    const anchor = (surface?.card instanceof HTMLElement && surface.card.parentElement)
      ? surface.card
      : currentRosterRoot();
    if (!(anchor instanceof HTMLElement) || !anchor.parentElement) return null;
    let panelHost = inlinePanelHost;
    if (!(panelHost instanceof HTMLElement) || !ownedPanelHosts.has(panelHost)) {
      const collision = document.getElementById(SCRIPT.panelId);
      if (collision && !ownedPanelHosts.has(collision)) return null;
      collision?.remove();
      panelHost = document.createElement("div");
      panelHost.id = SCRIPT.panelId;
      Object.assign(panelHost.style, {
        display: "block",
        position: "static",
        width: "100%",
        boxSizing: "border-box",
        margin: "6px 0"
      });
      ownedPanelHosts.add(panelHost);
      inlinePanelHost = panelHost;
      panelHost.attachShadow({ mode: "open" });
    }
    if (panelHost.parentElement !== anchor.parentElement || panelHost.nextElementSibling !== anchor) {
      anchor.before(panelHost);
    }
    const panelShadow = panelHost.shadowRoot;
    if (!panelShadow?.querySelector("[data-role='panel']") && sourceShadow) {
      const style = sourceShadow.querySelector("style")?.cloneNode(true);
      const panel = sourceShadow.querySelector("[data-role='panel']");
      if (style) panelShadow.appendChild(style);
      if (panel) {
        panel.removeAttribute("id");
        panelShadow.appendChild(panel);
      }
    }
    sourceShadow?.querySelectorAll("[data-role='panel']").forEach(panel => panel.remove());
    return panelHost;
  }

  function ensurePresentationLayer() {
    const root = currentRosterRoot();
    if (!(root instanceof HTMLElement) || !isWarPanelPresent()) return null;
    if (presentationRoot !== root) {
      retireAllBindings();
      presentationResizeObserver?.disconnect();
      presentationIntersectionObserver?.disconnect();
      rowRegistry.clear();
      targetRows.clear();
      ownedPresentationLayer?.remove();
      ownedPresentationLayer = null;
      presentationRoot = root;
      presentationRootEpoch += 1;
    }
    let layer = presentationLayer();
    if (layer?.shadowRoot) {
      ensureInlinePanel();
      return layer;
    }
    const idCollision = document.getElementById(SCRIPT.layerId);
    if (idCollision && !ownedPresentationLayers.has(idCollision)) return null;
    retireAllBindings();
    presentationResizeObserver?.disconnect();
    presentationResizeObserver = null;
    idCollision?.remove();

    layer = document.createElement("div");
    layer.id = SCRIPT.layerId;
    Object.assign(layer.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      overflow: "visible",
      pointerEvents: "none",
      zIndex: "2"
    });
    ownedPresentationLayers.add(layer);
    ownedPresentationLayer = layer;
    presentationRoot.appendChild(layer);
    const shadow = layer.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all:initial; display:block; width:100%; }
        *,*::before,*::after { box-sizing:border-box; }
        [data-role='row-surface'] { position:absolute; left:0; top:0; width:100%; height:0; overflow:visible; pointer-events:none; }
        [data-role='row-host'] { position:absolute; display:block; overflow:visible; pointer-events:none; contain:layout style; font-family:Arial,sans-serif; }
        .presenter { position:absolute; display:none; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; pointer-events:none; text-align:center; }
        .presenter[hidden] { display:none !important; }
        .ff,.est,.hospital { border:1px solid rgba(15,23,42,.55); border-radius:4px; color:#fff; background:rgba(15,23,42,.88); text-shadow:0 1px 1px #000; font-weight:900; line-height:14px; }
        .ff { font-size:7px; }
        .est { font-size:7px; }
        .hospital { color:#ffe2e2; background:rgba(127,29,29,.88); border-color:rgba(248,113,113,.75); font-size:7px; }
        button[data-role='dibs'] { position:absolute; display:none; min-width:34px; min-height:30px; margin:0; padding:1px 2px; border:1px solid #718096; border-radius:6px; background:rgba(26,32,44,.96); color:#e2e8f0; font:900 8px/1.05 Arial,sans-serif; text-align:center; touch-action:manipulation; -webkit-tap-highlight-color:transparent; pointer-events:auto; overflow:hidden; }
        button[data-role='dibs'] .label { display:block; font:900 12px/1.15 Arial,sans-serif; white-space:nowrap; }
        button[data-role='dibs'] .sub { display:block; font:700 8px/1.1 Arial,sans-serif; opacity:.85; white-space:nowrap; }
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
        .panel { box-sizing:border-box; width:100%; padding:7px 10px 6px; border:1px solid rgba(100,116,139,.55); border-radius:8px; background:rgba(15,23,42,.96); color:#dbe5f1; font-family:system-ui,sans-serif; pointer-events:auto; }
        .top { display:flex; justify-content:space-between; align-items:center; gap:8px; }
        .brand { font:850 10px/1.2 system-ui,sans-serif; color:#f8fafc; }
        .version { font:750 8px/1.2 system-ui,sans-serif; color:#8fa0b4; }
        .status-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; margin-top:5px; }
        .status-item { min-width:0; display:flex; align-items:center; gap:4px; padding:4px 5px; border:1px solid rgba(100,116,139,.25); border-radius:5px; background:rgba(2,6,23,.45); }
        .dot { flex:0 0 5px; width:5px; height:5px; border-radius:50%; background:#64748b; }
        [data-state='ready'] .dot,[data-state='online'] .dot { background:#22c55e; }
        [data-state='upcoming'] .dot,[data-state='degraded'] .dot { background:#f59e0b; }
        [data-state='syncing'] .dot,[data-state='writing'] .dot { background:#38bdf8; }
        [data-state='error'] .dot,[data-state='offline'] .dot,[data-state='unknown'] .dot,[data-state='ended'] .dot { background:#ef4444; }
        .status { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#cbd5e1; font:700 7.7px/1.2 system-ui,sans-serif; }
        .controls { display:flex; align-items:center; flex-wrap:wrap; gap:2px; margin-top:5px; }
        button,a { border:0; padding:0; background:none; color:#94a3b8; font:700 8.2px/1.2 system-ui,sans-serif; text-decoration:none; cursor:pointer; }
        button:hover,a:hover { color:#fff; text-decoration:underline; }
        button:disabled { opacity:.4; cursor:default; text-decoration:none; }
        button[data-role='dibs']:hover { text-decoration:none; }
        .sep { color:#667386; font:700 8px/1 system-ui,sans-serif; }
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
      <div data-role="row-surface"></div>
      <div class="panel" data-role="panel" id="${SCRIPT.panelId}">
        <div class="top"><span class="brand">KS Torn War Dibs</span><span class="version">v${SCRIPT.version}</span></div>
        <div class="status-grid">
          <div class="status-item" data-role="shared-item"><span class="dot"></span><span class="status" data-role="status">Shared: loading…</span></div>
          <div class="status-item" data-role="torn-item"><span class="dot"></span><span class="status" data-role="torn-status">Torn: loading…</span></div>
          <div class="status-item" data-role="rw-item"><span class="dot"></span><span class="status" data-role="rw-status">DIBS: checking RW…</span></div>
        </div>
        <div class="controls">
          <button type="button" data-role="key">FFScouter key</button><span class="sep">·</span>
          <button type="button" data-role="torn-key">Torn key</button><span class="sep">·</span>
          <a data-role="create-key" target="_blank" rel="noopener noreferrer">Create custom API key</a><span class="sep">·</span>
          <button type="button" data-role="sync">Sync</button><span class="sep">·</span>
          <button type="button" data-role="demo">Demo</button><span class="sep">·</span>
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

    const panelHost = ensureInlinePanel(shadow);
    const byRole = role => presentationShadow()?.querySelector(`[data-role='${role}']`);
    if (panelHost instanceof HTMLElement && !boundPanelHosts.has(panelHost)) {
      boundPanelHosts.add(panelHost);
      byRole("war-room").href = SCRIPT.ffscouterWarRoomUrl;
      byRole("ff-terms").href = SCRIPT.ffscouterTermsUrl;
      byRole("ff-privacy").href = SCRIPT.ffscouterPrivacyUrl;
      byRole("create-key").href = SCRIPT.tornCustomKeyUrl;
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
      byRole("demo")?.addEventListener("click", () => {
        if (!viewOnlyMode()) { demoMode = false; updatePanel(); return; }
        demoMode = !demoMode;
        scanWarRows();
        updatePanel();
      });
      byRole("forget-ff")?.addEventListener("click", () => void runFfCredentialMutation(forgetSharedKey));
      byRole("forget-torn")?.addEventListener("click", () => void runTornCredentialMutation(forgetTornKey));
    }
    startPresentationResizeObserver();
    startPresentationIntersectionObserver();
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

  function clipsPresentationViewport(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const clipsY = ["auto", "scroll", "hidden", "clip"].includes(style.overflowY);
    return clipsY && element.scrollHeight > element.clientHeight + 1;
  }

  function presentationVisibilityRoot() {
    let candidate = presentationRoot;
    while (
      candidate instanceof HTMLElement &&
      candidate !== document.body &&
      candidate !== document.documentElement
    ) {
      if (clipsPresentationViewport(candidate)) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  function startPresentationIntersectionObserver() {
    presentationIntersectionObserver?.disconnect();
    presentationIntersectionObserver = null;
    if (typeof IntersectionObserver !== "function") {
      for (const entry of rowRegistry.values()) entry.nearVisible = true;
      return;
    }
    presentationIntersectionObserver = new IntersectionObserver(records => {
      let changed = false;
      for (const record of records) {
        const entry = rowRegistry.get(record.target);
        if (!entry) continue;
        const nearVisible = record.isIntersecting || record.intersectionRatio > 0;
        if (entry.nearVisible === nearVisible) continue;
        entry.nearVisible = nearVisible;
        changed = true;
      }
      if (changed) schedulePresentationFrame({ layout: false, render: true });
    }, { root: presentationVisibilityRoot(), rootMargin: "160px 0px", threshold: 0 });
    for (const entry of rowRegistry.values()) presentationIntersectionObserver.observe(entry.row);
  }

  function observeBindingGeometry(binding) {
    if (!presentationResizeObserver || !binding) return;
    for (const node of [binding.row, ...Object.values(binding.anchors)]) {
      if (node instanceof Element) presentationResizeObserver.observe(node);
    }
  }

  // Torn's status text is wider than the cell KS measures, so it printed out
  // from behind the button -- "Okay" and "Abroad" reading through a DIBS box
  // (owner screenshots 2026-09-05). Hiding it is the only way to own the cell,
  // and it is done for exactly as long as the button covers it: the moment the
  // button has nothing to say, Torn's own status is back, untouched.
  //
  // visibility, not display: display would change the row's layout and move
  // everything KS has just measured.
  function setNativeStatusHidden(binding, hidden) {
    const cell = binding?.anchors?.status;
    if (!(cell instanceof HTMLElement)) return;
    const next = hidden ? "hidden" : "";
    if (cell.style.visibility !== next) cell.style.visibility = next;
  }

  // Same rule for the Score cell. The Est box was drawn on top of Torn's own
  // score and the score read through behind it -- two numbers in one small cell
  // (owner, 2026-09-05). KS takes the cell only when it has an estimate to put
  // there; with no estimate the box goes away and Torn's score is untouched.
  function setNativeScoreHidden(binding, hidden) {
    const cell = binding?.anchors?.est;
    if (!(cell instanceof HTMLElement)) return;
    const next = hidden ? "hidden" : "";
    if (cell.style.visibility !== next) cell.style.visibility = next;
  }

  function retireBinding(binding) {
    if (!binding) return;
    // Never leave a Torn cell hidden behind a control that is going away.
    setNativeStatusHidden(binding, false);
    setNativeScoreHidden(binding, false);
    for (const node of [binding.row, ...Object.values(binding.anchors || {})]) {
      if (node instanceof Element) presentationResizeObserver?.unobserve(node);
    }
    if (rowBindings.get(binding.row) === binding) rowBindings.delete(binding.row);
    if (xidBindings.get(binding.targetId) === binding) xidBindings.delete(binding.targetId);
    const entry = rowRegistry.get(binding.row);
    if (entry?.binding === binding) entry.binding = null;
    binding.host?.remove();
  }

  function retireAllBindings() {
    for (const binding of [...rowBindings.values()]) retireBinding(binding);
    rowBindings.clear();
    xidBindings.clear();
  }

  function removePresentationLayer() {
    if (presentationFrameHandle !== null) cancelAnimationFrame(presentationFrameHandle);
    presentationFrameHandle = null;
    presentationFrameNeedsLayout = false;
    presentationFrameNeedsRender = false;
    presentationFrameRenderAll = false;
    lastPresentationDataSignature = "";
    lastPresentationFairFightAt = 0;
    retireAllBindings();
    for (const entry of rowRegistry.values()) {
      presentationIntersectionObserver?.unobserve(entry.row);
    }
    rowRegistry.clear();
    targetRows.clear();
    presentationResizeObserver?.disconnect();
    presentationIntersectionObserver?.disconnect();
    presentationResizeObserver = null;
    presentationIntersectionObserver = null;
    presentationRoot = null;
    presentationRootEpoch += 1;
    const layer = ownedPresentationLayer;
    ownedPresentationLayer = null;
    if (layer instanceof HTMLElement && ownedPresentationLayers.has(layer)) layer.remove();
    const panelHost = inlinePanelHost;
    inlinePanelHost = null;
    if (panelHost instanceof HTMLElement && ownedPanelHosts.has(panelHost)) panelHost.remove();
  }

  function sameResolvedBinding(binding, resolved) {
    return Boolean(
      binding && resolved &&
      binding.host?.isConnected &&
      binding.host.getRootNode() === rowPlaneShadow() &&
      binding.host.parentElement === rowPlaneShadow()?.querySelector("[data-role='row-surface']") &&
      binding.rootEpoch === presentationRootEpoch &&
      binding.row === resolved.row &&
      binding.targetId === resolved.id &&
      binding.profile === resolved.profile &&
      binding.anchors.member === resolved.anchors.member &&
      binding.anchors.est === resolved.anchors.est &&
      binding.anchors.status === resolved.anchors.status &&
      binding.anchors.attack === resolved.anchors.attack &&
      xidBindings.get(binding.targetId) === binding
    );
  }

  function currentResolvedBinding(binding) {
    if (!binding || presentationRoot !== currentRosterRoot()) return null;
    const entry = rowRegistry.get(binding.row);
    if (!entry || entry.binding !== binding || entry.targetId !== binding.targetId) return null;
    const resolved = resolveLivePdaRow(binding.row, presentationRoot);
    return sameResolvedBinding(binding, resolved) ? resolved : null;
  }

  function cachedResolvedBinding(binding) {
    if (!binding || !(presentationRoot instanceof HTMLElement) || !presentationRoot.isConnected) return null;
    const entry = rowRegistry.get(binding.row);
    if (
      !entry || entry.binding !== binding || entry.targetId !== binding.targetId ||
      !binding.host?.isConnected || binding.host.getRootNode() !== rowPlaneShadow() ||
      !binding.row?.isConnected || !presentationRoot.contains(binding.row)
    ) return null;
    for (const anchor of [binding.profile, ...Object.values(binding.anchors || {})]) {
      if (!(anchor instanceof Element) || !anchor.isConnected || !binding.row.contains(anchor)) return null;
    }
    return {
      row: binding.row,
      li: binding.row,
      statusDiv: binding.anchors.status instanceof HTMLElement
        ? binding.anchors.status
        : binding.row,
      id: binding.targetId,
      profile: binding.profile,
      anchors: binding.anchors
    };
  }

  function activeTargetEntries(targetId) {
    const rows = targetRows.get(String(targetId || ""));
    if (!rows) return [];
    const entries = [];
    for (const row of rows) {
      const entry = rowRegistry.get(row);
      const resolved = resolveLivePdaRow(row, presentationRoot);
      if (entry && resolved && entry.targetId === resolved.id && entry.profile === resolved.profile) {
        entries.push(entry);
      }
    }
    return entries;
  }

  function bindingTargetIsUnique(binding, resolved) {
    if (!binding || !resolved || binding.targetId !== resolved.id) return false;
    const entries = activeTargetEntries(resolved.id);
    return entries.length === 1 &&
      entries[0].row === binding.row &&
      entries[0].binding === binding &&
      xidBindings.get(resolved.id) === binding;
  }

  function removeRowRegistryEntry(row, { reconcile = true } = {}) {
    const entry = rowRegistry.get(row);
    if (!entry) return;
    presentationIntersectionObserver?.unobserve(row);
    if (entry.binding) retireBinding(entry.binding);
    rowRegistry.delete(row);
    const rows = targetRows.get(entry.targetId);
    rows?.delete(row);
    if (rows?.size === 0) targetRows.delete(entry.targetId);
    if (reconcile) reconcileTargetOwnership(entry.targetId);
  }

  function reconcileTargetOwnership(targetId) {
    const entries = activeTargetEntries(targetId);
    if (entries.length !== 1) {
      for (const entry of entries) {
        if (entry.binding) retireBinding(entry.binding);
      }
      xidBindings.delete(String(targetId || ""));
      return null;
    }
    const entry = entries[0];
    const resolved = resolveLivePdaRow(entry.row, presentationRoot);
    if (!resolved) {
      removeRowRegistryEntry(entry.row);
      return null;
    }
    let binding = entry.binding;
    if (!sameResolvedBinding(binding, resolved)) {
      if (binding) retireBinding(binding);
      binding = createBinding(resolved);
    }
    return binding;
  }

  function registerOrReconcileRow(row) {
    if (!(row instanceof HTMLElement)) return null;
    const resolved = resolveLivePdaRow(row, presentationRoot);
    const existing = rowRegistry.get(row);
    const same = Boolean(
      existing && resolved &&
      existing.targetId === resolved.id &&
      existing.profile === resolved.profile &&
      existing.anchors.member === resolved.anchors.member &&
      existing.anchors.honor === resolved.anchors.honor &&
      existing.anchors.est === resolved.anchors.est &&
      existing.anchors.status === resolved.anchors.status &&
      existing.anchors.attack === resolved.anchors.attack
    );
    if (same) {
      reconcileTargetOwnership(existing.targetId);
      return existing;
    }
    const oldTargetId = existing?.targetId || "";
    if (existing) removeRowRegistryEntry(row, { reconcile: false });
    if (oldTargetId) reconcileTargetOwnership(oldTargetId);
    if (!resolved) return null;
    const entry = {
      row,
      targetId: resolved.id,
      profile: resolved.profile,
      anchors: resolved.anchors,
      nearVisible: !presentationIntersectionObserver,
      binding: null
    };
    rowRegistry.set(row, entry);
    let rows = targetRows.get(entry.targetId);
    if (!rows) {
      rows = new Set();
      targetRows.set(entry.targetId, rows);
    }
    rows.add(row);
    presentationIntersectionObserver?.observe(row);
    reconcileTargetOwnership(entry.targetId);
    return entry;
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
      if (binding) registerOrReconcileRow(binding.row);
      return;
    }
    // DEMO is a picture. Nothing behind it exists to act on.
    if (demoActive()) return;
    const own = currentOwnClaim();
    const state = button.dataset.state;
    if ((state === "claimed" || state === "cleanup") && own?.targetId === resolved.id) {
      beginSharedWriteFeedback();
      void releaseOwnSharedTarget();
      return;
    }
    if (button.disabled || button.dataset.ready !== "true") return;
    if (
      own || sharedWriteBusy || ffCredentialChangeBusy() ||
      tornCredentialMutationInProgress || !newClaimStorageAuthorityReady() || !sharedApiKey
    ) return;
    beginSharedWriteFeedback();
    void claimSharedTarget(resolved.id, getPlayerName(resolved));
  }

  function createBinding(resolved) {
    const surface = rowPlaneShadow()?.querySelector(`[data-role='row-surface']`);
    if (!(surface instanceof HTMLElement)) return null;
    const host = document.createElement("div");
    host.id = `${SCRIPT.rowHostPrefix}${resolved.id}`;
    host.dataset.role = "row-host";
    host.dataset.xid = resolved.id;
    host.innerHTML = `
      <span class="presenter ff" data-role="ff"></span>
      <span class="presenter est" data-role="est"></span>
      <span class="presenter hospital" data-role="hospital" hidden></span>
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
    const entry = rowRegistry.get(resolved.row);
    if (entry) entry.binding = binding;
    hostBindings.set(host, binding);
    host.querySelector(`[data-role='dibs']`)?.addEventListener("click", handleDibsClick);
    observeBindingGeometry(binding);
    return binding;
  }

  function setOwnGeometry(element, rect, rowRect, options = {}) {
    if (!(element instanceof HTMLElement) || element.hidden || !rect || rect.width <= 0 || rect.height <= 0) {
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

  function measureRowBinding(binding, layerRect) {
    const resolved = currentResolvedBinding(binding);
    if (!resolved) return { binding, resolved: null };
    const rowRect = resolved.row.getBoundingClientRect();
    if (rowRect.width <= 0 || rowRect.height <= 0) {
      return { binding, resolved, hidden: true };
    }
    return {
      binding,
      resolved,
      layerRect,
      rowRect,
      memberRect: resolved.anchors.honor?.getBoundingClientRect() || null,
      estRect: resolved.anchors.est?.getBoundingClientRect() || null,
      statusRect: resolved.anchors.status?.getBoundingClientRect() || null,
      attackRect: resolved.anchors.attack?.getBoundingClientRect() || null
    };
  }

  function applyRowBindingLayout(measurement) {
    const { binding, resolved, layerRect, rowRect } = measurement;
    if (!resolved) { retireBinding(binding); return; }
    if (measurement.hidden) { binding.host.style.display = "none"; return; }
    binding.lastLayout = {
      rowRect,
      statusRect: measurement.statusRect
    };
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
    const memberRect = measurement.memberRect;
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
    setOwnGeometry(est, measurement.estRect, rowRect, { inset: 1 });
    // The countdown moved into the button, which now owns the Status cell.
    // Two boxes cannot share one cell on a phone.
    setOwnGeometry(hospital, null, rowRect);
    const dibsPlaced = setOwnGeometry(dibs, measurement.statusRect, rowRect, { inset: 1 });
    if (!dibsPlaced && dibs instanceof HTMLButtonElement) { dibs.disabled = true; dibs.dataset.ready = "false"; }
  }

  function layoutRowBindings() {
    schedulePresentationFrame({ layout: true, render: false });
  }

  // Covering Torn's Status cell is only justified when KS actually has something
  // to add. Otherwise the cell is left alone and Torn's own Okay / Traveling /
  // Abroad reads exactly as it always did.
  function dibsControlHasSomethingToSay({ playerId, own, sharedClaim, countdown }) {
    return Boolean(
      countdown ||
      sharedClaim ||
      sharedClaimsUnreadable.has(playerId) ||
      pendingTargetId === playerId ||
      own?.targetId === playerId
    );
  }

  // The button sits on the Status cell and is the only thing KS draws there.
  //
  // MEASURED 2026-09-05 on the owner's phone: `attack cell 0x0, DIBS HIDDEN`.
  // Torn PDA's Ranked War roster has Members, Score and Status and no Attack
  // column; the attack cell exists with a valid attack link but has no size, so
  // setOwnGeometry hid the button on every row. The button had never been drawn
  // on PDA at all -- it would have been discovered mid-war.
  //
  // It therefore takes the Status cell and carries the countdown itself. When it
  // has nothing to say -- not in hospital, no claim, nothing pending -- it goes
  // invisible instead, and Torn's own Okay / Traveling / Abroad shows through
  // untouched. Visibility, not display: layout runs after render in the same
  // frame and would undo a display change.
  function updateDibsControl(host, decision, sharedClaim, context = {}) {
    const button = host?.querySelector?.(`[data-role='dibs']`);
    const label = button?.querySelector?.(".label");
    const sub = button?.querySelector?.(".sub");
    if (!(button instanceof HTMLButtonElement) || !label || !sub || !decision) return;
    const playerId = String(host.dataset.xid || "");
    const own = currentOwnClaim();
    const exactOwnProof = exactSharedProofForOwnClaim(own);
    const countdown = normalizeText(context.countdown);
    button.dataset.ready = "false";
    button.removeAttribute("title");

    if (!demoActive() && !dibsControlHasSomethingToSay({ playerId, own, sharedClaim, countdown })) {
      button.style.visibility = "hidden";
      button.disabled = true;
      return;
    }
    button.style.visibility = "visible";

    if (demoActive()) {
      // The example state is assigned per target id, so it can land on a row
      // whose real countdown is hours away or unreadable. An attackable example
      // must never be shown against a time that says otherwise, so the example
      // states carry example times; only the locked example keeps the real one.
      const ff = demoFairFightForTarget(playerId).toFixed(1);
      switch (demoStateForTarget(playerId)) {
        case "ready":
          button.className = "ready"; button.dataset.state = TARGET_STATE.READY;
          button.disabled = false; button.dataset.ready = "true";
          label.textContent = "0:42"; sub.textContent = `DIBS · FF${ff}`;
          return;
        case "claimed":
          button.className = "claimed"; button.dataset.state = "claimed"; button.disabled = false;
          label.textContent = "DIBBED"; sub.textContent = "RELEASE";
          return;
        case "shared":
          button.className = "shared"; button.dataset.state = "shared"; button.disabled = true;
          label.textContent = "TAKEN"; sub.textContent = "Kingshade";
          return;
        case "ff-low":
          button.className = TARGET_STATE.LOCKED; button.dataset.state = TARGET_STATE.LOCKED;
          button.disabled = true; label.textContent = "1:05"; sub.textContent = `FF${ff}`;
          return;
        case "unreadable":
          button.className = "unavailable"; button.dataset.state = "unreadable"; button.disabled = true;
          label.textContent = "DIBS?"; sub.textContent = "UNKNOWN";
          return;
        default:
          button.className = TARGET_STATE.LOCKED; button.dataset.state = TARGET_STATE.LOCKED;
          button.disabled = true;
          label.textContent = countdown && countdown !== "?" ? countdown : "3h 12m";
          sub.textContent = "LOCKED";
          return;
      }
    }

    // Read-only preview of another faction's war. The countdown is the point:
    // it is what makes the clock and the mount verifiable without an own war.
    if (viewOnlyMode()) {
      button.className = "unavailable";
      button.dataset.state = "view";
      button.disabled = true;
      label.textContent = countdown || "VIEW";
      sub.textContent = "VIEW";
      return;
    }

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
    if (!sharedClaim && sharedClaimsUnreadable.has(playerId)) {
      button.className = "unavailable"; button.dataset.state = "unreadable"; button.disabled = true;
      label.textContent = "DIBS?"; sub.textContent = "UNKNOWN"; return;
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
    // The number is what the caller reads, so it leads. The word underneath
    // says why the number is not actionable yet.
    label.textContent = countdown || "DIBS";
    if (decision.state === TARGET_STATE.READY) {
      button.disabled = !sharedApiKey || sharedWriteBusy;
      button.dataset.ready = button.disabled ? "false" : "true";
      sub.textContent = `DIBS · FF${Number(decision.fairFight).toFixed(1)}`;
      return;
    }
    button.disabled = true;
    if (decision.state === TARGET_STATE.BLOCKED) { label.textContent = "BLOCKED"; sub.textContent = own?.claimerName || "ACTIVE"; return; }
    if (decision.reason === "rw-not-started") { sub.textContent = "PREWAR"; return; }
    if (decision.reason === "fair-fight-too-low" || decision.reason === "fair-fight-too-high") {
      sub.textContent = `FF${Number(decision.fairFight).toFixed(1)}`;
      return;
    }
    if (decision.state === TARGET_STATE.UNKNOWN) { sub.textContent = "UNKNOWN"; return; }
    if (decision.state === TARGET_STATE.UNAVAILABLE) { sub.textContent = ""; return; }
    sub.textContent = "LOCKED";
  }

  // The FF pill is KS's own element on the nameplate, not a Torn cell, but it
  // follows the same rule Status and Score already do: draw only when there
  // is a real value, and leave nothing behind when there is not. It used to
  // print "FF -" on every row with no value yet, covering part of the member
  // name (owner Demo-off screenshot 2026-09-05). visibility, not display: the
  // layout pass runs after this one and would undo a display change.
  function renderFairFightBadge(ff, shown) {
    if (!(ff instanceof HTMLElement)) return;
    const hasFf = Number.isFinite(shown) && shown > 0;
    ff.textContent = hasFf ? `FF ${shown.toFixed(2)}` : "";
    ff.style.background = hasFf ? scoutColorForFairFight(shown) : "rgba(15,23,42,.88)";
    ff.style.visibility = hasFf ? "visible" : "hidden";
  }

  function renderRowBinding(binding, resolved, rwPhase) {
    const host = binding.host;
    const stats = scoutStatsForTarget(resolved.id);
    const ffValue = Number(stats?.fairFight);
    const ff = host.querySelector(`[data-role='ff']`);
    const est = host.querySelector(`[data-role='est']`);
    const hospital = host.querySelector(`[data-role='hospital']`);
    // A foreign roster has no FF and no Est -- the shared key is refused there
    // by design -- so DEMO supplies illustrative ones. Nothing else does.
    const demoFf = demoActive() ? demoFairFightForTarget(resolved.id) : null;
    renderFairFightBadge(ff, Number.isFinite(demoFf) ? demoFf : ffValue);
    const estimate = demoActive()
      ? `${(1.2 + (Number(resolved.id) % 40) / 10).toFixed(1)}m`
      : formatBattleStatsEstimate(stats);
    const hasEstimate = Boolean(estimate) && estimate !== "-";
    if (est instanceof HTMLElement) {
      est.textContent = hasEstimate ? `Est ${estimate}` : "";
      est.style.visibility = hasEstimate ? "visible" : "hidden";
    }
    setNativeScoreHidden(binding, hasEstimate);
    const hospitalState = computeHospitalSeconds(resolved);
    // The separate hospital box is retired: the button owns the Status cell and
    // carries the countdown. The element is kept, emptied and hidden, so nothing
    // can re-place it over the button on a later frame.
    if (hospital instanceof HTMLElement) {
      hospital.hidden = true;
      hospital.textContent = "";
      hospital.style.display = "none";
    }

    const decision = classifyTargetState({
      playerId: resolved.id,
      ownClaim: currentOwnClaim(),
      isHospital: hospitalState.isHospital,
      seconds: hospitalState.seconds,
      fairFight: fairFightForTarget(resolved.id),
      rwPhase,
      ownershipUnresolved: Boolean(
        !newClaimStorageAuthorityReady() ||
        (sharedApiKey && sharedClaimsVerifiedAt <= 0) ||
        tornCredentialMutationInProgress ||
        currentClaimQuarantine() ||
        ambiguousOwnServerClaims
      )
    });
    updateDibsControl(host, decision, sharedClaimForTarget(resolved.id), {
      countdown: hospitalCountdownText(hospitalState)
    });
    const dibs = host.querySelector(`[data-role='dibs']`);
    setNativeStatusHidden(binding, dibs instanceof HTMLElement && dibs.style.visibility !== "hidden");
  }

  function auditRowRegistry() {
    if (!(presentationRoot instanceof HTMLElement) || presentationRoot !== currentRosterRoot()) return;
    const rows = [...presentationRoot.querySelectorAll("li.enemy")];
    const currentRows = new Set(rows);
    for (const entry of [...rowRegistry.values()]) {
      if (!currentRows.has(entry.row)) removeRowRegistryEntry(entry.row, { reconcile: false });
    }
    for (const row of rows) registerOrReconcileRow(row);
    for (const targetId of targetRows.keys()) reconcileTargetOwnership(targetId);
    schedulePresentationFrame({ layout: true, render: true, renderAll: true });
  }

  function orderedRegistryEntries() {
    return [...rowRegistry.values()].sort((left, right) =>
      Number(right.nearVisible) - Number(left.nearVisible)
    );
  }

  function renderRegisteredRows({ all = false } = {}) {
    const rwPhase = currentRwPhase({ refresh: false });
    for (const entry of orderedRegistryEntries()) {
      if (!entry.binding || (!all && !entry.nearVisible)) continue;
      const resolved = cachedResolvedBinding(entry.binding);
      if (!resolved) {
        registerOrReconcileRow(entry.row);
        continue;
      }
      renderRowBinding(entry.binding, resolved, rwPhase);
    }
    updatePanel();
  }

  function renderScoutCacheRows({ all = false } = {}) {
    for (const entry of orderedRegistryEntries()) {
      if (!entry.binding || (!all && !entry.nearVisible)) continue;
      const host = entry.binding.host;
      const stats = scoutStatsForTarget(entry.targetId);
      const ffValue = Number(stats?.fairFight);
      const ff = host?.querySelector?.(`[data-role='ff']`);
      const est = host?.querySelector?.(`[data-role='est']`);
      renderFairFightBadge(ff, ffValue);
      if (est instanceof HTMLElement) est.textContent = `Est ${formatBattleStatsEstimate(stats)}`;
    }
  }

  function performPresentationFrame() {
    presentationFrameHandle = null;
    const needsLayout = presentationFrameNeedsLayout;
    const needsRender = presentationFrameNeedsRender;
    const renderAll = presentationFrameRenderAll;
    presentationFrameNeedsLayout = false;
    presentationFrameNeedsRender = false;
    presentationFrameRenderAll = false;
    if (!runtimeActive || !bridgeMounted || !isRuntimeEligible()) return;
    const layer = presentationLayer();
    if (!layer) return;
    let measurements = [];
    if (needsLayout) {
      const layerRect = layer.getBoundingClientRect();
      measurements = orderedRegistryEntries()
        .filter(entry => entry.binding)
        .map(entry => measureRowBinding(entry.binding, layerRect));
    }
    if (needsRender) renderRegisteredRows({ all: renderAll });
    for (const measurement of measurements) applyRowBindingLayout(measurement);
  }

  function schedulePresentationFrame({ layout = false, render = false, renderAll = false } = {}) {
    presentationFrameNeedsLayout ||= layout;
    presentationFrameNeedsRender ||= render;
    presentationFrameRenderAll ||= render && renderAll;
    if (presentationFrameHandle !== null) return;
    presentationFrameHandle = requestAnimationFrame(performPresentationFrame);
  }

  function onPresentationScroll() {
    // Row hosts use the roster's own content coordinates, so native scrolling
    // moves cached presentation in lockstep without geometry reads or rescans.
  }

  function tickVisibleHospitalCountdowns() {
    if (!runtimeActive || !bridgeMounted || !isRuntimeEligible()) return;
    void maybeAutoReleaseBeatenTarget();
    renderRegisteredRows();
  }

  function presentationDataSignature() {
    return [
      runtimeGeneration,
      sharedAuthorityEpoch,
      tornCredentialEpoch,
      sharedClaimsVerifiedAt,
      fairFightLastFetchAt,
      ownWarsState.fetchedAt,
      opponentMembersState.fetchedAt
    ].join(":");
  }

  function scanWarRows({ structural = false } = {}) {
    if (!runtimeActive || !bridgeMounted || !isRuntimeEligible() || !isWarPanelPresent()) return;
    refreshCurrentWarSurface({ structural });
    const layer = ensurePresentationLayer();
    if (!layer || !(presentationRoot instanceof HTMLElement)) return;
    const dataSignature = presentationDataSignature();
    const renderAll = dataSignature !== lastPresentationDataSignature;
    const fairFightChanged = fairFightLastFetchAt !== lastPresentationFairFightAt;
    lastPresentationDataSignature = dataSignature;
    lastPresentationFairFightAt = fairFightLastFetchAt;
    if (structural || rowRegistry.size === 0) auditRowRegistry();
    else {
      if (renderAll) {
        if (fairFightChanged) renderScoutCacheRows();
        else renderRegisteredRows();
      }
      schedulePresentationFrame({ layout: false, render: true, renderAll });
    }
    ensureInlinePanel();
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
    const sharedItem = $("shared-item"); const tornItem = $("torn-item"); const rwItem = $("rw-item");
    if (sharedItem) sharedItem.dataset.state = sharedStatus.state;
    if (tornItem) tornItem.dataset.state = tornStatusState.state;

    // Never let DEMO survive a route change onto the owner's own war.
    if (demoMode && !viewOnlyMode()) demoMode = false;
    if ($("demo")) {
      $("demo").textContent = demoMode ? "Demo: ON" : "Demo";
      $("demo").disabled = !viewOnlyMode();
    }
    const rwState = currentRwPhase();
    if (rwItem) {
      rwItem.dataset.state = demoActive()
        ? "degraded"
        : rwState.view === true
        ? "idle"
        : (rwState.phase === RW_PHASE.LIVE
          ? "online"
          : (rwState.phase === RW_PHASE.PREWAR ? "idle" : "error"));
    }
    if ($("rw-status")) {
      if (demoActive()) {
        $("rw-status").textContent = "RW: DEMO · example only, nothing here is real";
        $("rw-status").title = "A picture of the live look on somebody else's roster. No DIBS is read, written or possible.";
      } else if (rwState.view === true) {
        // Say plainly that this is somebody else's war, rather than letting it
        // read as an own war that could not be verified.
        $("rw-status").textContent = "RW: VIEW · read-only";
        $("rw-status").title = "Another faction's Ranked War. DIBS is available only on your own faction's active Ranked War.";
      } else if (rwState.phase === RW_PHASE.LIVE) {
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
    if (note) {
      note.textContent = "LIVE: Hospital ≤2:00 + FF 2.00–5.00. First successful DIBS wins; claimant can RELEASE.";
    }
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
    sharedClaims = new Map(); sharedClaimsUnreadable = new Set();
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
    sharedClaims = new Map(); sharedClaimsUnreadable = new Set();
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

  const queuedRosterMutationRecords = [];

  function rowsWithinMutationNode(node) {
    if (!(node instanceof Element)) return [];
    const rows = [];
    if (node.matches("li.enemy")) rows.push(node);
    rows.push(...node.querySelectorAll("li.enemy"));
    return rows;
  }

  function reconcileRosterMutations(records) {
    const affectedRows = new Set();
    let layoutNeeded = false;
    for (const record of records) {
      const target = record.target instanceof Element
        ? record.target
        : record.target?.parentElement;
      const targetRow = target?.closest?.("li.enemy");
      if (targetRow) affectedRows.add(targetRow);
      else if (target instanceof HTMLElement && rowRegistry.has(target)) affectedRows.add(target);
      for (const node of record.removedNodes) {
        for (const row of rowsWithinMutationNode(node)) {
          if (rowRegistry.has(row)) layoutNeeded = true;
          removeRowRegistryEntry(row);
        }
      }
      for (const node of record.addedNodes) {
        for (const row of rowsWithinMutationNode(node)) affectedRows.add(row);
      }
    }
    for (const row of affectedRows) {
      const before = rowRegistry.get(row);
      const beforeBinding = before?.binding || null;
      const beforeTargetId = before?.targetId || "";
      const after = registerOrReconcileRow(row);
      if (
        beforeBinding !== (after?.binding || null) ||
        beforeTargetId !== (after?.targetId || "")
      ) layoutNeeded = true;
    }
    schedulePresentationFrame({ layout: layoutNeeded, render: true });
  }

  function kickInitialFairFightLoad() {
    if (fairFightEverSucceeded || fairFightSyncing || !sharedApiKey) return;
    if (!runtimeActive || !isRuntimeEligible() || !bridgeMounted || !isWarPanelPresent()) return;
    if (rowRegistry.size === 0) return;
    void fetchFairFightStats({ force: true });
  }

  function queueObserverScan(records = []) {
    queuedRosterMutationRecords.push(...records);
    if (observerScanQueued) return;
    observerScanQueued = true;
    queueMicrotask(() => {
      observerScanQueued = false;
      if (!runtimeActive || !isRuntimeEligible()) return;
      const queued = queuedRosterMutationRecords.splice(0);
      reconcileRosterMutations(queued);
    });
  }

  function startBodyObserver() {
    const root = currentRosterRoot();
    if (!(root instanceof HTMLElement)) return;
    if (bodyObserver && observedRosterRoot === root) return;
    bodyObserver?.disconnect();
    bodyObserver = new MutationObserver(records => {
      if (runtimeActive && isRuntimeEligible()) queueObserverScan(records);
    });
    observedRosterRoot = root;
    bodyObserver.observe(root, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
      attributeFilter: ["href", "class", ...ROW_IDENTITY_ATTRIBUTES, "data-until", "title"]
    });
  }

  function stopBodyObserver() {
    bodyObserver?.disconnect(); bodyObserver = null; observedRosterRoot = null; observerScanQueued = false;
    queuedRosterMutationRecords.splice(0);
  }

  function mutationTouchesRouteSurface(records) {
    const routeSurfaceSelector =
      "[data-warid], #faction_war_list_id, .enemy-faction, a[href*='factions.php']";
    for (const record of records) {
      const element = record.target instanceof Element ? record.target : record.target?.parentElement;
      if (record.type === "attributes" && element instanceof Element) {
        const root = document.getElementById("faction_war_list_id");
        const visibilityAttribute = ["aria-hidden", "class", "hidden", "style"]
          .includes(String(record.attributeName || ""));
        if (
          visibilityAttribute && root instanceof Element &&
          (element === root || element.contains(root))
        ) return true;
        if (
          record.attributeName === "data-warid" &&
          (
            element.matches(routeSurfaceSelector) ||
            Boolean(element.closest(routeSurfaceSelector)) ||
            Boolean(element.querySelector(routeSurfaceSelector))
          )
        ) return true;
      }
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
      attributeFilter: ["aria-hidden", "class", "data-warid", "hidden", "style"],
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
    ensurePresentationLayer(); startBodyObserver(); scanWarRows({ structural: true });
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
    if (rowRegistry.size === 0 && attempt < CONFIG.mountPrimeMaxAttempts) {
      scanWarRows({ structural: true });
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
    rowRefreshTimer = window.setInterval(() => { if (runtimeActive && isRuntimeEligible()) tickVisibleHospitalCountdowns(); }, CONFIG.rowRefreshMs);
    sharedPollTimer = window.setInterval(() => { if (sharedApiKey && runtimeActive && isRuntimeEligible()) void fetchSharedClaims(); }, CONFIG.sharedPollMs);
    fairFightTimer = window.setInterval(() => { if (sharedApiKey && runtimeActive && isRuntimeEligible()) void fetchFairFightStats(); }, CONFIG.fairFightRefreshMs);
    tornStatusTimer = window.setInterval(() => {
      if (!effectiveTornApiKey() || !runtimeActive || !isRuntimeEligible()) return;
      void fetchTornStatuses();
      if (selfPlayerId) {
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
    sharedClaims = new Map(); sharedClaimsUnreadable = new Set();
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
    schedulePresentationFrame({ layout: true, render: true });
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
    document.removeEventListener("scroll", onPresentationScroll, true);
    window.removeEventListener("resize", handleViewportGeometryChange);
    window.removeEventListener("orientationchange", handleViewportGeometryChange);
    window.visualViewport?.removeEventListener("resize", handleViewportGeometryChange);
    window.visualViewport?.removeEventListener("scroll", onPresentationScroll);
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
  document.addEventListener("scroll", onPresentationScroll, { capture: true, passive: true });
  window.addEventListener("resize", handleViewportGeometryChange, { passive: true });
  window.addEventListener("orientationchange", handleViewportGeometryChange, { passive: true });
  window.visualViewport?.addEventListener("resize", handleViewportGeometryChange, { passive: true });
  window.visualViewport?.addEventListener("scroll", onPresentationScroll, { passive: true });
  installHistoryLifecycleHooks();

  void initializeApiKeyStorage();
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
