/* ============================================================================
 * config-loader.js — runs on every page.
 * Applies brand name, contact email, announcement banner, and footer year
 * from the Settings tab (with config.js fallbacks). Sets up nav interactions.
 * ==========================================================================*/

import { applyChrome } from "./ui.js";
import { initMotion } from "./motion.js";
import { initFx } from "./fx.js";
import { initCursor } from "./cursor.js";
import "./loader.js";

document.addEventListener("DOMContentLoaded", () => {
  applyChrome().catch((err) => {
    // Non-fatal: the page still works with the static fallbacks in config.js.
    console.warn("Chrome/settings could not be loaded from the API:", err);
  });
  try { initMotion(); } catch (e) { /* motion is purely cosmetic */ }
  try { initFx(); } catch (e) { /* fx is purely cosmetic */ }
  try { initCursor(); } catch (e) { /* cursor is purely cosmetic */ }
});
