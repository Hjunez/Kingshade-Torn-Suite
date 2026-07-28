// ==UserScript==
// @name         Kingshade's Market Advisor
// @namespace    https://kingshade.tools/market-advisor
// @version      0.9.3.1
// @description  Kingshade's Market Advisor for Torn PDA — Item Market and Bazaar comparison with Happy Jump route planning.
// @author       Kingshade
// @downloadURL  https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/Kingshades_Market_Advisor_v0.9.3.user.js
// @updateURL    https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/Kingshades_Market_Advisor_v0.9.3.user.js
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @noframes
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      weav3r.dev
// @connect      www.torn.com
// @connect      torn.com
// ==/UserScript==

(() => {
  "use strict";

  const VERSION = "0.9.3";
  const VERSION_LABEL = "RELEASE";
  const SCRIPT_NAME = "Kingshade's Market Advisor";
  const BUILD_LABEL = "Release";
  const INSTANCE_KEY = "__ksma093ReleaseController";
  const LEGACY_INSTANCE_KEY = "__ksmaFullProfileIntegrationActive";
  const LEGACY_GUARD_KEY = "__ksmaAuthoritativeUiGuard";
  const HOST_ATTR = "data-ksma-093release-host";
  const ADVICE_ATTR = "data-ksma-093release-advice";
  const BEST_ATTR = "data-ksma-093release-best";
  const PRICE_STYLE_ATTR = "data-ksma-093release-original-style";
  const NO_STYLE_SENTINEL = "__KSMA_NO_STYLE__";
  const COLLAPSED_STORAGE_KEY = "ksma:fpi:panel-collapsed:v1";
  const API_KEY_STORAGE_KEY = "ksma:fpi:torn-api-key:v1";
  const API_BASE_URL = "https://api.torn.com/v2";
  const SCHEMA_VERSION = 119;
  const MAX_VISIBLE_ROWS = 250;
  const MAX_PLANNER_QUANTITY = 999;
  const PRACTICAL_MAX_STOPS = 3;
  const PRACTICAL_CANDIDATE_LIMIT = 24;
  const ROUTE_SESSION_STORAGE_KEY = "ksma:happy-jump-route-session:alpha5814r5:v1";
  const BAZAAR_NAV_HOST_ATTR = "data-ksma-093release-bazaar-route-nav";
  const WORKSPACE_ITEM = "item-advisor";
  const WORKSPACE_HAPPY = "happy-jump";
  const ROUTE_SESSION_TTL_MS = 30 * 60 * 1000;
  const STOCK_RISK_MIN_HEADROOM = 2;
  const STOCK_RISK_HEADROOM_RATIO = 0.5;
  const BAZAAR_HTML_PREFLIGHT_TIMEOUT_MS = 4500;
  const BAZAAR_OFFICIAL_VERIFY_TIMEOUT_MS = 6500;
  const BAZAAR_LIVE_DATA_TIMEOUT_MS = 6500;
  const ITEM_BAZAAR_RETURN_STORAGE_KEY = "ksma:item-advisor-bazaar-return:v1";
  const ITEM_BAZAAR_RETURN_TTL_MS = 30 * 60 * 1000;
  const ITEM_BAZAAR_BACK_HOST_ATTR = "data-ksma-093release-item-bazaar-back";
  const TORN_API_V1_USER_URL = "https://api.torn.com/user";
  const LIVE_BAZAAR_CACHE_KEY = "ksma:live-bazaar-listings:v2";
  const LIVE_BAZAAR_CACHE_TTL_MS = 10 * 60 * 1000;
  const LIVE_BAZAAR_VERIFY_TTL_MS = 2 * 60 * 1000;
  const LIVE_BAZAAR_CAPTURE_DEBOUNCE_MS = 350;
  const BAZAAR_ROUTE_SETTLE_MS = 900;
  const BAZAAR_IDENTITY_RECHECK_DELAYS_MS = Object.freeze([80, 240, 520, 900, 1400]);
  const BAZAAR_CLOSED_PATTERNS = Object.freeze([/\bcurrently\s+closed\b/i, /\bbazaar\s+(?:is|was|has\s+been)\s+closed\b/i, /\bclosed\s+(?:his|her|their|this)\s+bazaar\b/i]);
  const BAZAAR_BLOCKED_PATTERNS = Object.freeze([/\baccess\s+denied\b/i, /\bjust\s+a\s+moment\b/i, /\bcloudflare\b/i, /\btemporarily\s+unavailable\b/i, /\bnot\s+logged\s+in\b/i]);
  const HAPPY_JUMP_ITEMS = Object.freeze([
    Object.freeze({ itemId: "206", itemName: "Xanax", defaultQuantity: 4 }),
    Object.freeze({ itemId: "366", itemName: "Erotic DVD", defaultQuantity: 5 }),
    Object.freeze({ itemId: "197", itemName: "Ecstasy", defaultQuantity: 1 }),
    Object.freeze({ itemId: "310", itemName: "Lollipop", defaultQuantity: 0 }),
    Object.freeze({ itemId: "36", itemName: "Big Box of Chocolate Bars", defaultQuantity: 0 })
  ]);
  const HAPPY_JUMP_PRESETS = Object.freeze({
    EDVD: Object.freeze({ label: "EDVD", itemIds: Object.freeze(["206", "366", "197"]), quantities: Object.freeze({ "206": 4, "366": 5, "197": 1, "310": 0, "36": 0 }) }),
    LOLLIPOP: Object.freeze({ label: "LOLLIPOP", itemIds: Object.freeze(["206", "197", "310"]), quantities: Object.freeze({ "206": 4, "366": 0, "197": 1, "310": 49, "36": 0 }) }),
    BIG_CHOCO: Object.freeze({ label: "BIG CHOCO", itemIds: Object.freeze(["206", "197", "36"]), quantities: Object.freeze({ "206": 4, "366": 0, "197": 1, "310": 0, "36": 49 }) }),
    CUSTOM: Object.freeze({ label: "CUSTOM", itemIds: Object.freeze(["206", "366", "197", "310", "36"]), quantities: null })
  });
  const DEFAULT_HAPPY_JUMP_PRESET = "EDVD";
  const RUNTIME_RUN_ID = `${VERSION}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
  const UNSUPPORTED_EQUIPMENT_TYPES = new Set([
    "primary", "secondary", "melee", "armor", "armour", "weapon", "weapons",
    "firearm", "firearms", "temporary", "equipment"
  ]);

  const state = {
    createdAt: new Date().toISOString(),
    refreshCount: 0,
    refreshToken: 0,
    plannerToken: 0,
    lastResult: null,
    lastReport: null,
    happyJumpPlan: null,
    happyJumpData: null,
    happyJumpQuantities: Object.fromEntries(HAPPY_JUMP_ITEMS.map(item => [item.itemId, item.defaultQuantity])),
    happyJumpPreset: DEFAULT_HAPPY_JUMP_PRESET,
    openedRouteKeys: new Set(),
    quarantinedRouteKeys: new Set(),
    quarantineReasons: {},
    restoredRouteAt: null,
    activeWorkspace: WORKSPACE_ITEM,
    activeRouteKey: null,
    activeRouteKind: "practical",
    routeReturnUrl: null,
    returnFocusPending: false,
    returnAnchorActive: false,
    returnAnchorToken: 0,
    returnAnchorTimers: new Set(),
    scrollAnchorToken: 0,
    scrollAnchorTimers: new Set(),
    preflightBusy: false,
    preflightToken: 0,
    lastBazaarVerification: null,
    lastQuarantineResult: null,
    routeKey: null,
    bazaarNavHost: null,
    bazaarNavRoot: null,
    bazaarNavSignature: null,
    bazaarNavCollapsed: false,
    bazaarNavAlert: null,
    bazaarLocationKey: null,
    bazaarLocationEnteredAt: 0,
    bazaarIdentityTimers: new Set(),
    itemBackHost: null,
    itemBackRoot: null,
    liveBazaarCaptureTimer: 0,
    liveBazaarCaptureSignature: null,
    lastLiveBazaarCaptureAt: 0,
    collapsed: readBoolean(COLLAPSED_STORAGE_KEY, Boolean(readString(API_KEY_STORAGE_KEY, ""))),
    busy: false,
    destroyed: false,
    rebindFrame: 0,
    guardFrame: 0,
    mountStrategy: "none",
    contextSource: "none",
    observer: null,
    host: null,
    root: null,
    nodes: null,
    lastScope: null
  };

  const TEST_API = Object.freeze({
    numberFromKeys,
    idFromKeys,
    collectArrayCandidates,
    normalizeTornW3bBazaarListings,
    normalizeApiMarketRecords,
    comparePrices,
    bazaarDestinationForUserId,
    parseItemMarketContextFromHref,
    safeItemName,
    sourceAgeSeconds,
    sourceFreshness,
    formatLastSeen,
    normalizeItemType,
    isUnsupportedEquipmentType,
    normalizePlannerQuantity,
    buildAbsoluteMultiItemPlan,
    buildHappyJumpRoutePlan,
    evaluateRouteSubset,
    groupRouteAllocations,
    stockRiskForQuantity,
    findBackupOptionForRiskItem,
    safeRouteHref,
    safeItemMarketReturnUrl,
    routeStepUserId,
    resolveBazaarRouteStepIndex,
    classifyBazaarPreflightText,
    classifyBazaarLiveData,
    mergeBazaarListingSources,
    normalizeOwnBazaarSnapshot,
    readLiveBazaarListingsForItem,
    filterHappyJumpDataForQuarantine,
    normalizeStoredHappyJumpData,
    isHappyJumpRouteComplete,
    adoptBackupStop,
    recalculatePracticalRouteAfterAdoption
  });

  if (globalThis.__KSMA_093_RC1__) {
    globalThis.__KSMA_093_RC1_API__ = TEST_API;
    return;
  }

  stopPriorInstances();
  purgeContaminatedKsmaState();
  purgeRuntimeArtifacts();
  createUi();
  restoreHappyJumpSession();
  installController();
  installObserver();
  scheduleGuardSync();

  function purgeContaminatedKsmaState() {
    const preserve = new Set([ROUTE_SESSION_STORAGE_KEY, ITEM_BAZAAR_RETURN_STORAGE_KEY]);
    try {
      const remove = [];
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (key && key.startsWith("ksma:") && !preserve.has(key)) remove.push(key);
      }
      for (const key of remove) sessionStorage.removeItem(key);
    } catch {}
  }

  function stopPriorInstances() {
    const keys = [
      INSTANCE_KEY,
      "__ksma093Rc5Controller",
      "__ksma093Rc4Controller",
      "__ksma093Rc3Controller",
      "__ksma093Rc2Controller",
      "__ksma093Rc1Controller",
      "__ksmaAlpha5833Controller",
      "__ksmaAlpha5831Controller",
      "__ksmaAlpha5830Controller",
      "__ksmaAlpha5829Controller",
      "__ksmaAlpha5828Controller",
      "__ksmaAlpha5827Controller",
      "__ksmaAlpha5826Controller",
      "__ksmaAlpha5825Controller",
      "__ksmaAlpha5824Controller",
      "__ksmaAlpha5823Controller",
      "__ksmaAlpha5822Controller",
      "__ksmaAlpha5821Controller",
      "__ksmaAlpha5820Controller",
      "__ksmaAlpha5819Controller",
      "__ksmaAlpha5814R5Controller",
      "__ksmaAlpha592Controller",
      "__ksmaAlpha591Controller",
      "__ksmaAlpha590Controller",
      "__ksmaAlpha5818Controller",
      "__ksmaAlpha5817Controller",
      "__ksmaAlpha5816Controller",
      "__ksmaAlpha5815Controller",
      "__ksmaAlpha5814R4Controller",
      "__ksmaAlpha5814R3Controller",
      "__ksmaAlpha5814R2Controller",
      "__ksmaAlpha5814R1Controller",
      "__ksmaAlpha5814Controller",
      "__ksmaAlpha5813Controller",
      "__ksmaAlpha5812Controller",
      "__ksmaAlpha5811Controller",
      "__ksmaAlpha5810Controller",
      "__ksmaAlpha589Controller",
      "__ksmaAlpha588Controller",
      "__ksmaAlpha587Controller",
      "__ksmaAlpha586Controller",
      "__ksmaAlpha585Controller",
      "__ksmaAlpha584Controller",
      "__ksmaAlpha583Controller",
      "__ksmaAlpha582Controller",
      "__ksmaAlpha581Controller",
      "__ksmaAlpha580Controller",
      "__ksmaAlpha571Controller",
      "__ksmaAlpha570Controller",
      "__ksmaRc6Controller",
      "__ksmaRc5Controller",
      "__ksmaRc4Controller",
      "__ksmaRc3Controller",
      "__ksmaRc2Controller",
      "__ksmaRc1Controller",
      LEGACY_INSTANCE_KEY,
      LEGACY_GUARD_KEY
    ];
    const seen = new Set();
    for (const key of keys) {
      const controller = globalThis[key];
      if (!controller || seen.has(controller)) continue;
      seen.add(controller);
      try { controller.destroy?.({ force: true, byVersion: VERSION, reason: "version-upgrade" }); } catch {}
    }
  }

  function installController() {
    const api = {
      version: VERSION,
      runId: RUNTIME_RUN_ID,
      destroy(options = {}) {
        if (state.destroyed) return true;
        if (!options.force && options.byVersion !== VERSION) return false;
        state.destroyed = true;
        try { state.observer?.disconnect(); } catch {}
        window.removeEventListener("hashchange", onRouteChange);
        window.removeEventListener("popstate", onRouteChange);
        if (state.rebindFrame) cancelAnimationFrame(state.rebindFrame);
        if (state.guardFrame) cancelAnimationFrame(state.guardFrame);
        cancelReturnRouteAnchor();
        cancelKsmaScrollAnchor();
        cancelBazaarIdentityTimers();
        if (state.liveBazaarCaptureTimer) clearTimeout(state.liveBazaarCaptureTimer);
        state.liveBazaarCaptureTimer = 0;
        state.refreshToken += 1;
        state.plannerToken += 1;
        removeInlineAdvice();
        removeBazaarRouteNavigation();
        removeItemAdvisorBackNavigation();
        state.host?.remove();
        purgeRuntimeArtifacts();
        for (const key of [INSTANCE_KEY, LEGACY_INSTANCE_KEY, LEGACY_GUARD_KEY]) {
          if (globalThis[key] === api) delete globalThis[key];
        }
        return true;
      }
    };
    globalThis[INSTANCE_KEY] = api;
    globalThis[LEGACY_INSTANCE_KEY] = api;
    globalThis[LEGACY_GUARD_KEY] = api;
  }

  function purgeRuntimeArtifacts() {
    const hostSelectors = [
      `[${HOST_ATTR}]`,
      "[data-ksma-alpha592-host]",
      "[data-ksma-alpha591-host]",
      "[data-ksma-alpha590-host]",
      "[data-ksma-alpha5818-host]",
      "[data-ksma-alpha5817-host]",
      "[data-ksma-alpha5816-host]",
      "[data-ksma-alpha5815-host]",
      "[data-ksma-alpha5814r2-host]",
      "[data-ksma-alpha5814r1-host]",
      "[data-ksma-alpha5814-host]",
      "[data-ksma-alpha589-host]",
      "[data-ksma-alpha588-host]",
      "[data-ksma-alpha587-host]",
      "[data-ksma-alpha586-host]",
      "[data-ksma-alpha585-host]",
      "[data-ksma-alpha584-host]",
      "[data-ksma-alpha583-host]",
      "[data-ksma-alpha582-host]",
      "[data-ksma-alpha581-host]",
      "[data-ksma-alpha580-host]",
      "[data-ksma-alpha571-host]",
      "[data-ksma-alpha570-host]",
      "[data-ksma-rc6-host]",
      "[data-ksma-rc5-host]",
      "[data-ksma-rc4-host]",
      "[data-ksma-rc3-host]",
      "[data-ksma-rc2-host]",
      "[data-ksma-rc1-host]",
      "[data-ksma-alpha560-host]",
      "[data-ksma-alpha561-host]",
      "[data-ksma-alpha562-host]",
      "[data-ksma-alpha563-host]",
      "[data-ksfpi-integration]"
    ];
    for (const node of document.querySelectorAll(hostSelectors.join(","))) node.remove();
    for (const node of document.querySelectorAll(`[${ITEM_BAZAAR_BACK_HOST_ATTR}], [data-ksma-alpha5811-item-bazaar-back], [${BAZAAR_NAV_HOST_ATTR}], [data-ksma-alpha589-bazaar-route-nav], [data-ksma-alpha588-bazaar-route-nav], [data-ksma-alpha587-bazaar-route-nav], [data-ksma-alpha586-bazaar-route-nav], [data-ksma-alpha585-bazaar-route-nav], [data-ksma-alpha584-bazaar-route-nav], [data-ksma-alpha583-bazaar-route-nav], [data-ksma-alpha582-bazaar-route-nav], [data-ksma-alpha581-bazaar-route-nav]`)) node.remove();

    const markerSelectors = [
      `[${ADVICE_ATTR}]`, `[${BEST_ATTR}]`,
      "[data-ksma-alpha589-advice]", "[data-ksma-alpha589-best]",
      "[data-ksma-alpha588-advice]", "[data-ksma-alpha588-best]",
      "[data-ksma-alpha587-advice]", "[data-ksma-alpha587-best]",
      "[data-ksma-alpha586-advice]", "[data-ksma-alpha586-best]",
      "[data-ksma-alpha585-advice]", "[data-ksma-alpha585-best]",
      "[data-ksma-alpha584-advice]", "[data-ksma-alpha584-best]",
      "[data-ksma-alpha583-advice]", "[data-ksma-alpha583-best]",
      "[data-ksma-alpha582-advice]", "[data-ksma-alpha582-best]",
      "[data-ksma-alpha581-advice]", "[data-ksma-alpha581-best]",
      "[data-ksma-alpha580-advice]", "[data-ksma-alpha580-best]",
      "[data-ksma-alpha571-advice]", "[data-ksma-alpha571-best]",
      "[data-ksma-alpha570-advice]", "[data-ksma-alpha570-best]",
      "[data-ksma-rc6-advice]", "[data-ksma-rc6-best]",
      "[data-ksma-rc5-advice]", "[data-ksma-rc5-best]",
      "[data-ksma-rc4-advice]", "[data-ksma-rc4-best]",
      "[data-ksma-rc3-advice]", "[data-ksma-rc3-best]",
      "[data-ksma-rc2-advice]", "[data-ksma-rc2-best]",
      "[data-ksma-rc1-advice]", "[data-ksma-rc1-best]",
      "[data-ksma-alpha560-advice]", "[data-ksma-alpha561-advice]",
      "[data-ksma-alpha562-advice]", "[data-ksma-alpha563-advice]",
      "[data-ksma-alpha560-best]", "[data-ksma-alpha561-best]",
      "[data-ksma-alpha562-best]", "[data-ksma-alpha563-best]",
      "[data-ksfpi-ordinary-advice='true']",
      "[data-ksfpi-rw-advice='true']",
      "[data-ksfpi-smart-bazaar-panel='true']"
    ];
    for (const node of document.querySelectorAll(markerSelectors.join(","))) node.remove();

    restoreLegacyPriceCells("data-ksma-alpha589-original-style");
    restoreLegacyPriceCells("data-ksma-alpha588-original-style");
    restoreLegacyPriceCells("data-ksma-alpha587-original-style");
    restoreLegacyPriceCells("data-ksma-alpha586-original-style");
    restoreLegacyPriceCells("data-ksma-alpha585-original-style");
    restoreLegacyPriceCells("data-ksma-alpha584-original-style");
    restoreLegacyPriceCells("data-ksma-alpha583-original-style");
    restoreLegacyPriceCells("data-ksma-alpha582-original-style");
    restoreLegacyPriceCells("data-ksma-alpha581-original-style");
    restoreLegacyPriceCells("data-ksma-alpha580-original-style");
    restoreLegacyPriceCells("data-ksma-alpha571-original-style");
    restoreLegacyPriceCells("data-ksma-alpha570-original-style");
    restoreLegacyPriceCells("data-ksma-rc6-original-style");
    restoreLegacyPriceCells("data-ksma-rc5-original-style");
    restoreLegacyPriceCells("data-ksma-rc4-original-style");
    restoreLegacyPriceCells("data-ksma-rc3-original-style");
    restoreLegacyPriceCells("data-ksma-alpha562-original-style");
  }

  function restoreLegacyPriceCells(attribute) {
    for (const cell of document.querySelectorAll(`[${attribute}]`)) {
      const original = cell.getAttribute(attribute);
      if (original === NO_STYLE_SENTINEL || original == null) cell.removeAttribute("style");
      else cell.setAttribute("style", original);
      cell.removeAttribute(attribute);
    }
  }

  function createUi() {
    const host = document.createElement("div");
    host.setAttribute(HOST_ATTR, "true");
    host.dataset.version = VERSION;
    host.dataset.runId = RUNTIME_RUN_ID;
    host.style.cssText = "display:block;width:100%;box-sizing:border-box;margin:0 0 8px 0;position:relative;z-index:1;";

    const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    root.innerHTML = uiMarkup();

    state.host = host;
    state.root = root;
    state.nodes = {
      panel: root.querySelector("[data-ui='panel']"),
      head: root.querySelector("[data-ui='head']"),
      titleMeta: root.querySelector("[data-ui='title-meta']"),
      toggle: root.querySelector("[data-ui='toggle']"),
      compactRefresh: root.querySelector("[data-ui='compact-refresh']"),
      workspaceItem: root.querySelector("[data-ui='workspace-item']"),
      workspaceHappy: root.querySelector("[data-ui='workspace-happy']"),
      summaryShell: root.querySelector("[data-ui='summary-shell']"),
      itemSummary: root.querySelector("[data-ui='item-summary']"),
      happySummary: root.querySelector("[data-ui='happy-summary']"),
      happyJumpResult: root.querySelector("[data-ui='happy-jump-result']"),
      result: root.querySelector("[data-ui='result']"),
      controls: root.querySelector("[data-ui='controls']"),
      itemWorkspace: root.querySelector("[data-ui='item-workspace']"),
      happyWorkspace: root.querySelector("[data-ui='happy-workspace']"),
      context: root.querySelector("[data-ui='context']"),
      status: root.querySelector("[data-ui='status']"),
      apiKey: root.querySelector("[data-ui='api-key']"),
      saveApiKey: root.querySelector("[data-ui='save-api-key']"),
      refresh: root.querySelector("[data-ui='refresh']"),
      planHappyJump: root.querySelector("[data-ui='plan-happy-jump']"),
      happyJumpInputs: [...root.querySelectorAll("[data-ui='happy-jump-quantity']")],
      happyJumpPresets: [...root.querySelectorAll("[data-ui='happy-jump-preset']")],
      copy: root.querySelector("[data-ui='copy']"),
      download: root.querySelector("[data-ui='download']"),
      reset: root.querySelector("[data-ui='reset']")
    };

    const planner = root.querySelector("[data-ui='happy-jump-planner']");
    if (planner && state.nodes.happySummary) {
      planner.insertAdjacentElement("afterend", state.nodes.happySummary);
    }

    state.nodes.apiKey.value = readString(API_KEY_STORAGE_KEY, "");
    applyWorkspaceState(false);
    applyCollapsedState(false);

    state.nodes.workspaceItem.addEventListener("click", () => setActiveWorkspace(WORKSPACE_ITEM, { scroll: true }));
    state.nodes.workspaceHappy.addEventListener("click", () => setActiveWorkspace(WORKSPACE_HAPPY, { scroll: true }));

    state.nodes.head.addEventListener("click", event => {
      if (event.target instanceof HTMLElement && event.target.closest("button,a,input,summary")) return;
      toggleCollapsed();
    });
    state.nodes.head.addEventListener("keydown", event => {
      if (event.target !== state.nodes.head || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      toggleCollapsed();
    });
    state.nodes.toggle.addEventListener("click", event => {
      event.stopPropagation();
      toggleCollapsed();
    });
    state.nodes.compactRefresh.addEventListener("click", event => {
      event.stopPropagation();
      runRefresh();
    });
    state.nodes.saveApiKey.addEventListener("click", saveApiKey);
    state.nodes.refresh.addEventListener("click", runRefresh);
    bindHappyJumpPlannerControls();
    syncHappyJumpPresetItemVisibility();
    state.nodes.planHappyJump.addEventListener("click", runHappyJumpPlanner);
    state.root.addEventListener("click", handlePlannerResultClick);
    state.nodes.copy.addEventListener("click", copyReport);
    state.nodes.download.addEventListener("click", downloadReport);
    state.nodes.reset.addEventListener("click", resetSession);
  }

  function uiMarkup() {
    return `
      <style>
        :host{all:initial;display:block;width:100%;font-family:Arial,Helvetica,sans-serif;color:#f4f7fb;--green:#48f59b;--cyan:#42dfff;--gold:#ffc857;--orange:#ff9f43;--red:#ff5f6d;--violet:#8f7cff}
        *{box-sizing:border-box}button,input,summary{font:inherit}[hidden]{display:none!important}
        .panel{width:100%;border:1px solid #7567c9;border-radius:11px;background:#171c24;box-shadow:0 0 0 1px rgba(66,223,255,.12),0 8px 24px rgba(0,0,0,.38),0 0 18px rgba(143,124,255,.14);overflow:hidden}
        .head{min-height:50px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:linear-gradient(135deg,#29253f 0%,#202d3a 50%,#18252f 100%);border-bottom:1px solid rgba(66,223,255,.22);cursor:pointer;user-select:none}
        .title{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:2px}.title strong{font-size:13px;line-height:15px;color:#fff;white-space:normal;overflow:visible;text-overflow:clip;text-shadow:0 0 10px rgba(66,223,255,.3)}
        .title>span{font-size:10px;line-height:13px;color:#bfc8d7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.head-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}
        button{min-height:38px;border:1px solid #626c76;border-radius:7px;background:#343b43;color:#fff;padding:7px 10px;font-weight:800;cursor:pointer}button:disabled{opacity:.45;cursor:default}
        .compact-refresh{min-width:72px;min-height:34px;padding:6px 8px;border:1px solid #65ffb3;background:linear-gradient(135deg,#197c4b,#24a962);box-shadow:0 0 12px rgba(72,245,155,.2);font-size:10px;font-weight:900;white-space:nowrap}
        .toggle{min-width:38px;min-height:34px;border-color:#7a88a0;background:linear-gradient(180deg,#3b4655,#2a323e)}
        .workspace-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:7px 9px;background:#191f28;border-bottom:1px solid rgba(66,223,255,.16)}.workspace-tab{min-height:35px;border-color:#4e5968;background:#252d37;color:#bfc8d7;font-size:9px;letter-spacing:.04em}.workspace-tab.active{border-color:#8f7cff;background:linear-gradient(135deg,#493c83,#284b62);color:#fff;box-shadow:0 0 12px rgba(143,124,255,.16)}
        .summary-shell{display:grid;gap:8px;padding:9px;border-top:1px solid rgba(66,223,255,.16);background:linear-gradient(180deg,#171c24,#1d232c)}.workspace-summary{display:grid;gap:8px}.workspace-body{display:grid;gap:8px}
        .controls{display:grid;gap:8px;padding:0 9px 9px;border-top:1px solid rgba(66,223,255,.16);background:#1a2028}.controls>.notice:first-child{margin-top:9px;min-height:46px;max-height:46px;box-sizing:border-box;overflow:hidden}
        .notice{margin:0;padding:7px 8px;border:1px solid #4d555e;border-radius:7px;background:#292f36;font-size:11px;line-height:15px;color:#e5e8eb}.notice[data-state='ready']{border-color:#3f7d53;background:#23382a}.notice[data-state='warning']{border-color:#8b6b3b;background:#3c3020}.notice[data-state='error']{border-color:#9a4a4a;background:#3d2424}
        .api-box{display:grid;gap:5px;padding:8px;border:1px solid #4d555e;border-radius:7px;background:#292f36}.api-box label{font-size:10px;font-weight:800;color:#cfd5db}.api-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}
        input{width:100%;min-height:38px;border:1px solid #5b646e;border-radius:7px;background:#171b20;color:#fff;padding:8px;outline:none}input:focus{border-color:#8fa9c1}
        .primary{border-color:#67ffb0;background:linear-gradient(135deg,#197a4b,#28a965);box-shadow:0 0 11px rgba(72,245,155,.12)}.actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}.wide{grid-column:1/-1}.settings-stack{display:grid;gap:7px;margin-top:7px}.settings-stack .api-box{padding:7px}.settings-stack .wide{width:100%}.diagnostic-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px}.compact-help{margin:7px 0 0;font-size:9px;line-height:13px;color:#cbd3dd}
        .result{display:grid;gap:7px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:7px}.card{min-width:0;padding:9px;border:1px solid #4d5968;border-radius:9px;background:linear-gradient(145deg,#26303a,#1f2730);box-shadow:inset 0 1px 0 rgba(255,255,255,.035)}
        .card.bazaar-card{border-color:#2fbf75;box-shadow:0 0 14px rgba(72,245,155,.10)}.card.market-card{border-color:#3189b8;box-shadow:0 0 14px rgba(66,223,255,.10)}.card .label{font-size:10px;font-weight:900;color:#c6d0dd}.bazaar-card .label{color:#7bffb8}.market-card .label{color:#72dcff}.card .value{margin-top:2px;font-size:16px;line-height:19px;font-weight:900;color:#fff;overflow-wrap:anywhere}.card .sub{margin-top:3px;font-size:10px;line-height:13px;color:#c8ced4}
        .verdict{padding:10px;border-radius:9px;font-size:13px;line-height:17px;font-weight:900;text-align:center}.verdict.bazaar{border:1px solid var(--green);background:linear-gradient(135deg,#153f2b,#1d5739)}.verdict.market{border:1px solid #ffb454;background:linear-gradient(135deg,#4a2e13,#68421b)}.verdict.same{border:1px solid var(--violet);background:linear-gradient(135deg,#30284e,#252d3d)}
        .bazaar-top3{display:grid;gap:6px;padding:8px;border:1px solid #5a6077;border-radius:9px;background:linear-gradient(160deg,#242936,#1e252e)}.bazaar-top3-title{font-size:10px;font-weight:900;color:#f4f7ff;letter-spacing:.05em}
        .happy-jump-planner{display:grid;gap:7px;padding:9px;border:1px solid #7968d8;border-radius:9px;background:linear-gradient(155deg,#27233d,#1e2b37);box-shadow:0 0 16px rgba(143,124,255,.10)}.planner-title{font-size:11px;font-weight:1000;color:#fff;letter-spacing:.04em}.planner-subtitle{font-size:9px;line-height:12px;color:#bfc8d7}.preset-bar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}.preset-button{min-height:33px;padding:5px;border-color:#596575;background:#252d37;color:#c5cfda;font-size:8px}.preset-button.active{border-color:#9a8cff;background:linear-gradient(135deg,#4d3d9e,#6b56c5);color:#fff}.planner-items{display:grid;gap:6px}.planner-item{display:grid;grid-template-columns:minmax(0,1fr) 70px;gap:7px;align-items:center;padding:7px;border:1px solid #4e5968;border-radius:8px;background:#202833}.planner-item label{font-size:11px;font-weight:900;color:#fff}.planner-item span{display:block;margin-top:2px;font-size:8px;color:#aeb9c8}.planner-item input{min-height:34px;text-align:center;font-weight:900}.planner-button{width:100%;min-height:40px;border-color:#9a8cff;background:linear-gradient(135deg,#4d3d9e,#6b56c5)}.happy-jump-result{display:grid;gap:7px;overflow-anchor:none}.preset-bar{overflow-anchor:none}.happy-jump-result [data-route-anchor="top"],.happy-jump-result .route-stop.next{scroll-margin-top:82px}.planner-summary{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}.planner-stat{padding:7px;border:1px solid #4e5968;border-radius:7px;background:#202833}.planner-stat span{display:block;font-size:8px;font-weight:900;color:#aeb9c8}.planner-stat strong{display:block;margin-top:2px;font-size:13px;line-height:16px;color:#fff}.route-verdict{padding:9px;border:1px solid #48f59b;border-radius:8px;background:#193b2b;text-align:center;font-size:11px;line-height:14px;font-weight:900}.route-verdict.partial{border-color:#ff9f43;background:#45301d}.route-verdict.warning{border-color:#ff5f6d;background:#44232a}.route-list{display:grid;gap:6px}.route-stop{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:7px;align-items:start;padding:8px;border:1px solid #46515f;border-radius:8px;background:#222b35}.route-stop-index{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#394555;font-size:10px;font-weight:1000}.route-stop-main{min-width:0}.route-stop-source{font-size:9px;font-weight:1000;color:#80e8ff}.route-stop-source.bazaar{color:#80ffbd}.route-item-line{margin-top:3px;font-size:10px;line-height:13px;font-weight:900;color:#fff}.route-item-line.adopted{color:#9dd7ff}.adopted-badge{display:inline-block;margin-left:4px;padding:1px 4px;border:1px solid #7bc8ff;border-radius:999px;background:#244b68;color:#c7ecff;font-size:7px;line-height:9px;font-weight:1000;vertical-align:1px}.route-item-meta{font-size:8px;line-height:11px;color:#bfc8d7}.route-stop-total{margin-top:4px;font-size:9px;font-weight:900;color:#ffd783}.route-open{min-height:31px;padding:5px 8px;border:1px solid #67ffb0;border-radius:7px;background:linear-gradient(135deg,#197a4b,#28a965);color:#fff;text-decoration:none;font-size:8px;font-weight:900;display:flex;align-items:center;justify-content:center;white-space:nowrap}.route-stop.next{border-color:#48f59b;box-shadow:0 0 13px rgba(72,245,155,.12)}.route-stop.visited{opacity:.68;border-color:#59616b}.route-stop.visited .route-stop-index{background:#245e42;color:#8cffbd}.route-stop.quarantined{border-color:#ff5f6d;background:#35242a}.route-stop.quarantined .route-open,.backup-open[aria-disabled='true']{opacity:.45;pointer-events:none}.route-progress{padding:7px 8px;border:1px solid #3f7d53;border-radius:7px;background:#23382a;font-size:9px;line-height:12px;font-weight:900;color:#a9ffd0}.route-progress.completed{border-color:#8f7cff;background:#302a4b;color:#e1dbff}.stock-risk{margin-top:4px;padding:5px 6px;border:1px solid #ff9f43;border-radius:6px;background:#45301d;font-size:8px;line-height:11px;font-weight:900;color:#ffd0a0}.stock-risk.high{border-color:#ff5f6d;background:#44232a;color:#ffb7be}.backup-option{margin-top:5px;padding:6px;border:1px solid #5c78a8;border-radius:6px;background:#202d3d}.backup-title{font-size:8px;line-height:10px;font-weight:1000;color:#9dd7ff}.backup-meta{margin-top:2px;font-size:8px;line-height:11px;color:#d2deec}.backup-open{display:inline-flex;margin-top:5px;min-height:27px;padding:4px 7px;border:1px solid #7bc8ff;border-radius:6px;background:#24577a;color:#fff;text-decoration:none;font-size:8px;font-weight:900;align-items:center}.planner-inline-actions{display:grid;grid-template-columns:1fr;gap:6px}.replan-button{width:100%;min-height:37px;border-color:#79d7ff;background:linear-gradient(135deg,#225a77,#287da2)}.planner-note{padding:7px;border:1px solid #6a5d88;border-radius:7px;background:#2b2638;font-size:8px;line-height:11px;color:#d9d3ef}.planner-note.warning{border-color:#ff9f43;background:#45301d}.absolute-summary{padding:7px;border:1px solid #4d555e;border-radius:7px;background:#292f36;font-size:9px;line-height:13px;color:#e5e8eb}
        .bazaar-option{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px;border:1px solid #46515f;border-radius:8px;background:linear-gradient(135deg,#29323d,#232a34);overflow:hidden}.bazaar-option.rank-1{border-color:#4ff7a0;box-shadow:inset 3px 0 0 #48f59b}.bazaar-option.rank-2{border-color:#f1bf55;box-shadow:inset 3px 0 0 #ffc857}.bazaar-option.rank-3{border-color:#c8814a;box-shadow:inset 3px 0 0 #d88a50}.bazaar-option.warning{background:linear-gradient(135deg,#352d24,#292a30)}.bazaar-option.stale{background:linear-gradient(135deg,#3b242a,#2c252c)}
        .rank{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;color:#111820;font-size:11px;font-weight:1000}.rank-1 .rank{background:linear-gradient(145deg,#7dffc0,#35d780)}.rank-2 .rank{background:linear-gradient(145deg,#ffe39a,#ffc24c)}.rank-3 .rank{background:linear-gradient(145deg,#f0b27e,#c97842)}
        .option-main{min-width:0}.option-kicker{font-size:8px;line-height:10px;font-weight:900;color:#9fecc2}.rank-2 .option-kicker{color:#ffda7a}.rank-3 .option-kicker{color:#eeb185}.option-price{font-size:14px;line-height:17px;font-weight:900;color:#fff}.option-meta{font-size:9px;line-height:12px;color:#c7d0da;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .freshness{display:inline-block;margin-top:3px;padding:2px 5px;border-radius:99px;font-size:8px;line-height:10px;font-weight:900}.freshness.fresh{border:1px solid #3ecf83;background:#173c2a;color:#8cffbd}.freshness.warning{border:1px solid var(--orange);background:#4b321b;color:#ffd09a}.freshness.stale{border:1px solid var(--red);background:#4a2228;color:#ffb1b8}.freshness.unknown{border:1px solid #7e8998;background:#303744;color:#d0d7df}
        .open{min-height:32px;padding:5px 9px;border-radius:7px;color:#fff;text-decoration:none;font-size:9px;font-weight:900;display:flex;align-items:center;justify-content:center;white-space:nowrap}.open.rank-1{border:1px solid #67ffb0;background:linear-gradient(135deg,#197a4b,#28a965)}.open.rank-2{border:1px solid #ffd36f;background:linear-gradient(135deg,#7a5419,#a76f1d)}.open.rank-3{border:1px solid #e4a16f;background:linear-gradient(135deg,#70401f,#91532b)}
        details{padding:7px 8px;border:1px solid #4d555e;border-radius:7px;background:#292f36;color:#d5dae0;font-size:10px;line-height:14px}summary{cursor:pointer;font-weight:800;color:#e8ebee}details p{margin:6px 0 0}
        @media(max-width:360px){.actions,.cards,.planner-summary{grid-template-columns:1fr}.wide{grid-column:auto}.api-row{grid-template-columns:1fr}.api-row button{width:100%}.planner-item{grid-template-columns:minmax(0,1fr) 64px}}
      </style>
      <section class="panel" data-ui="panel" aria-label="Kingshade's Market Advisor">
        <header class="head" data-ui="head" role="button" tabindex="0" aria-expanded="true">
          <div class="title"><strong>Kingshade's Market Advisor</strong><span data-ui="title-meta">v${VERSION} TEST</span></div>
          <div class="head-actions"><button class="compact-refresh" type="button" data-ui="compact-refresh" hidden>↻ REFRESH</button><button class="toggle" type="button" data-ui="toggle">▲</button></div>
        </header>
        <nav class="workspace-tabs" aria-label="Market Advisor workspace">
          <button class="workspace-tab" type="button" data-ui="workspace-item">ITEM ADVISOR</button>
          <button class="workspace-tab" type="button" data-ui="workspace-happy">HAPPY JUMP</button>
        </nav>
        <div class="summary-shell" data-ui="summary-shell" hidden>
          <section class="workspace-summary" data-ui="happy-summary" hidden><div class="happy-jump-result" data-ui="happy-jump-result" aria-live="polite" hidden></div></section>
          <section class="workspace-summary" data-ui="item-summary"><div class="result" data-ui="result" aria-live="polite" hidden></div></section>
        </div>
        <div class="controls" data-ui="controls">
          <p class="notice" data-ui="status" aria-live="polite">Clean session ready. Build a new route.</p>
          <section class="workspace-body" data-ui="item-workspace">
            <p class="notice" data-ui="context" data-state="ready">Current Item Market listing.</p>
            <button class="primary" type="button" data-ui="refresh">REFRESH MARKET DATA</button>
          </section>
          <section class="workspace-body" data-ui="happy-workspace" hidden>
            <section class="happy-jump-planner" data-ui="happy-jump-planner">
              <div><div class="planner-title">HAPPY JUMP ROUTE PLANNER</div><div class="planner-subtitle">Choose a preset or edit quantities manually.</div></div>
              <div class="preset-bar">
                ${Object.entries(HAPPY_JUMP_PRESETS).map(([key, preset]) => `<button class="preset-button${key === DEFAULT_HAPPY_JUMP_PRESET ? " active" : ""}" type="button" data-ui="happy-jump-preset" data-preset="${key}">${preset.label}</button>`).join("")}
              </div>
              <div class="planner-items">
                ${HAPPY_JUMP_ITEMS.map(item => `<div class="planner-item" data-planner-item-id="${item.itemId}"><label>${item.itemName}</label><input data-ui="happy-jump-quantity" data-item-id="${item.itemId}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" value="${item.defaultQuantity}" aria-label="${item.itemName} quantity" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true"></div>`).join("")}
              </div>
              <button class="planner-button" type="button" data-ui="plan-happy-jump">PLAN HAPPY JUMP ROUTE</button>
            </section>
          </section>
          <details><summary>⚙ SETTINGS</summary><div class="settings-stack">
            <div class="api-box"><label for="ksma-093release-api-key">Torn API key</label><div class="api-row"><input id="ksma-093release-api-key" data-ui="api-key" type="password" autocomplete="off" placeholder="Stored on this device"><button type="button" data-ui="save-api-key">SAVE</button></div></div>
            <button class="wide" type="button" data-ui="reset">RESET SESSION</button>
          </div></details>
          <details hidden aria-hidden="true"><summary>ⓘ TROUBLESHOOTING</summary>
            <div class="diagnostic-actions"><button type="button" data-ui="copy" disabled>COPY REPORT</button><button type="button" data-ui="download" disabled>DOWNLOAD REPORT</button></div>
            <p class="compact-help">Reports exclude API keys, seller identity and raw page content. KSMA never purchases or clicks market actions automatically.</p>
          </details>
        </div>
      </section>`;
  }

  function installObserver() {
    state.observer = new MutationObserver(() => {
      if (state.destroyed) return;
      scheduleGuardSync();
      scheduleRebind();
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-selected", "aria-current"] });
    window.addEventListener("hashchange", onRouteChange, { passive: true });
    window.addEventListener("popstate", onRouteChange, { passive: true });
  }

  function onRouteChange() {
    state.refreshToken += 1;
    state.plannerToken += 1;
    state.bazaarLocationKey = null;
    state.bazaarLocationEnteredAt = 0;
    cancelBazaarIdentityTimers();
    scheduleGuardSync();
    scheduleRebind();
  }

  function scheduleGuardSync() {
    if (state.destroyed || state.guardFrame) return;
    state.guardFrame = requestAnimationFrame(() => {
      state.guardFrame = 0;
      guardAndSync();
    });
  }

  function guardAndSync() {
    if (isBazaarPage()) {
      scheduleLiveBazaarCapture();
      removeInlineAdvice();
      state.host?.remove();
      state.mountStrategy = "bazaar-route-navigation";
      syncBazaarRouteNavigation();
      return false;
    }

    removeBazaarRouteNavigation();
    removeItemAdvisorBackNavigation();
    const scope = evaluateScope();
    state.lastScope = scope;

    if (!scope.valid) {
      failClosedUnmount(scope.reason);
      return false;
    }

    const point = findStrictMountPoint(scope);
    if (!point?.parent) {
      failClosedUnmount("strict-mount-target-not-ready");
      return false;
    }

    if (state.host.parentNode !== point.parent || state.host.nextSibling !== point.before) {
      point.parent.insertBefore(state.host, point.before || null);
    }
    state.mountStrategy = point.strategy;
    updateContextUi(scope);
    return true;
  }

  function failClosedUnmount(reason) {
    const wasMounted = Boolean(state.host?.isConnected);
    if (wasMounted || state.lastScope?.valid === false) { state.refreshToken += 1; state.plannerToken += 1; }
    removeInlineAdvice();
    state.host?.remove();
    state.mountStrategy = reason || "scope-invalid";
    state.routeKey = null;
  }

  function evaluateScope() {
    const context = currentContext();
    if (context.kind !== "itemMarket") return { valid: false, reason: "not-item-market", context };
    if (!/^\d+$/.test(String(context.itemId || ""))) return { valid: false, reason: "item-id-required", context };
    if (isUnsupportedEquipmentContext(context)) return { valid: false, reason: "unsupported-equipment-or-rw", context };

    const rows = findMarketRowsWithPrices();
    const list = findKnownMarketList(rows);
    const header = findMarketHeaderRow();
    const title = findCurrentItemTitle(context.itemName);
    const detailEvidence = rows.length > 0 && Boolean(list || header || title);

    if (!detailEvidence) {
      return { valid: false, reason: "ordinary-detail-evidence-required", context, rows, list, header, title };
    }

    if (isCategoryOrOverviewPage(context, rows, header)) {
      return { valid: false, reason: "category-or-overview", context, rows, list, header, title };
    }

    return { valid: true, reason: null, context, rows, list, header, title };
  }

  function isCategoryOrOverviewPage(context, rows, header) {
    if (!context.itemId || !rows.length) return true;
    if (header) return false;
    return rows.every(entry => !entry.priceCell || !Number.isFinite(entry.price));
  }

  function findStrictMountPoint(scope) {
    if (!scope?.valid) return null;
    if (scope.list?.parentNode) return { parent: scope.list.parentNode, before: scope.list, strategy: "verified-market-list" };
    if (scope.header?.parentNode) return { parent: scope.header.parentNode, before: scope.header, strategy: "verified-column-header" };
    const firstRow = scope.rows?.[0]?.row;
    if (firstRow?.parentNode) return { parent: firstRow.parentNode, before: firstRow, strategy: "verified-first-price-row" };
    return null;
  }

  function updateContextUi(scope = evaluateScope()) {
    if (!scope.valid || !state.host?.isConnected) return;
    const context = scope.context;
    const routeKey = `${context.itemId}|${context.itemName || ""}`;
    const changed = routeKey !== state.routeKey;
    state.routeKey = routeKey;

    state.nodes.context.textContent = context.itemName || "Current item";
    state.nodes.context.dataset.state = "ready";
    state.nodes.refresh.disabled = state.busy;
    state.nodes.compactRefresh.disabled = state.busy;
    state.nodes.planHappyJump.disabled = state.busy;
    applyWorkspaceState(false);
    if (state.returnFocusPending && state.activeWorkspace === WORKSPACE_HAPPY) {
      scheduleReturnRouteAnchor();
    }

    const resultMatches = state.lastResult && String(state.lastResult.itemId) === String(context.itemId);
    if (state.activeWorkspace === WORKSPACE_ITEM) {
      state.nodes.titleMeta.textContent = resultMatches
        ? `${context.itemName || state.lastResult.itemName} · Updated ${formatClock(state.lastResult.capturedAt)}`
        : `${context.itemName || `Item ${context.itemId}`} · Advisor`;
    }

    if (changed && state.lastResult && !resultMatches) {
      removeInlineAdvice();
      setStatus(`Saved market data belongs to ${state.lastResult.itemName}. Press REFRESH MARKET DATA for this item.`, "warning");
      renderResultMismatch(context);
    } else if (resultMatches) {
      renderResult(state.lastResult);
      if (state.activeWorkspace === WORKSPACE_ITEM && !adviceBindingsCurrent(state.lastResult)) renderInlineAdvice(state.lastResult);
    }
  }

  function findReturnRouteAnchor() {
    const result = state.nodes?.happyJumpResult;
    if (!result || result.hidden || !result.isConnected) return null;
    return result.querySelector(".route-stop.next:not(.quarantined)")
      || result.querySelector("[data-route-anchor='top']")
      || result;
  }

  function cancelReturnRouteAnchor() {
    state.returnAnchorToken += 1;
    state.returnAnchorActive = false;
    for (const timerId of state.returnAnchorTimers || []) clearTimeout(timerId);
    state.returnAnchorTimers?.clear?.();
  }

  function scheduleReturnRouteAnchor() {
    if (!state.returnFocusPending || state.activeWorkspace !== WORKSPACE_HAPPY || state.returnAnchorActive) return false;
    if (!state.host?.isConnected) return false;

    const firstTarget = findReturnRouteAnchor();
    if (!firstTarget) return false;

    state.returnAnchorActive = true;
    const token = ++state.returnAnchorToken;
    const settleDelays = [0, 90, 260, 650];

    const anchorOnce = isFinal => {
      if (state.destroyed || token !== state.returnAnchorToken || state.activeWorkspace !== WORKSPACE_HAPPY) return;
      const target = findReturnRouteAnchor();
      if (!target) {
        if (isFinal) state.returnAnchorActive = false;
        return;
      }
      try { target.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" }); } catch {}
      if (isFinal) {
        state.returnAnchorActive = false;
        state.returnFocusPending = false;
        persistHappyJumpSession();
      }
    };

    requestAnimationFrame(() => anchorOnce(false));
    for (const delay of settleDelays.slice(1)) {
      const timerId = setTimeout(() => {
        state.returnAnchorTimers.delete(timerId);
        anchorOnce(delay === settleDelays[settleDelays.length - 1]);
      }, delay);
      state.returnAnchorTimers.add(timerId);
    }
    return true;
  }

  function captureViewportLock(target) {
    const entries = [];
    const seen = new Set();

    const add = element => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      entries.push({
        element,
        scrollTop: Number(element.scrollTop || 0),
        scrollLeft: Number(element.scrollLeft || 0)
      });
    };

    add(document.scrollingElement);
    add(document.documentElement);
    add(document.body);

    let node = target;
    while (node && node !== document) {
      if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 2) add(node);
      node = node.parentNode || node.host || null;
    }

    return {
      entries,
      windowX: Number(globalThis.scrollX || 0),
      windowY: Number(globalThis.scrollY || 0)
    };
  }

  function restoreViewportLock(lock) {
    if (!lock?.entries?.length) return;
    cancelKsmaScrollAnchor();
    const token = state.scrollAnchorToken;
    const delays = [0, 40, 100, 220, 450, 800];

    const restoreOnce = isFinal => {
      if (state.destroyed || token !== state.scrollAnchorToken) return;

      for (const entry of lock.entries) {
        const element = entry.element;
        if (!element?.isConnected && element !== document.scrollingElement) continue;
        try {
          element.scrollTop = entry.scrollTop;
          element.scrollLeft = entry.scrollLeft;
        } catch {}
      }

      try { globalThis.scrollTo({ top: lock.windowY, left: lock.windowX, behavior: "auto" }); }
      catch { globalThis.scrollTo(lock.windowX, lock.windowY); }

      if (isFinal) cancelKsmaScrollAnchor();
    };

    requestAnimationFrame(() => restoreOnce(false));
    for (const delay of delays.slice(1)) {
      const timerId = setTimeout(() => {
        state.scrollAnchorTimers.delete(timerId);
        restoreOnce(delay === delays[delays.length - 1]);
      }, delay);
      state.scrollAnchorTimers.add(timerId);
    }
  }

  function nearestScrollContainer(node) {
    let current = node?.parentElement || null;
    while (current && current !== document.body && current !== document.documentElement) {
      const style = globalThis.getComputedStyle?.(current);
      const overflowY = String(style?.overflowY || "");
      if (/(auto|scroll|overlay)/.test(overflowY) && current.scrollHeight > current.clientHeight + 2) return current;
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function preservePresetScreenPosition(mutate) {
    mutate();
  }

  function cancelKsmaScrollAnchor() {
    state.scrollAnchorToken += 1;
    for (const timerId of state.scrollAnchorTimers || []) clearTimeout(timerId);
    state.scrollAnchorTimers?.clear?.();
  }

  function scheduleKsmaScrollAnchor(kind) {
    cancelKsmaScrollAnchor();
    const token = state.scrollAnchorToken;
    const delays = [0, 100, 280, 650];

    const resolveTarget = () => {
      if (kind === "route") {
        return state.nodes?.happyJumpResult?.querySelector?.("[data-route-anchor='top']")
          || state.nodes?.happyJumpResult;
      }
      if (kind === "preset") {
        return state.root?.querySelector?.(".preset-bar")
          || state.nodes?.happyWorkspace;
      }
      return state.host;
    };

    const anchorOnce = isFinal => {
      if (state.destroyed || token !== state.scrollAnchorToken) return;
      const target = resolveTarget();
      if (!target?.isConnected) return;
      try { target.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" }); } catch {}
      if (isFinal) cancelKsmaScrollAnchor();
    };

    requestAnimationFrame(() => anchorOnce(false));
    for (const delay of delays.slice(1)) {
      const timerId = setTimeout(() => {
        state.scrollAnchorTimers.delete(timerId);
        anchorOnce(delay === delays[delays.length - 1]);
      }, delay);
      state.scrollAnchorTimers.add(timerId);
    }
  }

  function setActiveWorkspace(workspace, options = {}) {
    const next = workspace === WORKSPACE_HAPPY ? WORKSPACE_HAPPY : WORKSPACE_ITEM;
    if (next !== WORKSPACE_HAPPY) {
      state.returnFocusPending = false;
      cancelReturnRouteAnchor();
    }
    state.activeWorkspace = next;
    if (next === WORKSPACE_HAPPY) {
      removeInlineAdvice();
    } else {
      const scope = evaluateScope();
      if (scope.valid && state.lastResult && String(state.lastResult.itemId) === String(scope.context.itemId)) renderInlineAdvice(state.lastResult);
    }
    applyWorkspaceState(options.scroll === true);
    if (state.happyJumpPlan) persistHappyJumpSession();
  }

  function applyWorkspaceState(scrollToWorkspace = false) {
    if (!state.nodes) return;
    const happy = state.activeWorkspace === WORKSPACE_HAPPY;
    state.nodes.workspaceItem.classList.toggle("active", !happy);
    state.nodes.workspaceHappy.classList.toggle("active", happy);
    state.nodes.workspaceItem.setAttribute("aria-pressed", String(!happy));
    state.nodes.workspaceHappy.setAttribute("aria-pressed", String(happy));
    state.nodes.itemWorkspace.hidden = happy;
    state.nodes.happyWorkspace.hidden = !happy;
    state.nodes.itemSummary.hidden = happy || state.nodes.result.hidden;
    state.nodes.happySummary.hidden = !happy || state.nodes.happyJumpResult.hidden;
    state.nodes.compactRefresh.hidden = !state.collapsed || happy;
    if (happy) {
      const plan = state.happyJumpPlan?.practical;
      state.nodes.titleMeta.textContent = plan
        ? `Happy Jump · ${plan.stopCount} stop${plan.stopCount === 1 ? "" : "s"} · $${formatMoney(plan.totalCost)}`
        : "Happy Jump · Route Planner";
    } else if (state.lastResult) {
      state.nodes.titleMeta.textContent = `${state.lastResult.itemName} · Updated ${formatClock(state.lastResult.capturedAt)}`;
    }
    syncSummaryShellVisibility();
    if (scrollToWorkspace) scheduleKsmaScrollAnchor(happy ? "preset" : "panel");
  }

  function toggleCollapsed() {
    state.collapsed = !state.collapsed;
    writeBoolean(COLLAPSED_STORAGE_KEY, state.collapsed);
    applyCollapsedState(true);
  }

  function applyCollapsedState(focusToggle) {
    const collapsed = state.collapsed === true;
    state.nodes.controls.hidden = collapsed;
    state.nodes.compactRefresh.hidden = !collapsed || state.activeWorkspace === WORKSPACE_HAPPY;
    state.nodes.head.setAttribute("aria-expanded", String(!collapsed));
    state.nodes.toggle.textContent = collapsed ? "▼" : "▲";
    state.nodes.toggle.setAttribute("aria-label", collapsed ? "Show Market Advisor controls" : "Hide Market Advisor controls");
    if (focusToggle) state.nodes.toggle.focus({ preventScroll: true });
  }

  function saveApiKey() {
    const key = state.nodes.apiKey.value.trim();
    if (!key) {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
      setStatus("API key removed from this device.", "warning");
      return;
    }
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
    setStatus("API key saved on this device.", "ready");
  }

  async function runRefresh() {
    if (state.busy) return;
    setActiveWorkspace(WORKSPACE_ITEM);
    const scope = evaluateScope();
    if (!scope.valid) {
      failClosedUnmount(scope.reason);
      return;
    }

    const context = scope.context;
    const apiKey = state.nodes.apiKey.value.trim() || readString(API_KEY_STORAGE_KEY, "");
    if (!apiKey) {
      state.collapsed = false;
      writeBoolean(COLLAPSED_STORAGE_KEY, false);
      applyCollapsedState(false);
      setStatus("Save a Public Torn API key before refreshing.", "error");
      state.nodes.apiKey.focus({ preventScroll: true });
      return;
    }
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);

    const refreshToken = ++state.refreshToken;
    const requestedItemId = String(context.itemId);
    state.busy = true;
    setBusyUi(true, "current-item");
    setStatus("Loading Bazaar data and Item Market data…", "neutral");

    try {
      const visibleBefore = findVisibleCheapestItemMarketPrice();
      const [remoteBazaarListings, itemMarketPayload, ownBazaarSnapshot] = await Promise.all([
        fetchTornW3bBazaarListings(requestedItemId),
        fetchTornApiSelection(requestedItemId, "itemmarket", apiKey),
        fetchOwnBazaarSnapshot(apiKey).catch(() => null)
      ]);
      const bazaarListings = mergeBazaarListingSources(
        remoteBazaarListings,
        normalizeOwnBazaarSnapshot(ownBazaarSnapshot, requestedItemId),
        readLiveBazaarListingsForItem(requestedItemId)
      );
      const itemMarketListings = normalizeApiMarketRecords(itemMarketPayload, "itemmarket");

      const currentScope = evaluateScope();
      if (
        refreshToken !== state.refreshToken ||
        !currentScope.valid ||
        String(currentScope.context.itemId || "") !== requestedItemId
      ) {
        throw new Error("Item or page scope changed during refresh. No result was applied.");
      }

      const visibleAfter = findVisibleCheapestItemMarketPrice();
      const visiblePrice = minFinite(visibleBefore, visibleAfter);
      if (!bazaarListings.length) throw new Error("No Bazaar listings were returned for this item.");
      if (!itemMarketListings.length && !Number.isFinite(visiblePrice)) throw new Error("No Item Market listing price could be verified.");

      const bestBazaar = bazaarListings[0] || null;
      const bestItemApi = itemMarketListings[0] || null;
      const effectiveItem = resolveEffectiveItemMarket(bestItemApi, visiblePrice);
      const comparison = comparePrices(bestBazaar?.price, effectiveItem?.price);
      const capturedAt = Date.now();
      const result = {
        itemId: requestedItemId,
        itemName: currentScope.context.itemName || `Item ${requestedItemId}`,
        capturedAt,
        bazaarListings,
        itemMarketListings,
        bestBazaar,
        bestItemApi,
        visibleItemMarketPrice: Number.isFinite(visiblePrice) ? visiblePrice : null,
        effectiveItemMarket: effectiveItem,
        comparison,
        directLink: bestBazaar ? bazaarDestinationForUserId(bestBazaar.userId, requestedItemId) : null
      };

      state.refreshCount += 1;
      state.lastResult = result;
      renderResult(result);
      renderInlineAdvice(result);
      state.lastReport = buildReport(result);
      state.nodes.copy.disabled = false;
      state.nodes.download.disabled = false;
      state.nodes.titleMeta.textContent = `${result.itemName} · Updated ${formatClock(capturedAt)}`;
      const ageText = formatLastSeen(bestBazaar?.updatedAt, capturedAt);
      const fallback = effectiveItem?.source === "current-item-market-page" && bestItemApi
        ? ` Visible page is $${formatMoney(bestItemApi.price - effectiveItem.price)} lower than the Torn API cache.`
        : "";
      setStatus(`Market data ready. Bazaar ${bazaarListings.length} · Item Market ${itemMarketListings.length} · Best Bazaar ${ageText}.${fallback}`, "ready");
    } catch (error) {
      const message = String(error?.message || error).slice(0, 180);
      removeInlineAdvice();
      const currentScope = evaluateScope();
      if (!currentScope.valid) {
        failClosedUnmount(currentScope.reason);
      } else {
        if (/api key|incorrect key|invalid key|unauthori[sz]ed|permission/i.test(message)) {
          state.collapsed = false;
          writeBoolean(COLLAPSED_STORAGE_KEY, false);
          applyCollapsedState(false);
        }
        setStatus(`Market data failed: ${message}`, "error");
      }
    } finally {
      state.busy = false;
      if (state.host?.isConnected && evaluateScope().valid) setBusyUi(false);
    }
  }

  function setBusyUi(busy, mode = null) {
    state.nodes.panel.toggleAttribute("aria-busy", busy);
    state.nodes.refresh.disabled = busy;
    state.nodes.compactRefresh.disabled = busy;
    state.nodes.planHappyJump.disabled = busy;
    state.nodes.compactRefresh.textContent = busy && mode === "current-item" ? "…" : "↻ REFRESH";
    state.nodes.refresh.textContent = busy && mode === "current-item" ? "LOADING MARKET DATA…" : "REFRESH MARKET DATA";
    state.nodes.planHappyJump.textContent = busy && mode === "happy-jump" ? "BUILDING ROUTE…" : "PLAN HAPPY JUMP ROUTE";
    if (busy) {
      state.nodes.copy.disabled = true;
      state.nodes.download.disabled = true;
    } else {
      const available = Boolean(state.lastReport);
      state.nodes.copy.disabled = !available;
      state.nodes.download.disabled = !available;
    }
  }

  function renderResultMismatch(context) {
    const result = state.lastResult;
    state.nodes.result.hidden = false;
    syncSummaryShellVisibility();
    state.nodes.result.innerHTML = `<p class="notice" data-state="warning">Saved result: ${escapeHtml(result.itemName)} · Current item: ${escapeHtml(context.itemName || `Item ${context.itemId}`)}. Refresh before using prices.</p>`;
  }

  function renderResult(result) {
    const bestBazaar = result.bestBazaar;
    const bestItem = result.effectiveItemMarket;
    const comparison = result.comparison;
    const bazaarSub = bestBazaar ? `${Number.isFinite(bestBazaar.stock) ? `Qty ${bestBazaar.stock} · ` : ""}${formatLastSeen(bestBazaar.updatedAt, result.capturedAt)}` : "No listings";
    const itemSub = bestItem ? (bestItem.source === "current-item-market-page" ? `Visible page${result.bestItemApi ? ` · Torn API $${formatMoney(result.bestItemApi.price)}` : ""}` : "Torn API") : "No listings";

    let verdictClass = "same";
    let verdict = "PRICE COMPARISON UNAVAILABLE";
    if (comparison.status === "bazaar-cheaper") { verdictClass = "bazaar"; verdict = `BAZAAR SAVES $${formatMoney(comparison.difference)} (${comparison.differencePercent.toFixed(2)}%)`; }
    else if (comparison.status === "item-market-cheaper") { verdictClass = "market"; verdict = `ITEM MARKET SAVES $${formatMoney(comparison.difference)} (${comparison.differencePercent.toFixed(2)}%)`; }
    else if (comparison.status === "same-price") verdict = "SAME PRICE";

    const topThree = result.bazaarListings.slice(0, 3).map((listing, index) => bazaarOptionMarkup(listing, index, result.itemId, result.capturedAt)).join("");
    state.nodes.result.hidden = false;
    syncSummaryShellVisibility();
    state.nodes.result.innerHTML = `
      <div class="cards">
        <article class="card bazaar-card"><div class="label">BEST BAZAAR</div><div class="value">${bestBazaar ? `$${formatMoney(bestBazaar.price)}` : "—"}</div><div class="sub">${escapeHtml(bazaarSub)}</div></article>
        <article class="card market-card"><div class="label">BEST ITEM MARKET</div><div class="value">${bestItem ? `$${formatMoney(bestItem.price)}` : "—"}</div><div class="sub">${escapeHtml(itemSub)}</div></article>
      </div>
      <div class="verdict ${verdictClass}">${escapeHtml(verdict)}</div>
      <section class="bazaar-top3"><div class="bazaar-top3-title">TOP 3 LOWEST BAZAAR LISTINGS</div>${topThree || `<p class="notice">No Bazaar options returned.</p>`}</section>`;
  }

  function bazaarOptionMarkup(listing, index, itemId, capturedAt) {
    const rank = index + 1;
    const freshness = sourceFreshness(listing.updatedAt, capturedAt);
    const href = bazaarDestinationForUserId(listing.userId, itemId);
    const stock = Number.isFinite(listing.stock) ? `Qty ${listing.stock}` : "Qty unknown";
    return `
      <article class="bazaar-option rank-${rank} ${freshness}">
        <div class="rank">${rank}</div>
        <div class="option-main"><div class="option-kicker">${rank === 1 ? "LOWEST PRICE" : `OPTION ${rank}`}</div><div class="option-price">$${formatMoney(listing.price)}</div><div class="option-meta">${escapeHtml(stock)}</div><span class="freshness ${freshness}">${escapeHtml(formatLastSeen(listing.updatedAt, capturedAt))}</span></div>
        ${href ? `<a class="open rank-${rank}" href="${escapeAttribute(href)}" data-item-advisor-open="true" data-item-id="${escapeAttribute(itemId)}" data-seller-id="${escapeAttribute(listing.userId)}">OPEN</a>` : ""}
      </article>`;
  }

  function renderInlineAdvice(result) {
    removeInlineAdvice();
    const scope = evaluateScope();
    if (!scope.valid || String(scope.context.itemId) !== String(result.itemId)) return;

    const rows = findMarketRowsWithPrices();
    if (!rows.length || !result.bestBazaar) return;
    const preferred = rows.slice().sort((a, b) => a.price - b.price)[0] || null;

    for (const entry of rows) {
      const cell = entry.priceCell;
      if (!cell || !Number.isFinite(entry.price)) continue;
      if (!cell.hasAttribute(PRICE_STYLE_ATTR)) {
        const original = cell.getAttribute("style");
        cell.setAttribute(PRICE_STYLE_ATTR, original == null ? NO_STYLE_SENTINEL : original);
      }
      cell.style.setProperty("display", "flex", "important");
      cell.style.setProperty("flex-direction", "column", "important");
      cell.style.setProperty("align-items", "flex-end", "important");
      cell.style.setProperty("justify-content", "center", "important");
      cell.style.setProperty("min-width", "0", "important");
      cell.style.setProperty("box-sizing", "border-box", "important");
      cell.style.setProperty("overflow", "visible", "important");

      const comparison = comparePrices(result.bestBazaar.price, entry.price);
      const marker = document.createElement("span");
      marker.setAttribute(ADVICE_ATTR, "true");
      marker.dataset.price = String(entry.price);
      marker.style.cssText = "display:block;width:100%;min-width:0;height:10px;margin-top:0;font-size:8px;line-height:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;pointer-events:none;position:static;float:none;clear:both;text-align:right;font-weight:900;";

      let label = "NO BZ PRICE";
      let color = "#c7d0da";
      if (comparison.status === "item-market-cheaper") { label = "IM LOWER"; color = "#72dcff"; }
      else if (comparison.status === "same-price") { label = "SAME"; color = "#d7cbff"; }
      else if (comparison.status === "bazaar-cheaper") { label = "BZ LOWER"; color = "#7bffb8"; }
      if (preferred && entry.row === preferred.row) {
        label = `BEST · ${label}`;
        marker.setAttribute(BEST_ATTR, "true");
      }
      marker.textContent = label;
      marker.style.color = color;
      cell.append(marker);
    }
  }

  function removeInlineAdvice() {
    for (const marker of document.querySelectorAll(`[${ADVICE_ATTR}], [data-ksma-rc5-advice], [data-ksfpi-ordinary-advice='true']`)) marker.remove();
    for (const cell of document.querySelectorAll(`[${PRICE_STYLE_ATTR}]`)) {
      const original = cell.getAttribute(PRICE_STYLE_ATTR);
      if (original === NO_STYLE_SENTINEL) cell.removeAttribute("style");
      else if (original != null) cell.setAttribute("style", original);
      cell.removeAttribute(PRICE_STYLE_ATTR);
    }
  }

  function adviceBindingsCurrent(result) {
    const scope = evaluateScope();
    if (!scope.valid || String(scope.context.itemId) !== String(result?.itemId || "")) return false;
    const rows = findMarketRowsWithPrices();
    if (!rows.length) return false;
    const markers = document.querySelectorAll(`[${ADVICE_ATTR}]`);
    return markers.length === rows.length;
  }

  function scheduleRebind() {
    if (state.destroyed || state.rebindFrame) return;
    state.rebindFrame = requestAnimationFrame(() => {
      state.rebindFrame = 0;
      if (isBazaarPage()) return;
      const scope = evaluateScope();
      if (!scope.valid) {
        failClosedUnmount(scope.reason);
        return;
      }
      if (!state.lastResult || String(state.lastResult.itemId) !== String(scope.context.itemId)) return;
      const visible = findVisibleCheapestItemMarketPrice();
      const effective = resolveEffectiveItemMarket(state.lastResult.bestItemApi, visible);
      if (effective && (!state.lastResult.effectiveItemMarket || effective.price !== state.lastResult.effectiveItemMarket.price || effective.source !== state.lastResult.effectiveItemMarket.source)) {
        state.lastResult.visibleItemMarketPrice = Number.isFinite(visible) ? visible : null;
        state.lastResult.effectiveItemMarket = effective;
        state.lastResult.comparison = comparePrices(state.lastResult.bestBazaar?.price, effective.price);
        state.lastReport = buildReport(state.lastResult);
        renderResult(state.lastResult);
      }
      if (state.activeWorkspace === WORKSPACE_ITEM && !adviceBindingsCurrent(state.lastResult)) renderInlineAdvice(state.lastResult);
    });
  }

  function resetSession() {
    state.lastResult = null;
    state.lastReport = null;
    state.refreshCount = 0;
    state.happyJumpPlan = null;
    state.happyJumpData = null;
    state.happyJumpPreset = DEFAULT_HAPPY_JUMP_PRESET;
    state.happyJumpQuantities = Object.fromEntries(HAPPY_JUMP_ITEMS.map(item => [item.itemId, item.defaultQuantity]));
    state.openedRouteKeys = new Set();
    state.quarantinedRouteKeys = new Set();
    state.quarantineReasons = {};
    state.restoredRouteAt = null;
    state.activeRouteKey = null;
    state.activeRouteKind = "practical";
    state.routeReturnUrl = null;
    state.returnFocusPending = false;
    cancelReturnRouteAnchor();
    state.preflightToken += 1;
    state.preflightBusy = false;
    state.lastBazaarVerification = null;
    state.lastQuarantineResult = null;
    state.bazaarNavAlert = null;
    state.bazaarNavCollapsed = false;
    state.activeWorkspace = WORKSPACE_ITEM;
    removeBazaarRouteNavigation();
    clearHappyJumpSession();
    state.plannerToken += 1;
    for (const input of state.nodes.happyJumpInputs) {
      const item = HAPPY_JUMP_ITEMS.find(entry => entry.itemId === input.dataset.itemId);
      input.value = String(item?.defaultQuantity ?? 0);
    }
    syncHappyJumpPresetButtons();
    state.nodes.result.hidden = true;
    state.nodes.result.innerHTML = "";
    state.nodes.happyJumpResult.hidden = true;
    state.nodes.happyJumpResult.innerHTML = "";
    syncSummaryShellVisibility();
    state.nodes.copy.disabled = true;
    state.nodes.download.disabled = true;
    removeInlineAdvice();
    const scope = evaluateScope();
    if (scope.valid) updateContextUi(scope);
    setStatus("Session market data and Happy Jump route cleared. The saved API key was kept.", "warning");
  }

  function syncSummaryShellVisibility() {
    if (!state.nodes) return;
    const happy = state.activeWorkspace === WORKSPACE_HAPPY;
    state.nodes.itemSummary.hidden = happy || state.nodes.result.hidden;
    state.nodes.happySummary.hidden = !happy || state.nodes.happyJumpResult.hidden;
    state.nodes.summaryShell.hidden = happy ? state.nodes.happyJumpResult.hidden : state.nodes.result.hidden;
  }

  function quantitiesMatchPreset(quantities, presetKey) {
    const preset = HAPPY_JUMP_PRESETS[presetKey];
    if (!preset?.quantities) return false;
    return HAPPY_JUMP_ITEMS.every(item =>
      normalizePlannerQuantity(quantities?.[item.itemId] ?? 0, true)
      === normalizePlannerQuantity(preset.quantities[item.itemId] ?? 0, true)
    );
  }

  function inferHappyJumpPreset(quantities) {
    for (const presetKey of ["EDVD", "LOLLIPOP", "BIG_CHOCO"]) {
      if (quantitiesMatchPreset(quantities, presetKey)) return presetKey;
    }
    return "CUSTOM";
  }

  function syncHappyJumpPresetButtons() {
    for (const button of state.nodes.happyJumpPresets || []) {
      const active = button.dataset.preset === state.happyJumpPreset;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function syncHappyJumpPresetItemVisibility() {
    const preset = HAPPY_JUMP_PRESETS[state.happyJumpPreset] || HAPPY_JUMP_PRESETS.CUSTOM;
    const visibleItemIds = new Set(preset.itemIds || []);
    for (const input of state.nodes.happyJumpInputs || []) {
      const itemId = String(input.dataset.itemId || "");
      const row = input.closest("[data-planner-item-id]");
      if (row) row.hidden = !visibleItemIds.has(itemId);
    }
  }

  function applyHappyJumpPreset(presetKey) {
    const preset = HAPPY_JUMP_PRESETS[presetKey];
    if (!preset) return;
    state.happyJumpPreset = presetKey;

    if (preset.quantities) {
      for (const item of HAPPY_JUMP_ITEMS) {
        state.happyJumpQuantities[item.itemId] = normalizePlannerQuantity(preset.quantities[item.itemId] ?? 0, true);
      }
    }

    for (const input of state.nodes.happyJumpInputs) {
      input.value = String(state.happyJumpQuantities[input.dataset.itemId] ?? 0);
    }

    syncHappyJumpPresetButtons();
    syncHappyJumpPresetItemVisibility();
    invalidateHappyJumpPlan();

  }

  function bindHappyJumpPlannerControls() {
    for (const button of state.nodes.happyJumpPresets || []) {
      button.addEventListener("click", () => applyHappyJumpPreset(String(button.dataset.preset || "")));
    }

    for (const input of state.nodes.happyJumpInputs) {
      const itemId = String(input.dataset.itemId || "");
      const item = HAPPY_JUMP_ITEMS.find(entry => entry.itemId === itemId);
      const initial = state.happyJumpQuantities[itemId] ?? item?.defaultQuantity ?? 0;
      input.value = String(initial);
      input.addEventListener("input", () => {
        const clean = String(input.value || "").replace(/[^0-9]/g, "").slice(0, 3);
        if (input.value !== clean) input.value = clean;
        state.happyJumpQuantities[itemId] = normalizePlannerQuantity(clean, true);
        state.happyJumpPreset = "CUSTOM";
        syncHappyJumpPresetButtons();
        syncHappyJumpPresetItemVisibility();
        invalidateHappyJumpPlan();
      });
      input.addEventListener("blur", () => {
        const normalized = normalizePlannerQuantity(input.value, true);
        state.happyJumpQuantities[itemId] = normalized;
        input.value = String(normalized);
      });
      input.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        input.blur();
        runHappyJumpPlanner();
      });
    }
  }

  function invalidateHappyJumpPlan() {
    if (!state.happyJumpPlan) return;
    state.happyJumpPlan = null;
    state.happyJumpData = null;
    state.openedRouteKeys = new Set();
    state.quarantinedRouteKeys = new Set();
    state.quarantineReasons = {};
    state.restoredRouteAt = null;
    state.activeRouteKey = null;
    state.routeReturnUrl = null;
    state.returnFocusPending = false;
    cancelReturnRouteAnchor();
    state.preflightToken += 1;
    state.preflightBusy = false;
    state.bazaarNavAlert = null;
    removeBazaarRouteNavigation();
    clearHappyJumpSession();
    state.nodes.happyJumpResult.hidden = false;
    preservePresetScreenPosition(() => {
      state.nodes.happyJumpResult.innerHTML = `<div class="planner-note warning">Happy Jump quantities changed. Press PLAN HAPPY JUMP ROUTE to rebuild the route.</div>`;
    });
    if (state.lastReport?.reportType === "multi-item-happy-jump-route") {
      state.lastReport = state.lastResult ? buildReport(state.lastResult) : null;
      state.nodes.copy.disabled = !state.lastReport;
      state.nodes.download.disabled = !state.lastReport;
    }
    syncSummaryShellVisibility();
  }

  function readHappyJumpRequest() {
    return HAPPY_JUMP_ITEMS.map(item => {
      const input = state.nodes.happyJumpInputs.find(node => node.dataset.itemId === item.itemId);
      const quantity = normalizePlannerQuantity(input?.value ?? state.happyJumpQuantities[item.itemId], true);
      state.happyJumpQuantities[item.itemId] = quantity;
      if (input) input.value = String(quantity);
      return { ...item, quantity };
    }).filter(item => item.quantity > 0);
  }

  async function runHappyJumpPlanner() {
    if (state.busy) return;
    setActiveWorkspace(WORKSPACE_HAPPY, { scroll: false });
    const scope = evaluateScope();
    if (!scope.valid) {
      failClosedUnmount(scope.reason);
      return;
    }
    const apiKey = state.nodes.apiKey.value.trim() || readString(API_KEY_STORAGE_KEY, "");
    if (!apiKey) {
      state.collapsed = false;
      writeBoolean(COLLAPSED_STORAGE_KEY, false);
      applyCollapsedState(false);
      setStatus("Save a Public Torn API key before planning the Happy Jump route.", "error");
      state.nodes.apiKey.focus({ preventScroll: true });
      return;
    }
    const request = readHappyJumpRequest();
    if (!request.length) {
      setStatus("Enter at least one Happy Jump item quantity.", "error");
      return;
    }
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    const plannerToken = ++state.plannerToken;
    state.busy = true;
    setBusyUi(true, "happy-jump");
    setStatus(`Loading ${request.length} Happy Jump item${request.length === 1 ? "" : "s"} from Bazaar and Item Market…`, "neutral");

    try {
      const ownBazaarPromise = fetchOwnBazaarSnapshot(apiKey).catch(() => null);
      const itemData = await Promise.all(request.map(async item => {
        const [remoteBazaarListings, itemMarketPayload, ownBazaarSnapshot] = await Promise.all([
          fetchTornW3bBazaarListings(item.itemId),
          fetchTornApiSelection(item.itemId, "itemmarket", apiKey),
          ownBazaarPromise
        ]);
        const ownBazaarListings = normalizeOwnBazaarSnapshot(ownBazaarSnapshot, item.itemId);
        const liveBazaarListings = readLiveBazaarListingsForItem(item.itemId);
        const bazaarListings = mergeBazaarListingSources(
          remoteBazaarListings,
          ownBazaarListings,
          liveBazaarListings
        );
        const itemMarketListings = normalizeApiMarketRecords(itemMarketPayload, "itemmarket");
        if (!bazaarListings.length && !itemMarketListings.length) throw new Error(`No stock-backed listings were returned for ${item.itemName}.`);
        return {
          itemId: item.itemId,
          itemName: item.itemName,
          requestedQuantity: item.quantity,
          capturedAt: Date.now(),
          bazaarListings,
          itemMarketListings
        };
      }));

      const currentScope = evaluateScope();
      if (plannerToken !== state.plannerToken || !currentScope.valid) throw new Error("Page scope changed during route planning. No route was applied.");
      const preservedQuarantinedKeys = new Set(state.quarantinedRouteKeys);
      const preservedQuarantineReasons = { ...state.quarantineReasons };
      const routeData = filterHappyJumpDataForQuarantine(itemData, preservedQuarantinedKeys);
      const plan = buildHappyJumpRoutePlan(routeData, { maxPracticalStops: PRACTICAL_MAX_STOPS, candidateLimit: PRACTICAL_CANDIDATE_LIMIT });
      state.happyJumpData = itemData;
      state.happyJumpPlan = plan;
      // A user-initiated PLAN/REPLAN starts a new shopping trip. Visited progress
      // belongs only to the previous route and must never carry into fresh data.
      state.openedRouteKeys = new Set();
      state.quarantinedRouteKeys = preservedQuarantinedKeys;
      state.quarantineReasons = preservedQuarantineReasons;
      state.restoredRouteAt = null;
      state.activeRouteKey = null;
      state.routeReturnUrl = safeItemMarketReturnUrl(globalThis.location?.href || "") || itemMarketDestination(request[0]?.itemId);
      state.returnFocusPending = false;
      cancelReturnRouteAnchor();
      state.preflightToken += 1;
      state.preflightBusy = false;
      state.bazaarNavAlert = null;
      state.activeWorkspace = WORKSPACE_HAPPY;
      renderHappyJumpPlan(plan);

      state.lastReport = buildHappyJumpReport(plan, routeData);
      persistHappyJumpSession();
      state.nodes.copy.disabled = false;
      state.nodes.download.disabled = false;
      const status = plan.practical.complete
        ? `Happy Jump route ready. ${plan.practical.stopCount} stop${plan.practical.stopCount === 1 ? "" : "s"} · $${formatMoney(plan.practical.totalCost)} total.`
        : `Partial Happy Jump route only. ${plan.practical.missingItems.length} item requirement${plan.practical.missingItems.length === 1 ? "" : "s"} could not be filled.`;
      setStatus(status, plan.practical.complete ? "ready" : "warning");
    } catch (error) {
      const message = String(error?.message || error).slice(0, 180);
      const currentScope = evaluateScope();
      if (!currentScope.valid) failClosedUnmount(currentScope.reason);
      else setStatus(`Happy Jump route failed: ${message}`, "error");
    } finally {
      state.busy = false;
      if (state.host?.isConnected && evaluateScope().valid) setBusyUi(false);
    }
  }

  function isHappyJumpRouteComplete(plan = state.happyJumpPlan, visitedKeys = state.openedRouteKeys) {
    const practical = plan?.practical;
    const steps = practical?.steps || [];
    const visited = visitedKeys instanceof Set ? visitedKeys : new Set(visitedKeys || []);
    if (practical?.complete !== true || !steps.length) return false;
    return steps.every(step => visited.has(String(step.routeKey || "")));
  }

  function renderHappyJumpPlan(plan, options = {}) {
    const practical = plan.practical;
    const absolute = plan.absolute;
    const verdictClass = !practical.complete ? "partial" : practical.verificationRequired || practical.stockRiskCount ? "warning" : "";
    const verdict = practical.complete
      ? `RECOMMENDED ROUTE · ${practical.stopCount} STOP${practical.stopCount === 1 ? "" : "S"} · TOTAL $${formatMoney(practical.totalCost)}`
      : `PARTIAL ROUTE · ${formatMoney(practical.filledUnits)} OF ${formatMoney(practical.requestedUnits)} UNITS FOUND`;
    const orderedSteps = orderPracticalRouteSteps(practical.steps);
    const nextRouteKey = orderedSteps.find(step => !state.openedRouteKeys.has(step.routeKey))?.routeKey || null;
    const routeSteps = orderedSteps.map((step, index) => multiRouteStepMarkup(step, index, practical.capturedAt, {
      trackProgress: true,
      opened: state.openedRouteKeys.has(step.routeKey),
      next: step.routeKey === nextRouteKey
    })).join("");
    const openedCount = practical.steps.filter(step => state.openedRouteKeys.has(step.routeKey)).length;
    const routeComplete = isHappyJumpRouteComplete(plan);
    const progressText = practical.stopCount
      ? routeComplete
        ? `ROUTE COMPLETE · ${openedCount}/${practical.stopCount} recommended stops visited. Start a new Happy Jump to keep the same quantities and fetch fresh market data.`
        : `${openedCount}/${practical.stopCount} recommended stops visited.${nextRouteKey ? " The next unvisited stop is shown first." : ""}`
      : "No route stops available.";
    const planActionLabel = routeComplete ? "START NEW HAPPY JUMP" : "REPLAN WITH FRESH DATA";
    const absoluteDifference = practical.complete && absolute.complete ? Math.max(0, practical.totalCost - absolute.totalCost) : null;
    const absoluteText = absolute.complete
      ? `Absolute cheapest: $${formatMoney(absolute.totalCost)} across ${absolute.stopCount} stop${absolute.stopCount === 1 ? "" : "s"}.${Number.isFinite(absoluteDifference) ? ` Practical route costs $${formatMoney(absoluteDifference)} more to avoid ${Math.max(0, absolute.stopCount - practical.stopCount)} extra stop${Math.max(0, absolute.stopCount - practical.stopCount) === 1 ? "" : "s"}.` : ""}`
      : `Absolute cheapest route is also partial: ${formatMoney(absolute.filledUnits)} of ${formatMoney(absolute.requestedUnits)} units found.`;
    const staleNote = practical.verificationRequired ? `<div class="planner-note warning">VERIFY PRICE: one or more Bazaar snapshots are older than 5 minutes.</div>` : "";
    const riskNote = practical.stockRiskCount ? `<div class="planner-note warning">STOCK RISK: ${practical.stockRiskCount} allocation${practical.stockRiskCount === 1 ? "" : "s"} has limited stock. Replan if unavailable.</div>` : "";
    const guardNote = practical.stockRiskGuardCost > 0 ? `<div class="planner-note">STOCK GUARD: +$${formatMoney(practical.stockRiskGuardCost)} for safer stock.</div>` : "";
    const fallbackNote = practical.routeCapBlocked ? `<div class="planner-note warning">No complete route fits inside ${plan.maxPracticalStops} stops. The impractical multi-Bazaar route is available only under ABSOLUTE CHEAPEST COMPARISON.</div>` : "";
    const missingNote = practical.missingItems.length ? `<div class="planner-note warning">Missing: ${escapeHtml(practical.missingItems.map(item => `${item.quantity} ${item.itemName}`).join(", "))}.</div>` : "";
    const restoredNote = options.restored || state.restoredRouteAt ? `<div class="planner-note warning">SAVED ROUTE RESTORED: prices and stock were not refreshed.</div>` : "";
    const quarantineNote = state.quarantinedRouteKeys.size ? `<div class="planner-note warning">QUARANTINE: ${state.quarantinedRouteKeys.size} closed Bazaar${state.quarantinedRouteKeys.size === 1 ? "" : "s"} excluded.</div>` : "";
    const adoptionNote = Array.isArray(practical.backupAdoptions) && practical.backupAdoptions.length ? `<div class="planner-note">BACKUP ADOPTED: ${escapeHtml(practical.backupAdoptions.map(entry => `${entry.quantity} ${entry.itemName}${entry.extraCost ? ` (${entry.extraCost > 0 ? "+" : "−"}$${formatMoney(Math.abs(entry.extraCost))})` : ""}`).join(" · "))}.</div>` : "";
    const routeDetailNotes = `${adoptionNote}${quarantineNote}${restoredNote}${riskNote}${guardNote}${staleNote}${fallbackNote}${missingNote}`;
    const absoluteSteps = absolute.steps.map((step, index) => multiRouteStepMarkup(step, index, absolute.capturedAt, { trackProgress: false })).join("");

    state.nodes.happyJumpResult.hidden = false;
    preservePresetScreenPosition(() => {
      state.nodes.happyJumpResult.innerHTML = `<section class="happy-jump-planner" data-route-anchor="top">
      <div><div class="planner-title">HAPPY JUMP PURCHASE ROUTE</div><div class="planner-subtitle">Best practical route based on price, stops and stock.</div></div>
      <div class="planner-summary"><div class="planner-stat"><span>TOTAL COST</span><strong>${practical.filledUnits ? `$${formatMoney(practical.totalCost)}` : "—"}</strong></div><div class="planner-stat"><span>ROUTE STOPS</span><strong>${practical.stopCount}</strong></div><div class="planner-stat"><span>ITEM UNITS</span><strong>${formatMoney(practical.filledUnits)}/${formatMoney(practical.requestedUnits)}</strong></div></div>
      <div class="route-verdict ${verdictClass}">${escapeHtml(verdict)}</div>
      <div class="route-progress${routeComplete ? " completed" : ""}">${escapeHtml(progressText)}</div>
      ${routeSteps ? `<div class="route-list">${routeSteps}</div>` : `<div class="planner-note warning">No stock-backed route was available.</div>`}
      <div class="planner-inline-actions"><button class="replan-button" type="button" data-action="replan-happy-jump">${planActionLabel}</button></div>
      ${routeDetailNotes ? `<details><summary>ROUTE DETAILS</summary><div style="display:grid;gap:6px;margin-top:7px">${routeDetailNotes}</div></details>` : ""}
      <details><summary>ABSOLUTE CHEAPEST COMPARISON</summary><div class="absolute-summary" style="margin-top:7px">${escapeHtml(absoluteText)}</div>${absoluteSteps ? `<div class="route-list" style="margin-top:7px">${absoluteSteps}</div>` : ""}</details>
    </section>`;
    });
    applyWorkspaceState(false);
    if (state.returnFocusPending) scheduleReturnRouteAnchor();

  }

  function orderPracticalRouteSteps(steps) {
    return (steps || []).slice().sort((a, b) => {
      const aOpened = state.openedRouteKeys.has(a.routeKey) ? 1 : 0;
      const bOpened = state.openedRouteKeys.has(b.routeKey) ? 1 : 0;
      return aOpened - bOpened;
    });
  }

  function multiRouteStepMarkup(step, index, capturedAt, options = {}) {
    const sourceLabel = step.source === "bazaar" ? "BAZAAR" : "ITEM MARKET";
    const sourceClass = step.source === "bazaar" ? "bazaar" : "";
    const opened = options.opened === true;
    const next = options.next === true;
    const lines = step.items.map(item => {
      const priceText = item.minUnitPrice === item.maxUnitPrice ? `$${formatMoney(item.minUnitPrice)} each` : `$${formatMoney(item.minUnitPrice)}–$${formatMoney(item.maxUnitPrice)} each`;
      const risk = item.stockRisk ? stockRiskMarkup(item, capturedAt, step.routeKey) : "";
      const adopted = item.backupAdopted === true ? `<span class="adopted-badge">BACKUP ADOPTED</span>` : "";
      return `<div class="route-item-line${item.backupAdopted === true ? " adopted" : ""}">${formatMoney(item.quantity)} × ${escapeHtml(item.itemName)}${adopted}</div><div class="route-item-meta">${priceText} · $${formatMoney(item.subtotal)}</div>${risk}`;
    }).join("");
    const freshness = step.source === "bazaar" ? formatLastSeen(step.updatedAt, capturedAt) : "TORN API STOCK";
    const href = safeRouteHref(step.href);
    const stopState = opened ? "VISITED " : next ? "NEXT · " : "";
    const className = `route-stop${opened ? " visited" : ""}${next ? " next" : ""}`;
    const routeKind = options.trackProgress ? "practical" : "comparison";
    const routeAttrs = step.source === "bazaar" ? ` data-route-key="${escapeAttribute(step.routeKey)}" data-route-kind="${routeKind}" data-bazaar-preflight="true"` : "";
    const quarantined = state.quarantinedRouteKeys.has(step.routeKey);
    const openLabel = quarantined ? "BLOCKED" : opened ? "OPEN AGAIN" : "OPEN";
    return `<article class="${className}${quarantined ? " quarantined" : ""}"><div class="route-stop-index">${opened ? "✓" : index + 1}</div><div class="route-stop-main"><div class="route-stop-source ${sourceClass}">${stopState}${sourceLabel} STOP</div>${lines}<div class="route-stop-total">STOP TOTAL $${formatMoney(step.subtotal)} · ${escapeHtml(freshness)}</div>${quarantined ? `<div class="stock-risk high">CLOSED BAZAAR BLOCKED FOR THIS SESSION</div>` : ""}</div>${href ? `<a class="route-open" href="${escapeAttribute(href)}"${routeAttrs}${quarantined ? ` aria-disabled="true"` : ""}>${openLabel}</a>` : ""}</article>`;
  }

  function stockRiskMarkup(item, capturedAt, sourceRouteKey) {
    const level = item.stockRiskLevel === "high" ? "high" : "";
    const available = Number.isFinite(item.availableStock) ? formatMoney(item.availableStock) : "unknown";
    const headroom = Number.isFinite(item.stockHeadroom) ? formatMoney(item.stockHeadroom) : "unknown";
    const label = item.stockRiskLevel === "high" ? "HIGH SELL-OUT RISK" : "LOW STOCK HEADROOM";
    let backup = "";

    if (item.backup?.step) {
      const backupRouteKey = String(item.backup.step.routeKey || "");
      const practicalRouteKeys = new Set((state.happyJumpPlan?.practical?.steps || []).map(step => String(step.routeKey || "")));
      const alreadyIncludedLater = backupRouteKey && backupRouteKey !== String(sourceRouteKey || "") && practicalRouteKeys.has(backupRouteKey);
      if (!alreadyIncludedLater) backup = backupOptionMarkup(item.backup, capturedAt, sourceRouteKey, item.itemId);
    }

    return `<div class="stock-risk ${level}">${label} · snapshot stock ${available} for ${formatMoney(item.quantity)} needed · headroom ${headroom}</div>${backup}`;
  }

  function backupOptionMarkup(backup, capturedAt, sourceRouteKey, sourceItemId) {
    const source = backup.step.source === "bazaar" ? "BAZAAR" : "ITEM MARKET";
    const freshness = backup.step.source === "bazaar" ? formatLastSeen(backup.step.updatedAt, capturedAt) : "TORN API STOCK";
    const href = safeRouteHref(backup.step.href);
    const delta = backup.extraCost > 0 ? ` · +$${formatMoney(backup.extraCost)}` : backup.extraCost < 0 ? ` · saves $${formatMoney(Math.abs(backup.extraCost))}` : " · same cost";
    const risk = backup.stockRiskCount ? " · backup also has limited stock headroom" : " · safer stock headroom";
    const routeKey = backup.step.routeKey || (backup.step.source === "bazaar" && routeStepUserId(backup.step) ? `bazaar:${routeStepUserId(backup.step)}` : "");
    const adoptionAttrs = routeKey ? ` data-backup-adopt="true" data-route-key="${escapeAttribute(routeKey)}" data-route-kind="backup" data-backup-for-route-key="${escapeAttribute(sourceRouteKey || "")}" data-backup-item-id="${escapeAttribute(sourceItemId || backup.itemId || "")}"` : "";
    const routeAttrs = backup.step.source === "bazaar" && routeKey ? ` data-bazaar-preflight="true"` : "";
    const quarantined = routeKey && state.quarantinedRouteKeys.has(routeKey);
    return `<div class="backup-option"><div class="backup-title">BACKUP OPTION · ${source}</div><div class="backup-meta">${formatMoney(backup.quantity)} × ${escapeHtml(backup.itemName)} · $${formatMoney(backup.totalCost)}${escapeHtml(delta)} · ${escapeHtml(freshness)}${escapeHtml(risk)}</div>${href ? `<a class="backup-open" href="${escapeAttribute(href)}"${adoptionAttrs}${routeAttrs}${quarantined ? ` aria-disabled="true"` : ""}>${quarantined ? "BLOCKED" : "ADOPT & OPEN BACKUP"}</a>` : ""}</div>`;
  }

  function handlePlannerResultClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const itemAdvisorLink = target.closest("a[data-item-advisor-open='true']");
    if (itemAdvisorLink) {
      event.preventDefault();
      const href = safeRouteHref(itemAdvisorLink.getAttribute("href"));
      const returnUrl = safeItemMarketReturnUrl(globalThis.location?.href || "");
      const sellerUserId = String(itemAdvisorLink.getAttribute("data-seller-id") || "");
      const itemId = String(itemAdvisorLink.getAttribute("data-item-id") || "");
      if (!href || !returnUrl || !/^\d+$/.test(sellerUserId) || !/^\d+$/.test(itemId)) {
        setStatus("The Bazaar destination or Item Market return route could not be verified.", "error");
        return;
      }
      persistItemAdvisorBazaarReturn({
        sellerUserId,
        itemId,
        returnUrl
      });
      globalThis.location.assign(href);
      return;
    }
    const replan = target.closest("button[data-action='replan-happy-jump']");
    if (replan) {
      event.preventDefault();
      if (isHappyJumpRouteComplete()) {
        state.quarantinedRouteKeys = new Set();
        state.quarantineReasons = {};
        state.lastQuarantineResult = null;
      }
      runHappyJumpPlanner();
      return;
    }

    const backupLink = target.closest("a[data-backup-adopt='true'][data-route-key]");
    if (backupLink) {
      event.preventDefault();
      const routeKey = String(backupLink.getAttribute("data-route-key") || "");
      const originalRouteKey = String(backupLink.getAttribute("data-backup-for-route-key") || "");
      const itemId = String(backupLink.getAttribute("data-backup-item-id") || "");
      if (!routeKey || !originalRouteKey || !itemId || state.quarantinedRouteKeys.has(routeKey)) {
        setStatus("That backup source cannot be adopted for this route.", "error");
        return;
      }
      const step = findRouteStep(routeKey, "backup", backupLink.getAttribute("href"));
      if (!step) {
        setStatus("The backup source could not be verified against the saved route.", "error");
        return;
      }
      const backupAdoption = { originalRouteKey, itemId, backupRouteKey: routeKey };
      if (step.source === "bazaar") {
        void openRouteStepWithPreflight(step, { triggerElement: backupLink, routeKind: "backup", backupAdoption });
      } else {
        const adoptedStep = adoptBackupStop(backupAdoption);
        const href = safeRouteHref(step.href);
        if (!adoptedStep || !href) {
          setStatus("The backup could not be adopted into the active route.", "error");
          return;
        }
        state.openedRouteKeys.add(adoptedStep.routeKey);
        state.activeWorkspace = WORKSPACE_HAPPY;
        state.activeRouteKey = adoptedStep.routeKey;
        state.returnFocusPending = true;
        persistHappyJumpSession();
        globalThis.location.assign(href);
      }
      return;
    }

    const link = target.closest("a[data-bazaar-preflight='true'][data-route-key]");
    if (!link) return;
    event.preventDefault();
    const routeKey = String(link.getAttribute("data-route-key") || "");
    const routeKind = String(link.getAttribute("data-route-kind") || "practical");
    if (!routeKey || state.quarantinedRouteKeys.has(routeKey)) {
      setStatus("That Bazaar is blocked for this route session.", "error");
      return;
    }
    const step = findRouteStep(routeKey, routeKind, link.getAttribute("href"));
    if (!step) {
      setStatus("The selected Bazaar route step could not be verified.", "error");
      return;
    }
    void openRouteStepWithPreflight(step, { triggerElement: link, routeKind });
  }


  function adoptBackupStop(adoption) {
    const practical = state.happyJumpPlan?.practical;
    if (!practical?.steps?.length || !adoption) return null;
    const originalRouteKey = String(adoption.originalRouteKey || "");
    const itemId = String(adoption.itemId || "");
    const backupRouteKey = String(adoption.backupRouteKey || "");
    if (!originalRouteKey || !itemId || !backupRouteKey || originalRouteKey === backupRouteKey) return null;

    const originalIndex = practical.steps.findIndex(step => String(step.routeKey || "") === originalRouteKey);
    if (originalIndex < 0) return null;
    const originalStep = practical.steps[originalIndex];
    const originalItemIndex = (originalStep.items || []).findIndex(item => String(item.itemId || "") === itemId);
    if (originalItemIndex < 0) return null;
    const originalItem = originalStep.items[originalItemIndex];
    const backup = originalItem?.backup;
    if (!backup?.step || String(backup.step.routeKey || "") !== backupRouteKey) return null;

    const backupStep = cloneRouteStep(backup.step);
    const backupItem = backupStep?.items?.find(item => String(item.itemId || "") === itemId) || backupStep?.items?.[0] || null;
    if (!backupStep || !backupItem) return null;
    backupItem.backup = null;
    backupItem.backupAdopted = true;
    backupItem.backupAdoptedFromRouteKey = originalRouteKey;
    backupItem.backupAdoptedAt = Date.now();

    originalStep.items.splice(originalItemIndex, 1);
    if (!originalStep.items.length) {
      practical.steps.splice(originalIndex, 1);
      state.openedRouteKeys.delete(originalRouteKey);
    } else {
      recalculateRouteStep(originalStep);
    }

    let destination = practical.steps.find(step => String(step.routeKey || "") === backupRouteKey) || null;
    if (!destination) {
      destination = backupStep;
      destination.items = [backupItem];
      recalculateRouteStep(destination);
      practical.steps.push(destination);
    } else {
      const existing = destination.items.find(item => String(item.itemId || "") === itemId) || null;
      if (existing) mergeAdoptedRouteItem(existing, backupItem);
      else destination.items.push(backupItem);
      recalculateRouteStep(destination);
    }

    // A previously visited destination must be revisited because it now contains
    // an additional adopted purchase allocation.
    state.openedRouteKeys.delete(backupRouteKey);
    state.activeRouteKey = backupRouteKey;
    recalculatePracticalRouteAfterAdoption(practical);
    practical.backupAdoptions = Array.isArray(practical.backupAdoptions) ? practical.backupAdoptions : [];
    practical.backupAdoptions.push({
      itemId,
      itemName: originalItem.itemName,
      quantity: originalItem.quantity,
      fromRouteKey: originalRouteKey,
      toRouteKey: backupRouteKey,
      previousCost: originalItem.subtotal,
      adoptedCost: backupItem.subtotal,
      extraCost: Number(backupItem.subtotal || 0) - Number(originalItem.subtotal || 0),
      adoptedAt: Date.now()
    });
    practical.backupAdoptionCount = practical.backupAdoptions.length;
    state.restoredRouteAt = null;
    state.returnFocusPending = true;
    renderHappyJumpPlan(state.happyJumpPlan);
    state.lastReport = buildHappyJumpReport(state.happyJumpPlan, state.happyJumpData || []);
    state.nodes.copy.disabled = false;
    state.nodes.download.disabled = false;
    persistHappyJumpSession();
    const delta = Number(backupItem.subtotal || 0) - Number(originalItem.subtotal || 0);
    setStatus(`Backup adopted for ${originalItem.itemName}. Route total updated${delta ? ` by ${delta > 0 ? "+" : "−"}$${formatMoney(Math.abs(delta))}` : " at the same cost"}.`, "warning");
    return destination;
  }

  function cloneRouteStep(step) {
    if (!step || typeof step !== "object") return null;
    try { return typeof structuredClone === "function" ? structuredClone(step) : JSON.parse(JSON.stringify(step)); }
    catch { return null; }
  }

  function mergeAdoptedRouteItem(target, addition) {
    target.quantity = Math.max(0, Number(target.quantity) || 0) + Math.max(0, Number(addition.quantity) || 0);
    target.subtotal = Math.max(0, Number(target.subtotal) || 0) + Math.max(0, Number(addition.subtotal) || 0);
    target.availableStock = Math.max(Math.max(0, Number(target.availableStock) || 0), Math.max(0, Number(addition.availableStock) || 0));
    target.minUnitPrice = Math.min(Number(target.minUnitPrice) || Infinity, Number(addition.minUnitPrice) || Infinity);
    target.maxUnitPrice = Math.max(Number(target.maxUnitPrice) || 0, Number(addition.maxUnitPrice) || 0);
    target.backup = null;
    target.backupAdopted = true;
    target.backupAdoptedFromRouteKey = addition.backupAdoptedFromRouteKey || target.backupAdoptedFromRouteKey || null;
    target.backupAdoptedAt = addition.backupAdoptedAt || Date.now();
  }

  function recalculateRouteStep(step) {
    if (!step) return step;
    step.items = (step.items || []).filter(item => Number(item.quantity) > 0);
    step.subtotal = step.items.reduce((sum, item) => sum + Math.max(0, Number(item.subtotal) || 0), 0);
    for (const item of step.items) {
      const risk = stockRiskForQuantity(item.quantity, item.availableStock, step.source);
      item.stockHeadroom = risk.headroom;
      item.stockReserveRequired = risk.reserveRequired;
      item.stockRisk = risk.risk;
      item.stockRiskLevel = risk.level;
      if (!item.stockRisk) item.backup = null;
    }
    step.stockRiskCount = step.items.filter(item => item.stockRisk).length;
    step.highStockRiskCount = step.items.filter(item => item.stockRiskLevel === "high").length;
    const firstItemId = step.items[0]?.itemId || null;
    step.href = step.source === "bazaar" ? bazaarDestinationForUserId(step.userId || routeStepUserId(step), firstItemId) : itemMarketDestination(firstItemId);
    return step;
  }

  function recalculatePracticalRouteAfterAdoption(practical) {
    if (!practical) return practical;
    practical.steps = (practical.steps || []).filter(step => step?.items?.length).map(recalculateRouteStep);
    practical.totalCost = practical.steps.reduce((sum, step) => sum + Math.max(0, Number(step.subtotal) || 0), 0);
    practical.stopCount = practical.steps.length;
    practical.selectedRouteKeys = practical.steps.map(step => step.routeKey);
    const requested = new Map((state.happyJumpPlan?.requestedItems || []).map(item => [String(item.itemId), item]));
    const totals = new Map();
    for (const step of practical.steps) {
      for (const item of step.items || []) {
        const key = String(item.itemId || "");
        if (!totals.has(key)) totals.set(key, { filledQuantity: 0, totalCost: 0 });
        const total = totals.get(key);
        total.filledQuantity += Math.max(0, Number(item.quantity) || 0);
        total.totalCost += Math.max(0, Number(item.subtotal) || 0);
      }
    }
    practical.itemTotals = [...requested.values()].map(item => {
      const key = String(item.itemId || "");
      const aggregate = totals.get(key) || { filledQuantity: 0, totalCost: 0 };
      const requestedQuantity = Math.max(0, Number(item.requestedQuantity ?? item.quantity) || 0);
      const filledQuantity = Math.min(requestedQuantity, aggregate.filledQuantity);
      return { ...item, requestedQuantity, filledQuantity, missingQuantity: Math.max(0, requestedQuantity - filledQuantity), totalCost: aggregate.totalCost };
    });
    practical.requestedUnits = practical.itemTotals.reduce((sum, item) => sum + item.requestedQuantity, 0);
    practical.filledUnits = practical.itemTotals.reduce((sum, item) => sum + item.filledQuantity, 0);
    practical.missingItems = practical.itemTotals.filter(item => item.missingQuantity > 0).map(item => ({ itemId: item.itemId, itemName: item.itemName, quantity: item.missingQuantity }));
    practical.complete = practical.missingItems.length === 0;
    practical.stockRiskItems = practical.steps.flatMap(step => step.items.filter(item => item.stockRisk).map(item => ({ routeKey: step.routeKey, source: step.source, itemId: item.itemId, itemName: item.itemName, quantity: item.quantity, availableStock: item.availableStock, stockHeadroom: item.stockHeadroom, stockRiskLevel: item.stockRiskLevel })));
    practical.stockRiskCount = practical.stockRiskItems.length;
    practical.highStockRiskCount = practical.stockRiskItems.filter(item => item.stockRiskLevel === "high").length;
    practical.backupCount = practical.steps.flatMap(step => step.items).filter(item => item.backup).length;
    practical.stockRiskGuardCost = Number.isFinite(practical.cheapestPracticalCost) ? Math.max(0, practical.totalCost - practical.cheapestPracticalCost) : Math.max(0, Number(practical.stockRiskGuardCost) || 0);
    practical.verificationRequired = practical.steps.some(step => step.source === "bazaar" && sourceFreshness(step.updatedAt, practical.capturedAt) !== "fresh");
    return practical;
  }

  function findRouteStep(routeKey, routeKind = "practical", fallbackHref = null) {
    const key = String(routeKey || "");
    if (!key) return null;
    const planOrder = routeKind === "comparison"
      ? [state.happyJumpPlan?.absolute, state.happyJumpPlan?.practical]
      : [state.happyJumpPlan?.practical, state.happyJumpPlan?.absolute];
    for (const route of planOrder) {
      const direct = route?.steps?.find(step => String(step.routeKey || "") === key);
      if (direct) return direct;
      for (const step of route?.steps || []) {
        for (const item of step.items || []) {
          const backup = item.backup?.step;
          if (backup && String(backup.routeKey || "") === key) return backup;
        }
      }
    }
    const href = safeRouteHref(fallbackHref);
    if (!href) return null;
    return { source: "bazaar", routeKey: key, href, items: [], subtotal: 0, updatedAt: null };
  }

  async function openRouteStepWithPreflight(step, options = {}) {
    if (!step || step.source !== "bazaar" || state.preflightBusy) return false;
    let routeKey = String(step.routeKey || "");
    let href = safeRouteHref(step.href);
    if (!routeKey || !href || state.quarantinedRouteKeys.has(routeKey)) return false;

    const token = ++state.preflightToken;
    state.preflightBusy = true;
    state.bazaarNavAlert = { type: "checking", text: "CHECKING BAZAAR…" };
    setRouteActionBusy(options.triggerElement, true);
    if (isBazaarPage()) syncBazaarRouteNavigation();
    else setStatus("Checking that the Bazaar is open before navigation…", "neutral");

    try {
      const result = await preflightBazaarStep(step);
      if (token !== state.preflightToken) return false;

      if (result.status === "insufficient") {
        clearRouteActionRetry(options.triggerElement);
        quarantineRouteStep(step, result.reason || "insufficient-stock-preflight");
        const details = state.lastQuarantineResult;
        const replacementText = details?.replacementRouteKey ? " · BACKUP ROUTE ADOPTED" : "";
        const progressText = details?.nextProgress ? ` · ${details.nextProgress}` : "";
        const itemText = result.itemName ? ` · ${result.itemName} ${result.availableQuantity}/${result.requiredQuantity}` : "";
        state.bazaarNavAlert = { type: "closed", text: `INSUFFICIENT STOCK BLOCKED${itemText}${replacementText}${progressText}` };
        if (isBazaarPage()) syncBazaarRouteNavigation();
        else setStatus(`Insufficient Bazaar stock blocked before navigation${itemText}.${replacementText}${progressText}`, "error");
        return false;
      }

      if (result.status === "closed") {
        clearRouteActionRetry(options.triggerElement);
        quarantineRouteStep(step, result.reason || "closed-preflight");
        const details = state.lastQuarantineResult;
        const replacementText = details?.replacementRouteKey ? " · BACKUP ROUTE ADOPTED" : "";
        const progressText = details?.nextProgress ? ` · ${details.nextProgress}` : "";
        state.bazaarNavAlert = { type: "closed", text: `CLOSED BAZAAR BLOCKED${replacementText}${progressText}` };
        if (isBazaarPage()) syncBazaarRouteNavigation();
        else {
          const seller = routeStepUserId(step);
          setStatus(`Closed Bazaar${seller ? ` ${seller}` : ""} blocked before navigation.${replacementText}${progressText}`, "error");
          state.host?.scrollIntoView({ block: "start", behavior: "smooth" });
        }
        return false;
      }

      if (result.status !== "open") {
        clearRouteActionRetry(options.triggerElement);
        state.bazaarNavAlert = { type: "warning", text: "BAZAAR NOT PRE-VERIFIED · LANDING CHECK ACTIVE" };
        if (isBazaarPage()) syncBazaarRouteNavigation();
        else setStatus("Bazaar could not be pre-verified. Opening with landing-page verification.", "neutral");
      } else {
        clearRouteActionRetry(options.triggerElement);
      }

      if (options.backupAdoption) {
        const adoptedStep = adoptBackupStop(options.backupAdoption);
        if (!adoptedStep) {
          markRouteActionRetry(options.triggerElement);
          state.bazaarNavAlert = { type: "warning", text: "BACKUP ADOPTION FAILED · RETRY CHECK" };
          setStatus("The Bazaar is open, but the backup could not be integrated. Navigation was blocked.", "error");
          return false;
        }
        step = adoptedStep;
        routeKey = String(adoptedStep.routeKey || routeKey);
        href = safeRouteHref(adoptedStep.href) || href;
      }

      state.activeWorkspace = WORKSPACE_HAPPY;
      state.activeRouteKey = routeKey;
      state.activeRouteKind = options.routeKind === "comparison" ? "comparison" : "practical";
      state.routeReturnUrl = safeItemMarketReturnUrl(globalThis.location?.href || "") || state.routeReturnUrl || itemMarketDestination(HAPPY_JUMP_ITEMS[0].itemId);
      state.returnFocusPending = true;
      state.bazaarNavAlert = null;
      persistHappyJumpSession();
      globalThis.location.assign(href);
      return true;
    } catch {
      if (token !== state.preflightToken) return false;
      clearRouteActionRetry(options.triggerElement);
      state.bazaarNavAlert = { type: "warning", text: "PREFLIGHT UNAVAILABLE · LANDING CHECK ACTIVE" };
      if (isBazaarPage()) syncBazaarRouteNavigation();
      else setStatus("Preflight unavailable. Opening with landing-page verification.", "neutral");

      state.activeWorkspace = WORKSPACE_HAPPY;
      state.activeRouteKey = routeKey;
      state.activeRouteKind = options.routeKind === "comparison" ? "comparison" : "practical";
      state.routeReturnUrl = safeItemMarketReturnUrl(globalThis.location?.href || "") || state.routeReturnUrl || itemMarketDestination(HAPPY_JUMP_ITEMS[0].itemId);
      state.returnFocusPending = true;
      persistHappyJumpSession();
      globalThis.location.assign(href);
      return true;
    } finally {
      if (token === state.preflightToken) {
        state.preflightBusy = false;
        setRouteActionBusy(options.triggerElement, false);
        if (isBazaarPage() && document.documentElement?.isConnected) syncBazaarRouteNavigation();
      }
    }
  }

  function setRouteActionBusy(element, busy) {
    if (!(element instanceof Element)) return;
    if (busy) {
      if (!element.dataset.ksmaOriginalText) {
        const visibleText = String(element.textContent || "OPEN").trim() || "OPEN";
        element.dataset.ksmaOriginalText = visibleText === "RETRY CHECK"
          ? (element.getAttribute("data-nav") === "next" ? "NEXT" : "OPEN")
          : visibleText;
      }
      element.textContent = "CHECKING…";
      element.setAttribute("aria-busy", "true");
      element.style.pointerEvents = "none";
      return;
    }
    const retry = element.dataset.ksmaRetryCheck === "true";
    element.textContent = retry ? "RETRY CHECK" : (element.dataset.ksmaOriginalText || element.textContent || "OPEN");
    delete element.dataset.ksmaOriginalText;
    element.removeAttribute("aria-busy");
    element.style.pointerEvents = "";
  }

  function markRouteActionRetry(element) {
    if (!(element instanceof Element)) return;
    element.dataset.ksmaRetryCheck = "true";
  }

  function clearRouteActionRetry(element) {
    if (!(element instanceof Element)) return;
    delete element.dataset.ksmaRetryCheck;
  }

  async function preflightBazaarStep(step) {
    const href = safeRouteHref(step?.href);
    const expectedUserId = routeStepUserId(step);
    const itemId = routeStepPrimaryItemId(step);
    const itemName = safeItemName(step?.items?.find?.(item => String(item?.itemId || "") === String(itemId))?.itemName || "");
    const apiKey = state.nodes?.apiKey?.value?.trim?.() || readString(API_KEY_STORAGE_KEY, "");
    if (!href || !expectedUserId || !itemId) {
      return { status: "unavailable", reason: "invalid-route-seller-or-item" };
    }

    let staticResult = { status: "ambiguous", reason: "static-check-skipped" };
    try {
      const response = await requestBazaarPreflightPage(href);
      staticResult = classifyBazaarPreflightText(response.text, response.status);
      if (staticResult.status === "closed") {
        noteBazaarVerification("static-html", staticResult, expectedUserId, itemId);
        return staticResult;
      }
    } catch {
      staticResult = { status: "ambiguous", reason: "static-request-failed" };
    }

    // Verify every item allocated to this Bazaar stop.
    let liveResult = { status: "unavailable", reason: "live-bazaar-data-failed" };
    try {
      const requiredItems = Array.isArray(step?.items) && step.items.length
        ? step.items
        : [{ itemId, itemName, quantity: 1 }];
      const verifiedItems = [];
      let unavailableResult = null;

      for (const requiredItem of requiredItems) {
        const requiredItemId = String(requiredItem?.itemId || "");
        const requiredName = safeItemName(requiredItem?.itemName || "");
        const requiredQuantity = Math.max(1, Math.trunc(Number(requiredItem?.quantity) || 1));
        const result = await verifyBazaarFromLiveData(expectedUserId, requiredItemId, requiredName);

        if (result.status === "closed") {
          noteBazaarVerification("torn-live-bazaar-data", result, expectedUserId, requiredItemId, staticResult);
          return result;
        }
        if (result.status !== "open") {
          unavailableResult = result;
          break;
        }

        const liveQuantity = Number(result.quantity);
        if (Number.isFinite(liveQuantity) && liveQuantity < requiredQuantity) {
          const insufficient = {
            status: "insufficient",
            reason: "live-bazaar-stock-insufficient",
            itemId: requiredItemId,
            itemName: requiredName,
            requiredQuantity,
            availableQuantity: Math.max(0, Math.trunc(liveQuantity))
          };
          noteBazaarVerification("torn-live-bazaar-data", insufficient, expectedUserId, requiredItemId, staticResult);
          return insufficient;
        }
        verifiedItems.push({ itemId: requiredItemId, requiredQuantity, availableQuantity: Number.isFinite(liveQuantity) ? Math.trunc(liveQuantity) : null });
      }

      if (!unavailableResult && verifiedItems.length === requiredItems.length) {
        liveResult = { status: "open", reason: "all-route-items-confirmed", verifiedItems };
        noteBazaarVerification("torn-live-bazaar-data", liveResult, expectedUserId, itemId, staticResult);
        return liveResult;
      }
      liveResult = unavailableResult || liveResult;
    } catch {
      liveResult = { status: "unavailable", reason: "live-bazaar-data-request-failed" };
    }

    // Official API sources may still provide a useful CLOSED signal. Their
    // positive OPEN state is cached and is deliberately not accepted as proof.
    let directoryResult = { status: "unavailable", reason: "directory-check-skipped" };
    let userResult = { status: "unavailable", reason: "user-bazaar-check-skipped" };

    if (apiKey) {
      try {
        directoryResult = await verifyBazaarFromOfficialDirectory(expectedUserId, itemId, apiKey);
        if (directoryResult.status === "closed") {
          noteBazaarVerification("torn-v2-market-bazaar-closed", directoryResult, expectedUserId, itemId, {
            staticResult,
            liveResult
          });
          return directoryResult;
        }
      } catch {}

      try {
        userResult = await verifyBazaarFromUserSelection(expectedUserId, itemId, apiKey);
        if (userResult.status === "closed") {
          noteBazaarVerification("torn-v1-user-bazaar-closed", userResult, expectedUserId, itemId, {
            staticResult,
            liveResult,
            directoryResult
          });
          return userResult;
        }
      } catch {}
    }

    const result = {
      status: "unavailable",
      reason: liveResult.reason || "no-live-open-proof"
    };
    noteBazaarVerification("fail-closed-unverified", result, expectedUserId, itemId, {
      staticResult,
      liveResult,
      directoryResult,
      userResult,
      cachedOpenSignalsIgnored: true
    });
    return result;
  }

  async function verifyBazaarFromLiveData(userId, itemId, itemName) {
    const payloadResult = await requestBazaarLiveData(userId, itemId, itemName);
    return classifyBazaarLiveData(payloadResult.payload, userId, itemId, itemName, payloadResult.url);
  }

  async function requestBazaarLiveData(userId, itemId, itemName) {
    const rfcv = readCookieValue("rfc_v");
    const origin = globalThis.location?.origin || "https://www.torn.com";
    const attempts = [
      { itemID: itemId, searchname: itemName || "", order: "default", start: "0" },
      { itemID: itemId, order: "default", start: "0" },
      { searchname: itemName || "", order: "default", start: "0" }
    ];

    let lastReason = "no-live-response";
    for (const params of attempts) {
      const url = new URL("/bazaar.php", origin);
      url.searchParams.set("sid", "bazaarData");
      url.searchParams.set("userId", String(userId));
      for (const [key, value] of Object.entries(params)) {
        if (value != null && String(value) !== "") url.searchParams.set(key, String(value));
      }
      if (rfcv) url.searchParams.set("rfcv", rfcv);
      url.searchParams.set("_ksma", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), BAZAAR_LIVE_DATA_TIMEOUT_MS);
      try {
        const response = await fetch(url.href, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
          signal: controller?.signal,
          headers: {
            Accept: "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest"
          }
        });
        const raw = await response.text();
        if (!response.ok) {
          lastReason = `live-http-${response.status || "error"}`;
          continue;
        }
        let payload = null;
        try { payload = JSON.parse(raw); } catch {
          lastReason = "live-non-json-response";
          continue;
        }
        return { payload, url: response.url || url.href };
      } catch (error) {
        lastReason = String(error?.name || "live-request-error");
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(lastReason);
  }

  function classifyBazaarLiveData(payload, expectedUserId, itemId, itemName, finalUrl = "") {
    if (!payload || typeof payload !== "object") {
      return { status: "unavailable", reason: "live-payload-missing" };
    }

    const flattened = normalizeText(JSON.stringify(payload));
    if (BAZAAR_CLOSED_PATTERNS.some(pattern => pattern.test(flattened))) {
      return { status: "closed", reason: "live-bazaar-data-closed" };
    }
    if (BAZAAR_BLOCKED_PATTERNS.some(pattern => pattern.test(flattened))) {
      return { status: "unavailable", reason: "live-bazaar-data-blocked" };
    }

    const expectedId = String(itemId || "");
    const wantedName = normalizeText(itemName || "").toLowerCase();
    const arrays = collectArrayCandidates(payload);
    let sawBazaarList = false;

    for (const array of arrays) {
      if (!Array.isArray(array)) continue;
      if (array === payload.list || array === payload.items || array === payload.bazaar) sawBazaarList = true;

      for (const record of array) {
        if (!record || typeof record !== "object" || Array.isArray(record)) continue;
        const recordItemId = idFromKeys(record, ["itemID", "itemId", "item_id", "ID"]);
        const recordName = normalizeText(record.name || record.itemName || record.item_name || "").toLowerCase();
        const price = numberFromKeys(record, ["price", "cost", "unitPrice", "unit_price"]);
        const quantity = numberFromKeys(record, ["quantity", "qty", "stock", "available"]);

        const idMatches = recordItemId === expectedId;
        const nameMatches = Boolean(wantedName && recordName === wantedName);
        if ((idMatches || nameMatches) && Number.isFinite(price) && price > 0) {
          return {
            status: "open",
            reason: "live-bazaar-item-confirmed",
            price,
            quantity: Number.isFinite(quantity) ? quantity : null,
            expectedUserId: String(expectedUserId || ""),
            finalUrl: String(finalUrl || "")
          };
        }
      }
    }

    const explicitOpen = payload.is_open === true
      || payload.isOpen === true
      || payload.bazaar_is_open === true
      || payload.open === true;

    if (explicitOpen) {
      return { status: "unavailable", reason: "live-open-without-target-item" };
    }
    if (sawBazaarList) {
      return { status: "unavailable", reason: "target-item-not-in-live-bazaar-data" };
    }
    return { status: "unavailable", reason: "live-bazaar-data-unrecognized" };
  }

  function readCookieValue(name) {
    const wanted = `${String(name || "")}=`;
    for (const part of String(document.cookie || "").split(";")) {
      const value = part.trim();
      if (!value.startsWith(wanted)) continue;
      try { return decodeURIComponent(value.slice(wanted.length)); }
      catch { return value.slice(wanted.length); }
    }
    return null;
  }

  function noteBazaarVerification(method, result, userId, itemId, extra = null) {
    state.lastBazaarVerification = {
      method,
      status: result?.status || "unavailable",
      reason: result?.reason || "unknown",
      userId: String(userId || ""),
      itemId: String(itemId || ""),
      checkedAt: new Date().toISOString(),
      extra
    };
  }

  function routeStepPrimaryItemId(step) {
    const fromItems = String(step?.items?.[0]?.itemId || "");
    if (/^\d+$/.test(fromItems)) return fromItems;
    try {
      const url = new URL(String(step?.href || ""), globalThis.location.href);
      const value = url.searchParams.get("itemID") || url.searchParams.get("itemId");
      return /^\d+$/.test(String(value || "")) ? String(value) : null;
    } catch {
      return null;
    }
  }

  async function verifyBazaarFromOfficialDirectory(userId, itemId, apiKey) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), BAZAAR_OFFICIAL_VERIFY_TIMEOUT_MS);
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const url = `${API_BASE_URL}/market/${encodeURIComponent(itemId)}/bazaar?key=${encodeURIComponent(apiKey)}&timestamp=${timestamp}`;
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        signal: controller?.signal,
        headers: { Accept: "application/json" }
      });
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok || payload?.error) {
        return { status: "unavailable", reason: `directory-http-${response.status || "error"}` };
      }
      const entries = Array.isArray(payload?.bazaar?.specialized)
        ? payload.bazaar.specialized
        : [];
      const match = entries.find(entry => String(entry?.id || "") === String(userId));
      if (!match) return { status: "unavailable", reason: "seller-not-in-item-directory" };
      if (match.is_open === false) return { status: "closed", reason: "official-directory-closed" };
      if (match.is_open === true) return { status: "open", reason: "official-directory-open" };
      return { status: "unavailable", reason: "directory-open-state-missing" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function verifyBazaarFromUserSelection(userId, itemId, apiKey) {
    const payload = await fetchUserBazaarSelection(userId, apiKey);
    if (payload?.bazaar_is_open === false) {
      return { status: "closed", reason: "user-bazaar-status-closed" };
    }
    if (payload?.bazaar_is_open !== true) {
      return { status: "unavailable", reason: "user-bazaar-open-state-missing" };
    }

    const itemEvidence = normalizeOwnBazaarSnapshot(payload, itemId, {
      forcedUserId: userId,
      source: "seller-user-bazaar"
    });
    if (itemEvidence.length) return { status: "open", reason: "user-bazaar-open-with-item" };

    // The status selection is globally cached, but a positive open flag is still
    // a useful PDA fallback when the live page probe is unavailable.
    return { status: "open", reason: "user-bazaar-open-status" };
  }

  async function fetchUserBazaarSelection(userId, apiKey) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), BAZAAR_OFFICIAL_VERIFY_TIMEOUT_MS);
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const idPart = /^\d+$/.test(String(userId || "")) ? `/${encodeURIComponent(userId)}` : "/";
      const url = `${TORN_API_V1_USER_URL}${idPart}?selections=basic,bazaar&key=${encodeURIComponent(apiKey)}&timestamp=${timestamp}`;
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        signal: controller?.signal,
        headers: { Accept: "application/json" }
      });
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok || payload?.error) {
        const reason = payload?.error?.error || payload?.error?.message || `HTTP ${response.status || "error"}`;
        throw new Error(String(reason).slice(0, 160));
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchOwnBazaarSnapshot(apiKey) {
    return fetchUserBazaarSelection(null, apiKey);
  }

  async function requestBazaarPreflightPage(href) {
    let fetchError = null;
    if (typeof fetch === "function") {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), BAZAAR_HTML_PREFLIGHT_TIMEOUT_MS);
      try {
        const response = await fetch(href, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
          signal: controller?.signal
        });
        const text = await response.text();
        clearTimeout(timer);
        return { status: response.status, text, finalUrl: response.url || href };
      } catch (error) {
        clearTimeout(timer);
        fetchError = error;
      }
    }

    const request = globalThis.GM?.xmlHttpRequest || globalThis.GM_xmlhttpRequest;
    if (!request) throw fetchError || new Error("Bazaar preflight request unavailable.");
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      try {
        request({
          method: "GET",
          url: href,
          timeout: BAZAAR_HTML_PREFLIGHT_TIMEOUT_MS,
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
          onload: response => finish(resolve, { status: Number(response?.status) || 0, text: String(response?.responseText || ""), finalUrl: String(response?.finalUrl || href) }),
          onerror: () => finish(reject, fetchError || new Error("Bazaar preflight network error.")),
          ontimeout: () => finish(reject, new Error("Bazaar preflight timed out."))
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function classifyBazaarPreflightText(value, httpStatus = 200) {
    const raw = String(value || "");
    const status = Number(httpStatus) || 0;
    const normalized = raw
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (BAZAAR_CLOSED_PATTERNS.some(pattern => pattern.test(normalized))) return { status: "closed", reason: "closed-marker" };
    if (status < 200 || status >= 400) return { status: "unavailable", reason: `http-${status || "error"}` };
    if (BAZAAR_BLOCKED_PATTERNS.some(pattern => pattern.test(normalized))) return { status: "unavailable", reason: "blocked-or-challenge" };
    if (raw.length < 200) return { status: "unavailable", reason: "empty-response" };
    return { status: "ambiguous", reason: "no-positive-open-proof" };
  }

  function documentShowsClosedBazaar() {
    if (!isBazaarPage()) return false;
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim();
    return BAZAAR_CLOSED_PATTERNS.some(pattern => pattern.test(text));
  }

  function quarantineRouteStep(step, reason = "closed") {
    const routeKey = String(step?.routeKey || "");
    if (!routeKey) return false;

    const previousRouteKeys = new Set((state.happyJumpPlan?.practical?.steps || []).map(entry => String(entry.routeKey || "")));
    state.quarantinedRouteKeys.add(routeKey);
    state.quarantineReasons[routeKey] = String(reason || "closed");
    state.openedRouteKeys.delete(routeKey);
    if (state.activeRouteKey === routeKey && !isBazaarPage()) state.activeRouteKey = null;

    const rebuilt = rebuildHappyJumpPlanFromStoredData();
    if (!rebuilt && state.happyJumpPlan) renderHappyJumpPlan(state.happyJumpPlan, { restored: true });

    const currentSteps = state.happyJumpPlan?.practical?.steps || [];
    const replacement = currentSteps.find(entry => {
      const key = String(entry.routeKey || "");
      return key && key !== routeKey && !previousRouteKeys.has(key);
    }) || null;
    const next = currentSteps.find(entry =>
      !state.openedRouteKeys.has(String(entry.routeKey || ""))
      && !state.quarantinedRouteKeys.has(String(entry.routeKey || ""))
    ) || null;
    const nextIndex = next ? currentSteps.findIndex(entry => String(entry.routeKey || "") === String(next.routeKey || "")) : -1;

    state.lastQuarantineResult = {
      routeKey,
      userId: routeStepUserId(step),
      reason: String(reason || "closed"),
      rebuilt,
      replacementRouteKey: replacement?.routeKey || null,
      nextRouteKey: next?.routeKey || null,
      nextProgress: nextIndex >= 0 ? `NEXT HJ ${nextIndex + 1}/${currentSteps.length}` : (currentSteps.length ? "ROUTE COMPLETE" : "NO ROUTE AVAILABLE"),
      quarantinedCount: state.quarantinedRouteKeys.size,
      detectedAt: new Date().toISOString()
    };
    if (state.happyJumpPlan && state.happyJumpData) {
      state.lastReport = buildHappyJumpReport(
        state.happyJumpPlan,
        filterHappyJumpDataForQuarantine(state.happyJumpData, state.quarantinedRouteKeys)
      );
    }
    persistHappyJumpSession();
    return rebuilt;
  }

  function rebuildHappyJumpPlanFromStoredData() {
    const sourceData = filterHappyJumpDataForQuarantine(state.happyJumpData, state.quarantinedRouteKeys);
    if (!sourceData.length) return false;
    const plan = buildHappyJumpRoutePlan(sourceData, { maxPracticalStops: PRACTICAL_MAX_STOPS, candidateLimit: PRACTICAL_CANDIDATE_LIMIT });
    state.happyJumpPlan = plan;
    state.happyJumpData = normalizeStoredHappyJumpData(state.happyJumpData);
    state.openedRouteKeys = new Set([...state.openedRouteKeys].filter(key => !state.quarantinedRouteKeys.has(key) && plan.practical.steps.some(step => step.routeKey === key)));
    state.activeWorkspace = WORKSPACE_HAPPY;
    state.restoredRouteAt = Date.now();
    if (state.nodes) {
      renderHappyJumpPlan(plan, { restored: true });
      state.lastReport = buildHappyJumpReport(plan, sourceData);
      state.nodes.copy.disabled = false;
      state.nodes.download.disabled = false;
    }
    return true;
  }


  function filterHappyJumpDataForQuarantine(itemData, quarantinedKeys = new Set()) {
    const blocked = quarantinedKeys instanceof Set ? quarantinedKeys : new Set(quarantinedKeys || []);
    return normalizeStoredHappyJumpData(itemData).map(item => ({
      ...item,
      bazaarListings: item.bazaarListings.filter(listing => !blocked.has(`bazaar:${listing.userId}`))
    }));
  }

  function normalizeStoredHappyJumpData(itemData) {
    const allowed = new Map(HAPPY_JUMP_ITEMS.map(item => [item.itemId, item.itemName]));
    const normalized = [];
    for (const item of itemData || []) {
      const itemId = String(item?.itemId || "");
      if (!allowed.has(itemId)) continue;
      const requestedQuantity = normalizePlannerQuantity(item?.requestedQuantity, true);
      if (!requestedQuantity) continue;
      const bazaarListings = (item?.bazaarListings || []).map((listing, index) => {
        const userId = String(listing?.userId || "");
        const price = Number(listing?.price);
        const stock = Math.trunc(Number(listing?.stock));
        const updatedAt = Number(listing?.updatedAt);
        if (!/^\d+$/.test(userId) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(stock) || stock <= 0) return null;
        return { kind: "bazaar", itemId, price, stock, userId, updatedAt: Number.isFinite(updatedAt) ? updatedAt : null, sourceIndex: Number.isFinite(Number(listing?.sourceIndex)) ? Number(listing.sourceIndex) : index };
      }).filter(Boolean);
      const itemMarketListings = (item?.itemMarketListings || []).map((listing, index) => {
        const price = Number(listing?.price);
        const stock = Math.trunc(Number(listing?.stock));
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(stock) || stock <= 0) return null;
        return { kind: "itemmarket", itemId, price, stock, sourceIndex: Number.isFinite(Number(listing?.sourceIndex)) ? Number(listing.sourceIndex) : index };
      }).filter(Boolean);
      normalized.push({
        itemId,
        itemName: safeItemName(item?.itemName || allowed.get(itemId)) || allowed.get(itemId),
        requestedQuantity,
        capturedAt: Number(item?.capturedAt) || Date.now(),
        bazaarListings,
        itemMarketListings
      });
    }
    return normalized;
  }

  function safeRouteHref(value) {
    try {
      const url = new URL(String(value || ""), "https://www.torn.com/");
      if (!/^https?:$/.test(url.protocol)) return null;
      if (!/(^|\.)torn\.com$/i.test(url.hostname)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function normalizePlannerQuantity(value, allowZero = false) {
    const parsed = Math.trunc(Number(String(value ?? "").replace(/[^0-9]/g, "")));
    if (!Number.isFinite(parsed)) return allowZero ? 0 : 1;
    if (allowZero && parsed <= 0) return 0;
    if (!allowZero && parsed < 1) return 1;
    return Math.min(parsed, MAX_PLANNER_QUANTITY);
  }

  function multiItemOffers(itemData) {
    const offers = [];
    for (const item of itemData || []) {
      const quantity = normalizePlannerQuantity(item.requestedQuantity, true);
      if (!quantity) continue;
      for (const listing of item.bazaarListings || []) {
        const stock = Math.trunc(Number(listing.stock));
        if (!/^\d+$/.test(String(listing.userId || "")) || !Number.isFinite(listing.price) || listing.price <= 0 || !Number.isFinite(stock) || stock <= 0) continue;
        offers.push({
          routeKey: `bazaar:${listing.userId}`,
          source: "bazaar",
          userId: String(listing.userId),
          itemId: String(item.itemId),
          itemName: item.itemName,
          price: Number(listing.price),
          stock,
          updatedAt: listing.updatedAt || null
        });
      }
      for (const listing of item.itemMarketListings || []) {
        const stock = Math.trunc(Number(listing.stock));
        if (!Number.isFinite(listing.price) || listing.price <= 0 || !Number.isFinite(stock) || stock <= 0) continue;
        offers.push({
          routeKey: `itemmarket:${item.itemId}`,
          source: "itemmarket",
          userId: null,
          itemId: String(item.itemId),
          itemName: item.itemName,
          price: Number(listing.price),
          stock,
          updatedAt: null
        });
      }
    }
    return offers.sort((a, b) => a.price - b.price || b.stock - a.stock || a.routeKey.localeCompare(b.routeKey));
  }

  function requestedItemsFromData(itemData) {
    return (itemData || []).map(item => ({
      itemId: String(item.itemId),
      itemName: item.itemName,
      requestedQuantity: normalizePlannerQuantity(item.requestedQuantity, true)
    })).filter(item => item.requestedQuantity > 0);
  }

  function allocateItemFromOffers(item, itemOffers, options = {}) {
    const greedyAllocations = [];
    let remaining = item.requestedQuantity;
    let greedyCost = 0;
    for (const offer of itemOffers) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, offer.stock);
      if (quantity <= 0) continue;
      const subtotal = quantity * offer.price;
      greedyAllocations.push({ ...offer, quantity, subtotal });
      remaining -= quantity;
      greedyCost += subtotal;
    }
    const greedy = { allocations: greedyAllocations, remaining, totalCost: greedyCost };
    if (!options.riskAware || remaining > 0 || !greedyAllocations.length) return greedy;

    const greedySteps = groupRouteAllocations(greedyAllocations);
    const greedyHasStockRisk = greedySteps.some(step => step.items.some(entry => entry.stockRisk));
    if (!greedyHasStockRisk) return greedy;

    const safeCandidates = itemOffers.filter(offer => {
      if (offer.stock < item.requestedQuantity) return false;
      return !stockRiskForQuantity(item.requestedQuantity, offer.stock, offer.source).risk;
    }).map(offer => ({
      offer,
      totalCost: item.requestedQuantity * offer.price
    })).sort((a, b) => a.totalCost - b.totalCost || b.offer.stock - a.offer.stock);
    if (!safeCandidates.length) return greedy;

    const safe = safeCandidates[0];
    const riskAvoidanceThreshold = Math.max(50000, Math.round(greedyCost * 0.005));
    if (safe.totalCost > greedyCost + riskAvoidanceThreshold) return greedy;
    return {
      allocations: [{ ...safe.offer, quantity: item.requestedQuantity, subtotal: safe.totalCost }],
      remaining: 0,
      totalCost: safe.totalCost,
      riskAvoidanceCost: Math.max(0, safe.totalCost - greedyCost)
    };
  }

  function evaluateRouteSubset(itemData, selectedRouteKeys = null, options = {}) {
    const requestedItems = requestedItemsFromData(itemData);
    const selected = selectedRouteKeys ? new Set(selectedRouteKeys) : null;
    const offers = multiItemOffers(itemData).filter(offer => !selected || selected.has(offer.routeKey));
    const allocations = [];
    const itemTotals = [];
    let totalCost = 0;
    let requestedUnits = 0;
    let filledUnits = 0;
    let riskAvoidanceCost = 0;

    for (const item of requestedItems) {
      const itemOffers = offers.filter(offer => offer.itemId === item.itemId).sort((a, b) => a.price - b.price || b.stock - a.stock);
      const allocation = allocateItemFromOffers(item, itemOffers, options);
      allocations.push(...allocation.allocations);
      const filledQuantity = item.requestedQuantity - allocation.remaining;
      requestedUnits += item.requestedQuantity;
      filledUnits += filledQuantity;
      totalCost += allocation.totalCost;
      riskAvoidanceCost += allocation.riskAvoidanceCost || 0;
      itemTotals.push({ ...item, filledQuantity, missingQuantity: allocation.remaining, totalCost: allocation.totalCost });
    }

    const steps = groupRouteAllocations(allocations);
    const capturedAt = Date.now();
    const missingItems = itemTotals.filter(item => item.missingQuantity > 0).map(item => ({ itemId: item.itemId, itemName: item.itemName, quantity: item.missingQuantity }));
    const stockRiskItems = steps.flatMap(step => step.items.filter(item => item.stockRisk).map(item => ({ routeKey: step.routeKey, source: step.source, itemId: item.itemId, itemName: item.itemName, quantity: item.quantity, availableStock: item.availableStock, stockHeadroom: item.stockHeadroom, stockRiskLevel: item.stockRiskLevel })));
    const stockRiskCount = stockRiskItems.length;
    const highStockRiskCount = stockRiskItems.filter(item => item.stockRiskLevel === "high").length;
    return {
      complete: missingItems.length === 0,
      totalCost,
      requestedUnits,
      filledUnits,
      stopCount: steps.length,
      selectedRouteKeys: selected ? [...selected] : [...new Set(allocations.map(entry => entry.routeKey))],
      steps,
      itemTotals,
      missingItems,
      stockRiskItems,
      stockRiskCount,
      highStockRiskCount,
      riskAvoidanceCost,
      verificationRequired: steps.some(step => step.source === "bazaar" && sourceFreshness(step.updatedAt, capturedAt) !== "fresh"),
      capturedAt
    };
  }

  function stockRiskForQuantity(quantity, availableStock, source = "bazaar") {
    const required = Math.max(0, Math.trunc(Number(quantity) || 0));
    const available = Math.max(0, Math.trunc(Number(availableStock) || 0));
    if (source !== "bazaar" || required <= 0) return { risk: false, level: "none", headroom: Math.max(0, available - required), reserveRequired: 0 };
    const headroom = Math.max(0, available - required);
    const reserveRequired = Math.max(STOCK_RISK_MIN_HEADROOM, Math.ceil(required * STOCK_RISK_HEADROOM_RATIO));
    if (available <= required) return { risk: true, level: "high", headroom, reserveRequired };
    if (headroom < reserveRequired) return { risk: true, level: "warning", headroom, reserveRequired };
    return { risk: false, level: "none", headroom, reserveRequired };
  }

  function groupRouteAllocations(allocations) {
    const groups = new Map();
    for (const allocation of allocations || []) {
      if (!groups.has(allocation.routeKey)) groups.set(allocation.routeKey, {
        routeKey: allocation.routeKey,
        source: allocation.source,
        userId: allocation.userId || null,
        subtotal: 0,
        updatedAt: allocation.updatedAt || null,
        itemMap: new Map()
      });
      const group = groups.get(allocation.routeKey);
      group.subtotal += allocation.subtotal;
      if (allocation.updatedAt && (!group.updatedAt || Number(allocation.updatedAt) < Number(group.updatedAt))) group.updatedAt = allocation.updatedAt;
      if (!group.itemMap.has(allocation.itemId)) group.itemMap.set(allocation.itemId, {
        itemId: allocation.itemId,
        itemName: allocation.itemName,
        quantity: 0,
        availableStock: 0,
        subtotal: 0,
        minUnitPrice: allocation.price,
        maxUnitPrice: allocation.price
      });
      const item = group.itemMap.get(allocation.itemId);
      item.quantity += allocation.quantity;
      item.availableStock += Math.max(0, Number(allocation.stock) || 0);
      item.subtotal += allocation.subtotal;
      item.minUnitPrice = Math.min(item.minUnitPrice, allocation.price);
      item.maxUnitPrice = Math.max(item.maxUnitPrice, allocation.price);
    }
    return [...groups.values()].map(group => {
      const items = [...group.itemMap.values()].map(item => {
        const risk = stockRiskForQuantity(item.quantity, item.availableStock, group.source);
        return {
          ...item,
          stockHeadroom: risk.headroom,
          stockReserveRequired: risk.reserveRequired,
          stockRisk: risk.risk,
          stockRiskLevel: risk.level,
          backup: null
        };
      }).sort((a, b) => a.itemName.localeCompare(b.itemName));
      const firstItemId = items[0]?.itemId || null;
      return {
        routeKey: group.routeKey,
        source: group.source,
        userId: group.userId,
        subtotal: group.subtotal,
        updatedAt: group.updatedAt,
        items,
        stockRiskCount: items.filter(item => item.stockRisk).length,
        highStockRiskCount: items.filter(item => item.stockRiskLevel === "high").length,
        href: group.source === "bazaar" ? bazaarDestinationForUserId(group.userId, firstItemId) : itemMarketDestination(firstItemId)
      };
    }).sort((a, b) => a.source === b.source ? a.subtotal - b.subtotal : a.source === "bazaar" ? -1 : 1);
  }

  function buildAbsoluteMultiItemPlan(itemData) {
    return evaluateRouteSubset(itemData, null, { riskAware: false });
  }

  function practicalRouteCandidates(itemData, candidateLimit = PRACTICAL_CANDIDATE_LIMIT) {
    const requested = requestedItemsFromData(itemData);
    const offers = multiItemOffers(itemData);
    const routeStats = new Map();
    const cheapestByItem = new Map();
    for (const item of requested) {
      const best = offers.filter(offer => offer.itemId === item.itemId).sort((a, b) => a.price - b.price)[0];
      if (best) cheapestByItem.set(item.itemId, best.price);
    }
    for (const offer of offers) {
      if (!routeStats.has(offer.routeKey)) routeStats.set(offer.routeKey, { routeKey: offer.routeKey, source: offer.source, itemIds: new Set(), score: 0, bestPrices: new Map() });
      const stat = routeStats.get(offer.routeKey);
      stat.itemIds.add(offer.itemId);
      const previous = stat.bestPrices.get(offer.itemId);
      if (!Number.isFinite(previous) || offer.price < previous) stat.bestPrices.set(offer.itemId, offer.price);
    }
    for (const stat of routeStats.values()) {
      const coverage = stat.itemIds.size;
      let ratio = 0;
      for (const [itemId, price] of stat.bestPrices) {
        const cheapest = cheapestByItem.get(itemId) || price;
        ratio += price / cheapest;
      }
      stat.score = coverage * 1000 - ratio * 20 + (stat.source === "bazaar" ? 5 : 0);
    }
    const mustInclude = new Set();
    for (const item of requested) {
      const itemOffers = offers.filter(offer => offer.itemId === item.itemId);
      const cheapestOffers = itemOffers.slice().sort((a, b) => a.price - b.price || b.stock - a.stock);
      const largestStockOffers = itemOffers.slice().sort((a, b) => b.stock - a.stock || a.price - b.price);
      for (const offer of cheapestOffers.slice(0, 8)) mustInclude.add(offer.routeKey);
      for (const offer of largestStockOffers.slice(0, 8)) mustInclude.add(offer.routeKey);
      mustInclude.add(`itemmarket:${item.itemId}`);
    }
    const ranked = [...routeStats.values()].sort((a, b) => b.score - a.score || a.routeKey.localeCompare(b.routeKey)).map(stat => stat.routeKey);
    const candidates = [...mustInclude, ...ranked].filter((key, index, array) => array.indexOf(key) === index).slice(0, Math.max(candidateLimit, mustInclude.size));
    return candidates;
  }

  function combinations(values, size, start = 0, prefix = [], output = []) {
    if (prefix.length === size) { output.push(prefix.slice()); return output; }
    for (let index = start; index <= values.length - (size - prefix.length); index += 1) {
      prefix.push(values[index]);
      combinations(values, size, index + 1, prefix, output);
      prefix.pop();
    }
    return output;
  }

  function buildHappyJumpRoutePlan(itemData, options = {}) {
    const maxPracticalStops = Math.max(1, Math.min(4, Number(options.maxPracticalStops) || PRACTICAL_MAX_STOPS));
    const candidateLimit = Math.max(8, Math.min(32, Number(options.candidateLimit) || PRACTICAL_CANDIDATE_LIMIT));
    const absolute = buildAbsoluteMultiItemPlan(itemData);
    const candidateKeys = practicalRouteCandidates(itemData, candidateLimit);
    const completeCandidates = [];
    let bestPartial = null;

    for (let size = 1; size <= Math.min(maxPracticalStops, candidateKeys.length); size += 1) {
      for (const subset of combinations(candidateKeys, size)) {
        const plan = evaluateRouteSubset(itemData, subset, { riskAware: true });
        if (plan.complete) completeCandidates.push(plan);
        else if (!bestPartial || plan.filledUnits > bestPartial.filledUnits || (plan.filledUnits === bestPartial.filledUnits && plan.highStockRiskCount < bestPartial.highStockRiskCount) || (plan.filledUnits === bestPartial.filledUnits && plan.highStockRiskCount === bestPartial.highStockRiskCount && plan.totalCost < bestPartial.totalCost)) bestPartial = plan;
      }
    }

    let practical;
    if (completeCandidates.length) {
      const cheapestPractical = completeCandidates.slice().sort((a, b) => a.totalCost - b.totalCost || a.stopCount - b.stopCount)[0];
      const hasLargeQuantity = requestedItemsFromData(itemData).some(item => item.requestedQuantity >= 20);
      const convenienceThreshold = hasLargeQuantity
        ? Math.max(150000, Math.round(cheapestPractical.totalCost * 0.03))
        : Math.max(50000, Math.round(cheapestPractical.totalCost * 0.005));
      const affordableCandidates = completeCandidates.filter(plan => plan.totalCost <= cheapestPractical.totalCost + convenienceThreshold);
      practical = affordableCandidates.sort((a, b) =>
        (hasLargeQuantity ? a.stopCount - b.stopCount : 0) ||
        a.highStockRiskCount - b.highStockRiskCount ||
        a.stockRiskCount - b.stockRiskCount ||
        a.stopCount - b.stopCount ||
        a.totalCost - b.totalCost
      )[0];
      practical.cheapestPracticalCost = cheapestPractical.totalCost;
      practical.convenienceThreshold = convenienceThreshold;
      practical.stockRiskGuardCost = Math.max(0, practical.totalCost - cheapestPractical.totalCost);
    } else if (absolute.complete) {
      practical = bestPartial || {
        ...absolute,
        complete: false,
        steps: [],
        stopCount: 0,
        filledUnits: 0,
        totalCost: 0,
        missingItems: requestedItemsFromData(itemData).map(item => ({
          itemId: item.itemId,
          itemName: item.itemName,
          quantity: item.requestedQuantity
        }))
      };
      practical.routeCapBlocked = true;
      practical.cheapestPracticalCost = absolute.totalCost;
      practical.convenienceThreshold = null;
      practical.stockRiskGuardCost = 0;
    } else {
      practical = bestPartial || absolute;
      practical.cheapestPracticalCost = null;
      practical.convenienceThreshold = null;
      practical.stockRiskGuardCost = 0;
    }

    attachBackupOptions(practical, itemData);
    return {
      preset: "HAPPY_JUMP",
      requestedItems: requestedItemsFromData(itemData),
      practical,
      absolute,
      candidateRouteCount: candidateKeys.length,
      maxPracticalStops
    };
  }

  function attachBackupOptions(routePlan, itemData) {
    if (!routePlan?.steps?.length) return routePlan;
    let backupCount = 0;
    for (const step of routePlan.steps) {
      for (const item of step.items) {
        if (!item.stockRisk) continue;
        item.backup = findBackupOptionForRiskItem(itemData, item, step.routeKey);
        if (item.backup) backupCount += 1;
      }
    }
    routePlan.backupCount = backupCount;
    return routePlan;
  }

  function findBackupOptionForRiskItem(itemData, routeItem, excludedRouteKey) {
    const itemId = String(routeItem?.itemId || "");
    const quantity = normalizePlannerQuantity(routeItem?.quantity, true);
    if (!itemId || quantity <= 0) return null;
    const sourceItem = (itemData || []).find(item => String(item.itemId) === itemId);
    if (!sourceItem) return null;
    const oneItemData = [{ ...sourceItem, requestedQuantity: quantity }];
    const routeKeys = [...new Set(multiItemOffers(oneItemData).map(offer => offer.routeKey))].filter(key => key !== excludedRouteKey);
    const candidates = [];
    for (const routeKey of routeKeys) {
      const candidate = evaluateRouteSubset(oneItemData, [routeKey], { riskAware: true });
      if (!candidate.complete || !candidate.steps.length) continue;
      candidates.push(candidate);
    }
    if (!candidates.length) return null;
    const best = candidates.sort((a, b) =>
      a.highStockRiskCount - b.highStockRiskCount ||
      a.stockRiskCount - b.stockRiskCount ||
      a.totalCost - b.totalCost ||
      a.stopCount - b.stopCount
    )[0];
    const currentCost = Number(routeItem.subtotal) || 0;
    return {
      itemId,
      itemName: routeItem.itemName,
      quantity,
      totalCost: best.totalCost,
      extraCost: best.totalCost - currentCost,
      stockRiskCount: best.stockRiskCount,
      highStockRiskCount: best.highStockRiskCount,
      step: best.steps[0]
    };
  }

  function scheduleLiveBazaarCapture() {
    if (!isBazaarPage() || state.liveBazaarCaptureTimer) return;
    state.liveBazaarCaptureTimer = setTimeout(() => {
      state.liveBazaarCaptureTimer = 0;
      captureVisibleBazaarListings();
    }, LIVE_BAZAAR_CAPTURE_DEBOUNCE_MS);
  }

  function captureVisibleBazaarListings() {
    if (!isBazaarPage()) return [];
    const userId = currentBazaarUserId();
    if (!userId) return [];

    const captured = [];
    for (const item of HAPPY_JUMP_ITEMS) {
      const listing = findVisibleBazaarListing(item, userId);
      if (listing) captured.push(listing);
    }
    if (!captured.length) return [];

    const signature = captured
      .map(entry => `${entry.userId}:${entry.itemId}:${entry.price}:${entry.stock}`)
      .sort()
      .join("|");
    if (signature === state.liveBazaarCaptureSignature && Date.now() - state.lastLiveBazaarCaptureAt < 1500) {
      return captured;
    }

    state.liveBazaarCaptureSignature = signature;
    state.lastLiveBazaarCaptureAt = Date.now();
    storeLiveBazaarListings(captured);
    return captured;
  }

  function findVisibleBazaarListing(item, userId) {
    const wanted = normalizeText(item?.itemName || "").toLowerCase();
    if (!wanted) return null;

    const seeds = [...document.querySelectorAll("a,span,div,p,h1,h2,h3,h4,li,strong")]
      .filter(node => {
        if (!isVisibleElement(node) || node.closest(`[${BAZAAR_NAV_HOST_ATTR}]`)) return false;
        return normalizeText(node.textContent).toLowerCase() === wanted;
      })
      .slice(0, 30);

    let best = null;
    for (const seed of seeds) {
      let node = seed;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        if (!(node instanceof Element) || node === document.body || node === document.documentElement) break;
        if (!isVisibleElement(node) || node.closest(`[${BAZAAR_NAV_HOST_ATTR}]`)) continue;

        const text = normalizeText(node.innerText || node.textContent || "");
        if (!text || text.length > 1200 || !text.toLowerCase().includes(wanted)) continue;

        const price = parseBazaarListingPrice(node, text);
        if (!Number.isFinite(price) || price <= 0) continue;

        const stock = parseBazaarListingStock(node, text);
        const rect = node.getBoundingClientRect();
        const currencyCount = visibleBazaarCurrencyValues(node).length;
        const hasCommerceAction = [...node.querySelectorAll("button,[role='button'],a")]
          .some(element => isVisibleElement(element) && /\b(?:buy|purchase|max)\b/i.test(normalizeText(element.textContent)));

        const score =
          (currencyCount === 1 ? 130 : currencyCount > 1 ? 80 : 0)
          + (hasCommerceAction ? 45 : 0)
          + (Number.isFinite(stock) ? 25 : 0)
          + (node.matches("li,article,[role='row']") ? 25 : 0)
          - Math.min(35, text.length / 30)
          - depth * 3;

        const candidate = {
          node,
          price,
          stock: Number.isFinite(stock) && stock > 0 ? Math.trunc(stock) : 1,
          score,
          area: rect.width * rect.height
        };
        if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.area < best.area)) {
          best = candidate;
        }
      }
    }

    if (!best) return null;
    return {
      kind: "bazaar",
      itemId: String(item.itemId),
      price: best.price,
      stock: best.stock,
      userId: String(userId),
      updatedAt: Math.floor(Date.now() / 1000),
      sourceIndex: -1,
      source: "live-bazaar-page",
      capturedAt: Date.now()
    };
  }

  function visibleBazaarCurrencyValues(node) {
    const values = [];
    const seen = new Set();

    const addText = value => {
      for (const match of String(value || "").matchAll(/\$\s*([0-9][0-9,]*(?:\.\d+)?)/g)) {
        const price = Number(match[1].replace(/,/g, ""));
        if (!Number.isFinite(price) || price <= 0) continue;
        const key = String(price);
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(price);
      }
    };

    for (const element of [node, ...node.querySelectorAll("span,div,p,strong,b,em,label")]) {
      if (element !== node && !isVisibleElement(element)) continue;
      const direct = [...element.childNodes]
        .filter(child => child.nodeType === Node.TEXT_NODE)
        .map(child => child.textContent || "")
        .join(" ");
      addText(direct);
    }

    return values;
  }

  function parseBazaarListingPrice(node, text) {
    const attributePrices = [];
    for (const element of [node, ...node.querySelectorAll("[data-price],[data-cost]")]) {
      for (const attribute of ["data-price", "data-cost"]) {
        const raw = element.getAttribute?.(attribute);
        if (raw == null) continue;
        const value = Number(String(raw).replace(/[$,\s]/g, ""));
        if (Number.isFinite(value) && value > 0) attributePrices.push(value);
      }
    }

    const renderedPrices = visibleBazaarCurrencyValues(node);
    const candidates = [...attributePrices, ...renderedPrices]
      .filter(value => Number.isFinite(value) && value > 0);

    if (!candidates.length) return null;
    if (renderedPrices.length === 1) return renderedPrices[0];
    if (renderedPrices.length > 1 && normalizeText(text).length > 450) return null;
    return renderedPrices[0] ?? attributePrices[0] ?? null;
  }

  function parseBazaarListingStock(node, text) {
    const values = [];

    for (const element of [node, ...node.querySelectorAll("[data-quantity],[data-qty],[data-stock]")]) {
      for (const attribute of ["data-quantity", "data-qty", "data-stock"]) {
        const raw = element.getAttribute?.(attribute);
        if (raw != null && /^\d+$/.test(String(raw).trim())) values.push(Number(raw));
      }
    }

    const patterns = [
      /\b(?:qty|quantity|stock)\s*:?\s*(\d{1,6})\b/i,
      /\b(\d{1,6})\s+(?:available|in stock)\b/i,
      /\bavailable\s*:?\s*(\d{1,6})\b/i
    ];
    for (const pattern of patterns) {
      const match = String(text || "").match(pattern);
      if (match) values.push(Number(match[1]));
    }

    const valid = values.filter(value => Number.isFinite(value) && value > 0);
    return valid.length ? Math.min(...valid) : null;
  }

  function storeLiveBazaarListings(listings) {
    const now = Date.now();
    const cache = readSessionJson(LIVE_BAZAAR_CACHE_KEY, { entries: {} });
    cache.entries = cache.entries && typeof cache.entries === "object" ? cache.entries : {};

    for (const listing of listings || []) {
      if (!listing?.userId || !listing?.itemId || !Number.isFinite(Number(listing.price))) continue;
      const key = `${listing.userId}:${listing.itemId}`;
      cache.entries[key] = {
        ...listing,
        userId: String(listing.userId),
        itemId: String(listing.itemId),
        price: Number(listing.price),
        stock: Math.max(1, Math.trunc(Number(listing.stock) || 1)),
        capturedAt: now,
        expiresAt: now + LIVE_BAZAAR_CACHE_TTL_MS
      };
    }

    for (const [key, entry] of Object.entries(cache.entries)) {
      if (!entry || Number(entry.expiresAt) <= now) delete cache.entries[key];
    }
    writeSessionJson(LIVE_BAZAAR_CACHE_KEY, cache);
  }

  function readLiveBazaarListingsForItem(itemId) {
    const expected = String(itemId || "");
    const now = Date.now();
    const cache = readSessionJson(LIVE_BAZAAR_CACHE_KEY, { entries: {} });
    const output = [];
    let changed = false;

    for (const [key, entry] of Object.entries(cache.entries || {})) {
      if (!entry || Number(entry.expiresAt) <= now) {
        delete cache.entries[key];
        changed = true;
        continue;
      }
      if (String(entry.itemId || "") !== expected) continue;
      const price = Number(entry.price);
      const stock = Math.trunc(Number(entry.stock));
      const userId = String(entry.userId || "");
      if (!/^\d+$/.test(userId) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(stock) || stock <= 0) continue;
      output.push({
        kind: "bazaar",
        itemId: expected,
        price,
        stock,
        userId,
        updatedAt: Math.floor(Number(entry.capturedAt || now) / 1000),
        sourceIndex: -1,
        source: "live-bazaar-page",
        capturedAt: Number(entry.capturedAt) || now
      });
    }

    if (changed) writeSessionJson(LIVE_BAZAAR_CACHE_KEY, cache);
    return output.sort((a, b) => a.price - b.price || b.stock - a.stock);
  }

  function recentLiveBazaarVerification(userId, itemId) {
    const listings = readLiveBazaarListingsForItem(itemId);
    const now = Date.now();
    return listings.some(entry =>
      String(entry.userId) === String(userId)
      && now - Number(entry.capturedAt || 0) <= LIVE_BAZAAR_VERIFY_TTL_MS
    );
  }

  function mergeBazaarListingSources(...sources) {
    const bySeller = new Map();
    const priority = {
      "live-bazaar-page": 30,
      "own-user-bazaar": 20,
      "seller-user-bazaar": 15,
      "tornw3b": 10
    };

    for (const source of sources) {
      for (const raw of source || []) {
        const userId = String(raw?.userId || "");
        const itemId = String(raw?.itemId || "");
        const price = Number(raw?.price);
        const stock = Math.trunc(Number(raw?.stock));
        if (!/^\d+$/.test(userId) || !/^\d+$/.test(itemId) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(stock) || stock <= 0) continue;
        const listing = { ...raw, userId, itemId, price, stock };
        const existing = bySeller.get(userId);
        const listingPriority = priority[listing.source] || 0;
        const existingPriority = priority[existing?.source] || 0;
        if (!existing || listingPriority > existingPriority || (listingPriority === existingPriority && price < existing.price)) {
          bySeller.set(userId, listing);
        }
      }
    }

    return [...bySeller.values()].sort((a, b) =>
      a.price - b.price
      || (b.updatedAt || 0) - (a.updatedAt || 0)
      || b.stock - a.stock
    );
  }

  function normalizeOwnBazaarSnapshot(payload, itemId, options = {}) {
    const expected = String(itemId || "");
    if (!payload || !/^\d+$/.test(expected)) return [];
    if (payload.bazaar_is_open === false) return [];

    const userId = String(
      options.forcedUserId
      || payload.player_id
      || payload.playerId
      || payload.user_id
      || payload.userId
      || payload?.profile?.id
      || ""
    );
    if (!/^\d+$/.test(userId)) return [];

    const candidates = [];
    const seen = new Set();
    const walk = (value, depth = 0, inheritedKey = null) => {
      if (depth > 7 || value == null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, depth + 1, null);
        return;
      }

      const directItemId = idFromKeys(value, ["ID", "id", "item_id", "itemId", "itemID"])
        || (/^\d+$/.test(String(inheritedKey || "")) ? String(inheritedKey) : null);
      const price = numberFromKeys(value, ["price", "cost", "asking_price", "askingPrice"]);
      const quantity = numberFromKeys(value, ["quantity", "qty", "stock", "amount"]);
      if (directItemId === expected && Number.isFinite(price) && price > 0 && Number.isFinite(quantity) && quantity > 0) {
        candidates.push({
          kind: "bazaar",
          itemId: expected,
          price,
          stock: Math.trunc(quantity),
          userId,
          updatedAt: Number(payload.bazaar_timestamp) || Math.floor(Date.now() / 1000),
          sourceIndex: candidates.length,
          source: options.source || "own-user-bazaar"
        });
      }

      for (const [key, child] of Object.entries(value)) {
        if (key === "error") continue;
        walk(child, depth + 1, key);
      }
    };

    walk(payload.bazaar ?? payload, 0, null);
    return mergeBazaarListingSources(candidates);
  }

  function readSessionJson(key, fallback) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeSessionJson(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function isBazaarPage() {
    try {
      const url = new URL(globalThis.location?.href || "", "https://www.torn.com/");
      return /\/bazaar\.php$/i.test(url.pathname) && /^\d+$/.test(url.searchParams.get("userId") || "");
    } catch {
      return false;
    }
  }

  function currentBazaarUserId() {
    try {
      const url = new URL(globalThis.location?.href || "", "https://www.torn.com/");
      return /^\d+$/.test(url.searchParams.get("userId") || "") ? url.searchParams.get("userId") : null;
    } catch {
      return null;
    }
  }

  function safeItemMarketReturnUrl(value) {
    try {
      const url = new URL(String(value || ""), "https://www.torn.com/");
      if (!/(^|\.)torn\.com$/i.test(url.hostname)) return null;
      const context = parseItemMarketContextFromHref(url.href);
      return context.kind === "itemMarket" && /^\d+$/.test(String(context.itemId || "")) ? url.href : null;
    } catch {
      return null;
    }
  }

  function routeStepUserId(step) {
    if (step?.source !== "bazaar") return null;
    const fromKey = String(step.routeKey || "").match(/^bazaar:(\d+)$/)?.[1] || null;
    if (fromKey) return fromKey;
    try {
      const url = new URL(String(step.href || ""), "https://www.torn.com/");
      const id = url.searchParams.get("userId");
      return /^\d+$/.test(id || "") ? id : null;
    } catch {
      return null;
    }
  }

  function resolveBazaarRouteStepIndex(steps, activeRouteKey, currentUserId) {
    const list = Array.isArray(steps) ? steps : [];
    const activeKey = String(activeRouteKey || "");
    const userId = /^\d+$/.test(String(currentUserId || "")) ? String(currentUserId) : null;
    const byActive = activeKey ? list.findIndex(step => String(step?.routeKey || "") === activeKey) : -1;
    const byUser = userId ? list.findIndex(step => routeStepUserId(step) === userId) : -1;

    if (byActive >= 0) {
      const activeUserId = routeStepUserId(list[byActive]);
      if (!userId || !activeUserId || activeUserId === userId) {
        return { index: byActive, source: "active-route-key", identityConfirmed: Boolean(userId && activeUserId === userId) };
      }
      if (byUser >= 0) return { index: byUser, source: "url-user-id", identityConfirmed: true };
      return { index: byActive, source: "active-route-pending", identityConfirmed: false };
    }

    if (byUser >= 0) return { index: byUser, source: "url-user-id", identityConfirmed: true };
    return { index: -1, source: "unresolved", identityConfirmed: false };
  }

  function currentBazaarLocationKey() {
    if (!isBazaarPage()) return null;
    const userId = currentBazaarUserId() || "unknown";
    try {
      const url = new URL(globalThis.location?.href || "", "https://www.torn.com/");
      return `${url.pathname}?userId=${userId}`;
    } catch {
      return `bazaar:${userId}`;
    }
  }

  function cancelBazaarIdentityTimers() {
    for (const timer of state.bazaarIdentityTimers) clearTimeout(timer);
    state.bazaarIdentityTimers.clear();
  }

  function scheduleBazaarIdentitySync(delayMs) {
    const delay = Math.max(0, Number(delayMs) || 0);
    const timer = setTimeout(() => {
      state.bazaarIdentityTimers.delete(timer);
      if (!state.destroyed) scheduleGuardSync();
    }, delay);
    state.bazaarIdentityTimers.add(timer);
  }

  function noteBazaarLocationEntry() {
    const locationKey = currentBazaarLocationKey();
    if (!locationKey || state.bazaarLocationKey === locationKey) return;
    state.bazaarLocationKey = locationKey;
    state.bazaarLocationEnteredAt = Date.now();
    cancelBazaarIdentityTimers();
    for (const delay of BAZAAR_IDENTITY_RECHECK_DELAYS_MS) scheduleBazaarIdentitySync(delay);
  }

  function syncBazaarRouteNavigation() {
    if (!isBazaarPage()) {
      removeBazaarRouteNavigation();
      removeItemAdvisorBackNavigation();
      return false;
    }

    if (!state.happyJumpPlan?.practical?.steps?.length || !state.activeRouteKey) {
      removeBazaarRouteNavigation();
      return syncItemAdvisorBackNavigation();
    }

    removeItemAdvisorBackNavigation();
    noteBazaarLocationEntry();
    const userId = currentBazaarUserId();
    const activeRoute = state.activeRouteKind === "comparison"
      ? state.happyJumpPlan.absolute
      : state.happyJumpPlan.practical;
    const originalSteps = activeRoute?.steps || [];
    const resolved = resolveBazaarRouteStepIndex(originalSteps, state.activeRouteKey, userId);
    let currentIndex = resolved.index;

    if (currentIndex < 0 && state.quarantinedRouteKeys.has(String(state.activeRouteKey || ""))) {
      const quarantinedUserId = String(state.activeRouteKey || "").match(/^bazaar:(\d+)$/)?.[1] || null;
      if (quarantinedUserId === userId) {
        const pseudoStep = { source: "bazaar", routeKey: state.activeRouteKey, userId, items: [], href: globalThis.location?.href || "", subtotal: 0, updatedAt: null };
        state.bazaarNavAlert = { type: "closed", text: "CLOSED BAZAAR QUARANTINED" };
        const replacementNext = originalSteps.find(step => !state.openedRouteKeys.has(step.routeKey) && !state.quarantinedRouteKeys.has(step.routeKey)) || null;
        renderBazaarRouteNavigation(pseudoStep, 0, originalSteps, replacementNext, `closed-restored|${state.activeRouteKey}|${replacementNext?.routeKey || "none"}|${state.bazaarNavCollapsed}`, { closed: true });
        return true;
      }
    }
    if (currentIndex < 0) {
      removeBazaarRouteNavigation();
      return false;
    }

    const currentStep = originalSteps[currentIndex];
    state.activeWorkspace = WORKSPACE_HAPPY;
    state.returnFocusPending = true;

    if (!resolved.identityConfirmed) {
      const pendingNext = originalSteps.find(step => step.routeKey !== currentStep.routeKey && !state.openedRouteKeys.has(step.routeKey) && !state.quarantinedRouteKeys.has(step.routeKey)) || null;
      const signature = `identity-pending|${currentStep.routeKey}|${userId || "none"}|${state.bazaarNavCollapsed}`;
      renderBazaarRouteNavigation(currentStep, currentIndex, originalSteps, pendingNext, signature, { identityPending: true });
      return true;
    }

    if (state.activeRouteKey !== currentStep.routeKey) {
      state.activeRouteKey = currentStep.routeKey;
      persistHappyJumpSession();
    }

    const settledForMs = Math.max(0, Date.now() - Number(state.bazaarLocationEnteredAt || 0));
    if (settledForMs < BAZAAR_ROUTE_SETTLE_MS) {
      scheduleBazaarIdentitySync(BAZAAR_ROUTE_SETTLE_MS - settledForMs + 40);
    } else if (documentShowsClosedBazaar()) {
      quarantineRouteStep(currentStep, "closed-after-navigation");
      state.bazaarNavAlert = { type: "closed", text: "CLOSED BAZAAR QUARANTINED" };
      const replacementSteps = state.happyJumpPlan?.practical?.steps || [];
      const replacementNext = replacementSteps.find(step => !state.openedRouteKeys.has(step.routeKey) && !state.quarantinedRouteKeys.has(step.routeKey)) || null;
      const signature = `closed|${currentStep.routeKey}|${replacementNext?.routeKey || "none"}|${state.bazaarNavCollapsed}`;
      renderBazaarRouteNavigation(currentStep, currentIndex, originalSteps, replacementNext, signature, { closed: true });
      return true;
    }

    const wasOpened = state.openedRouteKeys.has(currentStep.routeKey);
    state.openedRouteKeys.add(currentStep.routeKey);
    state.activeRouteKey = currentStep.routeKey;
    const steps = state.happyJumpPlan.practical.steps || [];
    const stableCurrentIndex = Math.max(0, steps.findIndex(step => step.routeKey === currentStep.routeKey));
    const nextStep = steps.find(step => step.routeKey !== currentStep.routeKey && !state.openedRouteKeys.has(step.routeKey) && !state.quarantinedRouteKeys.has(step.routeKey)) || null;
    const signature = `${currentStep.routeKey}|${nextStep?.routeKey || "done"}|${state.openedRouteKeys.size}|${state.bazaarNavCollapsed}|${state.bazaarNavAlert?.text || ""}`;
    if (!wasOpened || state.bazaarNavSignature !== signature) persistHappyJumpSession();
    renderBazaarRouteNavigation(currentStep, stableCurrentIndex, steps, nextStep, signature);
    return true;
  }

  function visibleElementForBazaarMount(node) {
    if (!(node instanceof Element) || !node.isConnected) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }

  function bazaarActionText(node) {
    return String(node?.value || node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
  }

  function bazaarRootDescriptor(node) {
    return `${node?.id || ""} ${typeof node?.className === "string" ? node.className : ""} ${node?.getAttribute?.("role") || ""}`.toLowerCase();
  }

  function visibleBazaarActionCount(node) {
    if (!(node instanceof Element)) return 0;
    return [...node.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit']")]
      .filter(element => visibleElementForBazaarMount(element) && /^(BUY|MAX)$/.test(bazaarActionText(element))).length;
  }

  function findImmediateBazaarRoot() {
    const viewportWidth = Math.max(320, Number(globalThis.innerWidth) || 390);
    const actionNodes = [...document.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit']")]
      .filter(node => visibleElementForBazaarMount(node) && /^(BUY|MAX)$/.test(bazaarActionText(node)));
    const firstAction = actionNodes[0] || null;
    const titleNode = [...document.querySelectorAll("h1,h2,h3,[class*='title' i],[class*='header' i]")]
      .find(node => visibleElementForBazaarMount(node) && /\bbazaar\b/i.test(String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())) || null;

    const candidates = new Set();
    for (const node of document.querySelectorAll("#mainContainer,main,[role='main'],[id*='bazaar' i],[class*='bazaar' i],[class*='content-wrapper' i],[class*='contentWrapper' i]")) candidates.add(node);
    for (const seed of [titleNode, firstAction]) {
      let node = seed;
      for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
        if (node instanceof Element) candidates.add(node);
        if (node === document.body) break;
      }
    }

    const scored = [...candidates].filter(node => {
      if (!(node instanceof Element) || !node.isConnected || node === document.body || node === document.documentElement) return false;
      if (node.closest(`[${BAZAAR_NAV_HOST_ATTR}]`)) return false;
      if (!visibleElementForBazaarMount(node)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width >= 240 && rect.width <= viewportWidth * 1.35 && rect.height >= 60;
    }).map(node => {
      const rect = node.getBoundingClientRect();
      const descriptor = bazaarRootDescriptor(node);
      const actionCount = visibleBazaarActionCount(node);
      const containsTitle = Boolean(titleNode && node.contains(titleNode));
      const containsAction = Boolean(firstAction && node.contains(firstAction));
      const textSample = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").slice(0, 3500);
      let score = 0;
      if (/\bmaincontainer\b/.test(descriptor)) score += 320;
      if (node.tagName === "MAIN" || node.getAttribute("role") === "main") score += 280;
      if (/bazaar/.test(descriptor)) score += 190;
      if (/content[-_ ]?wrapper|contentwrapper/.test(descriptor)) score += 120;
      if (containsTitle) score += 150;
      if (containsAction) score += 90;
      if (/\bbazaar\b/i.test(textSample)) score += 45;
      score += Math.min(10, actionCount) * 7;
      if (rect.top <= (titleNode?.getBoundingClientRect().top ?? rect.top) + 24) score += 35;
      if (rect.width > viewportWidth * 1.15) score -= 80;
      if (rect.height > 10000) score -= 25;
      return { node, score, area: rect.width * rect.height };
    }).sort((a, b) => b.score - a.score || a.area - b.area);

    return scored[0]?.node || null;
  }

  function findBazaarNavigationInsertionPoint() {
    const immediateRoot = findImmediateBazaarRoot();
    if (immediateRoot) return { parent: immediateRoot, before: immediateRoot.firstElementChild };

    const closedPage = documentShowsClosedBazaar();
    const fallback = [...document.querySelectorAll("[id*='bazaar' i],[class*='bazaar' i],main,[role='main']")]
      .filter(node => visibleElementForBazaarMount(node) && !node.closest(`[${BAZAAR_NAV_HOST_ATTR}]`))
      .map(node => ({ node, rect: node.getBoundingClientRect(), named: /bazaar/i.test(bazaarRootDescriptor(node)) }))
      .filter(entry => entry.rect.width >= 240 && entry.rect.height >= 60 && (entry.named || closedPage))
      .sort((a, b) => Number(b.named) - Number(a.named) || a.rect.top - b.rect.top || a.rect.height - b.rect.height)[0]?.node || null;
    return fallback ? { parent: fallback, before: fallback.firstElementChild } : null;
  }

  function mountBazaarNavigationHost(host) {
    const point = findBazaarNavigationInsertionPoint();
    if (!point?.parent?.isConnected) return false;
    try {
      point.parent.insertBefore(host, point.before || null);
      return host.isConnected;
    } catch {
      return false;
    }
  }

  function ensureBazaarNavigationHostPlacement() {
    const host = state.bazaarNavHost;
    if (!(host instanceof Element)) return false;
    const point = findBazaarNavigationInsertionPoint();
    if (!point?.parent?.isConnected) return host.isConnected;
    const correctParent = host.parentNode === point.parent;
    const correctSibling = !point.before || host.nextSibling === point.before || point.before === host;
    if (correctParent && correctSibling) return true;
    try {
      point.parent.insertBefore(host, point.before === host ? host.nextSibling : point.before || null);
      return host.isConnected;
    } catch {
      return host.isConnected;
    }
  }

  function renderBazaarRouteNavigation(currentStep, currentIndex, steps, nextStep, signature, options = {}) {
    if (!state.bazaarNavHost?.isConnected) {
      const host = document.createElement("div");
      host.setAttribute(BAZAAR_NAV_HOST_ATTR, "true");
      host.style.cssText = "position:sticky;top:2px;z-index:1200;display:block;width:100%;margin:4px 0 6px;padding:0;box-sizing:border-box;pointer-events:none;grid-column:1/-1;flex:0 0 100%;align-self:stretch;scroll-margin-top:6px;";
      const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
      root.innerHTML = `<style>:host{all:initial;font-family:Arial,Helvetica,sans-serif;display:block;width:100%}*{box-sizing:border-box}.shell{display:flex;justify-content:flex-end;width:100%;min-height:30px;pointer-events:none}.nav{pointer-events:auto;width:auto;max-width:100%;height:30px;display:flex;align-items:center;gap:3px;padding:2px 3px;border:1px solid #8f7cff;border-radius:7px;background:linear-gradient(135deg,#29253f,#183143);box-shadow:0 2px 7px rgba(0,0,0,.34);color:#fff;white-space:nowrap}.nav.closed{border-color:#ff5f6d;background:linear-gradient(135deg,#44232a,#2c2633)}.nav.warning{border-color:#ff9f43}.badge{flex:0 0 auto;min-width:45px;height:24px;display:grid;place-items:center;padding:0 5px;border-radius:5px;background:#3e356c;color:#fff;font-size:8px;line-height:10px;font-weight:1000;white-space:nowrap}.nav.closed .badge{background:#7c2935}.nav.warning .badge{background:#7b5322}.buttons{display:flex;gap:3px;align-items:center;flex:0 0 auto}button{height:24px;min-height:24px;padding:2px 6px;border:1px solid #6f7c8b;border-radius:5px;background:#2b3541;color:#fff;font:900 7px Arial,Helvetica,sans-serif;white-space:nowrap}button[data-nav='return']{border-color:#7bc8ff;background:#24577a}button[data-nav='next']{border-color:#67ffb0;background:linear-gradient(135deg,#197a4b,#28a965)}button[data-nav='toggle']{width:24px;padding:0;font-size:10px}.nav.collapsed{padding:2px;width:auto}.nav.collapsed .buttons{display:none}.nav.collapsed .badge{cursor:pointer;min-width:48px}.nav.no-next button[data-nav='next']{display:none}@media(max-width:390px){.nav{gap:2px;padding:2px}.buttons{gap:2px}button{padding:2px 5px}.badge{min-width:43px}}</style><div class="shell"><section class="nav" data-nav="panel"><div class="badge" data-nav="badge"></div><div class="buttons"><button type="button" data-nav="return">RETURN</button><button type="button" data-nav="next">NEXT</button><button type="button" data-nav="toggle" aria-label="Minimize Happy Jump navigation">−</button></div></section></div>`;
      state.bazaarNavHost = host;
      state.bazaarNavRoot = root;
      root.querySelector("button[data-nav='return']").addEventListener("click", returnToHappyJump);
      root.querySelector("button[data-nav='next']").addEventListener("click", goToNextRouteStop);
      root.querySelector("button[data-nav='toggle']").addEventListener("click", toggleCompactBazaarNavigation);
      root.querySelector("[data-nav='badge']").addEventListener("click", () => {
        if (!state.bazaarNavCollapsed) return;
        toggleCompactBazaarNavigation();
      });
      if (!mountBazaarNavigationHost(host)) {
        state.bazaarNavHost = null;
        state.bazaarNavRoot = null;
        return;
      }
    }

    ensureBazaarNavigationHostPlacement();
    state.bazaarNavSignature = signature;
    const root = state.bazaarNavRoot;
    const panel = root.querySelector("[data-nav='panel']");
    const alert = state.bazaarNavAlert;
    const identityPending = options.identityPending === true;
    const isClosed = !identityPending && (options.closed === true || alert?.type === "closed");
    const isWarning = identityPending || alert?.type === "warning" || alert?.type === "checking";
    panel.classList.toggle("collapsed", state.bazaarNavCollapsed);
    panel.classList.toggle("closed", isClosed);
    panel.classList.toggle("warning", isWarning);
    panel.classList.toggle("no-next", !nextStep);
    const total = Math.max(1, steps.length);
    const positionLabel = `HJ ${Math.min(currentIndex + 1, total)}/${total}`;
    root.querySelector("[data-nav='badge']").textContent = isClosed ? "HJ !" : identityPending || alert?.type === "checking" ? "HJ …" : positionLabel;
    const currentItems = (currentStep?.items || []).map(item => `${formatMoney(item.quantity)} ${item.itemName}`).join(" · ");
    const statusText = identityPending ? `Resolving ${positionLabel} Bazaar identity…` : alert?.text || (options.closed ? "Closed Bazaar blocked for this session" : `${positionLabel}${currentItems ? ` · ${currentItems}` : ""}`);
    panel.setAttribute("aria-label", statusText);
    panel.setAttribute("title", statusText);
    const nextButton = root.querySelector("button[data-nav='next']");
    const retryCheck = /RETRY CHECK/i.test(String(alert?.text || ""));
    nextButton.disabled = state.preflightBusy;
    nextButton.textContent = state.preflightBusy ? "CHECK" : retryCheck ? "RETRY CHECK" : "NEXT";
    nextButton.dataset.nextRouteKey = nextStep?.routeKey || "";
    root.querySelector("button[data-nav='toggle']").textContent = state.bazaarNavCollapsed ? "+" : "−";
  }

  function toggleCompactBazaarNavigation() {
    state.bazaarNavCollapsed = !state.bazaarNavCollapsed;
    persistHappyJumpSession();
    syncBazaarRouteNavigation();
  }

  function returnToHappyJump() {
    state.activeWorkspace = WORKSPACE_HAPPY;
    state.returnFocusPending = true;
    state.activeRouteKey = null;
    state.bazaarNavAlert = null;
    persistHappyJumpSession();
    const destination = safeItemMarketReturnUrl(state.routeReturnUrl) || itemMarketDestination(HAPPY_JUMP_ITEMS[0].itemId);
    if (destination) globalThis.location.assign(destination);
  }

  function goToNextRouteStop() {
    const key = state.bazaarNavRoot?.querySelector("button[data-nav='next']")?.dataset.nextRouteKey || "";
    const step = findRouteStep(key, "practical", null);
    if (!step || state.quarantinedRouteKeys.has(String(step.routeKey || ""))) return;
    const button = state.bazaarNavRoot?.querySelector("button[data-nav='next']") || null;
    if (step.source === "bazaar") {
      void openRouteStepWithPreflight(step, { triggerElement: button, routeKind: state.activeRouteKind });
      return;
    }
    const href = safeRouteHref(step.href);
    if (!href) return;
    state.activeWorkspace = WORKSPACE_HAPPY;
    state.activeRouteKey = step.routeKey;
    state.activeRouteKind = state.activeRouteKind === "comparison" ? "comparison" : "practical";
    state.returnFocusPending = true;
    persistHappyJumpSession();
    globalThis.location.assign(href);
  }

  function persistItemAdvisorBazaarReturn(value) {
    const now = Date.now();
    const payload = {
      sellerUserId: String(value?.sellerUserId || ""),
      itemId: String(value?.itemId || ""),
      returnUrl: safeItemMarketReturnUrl(value?.returnUrl),
      savedAt: now,
      expiresAt: now + ITEM_BAZAAR_RETURN_TTL_MS
    };
    if (!/^\d+$/.test(payload.sellerUserId) || !/^\d+$/.test(payload.itemId) || !payload.returnUrl) return false;
    try {
      sessionStorage.setItem(ITEM_BAZAAR_RETURN_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function readItemAdvisorBazaarReturn() {
    try {
      const raw = sessionStorage.getItem(ITEM_BAZAAR_RETURN_STORAGE_KEY);
      const payload = raw ? JSON.parse(raw) : null;
      if (!payload || Number(payload.expiresAt) <= Date.now()) {
        clearItemAdvisorBazaarReturn();
        return null;
      }
      const sellerUserId = String(payload.sellerUserId || "");
      const itemId = String(payload.itemId || "");
      const returnUrl = safeItemMarketReturnUrl(payload.returnUrl);
      if (!/^\d+$/.test(sellerUserId) || !/^\d+$/.test(itemId) || !returnUrl) {
        clearItemAdvisorBazaarReturn();
        return null;
      }
      return { ...payload, sellerUserId, itemId, returnUrl };
    } catch {
      clearItemAdvisorBazaarReturn();
      return null;
    }
  }

  function clearItemAdvisorBazaarReturn() {
    try { sessionStorage.removeItem(ITEM_BAZAAR_RETURN_STORAGE_KEY); } catch {}
  }

  function syncItemAdvisorBackNavigation() {
    if (!isBazaarPage()) {
      removeItemAdvisorBackNavigation();
      return false;
    }

    const payload = readItemAdvisorBazaarReturn();
    const userId = currentBazaarUserId();
    if (!payload || payload.sellerUserId !== userId) {
      removeItemAdvisorBackNavigation();
      return false;
    }

    renderItemAdvisorBackNavigation(payload);
    return true;
  }

  function renderItemAdvisorBackNavigation(payload) {
    if (!state.itemBackHost?.isConnected) {
      const host = document.createElement("div");
      host.setAttribute(ITEM_BAZAAR_BACK_HOST_ATTR, "true");
      host.style.cssText = "position:sticky;top:2px;z-index:1201;display:block;width:100%;margin:4px 0 6px;padding:0;box-sizing:border-box;pointer-events:none;grid-column:1/-1;flex:0 0 100%;align-self:stretch;";
      const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
      root.innerHTML = `<style>:host{all:initial;font-family:Arial,Helvetica,sans-serif;display:block;width:100%}*{box-sizing:border-box}.shell{display:flex;justify-content:flex-end;width:100%;pointer-events:none}.nav{pointer-events:auto;height:30px;display:flex;align-items:center;gap:3px;padding:2px 3px;border:1px solid #42dfff;border-radius:7px;background:linear-gradient(135deg,#203748,#183143);box-shadow:0 2px 7px rgba(0,0,0,.34);color:#fff}.badge{height:24px;display:grid;place-items:center;padding:0 6px;border-radius:5px;background:#24577a;font:1000 8px Arial,Helvetica,sans-serif}button{height:24px;min-height:24px;padding:2px 8px;border:1px solid #7bc8ff;border-radius:5px;background:#24577a;color:#fff;font:900 8px Arial,Helvetica,sans-serif;white-space:nowrap}</style><div class="shell"><section class="nav"><div class="badge">ITEM</div><button type="button" data-item-back="true">BACK</button></section></div>`;
      state.itemBackHost = host;
      state.itemBackRoot = root;
      root.querySelector("[data-item-back='true']").addEventListener("click", () => {
        const latest = readItemAdvisorBazaarReturn();
        const destination = safeItemMarketReturnUrl(latest?.returnUrl || payload?.returnUrl);
        clearItemAdvisorBazaarReturn();
        removeItemAdvisorBackNavigation();
        if (destination) globalThis.location.assign(destination);
      });
      if (!mountBazaarNavigationHost(host)) {
        state.itemBackHost = null;
        state.itemBackRoot = null;
        return false;
      }
    } else {
      const point = findBazaarNavigationInsertionPoint();
      if (point?.parent?.isConnected && state.itemBackHost.parentNode !== point.parent) {
        try { point.parent.insertBefore(state.itemBackHost, point.before || null); } catch {}
      }
    }
    return true;
  }

  function removeItemAdvisorBackNavigation() {
    state.itemBackHost?.remove();
    state.itemBackHost = null;
    state.itemBackRoot = null;
  }

  function removeBazaarRouteNavigation() {
    state.bazaarNavHost?.remove();
    state.bazaarNavHost = null;
    state.bazaarNavRoot = null;
    state.bazaarNavSignature = null;
    if (!isBazaarPage()) {
      state.bazaarLocationKey = null;
      state.bazaarLocationEnteredAt = 0;
      cancelBazaarIdentityTimers();
    }
  }

  function itemMarketDestination(itemId) {
    if (!/^\d+$/.test(String(itemId || ""))) return null;
    return `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${encodeURIComponent(itemId)}`;
  }

  function persistHappyJumpSession() {
    if (!state.happyJumpPlan) return;
    const now = Date.now();
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: now,
      expiresAt: now + ROUTE_SESSION_TTL_MS,
      presetKey: state.happyJumpPreset,
      quantities: state.happyJumpQuantities,
      visitedRouteKeys: [...state.openedRouteKeys],
      quarantinedRouteKeys: [...state.quarantinedRouteKeys],
      quarantineReasons: state.quarantineReasons,
      activeWorkspace: state.activeWorkspace,
      activeRouteKey: state.activeRouteKey,
      activeRouteKind: state.activeRouteKind,
      routeReturnUrl: safeItemMarketReturnUrl(state.routeReturnUrl),
      returnFocusPending: state.returnFocusPending === true,
      bazaarNavCollapsed: state.bazaarNavCollapsed === true,
      plan: state.happyJumpPlan,
      itemData: normalizeStoredHappyJumpData(state.happyJumpData),
      report: state.lastReport?.reportType === "multi-item-happy-jump-route" ? state.lastReport : null
    };
    try { sessionStorage.setItem(ROUTE_SESSION_STORAGE_KEY, JSON.stringify(payload)); } catch {}
  }

  function restoreHappyJumpSession() {
    let payload = null;
    try {
      const raw = sessionStorage.getItem(ROUTE_SESSION_STORAGE_KEY);
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      clearHappyJumpSession();
      return false;
    }
    if (!payload || ![111, 112, 113, 114, 115, 116, 117, 118, SCHEMA_VERSION].includes(Number(payload.schemaVersion)) || !payload.plan || Number(payload.expiresAt) <= Date.now()) {
      clearHappyJumpSession();
      return false;
    }
    const allowedItemIds = new Set(HAPPY_JUMP_ITEMS.map(item => item.itemId));
    const requestedIds = new Set((payload.plan.requestedItems || []).map(item => String(item.itemId || "")));
    if ([...requestedIds].some(itemId => !allowedItemIds.has(itemId))) {
      clearHappyJumpSession();
      return false;
    }
    state.happyJumpQuantities = Object.fromEntries(HAPPY_JUMP_ITEMS.map(item => {
      const quantity = normalizePlannerQuantity(payload.quantities?.[item.itemId] ?? item.defaultQuantity, true);
      return [item.itemId, quantity];
    }));
    state.happyJumpPreset = HAPPY_JUMP_PRESETS[payload.presetKey]
      ? payload.presetKey
      : inferHappyJumpPreset(state.happyJumpQuantities);
    for (const input of state.nodes.happyJumpInputs) {
      input.value = String(state.happyJumpQuantities[input.dataset.itemId] ?? 0);
    }
    syncHappyJumpPresetButtons();
    syncHappyJumpPresetItemVisibility();
    state.happyJumpPlan = payload.plan;
    state.happyJumpData = normalizeStoredHappyJumpData(payload.itemData || []);
    state.openedRouteKeys = new Set((payload.visitedRouteKeys || payload.openedRouteKeys || []).map(String));
    state.quarantinedRouteKeys = new Set((payload.quarantinedRouteKeys || []).map(String));
    state.quarantineReasons = payload.quarantineReasons && typeof payload.quarantineReasons === "object" ? { ...payload.quarantineReasons } : {};
    state.bazaarNavCollapsed = payload.bazaarNavCollapsed === true;
    state.restoredRouteAt = Number(payload.savedAt) || Date.now();
    state.activeWorkspace = payload.activeWorkspace === WORKSPACE_ITEM ? WORKSPACE_ITEM : WORKSPACE_HAPPY;
    state.activeRouteKey = typeof payload.activeRouteKey === "string" ? payload.activeRouteKey : null;
    state.activeRouteKind = payload.activeRouteKind === "comparison" ? "comparison" : "practical";
    state.routeReturnUrl = safeItemMarketReturnUrl(payload.routeReturnUrl) || itemMarketDestination(HAPPY_JUMP_ITEMS[0].itemId);
    state.returnFocusPending = payload.returnFocusPending === true;
    state.lastReport = payload.report?.reportType === "multi-item-happy-jump-route" ? payload.report : null;
    renderHappyJumpPlan(state.happyJumpPlan, { restored: true });
    state.nodes.copy.disabled = !state.lastReport;
    state.nodes.download.disabled = !state.lastReport;
    applyWorkspaceState(false);
    setStatus("Saved Happy Jump route restored. No prices or stock were refreshed automatically.", "warning");
    return true;
  }

  function clearHappyJumpSession() {
    try { sessionStorage.removeItem(ROUTE_SESSION_STORAGE_KEY); } catch {}
  }

  function buildHappyJumpReport(plan, itemData) {
    const scope = evaluateScope();
    const sanitizePlan = routePlan => ({
      complete: routePlan.complete,
      totalCost: routePlan.totalCost,
      requestedUnits: routePlan.requestedUnits,
      filledUnits: routePlan.filledUnits,
      stopCount: routePlan.stopCount,
      verificationRequired: routePlan.verificationRequired,
      stockRiskCount: routePlan.stockRiskCount || 0,
      highStockRiskCount: routePlan.highStockRiskCount || 0,
      stockRiskGuardCost: routePlan.stockRiskGuardCost || 0,
      backupCount: routePlan.backupCount || 0,
      backupAdoptionCount: routePlan.backupAdoptionCount || 0,
      backupAdoptions: routePlan.backupAdoptions || [],
      itemTotals: routePlan.itemTotals,
      missingItems: routePlan.missingItems,
      steps: routePlan.steps.map((step, index) => ({
        step: index + 1,
        source: step.source,
        subtotal: step.subtotal,
        items: step.items.map(item => ({ itemId: item.itemId, itemName: item.itemName, quantity: item.quantity, subtotal: item.subtotal, minUnitPrice: item.minUnitPrice, maxUnitPrice: item.maxUnitPrice, availableStock: item.availableStock, stockHeadroom: item.stockHeadroom, stockRisk: item.stockRisk, stockRiskLevel: item.stockRiskLevel, backupAvailable: Boolean(item.backup), backupAdopted: item.backupAdopted === true, backupAdoptedFromRouteKey: item.backupAdoptedFromRouteKey || null })),
        freshness: step.source === "bazaar" ? sourceFreshness(step.updatedAt, routePlan.capturedAt) : "api",
        directLinkAvailable: Boolean(step.href)
      }))
    });
    return {
      schemaVersion: SCHEMA_VERSION,
      reportType: "multi-item-happy-jump-route",
      script: { name: SCRIPT_NAME, version: VERSION, build: BUILD_LABEL },
      generatedAt: new Date().toISOString(),
      context: { route: sanitizeRoute(globalThis.location), platform: /Android|Mobile/i.test(navigator.userAgent || "") ? "mobile-or-pda" : "desktop", validOrdinaryDetail: scope.valid, scopeReason: scope.reason },
      request: { userInitiated: true, trigger: "PLAN_OR_START_NEW_HAPPY_JUMP", itemCount: itemData.length, requestsMade: itemData.length * 2, pollingUsed: false, automaticMarketClicksPerformed: false, automaticPurchasesPerformed: false },
      requestedItems: plan.requestedItems,
      optimization: { practicalMaxStops: plan.maxPracticalStops, candidateRouteCount: plan.candidateRouteCount, practicalConvenienceThreshold: plan.practical.convenienceThreshold, stockRiskGuardEnabled: true, backupRoutesEnabled: true, backupStopAdoptionEnabled: true, backupRouteNavigationEnabled: true, absoluteCheapestCompared: true, bazaarSellersGroupedAcrossItems: true, closedBazaarPreflightEnabled: true, failClosedLiveBazaarVerification: true, positiveOpenProofRequired: true, routeQuarantineEnabled: true },
      sessionPersistence: { enabled: true, storage: "sessionStorage", ttlMinutes: ROUTE_SESSION_TTL_MS / 60000, automaticRefreshOnRestore: false, quarantinedBazaarCount: state.quarantinedRouteKeys.size, compactBazaarNavigation: true, nonOverlayStickyNavigation: true, visitedStatePreservedOnReplan: false, quarantinePreservedOnOrdinaryReplan: true, quarantineClearedOnNewTrip: true, completedRouteState: true, routeComplete: isHappyJumpRouteComplete(plan) },
      closedBazaarDiagnostics: { lastVerification: state.lastBazaarVerification, lastQuarantine: state.lastQuarantineResult },
      practicalRoute: sanitizePlan(plan.practical),
      absoluteCheapestRoute: sanitizePlan(plan.absolute),
      privacy: { apiKeyExported: false, sellerIdentityExported: false, bazaarDestinationExported: false, rawResponseExported: false, rawHtmlCaptured: false }
    };
  }

  async function copyReport() {
    if (!state.lastReport) return;
    const text = JSON.stringify(state.lastReport, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Report copied. API key and seller identity are not included.", "ready");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      setStatus("Report copied. API key and seller identity are not included.", "ready");
    }
  }

  function downloadReport() {
    if (!state.lastReport) return;
    const blob = new Blob([JSON.stringify(state.lastReport, null, 2)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `KSMA_${VERSION.replace(/[^a-z0-9.]+/gi, "_")}_${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("Report downloaded as a .txt file.", "ready");
  }

  function buildReport(result) {
    const bestBazaar = result.bestBazaar || null;
    const bestItemApi = result.bestItemApi || null;
    const effective = result.effectiveItemMarket || null;
    const comparison = result.comparison || comparePrices(null, null);
    const scope = evaluateScope();
    return {
      schemaVersion: SCHEMA_VERSION,
      reportType: "api-market-refresh",
      script: { name: SCRIPT_NAME, version: VERSION, build: BUILD_LABEL },
      runtimeIdentity: {
        scriptVersion: VERSION,
        runtimeRunId: RUNTIME_RUN_ID,
        panelMode: "alpha5814r5-bazaar-nav-restore",
        validOrdinaryDetailMountGuardPresent: true,
        categoryOverviewMountBlocked: true,
        equipmentAndRwScopeBlocked: true,
        requestsBlockedOutsideValidScope: true,
        routeChangeUnmountPresent: true,
        inFlightResultInvalidationPresent: true,
        mountStrategy: state.mountStrategy,
        contextSource: state.contextSource,
        hostCount: document.querySelectorAll(`[${HOST_ATTR}]`).length
      },
      generatedAt: new Date().toISOString(),
      context: {
        route: sanitizeRoute(globalThis.location),
        platform: /Android|Mobile/i.test(navigator.userAgent || "") ? "mobile-or-pda" : "desktop",
        kind: scope.context?.kind || null,
        validOrdinaryDetail: scope.valid,
        scopeReason: scope.reason,
        routeItemId: String(result.itemId),
        routeItemName: result.itemName,
        routeItemType: scope.context?.itemType || null
      },
      releaseScope: { ordinaryItemsOnly: true, rankedWarItemsIncluded: false, automaticBuyingIncluded: false, multiItemRoutePlannerIncluded: true },
      request: { userInitiated: true, trigger: "REFRESH_MARKET_DATA", requestsMade: 2, pollingUsed: false, automaticMarketClicksPerformed: false },
      sources: { bazaar: "TornW3B marketplace", itemMarket: "Torn API v2", visiblePageFallbackUsed: Number.isFinite(result.visibleItemMarketPrice) },
      result: {
        itemId: String(result.itemId),
        itemName: result.itemName,
        bazaar: {
          listingCount: result.bazaarListings.length,
          lowestPrice: bestBazaar?.price ?? null,
          stock: bestBazaar?.stock ?? null,
          sourceCheckedAt: unixSecondsToIso(bestBazaar?.updatedAt),
          sourceAgeSeconds: sourceAgeSeconds(bestBazaar?.updatedAt, result.capturedAt),
          freshness: sourceFreshness(bestBazaar?.updatedAt, result.capturedAt),
          lastSeenLabel: formatLastSeen(bestBazaar?.updatedAt, result.capturedAt),
          directLinkAvailable: Boolean(result.directLink),
          topThree: result.bazaarListings.slice(0, 3).map((listing, index) => ({
            rank: index + 1,
            price: listing.price,
            stock: listing.stock,
            sourceCheckedAt: unixSecondsToIso(listing.updatedAt),
            sourceAgeSeconds: sourceAgeSeconds(listing.updatedAt, result.capturedAt),
            freshness: sourceFreshness(listing.updatedAt, result.capturedAt),
            verificationRecommended: sourceFreshness(listing.updatedAt, result.capturedAt) !== "fresh",
            lastSeenLabel: formatLastSeen(listing.updatedAt, result.capturedAt),
            directLinkAvailable: Boolean(bazaarDestinationForUserId(listing.userId, result.itemId))
          }))
        },
        itemMarket: {
          listingCount: result.itemMarketListings.length,
          apiLowestPrice: bestItemApi?.price ?? null,
          visiblePageLowestPrice: Number.isFinite(result.visibleItemMarketPrice) ? result.visibleItemMarketPrice : null,
          effectiveLowestPrice: effective?.price ?? null,
          effectiveSource: effective?.source ?? null
        },
        comparison: { status: comparison.status, difference: comparison.difference, differencePercent: comparison.differencePercent }
      },
      privacy: { apiKeyExported: false, sellerIdentityExported: false, bazaarDestinationExported: false, rawResponseExported: false, rawHtmlCaptured: false },
      sessionState: { apiRefreshCount: state.refreshCount, storedBazaarOptions: Math.min(result.bazaarListings.length, 3), panelCollapsed: state.collapsed }
    };
  }

  function setStatus(message, status = "neutral") {
    state.nodes.status.textContent = message;
    state.nodes.status.dataset.state = status;
  }

  function currentContext() {
    const fromHref = parseItemMarketContextFromHref(globalThis.location?.href || "");
    if (fromHref.kind === "itemMarket" && fromHref.itemId) {
      state.contextSource = "location";
      return fromHref;
    }
    const fromDom = parseItemMarketContextFromDom(fromHref);
    state.contextSource = fromDom.itemId ? "dom-verified-detail" : fromHref.kind === "itemMarket" ? "location-without-item-id" : "none";
    return fromDom.itemId || fromDom.kind === "itemMarket" ? fromDom : fromHref;
  }

  function parseItemMarketContextFromHref(href) {
    const raw = String(href || "");
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch {}
    const text = `${raw} ${decoded}`;
    const isItemMarket = /(?:[?&#]sid=ItemMarket\b|\/itemmarket\b|#\/market\/view=search\b)/i.test(text);
    if (!isItemMarket) return { kind: "other", itemId: null, itemName: null, itemType: null };
    const itemId = text.match(/[?&#]itemID=(\d+)/i)?.[1]
      || text.match(/[?&#]itemId=(\d+)/i)?.[1]
      || text.match(/\bitemID["']?\s*[:=]\s*["']?(\d+)/i)?.[1]
      || null;
    const encodedName = text.match(/[?&#]itemName=([^&#\s]+)/i)?.[1] || null;
    const encodedType = text.match(/[?&#]itemType=([^&#\s]+)/i)?.[1] || null;
    let itemName = null;
    let itemType = null;
    if (encodedName) { try { itemName = safeItemName(decodeURIComponent(encodedName.replace(/\+/g, " "))); } catch {} }
    if (encodedType) { try { itemType = normalizeItemType(decodeURIComponent(encodedType.replace(/\+/g, " "))); } catch {} }
    return { kind: "itemMarket", itemId, itemName, itemType };
  }

  function parseItemMarketContextFromDom(seed = { kind: "other", itemId: null, itemName: null, itemType: null }) {
    if (seed.kind !== "itemMarket" && !isLikelyItemMarketDocument()) return { kind: "other", itemId: null, itemName: null, itemType: null };
    const itemName = seed.itemName || findCurrentSearchName();
    const preliminaryRows = findMarketRowsWithPrices();
    if (!preliminaryRows.length) return { kind: "itemMarket", itemId: null, itemName, itemType: seed.itemType || detectEquipmentItemTypeFromDom() };

    const candidates = [...document.querySelectorAll("[data-itemid],[data-item-id],a[href*='itemID='],a[href*='itemId=']")];
    let itemId = null;
    for (const node of candidates) {
      if (!isVisibleElement(node) || node.closest(`[${HOST_ATTR}]`)) continue;
      const values = [node.getAttribute?.("data-itemid"), node.getAttribute?.("data-item-id"), node.getAttribute?.("href")].filter(Boolean);
      const id = values.join(" ").match(/(?:itemID=|itemId=|^)(\d{1,7})(?:\D|$)/i)?.[1] || null;
      if (!id) continue;
      const nodeText = normalizeText(`${node.textContent || ""} ${node.parentElement?.textContent || ""}`);
      if (itemName && nodeText && nodeText.toLowerCase().includes(itemName.toLowerCase())) { itemId = id; break; }
    }
    return { kind: "itemMarket", itemId, itemName, itemType: seed.itemType || detectEquipmentItemTypeFromDom() };
  }

  function isLikelyItemMarketDocument() {
    const title = normalizeText(document.title);
    if (/item market/i.test(title)) return true;
    return xpathElements("//*[normalize-space(text())='Item Market']", 8).some(isVisibleElement);
  }

  function findCurrentSearchName() {
    const inputSelectors = [
      "input[value]:not([value=''])",
      "input[aria-label*='item' i]",
      "input[placeholder*='item' i]"
    ];
    for (const selector of inputSelectors) {
      for (const input of document.querySelectorAll(selector)) {
        if (!isVisibleElement(input) || input.closest(`[${HOST_ATTR}]`)) continue;
        const value = safeItemName(input.value || "");
        if (value && !/search for an item|item market/i.test(value)) return value;
      }
    }
    return null;
  }

  function normalizeItemType(value) {
    const type = String(value || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    return type || null;
  }

  function isUnsupportedEquipmentType(value) {
    const type = normalizeItemType(value);
    return Boolean(type && UNSUPPORTED_EQUIPMENT_TYPES.has(type));
  }

  function isUnsupportedEquipmentContext(context) {
    if (!context || context.kind !== "itemMarket") return false;
    if (isUnsupportedEquipmentType(context.itemType)) return true;
    return detectEquipmentItemTypeFromDom() === "equipment";
  }

  function detectEquipmentItemTypeFromDom() {
    const labels = ["Damage", "Accuracy", "Bonus", "Quality", "Armor", "Armour"];
    let hits = 0;
    for (const label of labels) {
      const nodes = xpathElements(`//*[normalize-space(text())=${xpathLiteral(label)}]`, 12);
      if (nodes.some(node => isVisibleElement(node) && !node.closest(`[${HOST_ATTR}]`))) hits += 1;
    }
    if (hits >= 2) return "equipment";

    const activeEquipmentLabels = ["Primary", "Secondary", "Melee", "Armor", "Armour"];
    for (const label of activeEquipmentLabels) {
      const nodes = xpathElements(`//*[normalize-space(text())=${xpathLiteral(label)}]`, 12);
      for (const node of nodes) {
        if (!isVisibleElement(node) || node.closest(`[${HOST_ATTR}]`)) continue;
        const active = node.matches("[aria-selected='true'],[aria-current='true'],.active,.selected")
          || node.closest("[aria-selected='true'],[aria-current='true'],.active,.selected");
        if (active) return "equipment";
      }
    }
    return null;
  }

  function findMarketRowsWithPrices() {
    const rowSelectors = [
      "li[class*='rowWrapper___']",
      "li[class*='sellerRow']",
      "[class*='marketRow']",
      "[class*='seller-row']",
      "[class*='listingRow']",
      "[data-testid*='market-row']",
      "[role='row']"
    ];
    const rows = [];
    const seen = new Set();
    for (const selector of rowSelectors) {
      for (const row of document.querySelectorAll(selector)) {
        if (seen.has(row) || !isVisibleElement(row) || row.closest(`[${HOST_ATTR}]`)) continue;
        seen.add(row);
        const priceCell = findDirectPriceCell(row);
        const price = priceCell ? parseVisibleRowPrice(priceCell) : null;
        if (!priceCell || !Number.isFinite(price) || price <= 0) continue;
        rows.push({ row, priceCell, price });
        if (rows.length >= MAX_VISIBLE_ROWS) return rows;
      }
    }
    return rows;
  }

  function findDirectPriceCell(row) {
    const selectors = [
      "div[class*='price___']",
      "[class*='priceCell']",
      "[class*='price-cell']",
      "[class*='costCell']",
      "[class*='cost-cell']",
      "[data-testid*='price']",
      "[data-testid*='cost']"
    ];
    for (const selector of selectors) {
      const candidates = row.querySelectorAll(selector);
      for (const candidate of candidates) {
        if (!isVisibleElement(candidate) || candidate.closest(`[${HOST_ATTR}]`)) continue;
        if (Number.isFinite(parseVisibleRowPrice(candidate))) return candidate;
      }
    }
    const candidates = [...row.querySelectorAll("div,span,td")].filter(node => {
      if (!isVisibleElement(node) || node.closest(`[${HOST_ATTR}]`)) return false;
      const text = directText(node);
      return /^\s*\$\s*[0-9][0-9,]*(?:\.\d+)?\s*$/.test(text);
    });
    candidates.sort((a, b) => normalizeText(a.textContent).length - normalizeText(b.textContent).length);
    return candidates[0] || null;
  }

  function parseVisibleRowPrice(cell) {
    const text = directText(cell) || normalizeText(cell.textContent);
    const matches = [...text.matchAll(/\$\s*([0-9][0-9,]*(?:\.\d+)?)/g)];
    const values = matches.map(match => Number(match[1].replace(/,/g, ""))).filter(value => Number.isFinite(value) && value > 0);
    return values.length ? Math.min(...values) : null;
  }

  function directText(node) {
    return [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent || "").join(" ").replace(/\s+/g, " ").trim();
  }

  function findVisibleCheapestItemMarketPrice() {
    const prices = findMarketRowsWithPrices().map(entry => entry.price).filter(value => Number.isFinite(value) && value > 0);
    return prices.length ? Math.min(...prices) : null;
  }

  function findKnownMarketList(rows = findMarketRowsWithPrices()) {
    const first = rows[0]?.row;
    if (first) {
      const list = first.closest("ul,ol,table,[role='table']") || first.parentElement;
      if (list && isVisibleElement(list) && !list.closest(`[${HOST_ATTR}]`)) return list;
    }
    return null;
  }

  function findMarketHeaderRow() {
    const ownerNodes = xpathElements("//*[normalize-space(text())='Owner' or normalize-space(text())='OWNER']", 12);
    for (const owner of ownerNodes) {
      if (!isVisibleElement(owner)) continue;
      let node = owner;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        const text = normalizeText(node.textContent);
        if (text.length > 500) continue;
        if (/\bowner\b/i.test(text) && /\bcost\b/i.test(text) && /\bqty\b/i.test(text) && /\bbuy\b/i.test(text)) return node;
      }
    }
    return null;
  }

  function findCurrentItemTitle(itemName) {
    const wanted = safeItemName(itemName);
    if (!wanted) return null;
    const nodes = xpathElements(`//*[normalize-space(text())=${xpathLiteral(wanted)}]`, 20);
    return nodes.find(node => isVisibleElement(node) && !node.closest(`[${HOST_ATTR}]`)) || null;
  }

  function isVisibleElement(node) {
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function xpathElements(expression, limit = 20) {
    const result = [];
    try {
      const snapshot = document.evaluate(expression, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let index = 0; index < snapshot.snapshotLength && result.length < limit; index += 1) {
        const node = snapshot.snapshotItem(index);
        if (node instanceof Element) result.push(node);
      }
    } catch {}
    return result;
  }

  function xpathLiteral(value) {
    const text = String(value);
    if (!text.includes("'")) return `'${text}'`;
    if (!text.includes('"')) return `"${text}"`;
    return `concat('${text.replace(/'/g, `',"'",'`)}')`;
  }

  async function fetchTornApiSelection(itemId, selection, apiKey) {
    const url = `${API_BASE_URL}/market/${encodeURIComponent(itemId)}/${selection}?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store", headers: { Accept: "application/json" } });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.error) throw new Error(sanitizeApiError(payload, response));
    return payload;
  }

  function sanitizeApiError(payload, response) {
    const message = payload?.error?.error || payload?.error?.message || payload?.message || response?.statusText || "Torn API request failed";
    return String(message).slice(0, 180);
  }

  function requestExternalJson(url, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const modern = typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function" ? GM.xmlHttpRequest.bind(GM) : null;
      const legacy = typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : null;
      const request = modern || legacy;
      if (!request) { reject(new Error("Bazaar request API is unavailable in this userscript manager.")); return; }
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
      try {
        request({
          method: "GET", url, timeout: timeoutMs, headers: { Accept: "application/json" },
          onload: response => {
            const status = Number(response?.status || 0);
            if (status < 200 || status >= 300) { finish(reject, new Error(`Bazaar source returned HTTP ${status || "error"}.`)); return; }
            try { finish(resolve, JSON.parse(String(response?.responseText || ""))); }
            catch { finish(reject, new Error("Bazaar source returned invalid JSON.")); }
          },
          onerror: () => finish(reject, new Error("Bazaar source network error.")),
          ontimeout: () => finish(reject, new Error("Bazaar source request timed out."))
        });
      } catch { finish(reject, new Error("Bazaar source request failed.")); }
    });
  }

  async function fetchTornW3bBazaarListings(itemId) {
    const expected = String(itemId || "").trim();
    if (!/^\d+$/.test(expected)) throw new Error("Item ID is required for Bazaar data.");
    const payload = await requestExternalJson(`https://weav3r.dev/api/marketplace/${encodeURIComponent(expected)}`);
    const remote = normalizeTornW3bBazaarListings(payload, expected)
      .map(listing => ({ ...listing, source: "tornw3b" }));
    return mergeBazaarListingSources(remote, readLiveBazaarListingsForItem(expected));
  }

  function normalizeTornW3bBazaarListings(payload, itemId) {
    const expected = String(itemId || "").trim();
    if (!/^\d+$/.test(expected)) throw new Error("TORNW3B_ITEM_ID_REQUIRED");
    if (!payload || !Array.isArray(payload.listings)) throw new Error("TORNW3B_LISTINGS_MISSING");
    return payload.listings.map((listing, index) => {
      if (!listing || typeof listing !== "object" || Array.isArray(listing)) return null;
      const listingItemId = idFromKeys(listing, ["item_id", "itemId"]);
      const userId = idFromKeys(listing, ["player_id", "playerId", "user_id", "userId"]);
      const price = numberFromKeys(listing, ["price"]);
      const quantity = numberFromKeys(listing, ["quantity", "qty", "stock"]);
      const updatedAt = numberFromKeys(listing, ["last_checked", "updated", "updated_at"]);
      if (listingItemId && listingItemId !== expected) return null;
      if (!userId || !Number.isFinite(price) || price <= 0) return null;
      if (Number.isFinite(quantity) && quantity <= 0) return null;
      return { kind: "bazaar", itemId: expected, price, stock: Number.isFinite(quantity) ? Math.trunc(quantity) : null, userId, updatedAt: Number.isFinite(updatedAt) ? updatedAt : null, sourceIndex: index };
    }).filter(Boolean).sort((a, b) => a.price - b.price || (b.updatedAt || 0) - (a.updatedAt || 0) || (b.stock || 0) - (a.stock || 0));
  }

  function collectArrayCandidates(value, depth = 0, seen = new Set()) {
    if (depth > 6 || value == null || typeof value !== "object" || seen.has(value)) return [];
    seen.add(value);
    if (Array.isArray(value)) return [value, ...value.flatMap(entry => collectArrayCandidates(entry, depth + 1, seen))];
    return Object.values(value).flatMap(entry => collectArrayCandidates(entry, depth + 1, seen));
  }

  function normalizeApiMarketRecords(payload, kind) {
    const arrays = collectArrayCandidates(payload);
    let best = [];
    for (const array of arrays) {
      const normalized = array.map((record, index) => {
        if (!record || typeof record !== "object" || Array.isArray(record)) return null;
        const nested = firstObject(record, ["listing", "offer", "item", "details"]);
        const price = numberFromKeys(record, ["price", "cost", "amount", "unit_price", "unitPrice", "lowest_price", "lowestPrice"])
          ?? numberFromKeys(nested, ["price", "cost", "amount", "unit_price", "unitPrice", "lowest_price", "lowestPrice"]);
        if (!Number.isFinite(price) || price <= 0) return null;
        const quantity = numberFromKeys(record, ["quantity", "qty", "stock", "available", "amount_available", "amountAvailable"])
          ?? numberFromKeys(nested, ["quantity", "qty", "stock", "available", "amount_available", "amountAvailable"]);
        return { kind, price, stock: Number.isFinite(quantity) ? quantity : null, sourceIndex: index };
      }).filter(Boolean);
      if (normalized.length > best.length) best = normalized;
    }
    return best.sort((a, b) => a.price - b.price || (b.stock || 0) - (a.stock || 0));
  }

  function firstObject(value, keys) {
    for (const key of keys) {
      const candidate = value?.[key];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
    }
    return null;
  }

  function numberFromKeys(record, keys) {
    for (const key of keys) {
      const raw = record?.[key];
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "string") {
        const n = Number(raw.replace(/[$,\s]/g, ""));
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  }

  function idFromKeys(record, keys) {
    for (const key of keys) {
      const raw = record?.[key];
      if (typeof raw === "number" && Number.isFinite(raw)) return String(Math.trunc(raw));
      if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return raw.trim();
    }
    return null;
  }

  function resolveEffectiveItemMarket(apiListing, visiblePrice) {
    const apiPrice = Number(apiListing?.price);
    if (Number.isFinite(visiblePrice) && visiblePrice > 0 && (!Number.isFinite(apiPrice) || visiblePrice < apiPrice)) return { kind: "itemmarket", price: visiblePrice, stock: null, source: "current-item-market-page" };
    if (Number.isFinite(apiPrice) && apiPrice > 0) return { ...apiListing, source: "torn-api-v2" };
    if (Number.isFinite(visiblePrice) && visiblePrice > 0) return { kind: "itemmarket", price: visiblePrice, stock: null, source: "current-item-market-page" };
    return null;
  }

  function comparePrices(bazaarPrice, itemMarketPrice) {
    const bazaar = Number(bazaarPrice);
    const market = Number(itemMarketPrice);
    if (!Number.isFinite(bazaar) || bazaar <= 0 || !Number.isFinite(market) || market <= 0) return { status: "unavailable", difference: null, differencePercent: null };
    if (bazaar === market) return { status: "same-price", difference: 0, differencePercent: 0 };
    const difference = Math.abs(bazaar - market);
    const higher = Math.max(bazaar, market);
    return { status: bazaar < market ? "bazaar-cheaper" : "item-market-cheaper", difference, differencePercent: roundTwo((difference / higher) * 100) };
  }

  function bazaarDestinationForUserId(userId, itemId = null) {
    if (!/^\d+$/.test(String(userId || ""))) return null;
    const base = `https://www.torn.com/bazaar.php?userId=${encodeURIComponent(userId)}`;
    return /^\d+$/.test(String(itemId || "")) ? `${base}&itemID=${encodeURIComponent(itemId)}` : base;
  }

  function sourceAgeSeconds(updatedAt, capturedAt = Date.now()) {
    const raw = Number(updatedAt);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const age = Math.floor((Number(capturedAt) - ms) / 1000);
    return Number.isFinite(age) && age >= 0 ? age : null;
  }

  function sourceFreshness(updatedAt, capturedAt = Date.now()) {
    const age = sourceAgeSeconds(updatedAt, capturedAt);
    if (age == null) return "unknown";
    if (age <= 300) return "fresh";
    if (age <= 900) return "warning";
    return "stale";
  }

  function formatLastSeen(updatedAt, capturedAt = Date.now()) {
    const age = sourceAgeSeconds(updatedAt, capturedAt);
    if (age == null) return "TIME UNKNOWN";
    const freshness = sourceFreshness(updatedAt, capturedAt);
    const time = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
    if (freshness === "fresh") return `FRESH · ${time}`;
    if (freshness === "warning") return `VERIFY PRICE · ${time}`;
    return `STALE · VERIFY · ${time}`;
  }

  function unixSecondsToIso(updatedAt) {
    const raw = Number(updatedAt);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const ms = raw < 1e12 ? raw * 1000 : raw;
    try { return new Date(ms).toISOString(); } catch { return null; }
  }

  function safeItemName(value) {
    const text = normalizeText(value).replace(/[<>]/g, "").slice(0, 120);
    return text || null;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function sanitizeRoute(locationLike) {
    return `${locationLike?.pathname || ""}${locationLike?.search || ""}${locationLike?.hash || ""}`.slice(0, 500);
  }

  function minFinite(...values) {
    const valid = values.filter(value => Number.isFinite(value) && value > 0);
    return valid.length ? Math.min(...valid) : null;
  }

  function roundTwo(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function formatClock(value) {
    try { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    catch { return "now"; }
  }

  function readString(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }

  function readBoolean(key, fallback) {
    const value = readString(key, null);
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
  }

  function writeBoolean(key, value) {
    try { localStorage.setItem(key, value ? "true" : "false"); } catch {}
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }
})();
