/* ============================================================================
 * config-loader.js — runs on every page.
 * Applies brand name, contact email, announcement banner, and footer year
 * from the Settings tab (with config.js fallbacks). Sets up nav interactions.
 * ==========================================================================*/

import { applyChrome } from "./ui.js";

document.addEventListener("DOMContentLoaded", () => {
  applyChrome().catch((err) => {
    // Non-fatal: the page still works with the static fallbacks in config.js.
    console.warn("Chrome/settings could not be loaded from the API:", err);
  });
});
