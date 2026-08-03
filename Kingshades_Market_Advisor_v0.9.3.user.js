// ==UserScript==
// @name         Kingshade's Market Advisor
// @namespace    https://kingshade.tools/
// @version      0.9.4.1
// @description  Emergency compliance shutdown. All Market Advisor functionality is disabled pending Torn Staff review.
// @author       Kingshade
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-start
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/Kingshades_Market_Advisor_v0.9.3.user.js
// @downloadURL  https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/Kingshades_Market_Advisor_v0.9.3.user.js
// ==/UserScript==

(() => {
  "use strict";

  const controllerKeys = [
    "__ksma093ReleaseController",
    "__ksma093Rc5Controller",
    "__ksma093Rc4Controller",
    "__ksma093Rc3Controller",
    "__ksma093Rc2Controller",
    "__ksma093Rc1Controller",
    "__ksmaFullProfileIntegrationActive",
    "__ksmaAuthoritativeUiGuard"
  ];

  for (const key of controllerKeys) {
    try {
      globalThis[key]?.destroy?.({
        force: true,
        byVersion: "0.9.4.1",
        reason: "emergency-compliance-shutdown"
      });
    } catch {}

    try {
      delete globalThis[key];
    } catch {}
  }

  const removeLegacyUi = () => {
    const selectors = [
      "[data-ksma-093release-host]",
      "[data-ksma-093release-bazaar-route-nav]",
      "[data-ksma-093release-item-bazaar-back]",
      "[data-ksma-093release-advice]",
      "[data-ksma-093release-best]"
    ];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => node.remove());
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", removeLegacyUi, { once: true });
  } else {
    removeLegacyUi();
  }

  console.warn("Kingshade's Market Advisor is temporarily disabled for Torn rules compliance review.");
})();
